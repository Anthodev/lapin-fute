import {
  SCHEMA_VERSION,
  type ErrorCode,
} from "../../contracts/src/index.ts";

import type { CatalogReader } from "./catalog.ts";
import {
  DEPARTURE_METRIC_NAME,
  type DepartureMetricName,
  type DepartureMetrics,
  type DepartureResolver,
  type PublicDepartureData,
  type PublicDepartureError,
} from "./departures.ts";
import {
  buildPrimStopMonitoringUrl,
  normalizePrimDepartureResponse,
  parseRetryAfterSeconds,
} from "./prim-departures.ts";

export interface PrimDepartureRelayRequest {
  readonly target: URL;
  readonly apiKey: string;
}

export interface PrimDepartureRelayResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
  readonly retryAfter?: string;
}

export type PrimDepartureRelay = (
  request: PrimDepartureRelayRequest,
) => Promise<PrimDepartureRelayResponse>;

export interface UpstreamLimiter {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export interface PrimDepartureResolverDependencies {
  readonly catalog: CatalogReader;
  readonly relay: PrimDepartureRelay;
  readonly clock?: () => number;
  readonly metrics?: DepartureMetrics;
  readonly limiter?: UpstreamLimiter;
}

export const MAX_UPSTREAM_CALLS = 8 as const;
const UINT32_MAX = 0xffff_ffff;
const STRICT_UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

export function createUpstreamLimiter(
  maxActive = MAX_UPSTREAM_CALLS,
): UpstreamLimiter {
  if (!Number.isInteger(maxActive) || maxActive < 1) {
    throw new RangeError("maxActive must be a positive integer");
  }

  let active = 0;
  const queue: Array<() => void> = [];

  async function acquire(): Promise<void> {
    if (active < maxActive) {
      active += 1;
      return;
    }

    await new Promise<void>((resolve) => {
      queue.push(() => {
        active += 1;
        resolve();
      });
    });
  }

  function release(): void {
    active -= 1;
    queue.shift()?.();
  }

  return Object.freeze({
    async run<T>(operation: () => Promise<T>): Promise<T> {
      await acquire();
      try {
        return await operation();
      } finally {
        release();
      }
    },
  });
}

const PROCESS_UPSTREAM_LIMITER = createUpstreamLimiter();

function nowMilliseconds(clock: (() => number) | undefined): number {
  try {
    const value = clock?.() ?? Date.now();
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function metric(
  metrics: DepartureMetrics | undefined,
  name: DepartureMetricName,
  value: number,
): void {
  if (!Number.isFinite(value) || value < 0) return;
  try {
    metrics?.record(name, value);
  } catch {
    // Instrumentation must never affect the relay or request settlement.
  }
}

function epochSeconds(milliseconds: number): number {
  return Math.min(UINT32_MAX, Math.floor(milliseconds / 1_000));
}

function publicError(
  code: ErrorCode,
  milliseconds: number,
  retryAfterSeconds?: number,
): PublicDepartureError {
  return {
    schemaVersion: SCHEMA_VERSION,
    code,
    occurredAt: epochSeconds(milliseconds),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

interface RelayResponseEnvelope {
  readonly status: number;
  readonly bytes?: unknown;
  readonly retryAfter?: unknown;
}

function validRelayResponse(response: unknown): response is RelayResponseEnvelope {
  if (typeof response !== "object" || response === null || !("status" in response)) {
    return false;
  }
  const status = response.status;
  return typeof status === "number"
    && Number.isInteger(status)
    && status >= 100
    && status <= 599;
}

export function createPrimDepartureResolver(
  dependencies: PrimDepartureResolverDependencies,
): DepartureResolver {
  const limiter = dependencies.limiter ?? PROCESS_UPSTREAM_LIMITER;

  return async (request) => {
    const resolution = dependencies.catalog.resolveService(request.serviceId);
    if (resolution.status !== "RESOLVED") {
      return publicError("INVALID_SERVICE", nowMilliseconds(dependencies.clock));
    }

    const target = buildPrimStopMonitoringUrl(resolution);
    let apiKey = request.apiKey;
    let response: unknown;
    let completedAtMilliseconds: number | undefined;
    try {
      response = await limiter.run(async () => {
        metric(dependencies.metrics, DEPARTURE_METRIC_NAME.UPSTREAM_REQUEST, 1);
        const startedAtMilliseconds = nowMilliseconds(dependencies.clock);
        let status = 0;
        try {
          const relayResponse = await dependencies.relay({ target, apiKey });
          status = validRelayResponse(relayResponse) ? relayResponse.status : 0;
          return relayResponse;
        } finally {
          completedAtMilliseconds = nowMilliseconds(dependencies.clock);
          metric(dependencies.metrics, DEPARTURE_METRIC_NAME.UPSTREAM_STATUS, status);
          metric(
            dependencies.metrics,
            DEPARTURE_METRIC_NAME.UPSTREAM_LATENCY_MS,
            Math.max(0, completedAtMilliseconds - startedAtMilliseconds),
          );
        }
      });
    } catch {
      return publicError(
        "SOURCE_UNAVAILABLE",
        completedAtMilliseconds ?? nowMilliseconds(dependencies.clock),
      );
    } finally {
      apiKey = "";
    }

    const receivedAtMilliseconds =
      completedAtMilliseconds ?? nowMilliseconds(dependencies.clock);
    if (!validRelayResponse(response)) {
      return publicError("INVALID_RESPONSE", receivedAtMilliseconds);
    }
    if (response.status === 401 || response.status === 403) {
      return publicError("API_KEY_INVALID", receivedAtMilliseconds);
    }
    if (response.status === 429) {
      return publicError(
        "RATE_LIMITED",
        receivedAtMilliseconds,
        parseRetryAfterSeconds(response.retryAfter),
      );
    }
    if (response.status < 200 || response.status >= 300) {
      return publicError("SOURCE_UNAVAILABLE", receivedAtMilliseconds);
    }
    if (!(response.bytes instanceof Uint8Array)) {
      return publicError("INVALID_RESPONSE", receivedAtMilliseconds);
    }

    try {
      const payload = JSON.parse(STRICT_UTF8_DECODER.decode(response.bytes)) as unknown;
      return normalizePrimDepartureResponse(
        payload,
        resolution,
        epochSeconds(receivedAtMilliseconds),
      ) as PublicDepartureData;
    } catch {
      return publicError("INVALID_RESPONSE", receivedAtMilliseconds);
    }
  };
}
