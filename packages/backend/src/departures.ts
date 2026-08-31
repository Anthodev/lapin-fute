import {
  CACHE_FRESH_SECONDS,
  LIMITS,
  SCHEMA_VERSION,
  isDepartureResult,
  isErrorResult,
  isPersonalApiKey,
  utf8Bytes,
  type Departure,
  type DepartureResult,
  type ErrorCode,
  type ErrorResult,
} from "../../contracts/src/index.ts";

export const DEPARTURE_ROUTE = "/api/departures" as const;

export interface DepartureRequestBody {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly requestId: string;
  readonly favoriteId: string;
  readonly serviceId: string;
}

export interface DepartureHandlerRequest {
  readonly authorization: unknown;
  readonly body: unknown;
}

export type PublicDepartureData = Omit<DepartureResult, "requestId" | "favoriteId">;
export type PublicDepartureError = Omit<ErrorResult, "requestId" | "favoriteId">;
export type DepartureResolverResult = PublicDepartureData | PublicDepartureError;

export interface DepartureResolverRequest {
  readonly serviceId: string;
  readonly apiKey: string;
}

export type DepartureResolver = (
  request: DepartureResolverRequest,
) => Promise<DepartureResolverResult>;

export type DepartureAuthorizationParser = (authorization: unknown) => string;
export type DepartureClock = () => number;

export const DEPARTURE_METRIC_NAME = {
  CACHE_HIT: "departure.cache.hit",
  CACHE_MISS: "departure.cache.miss",
  UPSTREAM_REQUEST: "departure.upstream.request",
  UPSTREAM_STATUS: "departure.upstream.status",
  UPSTREAM_LATENCY_MS: "departure.upstream.latency_ms",
  NORMALIZED_RESPONSE_BYTES: "departure.normalized_response_bytes",
  COALESCED_REQUEST: "departure.coalesced.request",
} as const;

export type DepartureMetricName =
  (typeof DEPARTURE_METRIC_NAME)[keyof typeof DEPARTURE_METRIC_NAME];

export interface DepartureMetrics {
  record(name: DepartureMetricName, value: number): void;
}

export type DepartureHandlerResponse = DepartureResult | ErrorResult;

export type DepartureHttpStatus = 200 | 400 | 401 | 404 | 405 | 429 | 502 | 503;

export interface DepartureHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: unknown;
  readonly body: unknown;
}

export interface DepartureHttpResponse {
  readonly status: DepartureHttpStatus;
  readonly body: DepartureHandlerResponse;
}

interface DepartureBinding {
  readonly requestId: string;
  readonly favoriteId?: string;
}

interface CachedDeparture {
  readonly storedAtMilliseconds: number;
  readonly data: PublicDepartureData;
}

interface PendingDepartureEvent {
  readonly request: DepartureRequestBody;
  apiKey: string | null;
  resolver: DepartureResolver | null;
  clock: DepartureClock | undefined;
  metrics: DepartureMetrics | undefined;
  complete: ((result: DepartureHandlerResponse) => void) | null;
  promoted: boolean;
  settled: boolean;
}

interface DepartureFlight {
  readonly serviceId: string;
  active: PendingDepartureEvent | null;
  waiters: PendingDepartureEvent[];
}

export interface DepartureRuntimeState {
  readonly cache: Map<string, CachedDeparture>;
  readonly flights: Map<string, DepartureFlight>;
}

export interface DepartureHandlerDependencies {
  readonly resolve: DepartureResolver;
  readonly nowMilliseconds?: DepartureClock;
  readonly clock?: DepartureClock;
  readonly state?: DepartureRuntimeState;
  readonly metrics?: DepartureMetrics;
  readonly authorizationParser?: DepartureAuthorizationParser;
}

const DEPARTURE_REQUEST_KEYS = ["schemaVersion", "requestId", "favoriteId", "serviceId"] as const;
const PUBLIC_DEPARTURE_KEYS = [
  "schemaVersion",
  "fetchedAt",
  "sourceUpdatedAt",
  "freshness",
  "departures",
] as const;
const PUBLIC_ERROR_KEYS = [
  "schemaVersion",
  "code",
  "occurredAt",
  "retryAfterSeconds",
] as const;
const INVALID_REQUEST_ID = "invalid-request";
const UINT32_MAX = 0xffff_ffff;
const DEPARTURE_CACHE_FRESH_MS = CACHE_FRESH_SECONDS * 1_000;
const BEARER_PREFIX = "Bearer ";

const DEFAULT_RUNTIME_STATE = createDepartureRuntimeState();

export function createDepartureRuntimeState(): DepartureRuntimeState {
  return {
    cache: new Map<string, CachedDeparture>(),
    flights: new Map<string, DepartureFlight>(),
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}


function boundedId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const bytes = utf8Bytes(value);
  return bytes >= 1 && bytes <= LIMITS.idUtf8Bytes;
}

export function parseDepartureRequestBody(value: unknown): DepartureRequestBody | undefined {
  if (!record(value)) return undefined;

  try {
    if (
      !hasExactKeys(value, DEPARTURE_REQUEST_KEYS)
      || value.schemaVersion !== SCHEMA_VERSION
      || !boundedId(value.requestId)
      || !boundedId(value.favoriteId)
      || !boundedId(value.serviceId)
    ) {
      return undefined;
    }

    return {
      schemaVersion: SCHEMA_VERSION,
      requestId: value.requestId,
      favoriteId: value.favoriteId,
      serviceId: value.serviceId,
    };
  } catch {
    return undefined;
  }
}

export function isDepartureRequestBody(value: unknown): value is DepartureRequestBody {
  return parseDepartureRequestBody(value) !== undefined;
}

function departureBinding(value: unknown): DepartureBinding {
  if (!record(value)) return { requestId: INVALID_REQUEST_ID };

  try {
    const requestId = boundedId(value.requestId) ? value.requestId : INVALID_REQUEST_ID;
    const favoriteId = boundedId(value.favoriteId) ? value.favoriteId : undefined;
    return favoriteId === undefined ? { requestId } : { requestId, favoriteId };
  } catch {
    return { requestId: INVALID_REQUEST_ID };
  }
}

function isPublicDepartureData(value: unknown): value is PublicDepartureData {
  if (!record(value)) return false;

  try {
    return Object.keys(value).every((key) => PUBLIC_DEPARTURE_KEYS.includes(key))
      && "schemaVersion" in value
      && "fetchedAt" in value
      && "freshness" in value
      && "departures" in value
      && value.freshness !== "STALE"
      && isDepartureResult({
        ...value,
        requestId: INVALID_REQUEST_ID,
        favoriteId: INVALID_REQUEST_ID,
      });
  } catch {
    return false;
  }
}

function isPublicDepartureError(value: unknown): value is PublicDepartureError {
  if (!record(value)) return false;

  try {
    return Object.keys(value).every((key) => PUBLIC_ERROR_KEYS.includes(key))
      && "schemaVersion" in value
      && "code" in value
      && "occurredAt" in value
      && isErrorResult({ ...value, requestId: INVALID_REQUEST_ID });
  } catch {
    return false;
  }
}

function defaultAuthorizationParser(value: unknown): string {
  if (
    typeof value !== "string"
    || !value.startsWith(BEARER_PREFIX)
    || value.length === BEARER_PREFIX.length
    || value.charCodeAt(BEARER_PREFIX.length) === 0x20
  ) {
    throw new TypeError("Invalid bearer authorization");
  }
  return value.slice(BEARER_PREFIX.length);
}

function authorizationMissing(value: unknown): boolean {
  return value === undefined || value === null || value === "";
}

function parseAuthorization(
  value: unknown,
  parser: DepartureAuthorizationParser | undefined,
): string {
  const apiKey = (parser ?? defaultAuthorizationParser)(value);
  if (!isPersonalApiKey(apiKey)) throw new TypeError("Invalid bearer authorization");
  return apiKey;
}

function dependencyClock(dependencies: DepartureHandlerDependencies): DepartureClock | undefined {
  return dependencies.clock ?? dependencies.nowMilliseconds;
}

function nowMilliseconds(clock: DepartureClock | undefined): number {
  try {
    const value = clock?.() ?? Date.now();
    return Number.isFinite(value) && value >= 0 ? value : Date.now();
  } catch {
    return Date.now();
  }
}

function occurredAt(milliseconds: number): number {
  return Math.min(UINT32_MAX, Math.floor(milliseconds / 1_000));
}

function stableError(
  binding: DepartureBinding,
  code: ErrorCode,
  milliseconds: number,
): ErrorResult {
  const result: ErrorResult = {
    schemaVersion: SCHEMA_VERSION,
    requestId: binding.requestId,
    code,
    occurredAt: occurredAt(milliseconds),
  };
  if (binding.favoriteId !== undefined) result.favoriteId = binding.favoriteId;
  return result;
}

function publicError(code: ErrorCode, milliseconds: number): PublicDepartureError {
  return {
    schemaVersion: SCHEMA_VERSION,
    code,
    occurredAt: occurredAt(milliseconds),
  };
}

function copyDeparture(value: Departure): Departure {
  const copy: Departure = {
    expectedAt: value.expectedAt,
    minutes: value.minutes,
    status: value.status,
  };
  if (value.aimedAt !== undefined) copy.aimedAt = value.aimedAt;
  if (value.nextIntervalMinutes !== undefined) copy.nextIntervalMinutes = value.nextIntervalMinutes;
  return copy;
}

function copyPublicDeparture(value: PublicDepartureData): PublicDepartureData {
  const copy: PublicDepartureData = {
    schemaVersion: SCHEMA_VERSION,
    fetchedAt: value.fetchedAt,
    freshness: value.freshness,
    departures: value.departures.map(copyDeparture),
  };
  if (value.sourceUpdatedAt !== undefined) copy.sourceUpdatedAt = value.sourceUpdatedAt;
  return copy;
}

function bindDeparture(
  data: PublicDepartureData,
  request: DepartureRequestBody,
): DepartureResult {
  const result: DepartureResult = {
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    favoriteId: request.favoriteId,
    fetchedAt: data.fetchedAt,
    freshness: data.freshness,
    departures: data.departures.map(copyDeparture),
  };
  if (data.sourceUpdatedAt !== undefined) result.sourceUpdatedAt = data.sourceUpdatedAt;
  return result;
}

function bindPublicError(
  error: PublicDepartureError,
  request: DepartureRequestBody,
): ErrorResult {
  const result: ErrorResult = {
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    favoriteId: request.favoriteId,
    code: error.code,
    occurredAt: error.occurredAt,
  };
  if (error.retryAfterSeconds !== undefined) result.retryAfterSeconds = error.retryAfterSeconds;
  return result;
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
    // Instrumentation must never affect request settlement.
  }
}

function normalizedBytes(data: PublicDepartureData): number {
  return utf8Bytes(JSON.stringify(data));
}

function cachedDeparture(
  state: DepartureRuntimeState,
  serviceId: string,
  milliseconds: number,
): PublicDepartureData | undefined {
  const cached = state.cache.get(serviceId);
  if (cached === undefined) return undefined;

  const age = milliseconds - cached.storedAtMilliseconds;
  if (
    !Number.isFinite(cached.storedAtMilliseconds)
    || age < 0
    || age >= DEPARTURE_CACHE_FRESH_MS
    || !isPublicDepartureData(cached.data)
  ) {
    state.cache.delete(serviceId);
    return undefined;
  }
  return cached.data;
}

function settleEvent(
  event: PendingDepartureEvent,
  result: DepartureHandlerResponse,
): void {
  if (event.settled) return;
  event.settled = true;
  event.apiKey = null;
  event.resolver = null;
  event.clock = undefined;
  event.metrics = undefined;
  const complete = event.complete;
  event.complete = null;
  complete?.(result);
}

function removeFlight(state: DepartureRuntimeState, flight: DepartureFlight): void {
  if (state.flights.get(flight.serviceId) === flight) {
    state.flights.delete(flight.serviceId);
  }
}

function allFlightEvents(flight: DepartureFlight): PendingDepartureEvent[] {
  const events = flight.active === null
    ? flight.waiters
    : [flight.active, ...flight.waiters];
  flight.active = null;
  flight.waiters = [];
  return events;
}

function settleSharedError(
  state: DepartureRuntimeState,
  flight: DepartureFlight,
  error: PublicDepartureError,
): void {
  const events = allFlightEvents(flight);
  removeFlight(state, flight);
  for (const event of events) settleEvent(event, bindPublicError(error, event.request));
}

function settleSuccess(
  state: DepartureRuntimeState,
  flight: DepartureFlight,
  data: PublicDepartureData,
  storedAtMilliseconds: number,
): void {
  const cached = copyPublicDeparture(data);
  state.cache.set(flight.serviceId, { storedAtMilliseconds, data: cached });
  const events = allFlightEvents(flight);
  removeFlight(state, flight);
  const bytes = normalizedBytes(cached);
  for (const event of events) {
    metric(event.metrics, DEPARTURE_METRIC_NAME.NORMALIZED_RESPONSE_BYTES, bytes);
    settleEvent(event, bindDeparture(cached, event.request));
  }
}


function settleCredentialFailure(
  state: DepartureRuntimeState,
  flight: DepartureFlight,
  active: PendingDepartureEvent,
  activeKey: string,
  error: PublicDepartureError,
): void {
  const sameCredential: PendingDepartureEvent[] = [active];
  const remaining: PendingDepartureEvent[] = [];

  for (const waiter of flight.waiters) {
    if (waiter.apiKey === activeKey) sameCredential.push(waiter);
    else remaining.push(waiter);
  }

  flight.active = null;
  flight.waiters = remaining;
  for (const event of sameCredential) {
    settleEvent(event, bindPublicError(error, event.request));
  }

  const nextIndex = remaining.findIndex((event) =>
    !event.promoted && event.apiKey !== null && event.apiKey !== activeKey
  );
  if (nextIndex < 0) {
    const unsettled = allFlightEvents(flight);
    removeFlight(state, flight);
    const fallback = publicError("INVALID_RESPONSE", nowMilliseconds(active.clock));
    for (const event of unsettled) settleEvent(event, bindPublicError(fallback, event.request));
    return;
  }

  const [next] = remaining.splice(nextIndex, 1);
  if (next === undefined) return;
  next.promoted = true;
  flight.active = next;
  runPromotedEvent(state, flight, next);
}

function runPromotedEvent(
  state: DepartureRuntimeState,
  flight: DepartureFlight,
  active: PendingDepartureEvent,
): void {
  void (async () => {
    let activeKey = active.apiKey;
    const resolver = active.resolver;
    active.resolver = null;

    if (activeKey === null || resolver === null) {
      settleSharedError(
        state,
        flight,
        publicError("INVALID_RESPONSE", nowMilliseconds(active.clock)),
      );
      return;
    }

    const resolverRequest: DepartureResolverRequest = {
      serviceId: flight.serviceId,
      apiKey: activeKey,
    };

    let resolved: unknown;
    let failed = false;
    try {
      resolved = await resolver(resolverRequest);
    } catch {
      failed = true;
    }

    const completedAt = nowMilliseconds(active.clock);

    try {
      if (failed) {
        settleSharedError(state, flight, publicError("SOURCE_UNAVAILABLE", completedAt));
        return;
      }

      if (isPublicDepartureData(resolved)) {
        settleSuccess(state, flight, resolved, completedAt);
        return;
      }

      if (isPublicDepartureError(resolved)) {
        if (resolved.code === "API_KEY_INVALID" || resolved.code === "RATE_LIMITED") {
          settleCredentialFailure(state, flight, active, activeKey, resolved);
        } else {
          settleSharedError(state, flight, resolved);
        }
        return;
      }

      settleSharedError(state, flight, publicError("INVALID_RESPONSE", completedAt));
    } catch {
      if (!active.settled && state.flights.get(flight.serviceId) === flight) {
        settleSharedError(state, flight, publicError("SOURCE_UNAVAILABLE", completedAt));
      }
    } finally {
      activeKey = null;
    }
  })();
}

export async function handleDepartureRequest(
  request: DepartureHandlerRequest,
  dependencies: DepartureHandlerDependencies,
): Promise<DepartureHandlerResponse> {
  let authorization: unknown;
  let bodyValue: unknown;
  try {
    authorization = request.authorization;
    bodyValue = request.body;
  } catch {
    authorization = undefined;
    bodyValue = undefined;
  }

  const binding = departureBinding(bodyValue);
  let apiKey: string | null = null;
  try {
    apiKey = parseAuthorization(authorization, dependencies.authorizationParser);
  } catch {
    const code: ErrorCode = authorizationMissing(authorization)
      ? "API_KEY_REQUIRED"
      : "API_KEY_INVALID";
    return stableError(binding, code, nowMilliseconds(dependencyClock(dependencies)));
  }

  const body = parseDepartureRequestBody(bodyValue);
  if (body === undefined) {
    apiKey = null;
    return stableError(
      binding,
      "INVALID_SERVICE",
      nowMilliseconds(dependencyClock(dependencies)),
    );
  }

  const state = dependencies.state ?? DEFAULT_RUNTIME_STATE;
  const clock = dependencyClock(dependencies);
  const currentMilliseconds = nowMilliseconds(clock);
  const cached = cachedDeparture(state, body.serviceId, currentMilliseconds);
  if (cached !== undefined) {
    apiKey = null;
    metric(dependencies.metrics, DEPARTURE_METRIC_NAME.CACHE_HIT, 1);
    metric(
      dependencies.metrics,
      DEPARTURE_METRIC_NAME.NORMALIZED_RESPONSE_BYTES,
      normalizedBytes(cached),
    );
    return bindDeparture(cached, body);
  }

  metric(dependencies.metrics, DEPARTURE_METRIC_NAME.CACHE_MISS, 1);

  let complete: ((result: DepartureHandlerResponse) => void) | null = null;
  const result = new Promise<DepartureHandlerResponse>((resolve) => {
    complete = resolve;
  });
  const event: PendingDepartureEvent = {
    request: body,
    apiKey,
    resolver: dependencies.resolve,
    clock,
    metrics: dependencies.metrics,
    complete,
    promoted: false,
    settled: false,
  };
  apiKey = null;

  const existing = state.flights.get(body.serviceId);
  if (existing !== undefined) {
    existing.waiters.push(event);
    metric(dependencies.metrics, DEPARTURE_METRIC_NAME.COALESCED_REQUEST, 1);
  } else {
    const flight: DepartureFlight = {
      serviceId: body.serviceId,
      active: event,
      waiters: [],
    };
    event.promoted = true;
    state.flights.set(body.serviceId, flight);
    runPromotedEvent(state, flight, event);
  }

  return result;
}

export function departureHttpStatus(response: DepartureHandlerResponse): DepartureHttpStatus {
  if (isDepartureResult(response)) return 200;
  switch (response.code) {
    case "API_KEY_REQUIRED":
    case "API_KEY_INVALID":
      return 401;
    case "INVALID_SERVICE":
      return 400;
    case "RATE_LIMITED":
      return 429;
    case "SOURCE_UNAVAILABLE":
      return 503;
    case "INVALID_RESPONSE":
      return 502;
  }
}

export async function handleDepartureHttpRequest(
  request: DepartureHttpRequest,
  dependencies: DepartureHandlerDependencies,
): Promise<DepartureHttpResponse> {
  let method: string;
  let path: string;
  let authorization: unknown;
  let body: unknown;
  try {
    method = request.method;
    path = request.path;
    authorization = request.authorization;
    body = request.body;
  } catch {
    method = "";
    path = "";
    authorization = undefined;
    body = undefined;
  }

  const binding = departureBinding(body);
  if (path !== DEPARTURE_ROUTE) {
    return {
      status: 404,
      body: stableError(binding, "INVALID_SERVICE", nowMilliseconds(dependencyClock(dependencies))),
    };
  }
  if (method !== "POST") {
    return {
      status: 405,
      body: stableError(binding, "INVALID_SERVICE", nowMilliseconds(dependencyClock(dependencies))),
    };
  }

  const response = await handleDepartureRequest({ authorization, body }, dependencies);
  return { status: departureHttpStatus(response), body: response };
}
