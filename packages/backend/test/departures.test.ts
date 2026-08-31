import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { performance } from "node:perf_hooks";
import {
  CACHE_FRESH_SECONDS,
  LIMITS,
  PRIM_ORIGIN,
  SCHEMA_VERSION,
  isDepartureResult,
  isErrorResult,
  utf8Bytes,
  type Departure,
  type DepartureResult,
  type DepartureStatus,
  type ErrorCode,
  type ErrorResult,
  type Freshness,
  type TransportMode,
} from "../../contracts/src/index.ts";
import {
  DEPARTURE_METRIC_NAME,
  DEPARTURE_ROUTE,
  createDepartureRuntimeState,
  departureHttpStatus,
  handleDepartureHttpRequest,
  handleDepartureRequest,
  type DepartureHandlerResponse,
  type DepartureMetrics,
  type DepartureResolverRequest,
  type DepartureResolverResult,
  type DepartureRuntimeState,
  type PublicDepartureData,
  type PublicDepartureError,
} from "../src/departures.ts";
import {
  PrimNormalizationError,
  buildPrimStopMonitoringUrl,
  normalizePrimDepartureResponse,
  parseRetryAfterSeconds,
  type PrimNormalizedDepartureData,
  type PrimServiceResolution,
} from "../src/prim-departures.ts";
import {
  createPrimDepartureResolver,
  createUpstreamLimiter,
  type PrimDepartureRelay,
  type PrimDepartureRelayResponse,
  type UpstreamLimiter,
} from "../src/departure-service.ts";
import type { CatalogReader, CatalogServiceResolution } from "../src/catalog.ts";
import {
  relayPrimRequest,
  type PrimFetch,
  type PrimFetchInit,
} from "../src/index.ts";

const encoder = new TextEncoder();
const KEY_A = "test-personal-key-a";
const KEY_B = "test-personal-key-b";
const KEY_C = "test-personal-key-c";
const CLOCK_MS = Date.parse("2026-01-15T09:00:00Z");
const CLOCK_SEC = CLOCK_MS / 1000;
const FETCHED_AT = Date.parse("2026-01-15T08:30:00Z") / 1000;

const sec = (iso: string): number => Date.parse(iso) / 1000;

const RESOLUTIONS = {
  BUS: {
    monitoringRef: "IDFM:SP:1001",
    lineRef: "IDFM:C1001",
    directionId: "IDFM:1001D",
    destinationRef: "IDFM:1001DST",
  },
  METRO: {
    monitoringRef: "IDFM:SP:2001",
    lineRef: "IDFM:C2001",
    directionId: "IDFM:2001D",
    destinationRef: "IDFM:2001DST",
  },
  TRAM: {
    monitoringRef: "IDFM:SP:3001",
    lineRef: "IDFM:C3001",
    directionId: "IDFM:3001D",
    destinationRef: "IDFM:3001DST",
  },
  RER: {
    monitoringRef: "IDFM:SP:4001",
    lineRef: "IDFM:C4001",
    directionId: "IDFM:4001D",
    destinationRef: "IDFM:4001DST",
  },
  TRANSILIEN: {
    monitoringRef: "IDFM:SP:5001",
    lineRef: "IDFM:C5001",
    directionId: "IDFM:5001D",
    destinationRef: "IDFM:5001DST",
  },
} as const satisfies Record<TransportMode, PrimServiceResolution>;

function expectedDeparture(
  expectedIso: string,
  minutes: number,
  status: DepartureStatus,
  options: { aimedIso?: string; interval?: number } = {},
): Departure {
  const departure: Departure = { expectedAt: sec(expectedIso), minutes, status };
  if (options.aimedIso !== undefined) departure.aimedAt = sec(options.aimedIso);
  if (options.interval !== undefined) departure.nextIntervalMinutes = options.interval;
  return departure;
}

function expectedNormalized(
  freshness: Freshness,
  departures: Departure[],
  sourceUpdatedAt: number = FETCHED_AT,
): PrimNormalizedDepartureData {
  return { schemaVersion: SCHEMA_VERSION, fetchedAt: FETCHED_AT, sourceUpdatedAt, freshness, departures };
}

const FIXTURE_CACHE = new Map<string, unknown>();

async function loadFixture(name: string): Promise<unknown> {
  const cached = FIXTURE_CACHE.get(name);
  if (cached !== undefined) return cached;
  const parsed: unknown = JSON.parse(
    await readFile(new URL(`../../../fixtures/departures/prim/${name}.json`, import.meta.url), "utf8"),
  );
  FIXTURE_CACHE.set(name, parsed);
  return parsed;
}

const MODE_FIXTURES: ReadonlyArray<{
  readonly fixture: string;
  readonly mode: TransportMode;
  readonly resolution: PrimServiceResolution;
  readonly expected: PrimNormalizedDepartureData;
}> = [
  {
    fixture: "bus",
    mode: "BUS",
    resolution: RESOLUTIONS.BUS,
    expected: expectedNormalized("REALTIME", [
      expectedDeparture("2026-01-15T08:32:00Z", 2, "ON_TIME", {
        aimedIso: "2026-01-15T08:31:00Z",
        interval: 6,
      }),
      expectedDeparture("2026-01-15T08:38:00Z", 8, "ON_TIME", {
        aimedIso: "2026-01-15T08:37:30Z",
      }),
    ]),
  },
  {
    fixture: "metro",
    mode: "METRO",
    resolution: RESOLUTIONS.METRO,
    expected: expectedNormalized("REALTIME", [
      expectedDeparture("2026-01-15T08:34:00Z", 4, "ON_TIME", {
        aimedIso: "2026-01-15T08:33:00Z",
      }),
    ]),
  },
  {
    fixture: "tram",
    mode: "TRAM",
    resolution: RESOLUTIONS.TRAM,
    expected: expectedNormalized("REALTIME", [
      expectedDeparture("2026-01-15T08:36:00Z", 6, "ON_TIME", {
        aimedIso: "2026-01-15T08:35:00Z",
      }),
    ]),
  },
  {
    fixture: "rer",
    mode: "RER",
    resolution: RESOLUTIONS.RER,
    expected: expectedNormalized("REALTIME", [
      expectedDeparture("2026-01-15T08:33:00Z", 3, "ON_TIME", {
        aimedIso: "2026-01-15T08:32:30Z",
        interval: 14,
      }),
      expectedDeparture("2026-01-15T08:47:00Z", 17, "ON_TIME", {
        aimedIso: "2026-01-15T08:45:00Z",
      }),
    ]),
  },
  {
    fixture: "transilien",
    mode: "TRANSILIEN",
    resolution: RESOLUTIONS.TRANSILIEN,
    expected: expectedNormalized("REALTIME", [
      expectedDeparture("2026-01-15T08:41:00Z", 11, "ON_TIME", {
        aimedIso: "2026-01-15T08:40:00Z",
        interval: 14,
      }),
      expectedDeparture("2026-01-15T08:55:00Z", 25, "ON_TIME", {
        aimedIso: "2026-01-15T08:54:00Z",
      }),
    ]),
  },
];

interface RecordedMetric {
  readonly name: keyof typeof DEPARTURE_METRIC_NAME;
  readonly value: number;
}

function metricsRecorder(): DepartureMetrics & {
  readonly entries: RecordedMetric[];
  count(name: keyof typeof DEPARTURE_METRIC_NAME): number;
} {
  const entries: RecordedMetric[] = [];
  return {
    entries,
    record(name, value) {
      entries.push({ name, value });
    },
    count(name) {
      return entries.filter((entry) => entry.name === name).length;
    },
  };
}

function flush(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setImmediate(resolve);
  return promise;
}

function snapshot(fetchedAt: number, sourceUpdatedAt = fetchedAt - 10): PublicDepartureData {
  return {
    schemaVersion: SCHEMA_VERSION,
    fetchedAt,
    sourceUpdatedAt,
    freshness: "REALTIME",
    departures: [
      { expectedAt: fetchedAt + 120, aimedAt: fetchedAt + 60, minutes: 2, status: "ON_TIME" },
      { expectedAt: fetchedAt + 360, minutes: 6, status: "DELAYED" },
    ],
  };
}

function errorSnapshot(
  code: ErrorCode,
  occurredAt: number,
  retryAfterSeconds?: number,
): PublicDepartureError {
  return {
    schemaVersion: SCHEMA_VERSION,
    code,
    occurredAt,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  };
}

interface HandlerCallOptions {
  readonly serviceId: string;
  readonly requestId?: string;
  readonly favoriteId?: string;
  readonly apiKey?: string;
  readonly state: DepartureRuntimeState;
  readonly resolve: (request: DepartureResolverRequest) => Promise<DepartureResolverResult>;
  readonly nowMilliseconds?: () => number;
  readonly metrics?: DepartureMetrics;
}

function requestDepartures(options: HandlerCallOptions): Promise<DepartureHandlerResponse> {
  return handleDepartureRequest(
    {
      authorization: `Bearer ${options.apiKey ?? KEY_A}`,
      body: {
        schemaVersion: SCHEMA_VERSION,
        requestId: options.requestId ?? "dep-request",
        favoriteId: options.favoriteId ?? "dep-favorite",
        serviceId: options.serviceId,
      },
    },
    {
      resolve: options.resolve,
      state: options.state,
      ...(options.nowMilliseconds === undefined ? {} : { nowMilliseconds: options.nowMilliseconds }),
      ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    },
  );
}

function expectDeparture(result: DepartureHandlerResponse): DepartureResult {
  assert.equal(isDepartureResult(result), true);
  if (!isDepartureResult(result)) assert.fail("expected a departure result");
  return result;
}

function expectError(result: DepartureHandlerResponse): ErrorResult {
  assert.equal(isErrorResult(result), true);
  if (!isErrorResult(result)) assert.fail("expected an error result");
  return result;
}

function expectResolverError(result: DepartureResolverResult): PublicDepartureError {
  if ("code" in result) return result;
  assert.fail("expected a public departure error");
}

function recordingResolver(
  produce: (request: DepartureResolverRequest, call: number) => Promise<DepartureResolverResult>,
): { readonly seen: DepartureResolverRequest[]; readonly resolve: HandlerCallOptions["resolve"] } {
  const seen: DepartureResolverRequest[] = [];
  return {
    seen,
    resolve: async (request) => {
      seen.push({ ...request });
      return produce(request, seen.length);
    },
  };
}

test("normalize maps the five deterministic mode fixtures to frozen REALTIME results", async () => {
  for (const entry of MODE_FIXTURES) {
    const result = normalizePrimDepartureResponse(
      await loadFixture(entry.fixture),
      entry.resolution,
      FETCHED_AT,
    );
    assert.deepEqual(result, entry.expected, `fixture ${entry.fixture} (${entry.mode})`);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.departures), true);
    for (const departure of result.departures) assert.equal(Object.isFrozen(departure), true);
  }
});

test("delayed fixture keeps expected and aimed distinct and computes minutes from expected", async () => {
  const result = normalizePrimDepartureResponse(
    await loadFixture("delayed"),
    RESOLUTIONS.METRO,
    FETCHED_AT,
  );
  assert.deepEqual(result, expectedNormalized("REALTIME", [
    expectedDeparture("2026-01-15T08:37:00Z", 7, "DELAYED", {
      aimedIso: "2026-01-15T08:33:00Z",
    }),
  ]));
});

test("cancelled fixture emits CANCELLED without intervals and skips it as an interval anchor", async () => {
  const result = normalizePrimDepartureResponse(
    await loadFixture("cancelled"),
    RESOLUTIONS.TRAM,
    FETCHED_AT,
  );
  assert.deepEqual(result, expectedNormalized("REALTIME", [
    expectedDeparture("2026-01-15T08:32:00Z", 2, "CANCELLED", {
      aimedIso: "2026-01-15T08:31:30Z",
    }),
    expectedDeparture("2026-01-15T08:35:00Z", 5, "ON_TIME", {
      aimedIso: "2026-01-15T08:34:30Z",
      interval: 5,
    }),
    expectedDeparture("2026-01-15T08:40:00Z", 10, "ON_TIME", {
      aimedIso: "2026-01-15T08:39:30Z",
    }),
  ]));
  assert.equal("nextIntervalMinutes" in result.departures[0]!, false);
});

test("scheduled-only fixture falls back to aimed times with SCHEDULED freshness and UNKNOWN status", async () => {
  const result = normalizePrimDepartureResponse(
    await loadFixture("scheduled-only"),
    RESOLUTIONS.TRANSILIEN,
    FETCHED_AT,
  );
  assert.deepEqual(result, expectedNormalized("SCHEDULED", [
    expectedDeparture("2026-01-15T08:44:00Z", 14, "UNKNOWN", {
      aimedIso: "2026-01-15T08:44:00Z",
      interval: 14,
    }),
    expectedDeparture("2026-01-15T08:58:00Z", 28, "UNKNOWN", {
      aimedIso: "2026-01-15T08:58:00Z",
    }),
  ]));
});

test("mixed fixture labels the result MIXED exactly when expected and aimed-only visits coexist", async () => {
  const result = normalizePrimDepartureResponse(
    await loadFixture("mixed"),
    RESOLUTIONS.RER,
    FETCHED_AT,
  );
  assert.deepEqual(result, expectedNormalized("MIXED", [
    expectedDeparture("2026-01-15T08:33:00Z", 3, "ON_TIME", {
      aimedIso: "2026-01-15T08:32:30Z",
      interval: 8,
    }),
    expectedDeparture("2026-01-15T08:41:00Z", 11, "UNKNOWN", {
      aimedIso: "2026-01-15T08:41:00Z",
      interval: 8,
    }),
    expectedDeparture("2026-01-15T08:49:00Z", 19, "ON_TIME", {
      aimedIso: "2026-01-15T08:48:00Z",
    }),
  ]));
});

test("partial fixture filters foreign stops and lines and derives sourceUpdatedAt from matched visits only", async () => {
  const result = normalizePrimDepartureResponse(
    await loadFixture("partial"),
    RESOLUTIONS.BUS,
    FETCHED_AT,
  );
  assert.deepEqual(result, expectedNormalized(
    "REALTIME",
    [
      expectedDeparture("2026-01-15T08:34:00Z", 4, "ON_TIME", {
        aimedIso: "2026-01-15T08:33:00Z",
        interval: 8,
      }),
      expectedDeparture("2026-01-15T08:42:00Z", 12, "ON_TIME"),
    ],
    sec("2026-01-15T08:29:35Z"),
  ));
  assert.equal("aimedAt" in result.departures[1]!, false);
});

test("malformed fixture without call times is rejected with a stable normalization error", async () => {
  const payload = await loadFixture("malformed");
  assert.throws(
    () => normalizePrimDepartureResponse(payload, RESOLUTIONS.METRO, FETCHED_AT),
    (error: unknown) =>
      error instanceof PrimNormalizationError
      && /ExpectedDepartureTime or AimedDepartureTime/u.test(error.message),
  );
});

test("structurally malformed responses reject with PrimNormalizationError instead of guessing", () => {
  const validVisit = {
    RecordedAtTime: "2026-01-15T08:29:45Z",
    MonitoringRef: { value: RESOLUTIONS.BUS.monitoringRef },
    MonitoredVehicleJourney: {
      LineRef: { value: RESOLUTIONS.BUS.lineRef },
      MonitoredCall: { ExpectedDepartureTime: "2026-01-15T08:32:00Z" },
    },
  };
  const envelope = (delivery: unknown) => ({
    Siri: { ServiceDelivery: { StopMonitoringDelivery: [delivery] } },
  });
  const cases: ReadonlyArray<[unknown, RegExp]> = [
    [null, /response must be a JSON object/u],
    [{}, /Siri must be an object/u],
    [{ Siri: {} }, /Siri\.ServiceDelivery must be an object/u],
    [envelope({ MonitoredStopVisit: {} }), /MonitoredStopVisit must be an array/u],
    [envelope({ MonitoredStopVisit: [{ ...validVisit, RecordedAtTime: 17 }] }), /RecordedAtTime/u],
    [envelope({ MonitoredStopVisit: [{ ...validVisit, MonitoringRef: { value: "" } }] }), /MonitoringRef/u],
    [
      envelope({ MonitoredStopVisit: [{ ...validVisit, MonitoringRef: { value: "IDFM:SP:9999" } }] }),
      /no MonitoredStopVisit matches/u,
    ],
  ];
  for (const [payload, pattern] of cases) {
    assert.throws(
      () => normalizePrimDepartureResponse(payload, RESOLUTIONS.BUS, FETCHED_AT),
      (error: unknown) => error instanceof PrimNormalizationError && pattern.test(error.message),
    );
  }
});

test("normalization accepts RFC3339 timestamps with an explicit numeric offset", () => {
  const result = normalizePrimDepartureResponse(
    {
      Siri: {
        ServiceDelivery: {
          ResponseTimestamp: "2026-01-15T09:30:00.250+01:00",
          StopMonitoringDelivery: [{
            ResponseTimestamp: "2026-01-15T09:29:58+01:00",
            MonitoredStopVisit: [{
              RecordedAtTime: "2026-01-15T09:29:45+01:00",
              MonitoringRef: { value: RESOLUTIONS.BUS.monitoringRef },
              MonitoredVehicleJourney: {
                LineRef: { value: RESOLUTIONS.BUS.lineRef },
                MonitoredCall: {
                  ExpectedDepartureTime: "2026-01-15T09:32:00.999+01:00",
                  AimedDepartureTime: "2026-01-15T09:31:00+01:00",
                  DepartureStatus: "ontime",
                },
              },
            }],
          }],
        },
      },
    },
    RESOLUTIONS.BUS,
    FETCHED_AT,
  );

  assert.deepEqual(result, expectedNormalized("REALTIME", [
    expectedDeparture("2026-01-15T08:32:00Z", 2, "ON_TIME", {
      aimedIso: "2026-01-15T08:31:00Z",
    }),
  ]));
});

test("normalization rejects timestamps without an explicit offset or with invalid components", () => {
  const payload = (timestamp: string) => ({
    Siri: {
      ServiceDelivery: {
        StopMonitoringDelivery: [{
          MonitoredStopVisit: [{
            RecordedAtTime: "2026-01-15T08:29:45Z",
            MonitoringRef: { value: RESOLUTIONS.BUS.monitoringRef },
            MonitoredVehicleJourney: {
              LineRef: { value: RESOLUTIONS.BUS.lineRef },
              MonitoredCall: { ExpectedDepartureTime: timestamp },
            },
          }],
        }],
      },
    },
  });
  const invalid = [
    "2026-01-15T08:32:00",
    "2026-02-29T08:32:00Z",
    "2026-01-15T24:00:00Z",
    "2026-01-15T08:60:00Z",
    "2026-01-15T08:32:60Z",
    "2026-01-15T08:32:00+24:00",
    "2026-01-15T08:32:00+01:60",
    "2026-01-15T08:32:00z",
    "2026-01-15T08:32:00Z\n",
    "1969-12-31T23:59:59Z",
    "2106-02-07T06:28:16Z",
  ] as const;

  for (const timestamp of invalid) {
    assert.throws(
      () => normalizePrimDepartureResponse(payload(timestamp), RESOLUTIONS.BUS, FETCHED_AT),
      (error: unknown) =>
        error instanceof PrimNormalizationError
        && /ExpectedDepartureTime is not a valid contract timestamp/u.test(error.message),
      timestamp,
    );
  }
});

test("normalization sorts by expected time and bounds results to the shared departure limit", () => {
  const visit = (expectedIso: string) => ({
    RecordedAtTime: "2026-01-15T08:29:50Z",
    MonitoringRef: { value: RESOLUTIONS.BUS.monitoringRef },
    MonitoredVehicleJourney: {
      LineRef: { value: RESOLUTIONS.BUS.lineRef },
      MonitoredCall: { ExpectedDepartureTime: expectedIso, DepartureStatus: "ontime" },
    },
  });
  const result = normalizePrimDepartureResponse(
    {
      Siri: {
        ServiceDelivery: {
          StopMonitoringDelivery: [{
            MonitoredStopVisit: ["08:40", "08:35", "08:38", "08:37", "08:36", "08:39"]
              .map((time) => visit(`2026-01-15T${time}:00Z`)),
          }],
        },
      },
    },
    RESOLUTIONS.BUS,
    FETCHED_AT,
  );
  assert.equal(result.departures.length, LIMITS.departures);
  assert.deepEqual(result.departures.map((departure) => departure.minutes), [5, 6, 7, 8]);
  assert.deepEqual(
    result.departures.slice(0, -1).map((departure) => departure.nextIntervalMinutes),
    [1, 1, 1],
  );
});

test("buildPrimStopMonitoringUrl targets the exact PRIM path with ordered MonitoringRef and LineRef", () => {
  const url = buildPrimStopMonitoringUrl(RESOLUTIONS.BUS);
  assert.equal(url.origin, PRIM_ORIGIN);
  assert.equal(url.pathname, "/marketplace/stop-monitoring");
  assert.deepEqual([...url.searchParams.keys()], ["MonitoringRef", "LineRef"]);
  assert.equal(url.searchParams.get("MonitoringRef"), RESOLUTIONS.BUS.monitoringRef);
  assert.equal(url.searchParams.get("LineRef"), RESOLUTIONS.BUS.lineRef);
  const encoded = (value: string) => encodeURIComponent(value);
  assert.equal(
    url.href,
    `${PRIM_ORIGIN}/marketplace/stop-monitoring`
      + `?MonitoringRef=${encoded(RESOLUTIONS.BUS.monitoringRef)}`
      + `&LineRef=${encoded(RESOLUTIONS.BUS.lineRef)}`,
  );
});

test("parseRetryAfterSeconds accepts only bounded non-negative integer delta-seconds", () => {
  const cases: ReadonlyArray<[unknown, number | undefined]> = [
    ["30", 30],
    ["0", 0],
    ["86400", 86_400],
    ["007", 7],
    ["86401", undefined],
    ["-5", undefined],
    ["1.5", undefined],
    ["soon", undefined],
    ["", undefined],
    [90, 90],
    [0, 0],
    [86_400, 86_400],
    [86_401, undefined],
    [-1, undefined],
    [1.5, undefined],
    [Number.NaN, undefined],
    [null, undefined],
    [undefined, undefined],
  ];
  for (const [value, expected] of cases) {
    assert.equal(parseRetryAfterSeconds(value), expected, `value ${String(value)}`);
  }
});

function catalogReader(table: Record<string, CatalogServiceResolution>): CatalogReader {
  return {
    searchPlaces: () => [],
    listServices: () => undefined,
    resolveService: (serviceId) =>
      table[serviceId] ?? { status: "UNRESOLVED", code: "INVALID_SERVICE" },
  };
}

function relayJson(payload: unknown, status = 200, retryAfter?: string): PrimDepartureRelayResponse {
  return {
    status,
    bytes: encoder.encode(JSON.stringify(payload)),
    ...(retryAfter === undefined ? {} : { retryAfter }),
  };
}

const BUS_SERVICE = "svc-bus";

function busResolver(
  relay: PrimDepartureRelay,
  options: {
    readonly limiter?: UpstreamLimiter;
    readonly metrics?: DepartureMetrics;
    readonly clock?: () => number;
  } = {},
) {
  return createPrimDepartureResolver({
    catalog: catalogReader({
      [BUS_SERVICE]: { status: "RESOLVED", ...RESOLUTIONS.BUS },
    }),
    relay,
    clock: options.clock ?? (() => CLOCK_MS),
    ...(options.metrics === undefined ? {} : { metrics: options.metrics }),
    ...(options.limiter === undefined ? {} : { limiter: options.limiter }),
  });
}

test("resolver relays the exact PRIM URL and headers and normalizes the bus fixture", async () => {
  const busFixture = await loadFixture("bus");
  const captures: Array<{ target: URL; init: PrimFetchInit }> = [];
  const fetchFake: PrimFetch = async (target, init) => {
    captures.push({ target, init });
    return {
      status: 200,
      headers: { get: () => null },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(JSON.stringify(busFixture)));
          controller.close();
        },
      }),
    };
  };
  const resolver = busResolver(({ target, apiKey }) =>
    relayPrimRequest({ target, authorization: `Bearer ${apiKey}` }, { fetch: fetchFake }));
  const result = await resolver({ serviceId: BUS_SERVICE, apiKey: KEY_A });

  assert.deepEqual(result, normalizePrimDepartureResponse(busFixture, RESOLUTIONS.BUS, CLOCK_SEC));
  assert.equal(captures.length, 1);
  const { target, init } = captures[0]!;
  assert.equal(target.href, buildPrimStopMonitoringUrl(RESOLUTIONS.BUS).href);
  assert.equal(init.method, "GET");
  assert.deepEqual(init.headers, {
    apikey: KEY_A,
    accept: "application/json",
    "accept-encoding": "gzip",
  });
  assert.equal(init.redirect, "manual");
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
});

test("resolver rejects unknown catalog services without relay or upstream metrics", async () => {
  const metrics = metricsRecorder();
  let relayCalls = 0;
  const resolver = busResolver(async () => {
    relayCalls += 1;
    return relayJson({});
  }, { metrics });
  const result = await resolver({ serviceId: "unknown-service", apiKey: KEY_A });
  assert.deepEqual(result, errorSnapshot("INVALID_SERVICE", CLOCK_SEC));
  assert.equal(relayCalls, 0);
  assert.deepEqual(metrics.entries, []);
});

test("resolver records actual upstream 401 and 403 statuses before mapping them", async () => {
  for (const status of [401, 403]) {
    const metrics = metricsRecorder();
    const resolver = busResolver(
      async () => relayJson({ message: "nope" }, status),
      { metrics },
    );
    const result = expectResolverError(
      await resolver({ serviceId: BUS_SERVICE, apiKey: KEY_A }),
    );
    assert.deepEqual(result, errorSnapshot("API_KEY_INVALID", CLOCK_SEC));
    assert.deepEqual(metrics.entries, [
      { name: DEPARTURE_METRIC_NAME.UPSTREAM_REQUEST, value: 1 },
      { name: DEPARTURE_METRIC_NAME.UPSTREAM_STATUS, value: status },
      { name: DEPARTURE_METRIC_NAME.UPSTREAM_LATENCY_MS, value: 0 },
    ]);
  }
});

test("resolver ignores metric recorder failures", async () => {
  const busFixture = await loadFixture("bus");
  let metricCalls = 0;
  const metrics: DepartureMetrics = {
    record() {
      metricCalls += 1;
      throw new Error("metric recorder unavailable");
    },
  };
  const resolver = busResolver(
    async () => relayJson(busFixture),
    { metrics },
  );

  const result = await resolver({ serviceId: BUS_SERVICE, apiKey: KEY_A });
  assert.deepEqual(result, normalizePrimDepartureResponse(busFixture, RESOLUTIONS.BUS, CLOCK_SEC));
  assert.equal(metricCalls, 3);
});

test("resolver maps 429 to RATE_LIMITED carrying only validated Retry-After values", async () => {
  const limited = expectResolverError(
    await busResolver(async () => relayJson({}, 429, "30"))({ serviceId: BUS_SERVICE, apiKey: KEY_A }),
  );
  assert.deepEqual(limited, errorSnapshot("RATE_LIMITED", CLOCK_SEC, 30));

  const unparsable = expectResolverError(
    await busResolver(async () => relayJson({}, 429, "later"))({ serviceId: BUS_SERVICE, apiKey: KEY_A }),
  );
  assert.deepEqual(Object.keys(unparsable).sort(), ["code", "occurredAt", "schemaVersion"]);

  const serverError = expectResolverError(
    await busResolver(async () => relayJson({}, 503))({ serviceId: BUS_SERVICE, apiKey: KEY_A }),
  );
  assert.deepEqual(serverError, errorSnapshot("SOURCE_UNAVAILABLE", CLOCK_SEC));
});

test("resolver maps malformed, non-UTF-8, thrown, and invalid relay results to stable errors", async () => {
  const malformed = expectResolverError(
    await busResolver(async () => relayJson(await loadFixture("malformed")))({
      serviceId: BUS_SERVICE,
      apiKey: KEY_A,
    }),
  );
  assert.deepEqual(malformed, errorSnapshot("INVALID_RESPONSE", CLOCK_SEC));

  const invalidUtf8 = expectResolverError(
    await busResolver(async () => ({ status: 200, bytes: new Uint8Array([0xff, 0xfe]) }))({
      serviceId: BUS_SERVICE,
      apiKey: KEY_A,
    }),
  );
  assert.deepEqual(invalidUtf8, errorSnapshot("INVALID_RESPONSE", CLOCK_SEC));

  const thrownMetrics = metricsRecorder();
  const thrown = expectResolverError(
    await busResolver(async () => {
      throw new Error(`relay exploded for ${KEY_A}`);
    }, { metrics: thrownMetrics })({ serviceId: BUS_SERVICE, apiKey: KEY_A }),
  );
  assert.deepEqual(thrown, errorSnapshot("SOURCE_UNAVAILABLE", CLOCK_SEC));
  assert.deepEqual(thrownMetrics.entries, [
    { name: DEPARTURE_METRIC_NAME.UPSTREAM_REQUEST, value: 1 },
    { name: DEPARTURE_METRIC_NAME.UPSTREAM_STATUS, value: 0 },
    { name: DEPARTURE_METRIC_NAME.UPSTREAM_LATENCY_MS, value: 0 },
  ]);

  const invalidEnvelope = expectResolverError(
    await busResolver(
      async () => ({ status: "200" }) as unknown as PrimDepartureRelayResponse,
    )({ serviceId: BUS_SERVICE, apiKey: KEY_A }),
  );
  assert.deepEqual(invalidEnvelope, errorSnapshot("INVALID_RESPONSE", CLOCK_SEC));
});

test("upstream limiter enforces its configured global maximum and releases queued work", async () => {
  assert.throws(() => createUpstreamLimiter(0), RangeError);
  assert.throws(() => createUpstreamLimiter(1.5), RangeError);

  const limiter = createUpstreamLimiter(3);
  let started = 0;
  let concurrent = 0;
  let peak = 0;
  const gates = Array.from({ length: 5 }, () => Promise.withResolvers<void>());
  const runs = gates.map((gate) =>
    limiter.run(async () => {
      started += 1;
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await gate.promise;
      concurrent -= 1;
      return started;
    }));

  await flush();
  assert.equal(started, 3);
  assert.equal(peak, 3);

  gates[0]!.resolve();
  await runs[0]!;
  await flush();
  assert.equal(started, 4);
  assert.equal(peak, 3);

  gates[1]!.resolve();
  gates[2]!.resolve();
  await Promise.all([runs[1]!, runs[2]!]);
  await flush();
  assert.equal(started, 5);
  assert.equal(peak, 3);

  gates[3]!.resolve();
  gates[4]!.resolve();
  assert.equal((await Promise.all(runs)).length, 5);
  assert.equal(peak, 3);
});

test("resolver metrics exclude limiter queue time and cover only active relay calls", async () => {
  const limiter = createUpstreamLimiter(1);
  const metrics = metricsRecorder();
  const response = relayJson(await loadFixture("bus"));
  let now = CLOCK_MS;
  let relayCalls = 0;
  let relayPeak = 0;
  let relayActive = 0;
  const gates = [
    Promise.withResolvers<PrimDepartureRelayResponse>(),
    Promise.withResolvers<PrimDepartureRelayResponse>(),
  ];
  const resolver = busResolver(async () => {
    relayCalls += 1;
    relayActive += 1;
    relayPeak = Math.max(relayPeak, relayActive);
    try {
      return await gates[relayCalls - 1]!.promise;
    } finally {
      relayActive -= 1;
    }
  }, { limiter, metrics, clock: () => now });

  const first = resolver({ serviceId: BUS_SERVICE, apiKey: KEY_A });
  await flush();
  assert.equal(relayCalls, 1);
  assert.equal(metrics.count(DEPARTURE_METRIC_NAME.UPSTREAM_REQUEST), 1);

  const second = resolver({ serviceId: BUS_SERVICE, apiKey: KEY_B });
  await flush();
  assert.equal(relayCalls, 1);
  assert.equal(metrics.count(DEPARTURE_METRIC_NAME.UPSTREAM_REQUEST), 1);

  now += 5_000;
  gates[0]!.resolve(response);
  const firstResult = await first;
  assert.equal(
    isDepartureResult({ ...firstResult, requestId: "probe", favoriteId: "probe" }),
    true,
  );
  await flush();
  assert.equal(relayCalls, 2);
  assert.equal(metrics.count(DEPARTURE_METRIC_NAME.UPSTREAM_REQUEST), 2);

  now += 25;
  gates[1]!.resolve(response);
  const secondResult = await second;
  assert.equal(
    isDepartureResult({ ...secondResult, requestId: "probe", favoriteId: "probe" }),
    true,
  );
  assert.equal(relayPeak, 1);
  assert.deepEqual(
    metrics.entries
      .filter((entry) => entry.name === DEPARTURE_METRIC_NAME.UPSTREAM_STATUS)
      .map((entry) => entry.value),
    [200, 200],
  );
  assert.deepEqual(
    metrics.entries
      .filter((entry) => entry.name === DEPARTURE_METRIC_NAME.UPSTREAM_LATENCY_MS)
      .map((entry) => entry.value),
    [5_000, 25],
  );
});

test("the default process limiter caps concurrent upstream calls at eight", async () => {
  const gates = Array.from({ length: 9 }, () => Promise.withResolvers<PrimDepartureRelayResponse>());
  let relayCalls = 0;
  let relayPeak = 0;
  let relayActive = 0;
  const resolver = busResolver(async () => {
    relayCalls += 1;
    relayActive += 1;
    relayPeak = Math.max(relayPeak, relayActive);
    try {
      return await gates[relayCalls - 1]!.promise;
    } finally {
      relayActive -= 1;
    }
  });

  const results = Array.from(
    { length: 9 },
    () => resolver({ serviceId: BUS_SERVICE, apiKey: KEY_A }),
  );
  await flush();
  assert.equal(relayCalls, 8);
  assert.equal(relayPeak, 8);

  const payload = relayJson(await loadFixture("bus"));
  for (const gate of gates) gate.resolve(payload);
  await Promise.all(results);
  assert.equal(relayPeak, 8);
});

test("unknown services settle INVALID_SERVICE at the handler without caching or upstream work", async () => {
  const state = createDepartureRuntimeState();
  const { seen, resolve } = recordingResolver(async () => errorSnapshot("INVALID_SERVICE", CLOCK_SEC));
  const first = expectError(await requestDepartures({
    serviceId: "ghost-service",
    requestId: "ghost-1",
    state,
    resolve,
    nowMilliseconds: () => CLOCK_MS,
  }));
  assert.deepEqual(first, {
    schemaVersion: SCHEMA_VERSION,
    requestId: "ghost-1",
    favoriteId: "dep-favorite",
    code: "INVALID_SERVICE",
    occurredAt: CLOCK_SEC,
  });
  assert.equal(seen.length, 1);
  assert.equal(state.cache.size, 0);

  await requestDepartures({ serviceId: "ghost-service", state, resolve });
  assert.equal(seen.length, 2);
});

test("cache is service-keyed, credential-free, and fresh for exactly 60 seconds with source timestamps retained", async () => {
  const state = createDepartureRuntimeState();
  let now = CLOCK_MS;
  let resolverCalls = 0;
  const snapshots = [snapshot(CLOCK_SEC), snapshot(CLOCK_SEC + 60), snapshot(CLOCK_SEC + 120)];
  const resolve = async () => {
    resolverCalls += 1;
    return snapshots[resolverCalls - 1]!;
  };
  const call = (requestId: string, apiKey: string) =>
    requestDepartures({
      serviceId: "cache-service",
      requestId,
      apiKey,
      state,
      resolve,
      nowMilliseconds: () => now,
    });

  const initial = expectDeparture(await call("cache-1", KEY_A));
  assert.equal(initial.fetchedAt, CLOCK_SEC);
  assert.equal(initial.sourceUpdatedAt, CLOCK_SEC - 10);
  assert.deepEqual([...state.cache.keys()], ["cache-service"]);
  assert.equal(JSON.stringify([...state.cache.values()]).includes(KEY_A), false);
  assert.equal(JSON.stringify([...state.cache.values()]).includes(KEY_B), false);

  now = CLOCK_MS + CACHE_FRESH_SECONDS * 1_000 - 1;
  const fresh = expectDeparture(await call("cache-2", KEY_B));
  assert.equal(resolverCalls, 1);
  assert.equal(fresh.fetchedAt, CLOCK_SEC);
  assert.equal(fresh.sourceUpdatedAt, CLOCK_SEC - 10);

  now = CLOCK_MS + CACHE_FRESH_SECONDS * 1_000;
  const expired = expectDeparture(await call("cache-3", KEY_B));
  assert.equal(resolverCalls, 2);
  assert.equal(expired.fetchedAt, CLOCK_SEC + 60);

  now = CLOCK_MS;
  const backwards = expectDeparture(await call("cache-4", KEY_B));
  assert.equal(resolverCalls, 3);
  assert.equal(backwards.fetchedAt, CLOCK_SEC + 120);
});

test("cache hits accept any syntactically valid non-empty key and never validate upstream", async () => {
  const state = createDepartureRuntimeState();
  const metrics = metricsRecorder();
  let resolverCalls = 0;
  const resolve = async () => {
    resolverCalls += 1;
    if (resolverCalls === 1) return snapshot(CLOCK_SEC);
    throw new Error(`upstream must not run for cache hits (${KEY_A})`);
  };
  await requestDepartures({
    serviceId: "warm-service",
    apiKey: KEY_A,
    state,
    resolve,
    nowMilliseconds: () => CLOCK_MS,
  });

  const hit = expectDeparture(await requestDepartures({
    serviceId: "warm-service",
    requestId: "warm-2",
    apiKey: "x",
    state,
    resolve,
    nowMilliseconds: () => CLOCK_MS,
    metrics,
  }));
  assert.equal(hit.requestId, "warm-2");
  assert.deepEqual(metrics.entries.map((entry) => entry.name).sort(), [
    DEPARTURE_METRIC_NAME.CACHE_HIT,
    DEPARTURE_METRIC_NAME.NORMALIZED_RESPONSE_BYTES,
  ]);
  const cached = state.cache.get("warm-service")!;
  assert.equal(
    metrics.entries.find((entry) => entry.name === DEPARTURE_METRIC_NAME.NORMALIZED_RESPONSE_BYTES)?.value,
    utf8Bytes(JSON.stringify(cached.data)),
  );
});

test("cache hits return fresh per-caller bindings and defensive copies", async () => {
  const state = createDepartureRuntimeState();
  const resolve = async () => snapshot(CLOCK_SEC);
  await requestDepartures({
    serviceId: "bind-service",
    apiKey: KEY_A,
    state,
    resolve,
    nowMilliseconds: () => CLOCK_MS,
  });

  const first = expectDeparture(await requestDepartures({
    serviceId: "bind-service",
    requestId: "bind-1",
    favoriteId: "fav-1",
    apiKey: KEY_A,
    state,
    resolve,
    nowMilliseconds: () => CLOCK_MS,
  }));
  const second = expectDeparture(await requestDepartures({
    serviceId: "bind-service",
    requestId: "bind-2",
    favoriteId: "fav-2",
    apiKey: KEY_B,
    state,
    resolve,
    nowMilliseconds: () => CLOCK_MS,
  }));

  assert.equal(first.requestId, "bind-1");
  assert.equal(first.favoriteId, "fav-1");
  assert.equal(second.requestId, "bind-2");
  assert.equal(second.favoriteId, "fav-2");
  assert.notEqual(first.departures, second.departures);

  first.departures[0]!.minutes = 999;
  first.departures.push({
    expectedAt: CLOCK_SEC + 999,
    minutes: 999,
    status: "CANCELLED",
  });
  assert.equal(second.departures[0]!.minutes, 2);
  assert.equal(second.departures.length, 2);
  assert.equal(state.cache.get("bind-service")!.data.departures[0]!.minutes, 2);
});

test("concurrent misses on one service single-flight upstream and bind every caller", async () => {
  const state = createDepartureRuntimeState();
  const metrics = metricsRecorder();
  const gate = Promise.withResolvers<PublicDepartureData>();
  const { seen, resolve } = recordingResolver(async () => gate.promise);

  const calls = [KEY_A, KEY_B, KEY_C].map((apiKey, index) =>
    requestDepartures({
      serviceId: "flight-service",
      requestId: `flight-${index}`,
      favoriteId: `flight-fav-${index}`,
      apiKey,
      state,
      resolve,
      nowMilliseconds: () => CLOCK_MS,
      metrics,
    }));

  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { serviceId: "flight-service", apiKey: KEY_A });
  assert.equal(state.flights.get("flight-service")?.waiters.length, 2);

  gate.resolve(snapshot(CLOCK_SEC));
  const results = await Promise.all(calls);
  results.forEach((result, index) => {
    const departure = expectDeparture(result);
    assert.equal(departure.requestId, `flight-${index}`);
    assert.equal(departure.favoriteId, `flight-fav-${index}`);
    assert.equal(departure.fetchedAt, CLOCK_SEC);
  });
  assert.equal(seen.length, 1);
  assert.equal(state.flights.size, 0);
  assert.deepEqual([...state.cache.keys()], ["flight-service"]);
  assert.equal(JSON.stringify(results).includes(KEY_A), false);
  assert.equal(JSON.stringify(results).includes(KEY_C), false);

  assert.equal(metrics.count(DEPARTURE_METRIC_NAME.CACHE_MISS), 3);
  assert.equal(metrics.count(DEPARTURE_METRIC_NAME.COALESCED_REQUEST), 2);
  assert.equal(metrics.count(DEPARTURE_METRIC_NAME.UPSTREAM_REQUEST), 0);
  assert.equal(metrics.count(DEPARTURE_METRIC_NAME.UPSTREAM_STATUS), 0);
  assert.equal(metrics.count(DEPARTURE_METRIC_NAME.UPSTREAM_LATENCY_MS), 0);
  assert.equal(metrics.count(DEPARTURE_METRIC_NAME.NORMALIZED_RESPONSE_BYTES), 3);
  for (const entry of metrics.entries) {
    assert.ok(Object.values(DEPARTURE_METRIC_NAME).includes(entry.name));
    assert.equal(JSON.stringify(entry).includes(KEY_A), false);
  }
});

test("a same-key credential failure settles the whole in-flight queue from one upstream call", async () => {
  const state = createDepartureRuntimeState();
  const gate = Promise.withResolvers<PublicDepartureError>();
  const { seen, resolve } = recordingResolver(async () => gate.promise);

  const calls = [0, 1].map((index) =>
    requestDepartures({
      serviceId: "invalid-key-service",
      requestId: `invalid-${index}`,
      favoriteId: `invalid-fav-${index}`,
      apiKey: KEY_A,
      state,
      resolve,
      nowMilliseconds: () => CLOCK_MS,
    }));

  gate.resolve(errorSnapshot("API_KEY_INVALID", CLOCK_SEC, 120));
  const results = await Promise.all(calls);
  results.forEach((result, index) => {
    assert.deepEqual(result, {
      schemaVersion: SCHEMA_VERSION,
      requestId: `invalid-${index}`,
      favoriteId: `invalid-fav-${index}`,
      code: "API_KEY_INVALID",
      occurredAt: CLOCK_SEC,
      retryAfterSeconds: 120,
    });
  });
  assert.equal(seen.length, 1);
  assert.equal(state.flights.size, 0);
  assert.equal(state.cache.size, 0);

  const again = expectError(await requestDepartures({
    serviceId: "invalid-key-service",
    requestId: "invalid-2",
    apiKey: KEY_A,
    state,
    resolve,
    nowMilliseconds: () => CLOCK_MS,
  }));
  assert.equal(again.code, "API_KEY_INVALID");
  assert.equal(seen.length, 2);
});

test("mixed-key failures settle failed-key waiters and promote exactly one different-key leader without burst", async () => {
  const state = createDepartureRuntimeState();
  const metrics = metricsRecorder();
  const gates: Array<PromiseWithResolvers<DepartureResolverResult>> = [];
  const { seen, resolve } = recordingResolver(async () => {
    const gate = Promise.withResolvers<DepartureResolverResult>();
    gates.push(gate);
    return gate.promise;
  });

  const calls = [
    { apiKey: KEY_A, requestId: "mix-a1", favoriteId: "mix-fav-a1" },
    { apiKey: KEY_A, requestId: "mix-a2", favoriteId: "mix-fav-a2" },
    { apiKey: KEY_B, requestId: "mix-b", favoriteId: "mix-fav-b" },
    { apiKey: KEY_C, requestId: "mix-c", favoriteId: "mix-fav-c" },
  ].map((input) =>
    requestDepartures({
      serviceId: "mixed-service",
      ...input,
      state,
      resolve,
      nowMilliseconds: () => CLOCK_MS,
      metrics,
    }));

  assert.equal(seen.length, 1);
  gates[0]!.resolve(errorSnapshot("API_KEY_INVALID", CLOCK_SEC));
  const [failedA1, failedA2] = await Promise.all(calls.slice(0, 2));

  assert.deepEqual(failedA1, {
    schemaVersion: SCHEMA_VERSION,
    requestId: "mix-a1",
    favoriteId: "mix-fav-a1",
    code: "API_KEY_INVALID",
    occurredAt: CLOCK_SEC,
  });
  assert.deepEqual(failedA2, {
    schemaVersion: SCHEMA_VERSION,
    requestId: "mix-a2",
    favoriteId: "mix-fav-a2",
    code: "API_KEY_INVALID",
    occurredAt: CLOCK_SEC,
  });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], { serviceId: "mixed-service", apiKey: KEY_B });
  assert.notEqual(state.flights.get("mixed-service"), undefined);

  gates[1]!.resolve(snapshot(CLOCK_SEC));
  const [promoted, coalesced] = await Promise.all(calls.slice(2));
  const promotedData = expectDeparture(promoted!);
  const coalescedData = expectDeparture(coalesced!);
  assert.equal(promotedData.requestId, "mix-b");
  assert.equal(promotedData.fetchedAt, CLOCK_SEC);
  assert.equal(coalescedData.requestId, "mix-c");
  assert.equal(coalescedData.favoriteId, "mix-fav-c");
  assert.equal(coalescedData.fetchedAt, CLOCK_SEC);

  assert.equal(seen.length, 2);
  assert.equal(seen.filter((request) => request.apiKey === KEY_A).length, 1);
  assert.equal(state.flights.size, 0);
  assert.deepEqual([...state.cache.keys()], ["mixed-service"]);
  assert.equal(metrics.count(DEPARTURE_METRIC_NAME.COALESCED_REQUEST), 3);
  assert.equal(metrics.count(DEPARTURE_METRIC_NAME.UPSTREAM_REQUEST), 0);
});

test("shared upstream failures settle every waiter with its own bound error and never cache", async () => {
  const state = createDepartureRuntimeState();
  const { seen, resolve } = recordingResolver(async () => {
    throw new Error(`upstream socket lost (${KEY_B})`);
  });
  const keys = [KEY_A, KEY_B, KEY_C];
  const results = await Promise.all(keys.map((apiKey, index) =>
    requestDepartures({
      serviceId: "down-service",
      requestId: `down-${index}`,
      apiKey,
      state,
      resolve,
      nowMilliseconds: () => CLOCK_MS,
    })));
  results.forEach((result, index) => {
    assert.deepEqual(result, {
      schemaVersion: SCHEMA_VERSION,
      requestId: `down-${index}`,
      favoriteId: "dep-favorite",
      code: "SOURCE_UNAVAILABLE",
      occurredAt: CLOCK_SEC,
    });
  });
  assert.equal(seen.length, 1);
  assert.equal(state.cache.size, 0);
  assert.equal(state.flights.size, 0);
  assert.equal(JSON.stringify(results).includes(KEY_B), false);

  const junkState = createDepartureRuntimeState();
  const junk = expectError(await requestDepartures({
    serviceId: "junk-service",
    requestId: "junk-1",
    apiKey: KEY_A,
    state: junkState,
    resolve: async () => ({ unexpected: true }) as unknown as PublicDepartureData,
    nowMilliseconds: () => CLOCK_MS,
  }));
  assert.equal(junk.code, "INVALID_RESPONSE");
  assert.equal(junkState.cache.size, 0);
});

test("departure HTTP boundary maps methods, paths, and every error code to frozen statuses", async () => {
  const route = DEPARTURE_ROUTE;
  const base = {
    state: createDepartureRuntimeState(),
    resolve: async () => snapshot(CLOCK_SEC),
    nowMilliseconds: () => CLOCK_MS,
  };
  const post = (overrides: {
    readonly method?: string;
    readonly path?: string;
    readonly authorization?: unknown;
    readonly body?: unknown;
  }) => handleDepartureHttpRequest({
    method: overrides.method ?? "POST",
    path: overrides.path ?? route,
    authorization: overrides.authorization,
    body: overrides.body ?? {
      schemaVersion: SCHEMA_VERSION,
      requestId: "http-ok",
      favoriteId: "http-fav-ok",
      serviceId: "http-service",
    },
  }, base);

  const success = await post({ authorization: `Bearer ${KEY_A}` });
  assert.equal(success.status, 200);
  assert.equal(isDepartureResult(success.body), true);

  const methodMismatch = await post({ method: "GET" });
  assert.equal(methodMismatch.status, 405);
  assert.equal(expectError(methodMismatch.body).code, "INVALID_SERVICE");

  const pathMismatch = await post({ path: "/api/departures/extra" });
  assert.equal(pathMismatch.status, 404);

  const errorCases: ReadonlyArray<{
    readonly expectedStatus: 400 | 401 | 429 | 502 | 503;
    readonly expectedCode: ErrorCode;
    readonly authorization?: unknown;
    readonly body?: unknown;
    readonly resolve: (request: DepartureResolverRequest) => Promise<DepartureResolverResult>;
  }> = [
    {
      expectedStatus: 401,
      expectedCode: "API_KEY_REQUIRED",
      resolve: base.resolve,
    },
    {
      expectedStatus: 401,
      expectedCode: "API_KEY_INVALID",
      authorization: `Token ${KEY_A}`,
      resolve: base.resolve,
    },
    {
      expectedStatus: 400,
      expectedCode: "INVALID_SERVICE",
      authorization: `Bearer ${KEY_A}`,
      body: { schemaVersion: SCHEMA_VERSION },
      resolve: base.resolve,
    },
    {
      expectedStatus: 429,
      expectedCode: "RATE_LIMITED",
      authorization: `Bearer ${KEY_A}`,
      resolve: async () => errorSnapshot("RATE_LIMITED", CLOCK_SEC, 30),
    },
    {
      expectedStatus: 503,
      expectedCode: "SOURCE_UNAVAILABLE",
      authorization: `Bearer ${KEY_A}`,
      resolve: async () => {
        throw new Error("downstream gone");
      },
    },
    {
      expectedStatus: 502,
      expectedCode: "INVALID_RESPONSE",
      authorization: `Bearer ${KEY_A}`,
      resolve: async () => ({ junk: true }) as unknown as PublicDepartureData,
    },
  ];
  for (const [index, errorCase] of errorCases.entries()) {
    const response = await handleDepartureHttpRequest({
      method: "POST",
      path: route,
      authorization: errorCase.authorization,
      body: errorCase.body ?? {
        schemaVersion: SCHEMA_VERSION,
        requestId: `http-err-${index}`,
        favoriteId: `http-fav-${index}`,
        serviceId: `http-err-service-${index}`,
      },
    }, {
      state: createDepartureRuntimeState(),
      resolve: errorCase.resolve,
      nowMilliseconds: () => CLOCK_MS,
    });
    assert.equal(response.status, errorCase.expectedStatus, `case ${errorCase.expectedCode}`);
    const body = expectError(response.body);
    assert.equal(body.code, errorCase.expectedCode);
    if (errorCase.expectedCode === "RATE_LIMITED") {
      assert.equal(body.retryAfterSeconds, 30);
    }
    assert.equal(JSON.stringify(body).includes(KEY_A), false);
  }

  const rateLimited = expectError((await handleDepartureHttpRequest({
    method: "POST",
    path: route,
    authorization: `Bearer ${KEY_A}`,
    body: {
      schemaVersion: SCHEMA_VERSION,
      requestId: "http-429",
      favoriteId: "http-fav-429",
      serviceId: "http-429-service",
    },
  }, {
    state: createDepartureRuntimeState(),
    resolve: async () => errorSnapshot("RATE_LIMITED", CLOCK_SEC, 30),
    nowMilliseconds: () => CLOCK_MS,
  })).body);
  assert.equal(departureHttpStatus(rateLimited), 429);
});

test("representative cache-hit loop keeps p95 backend latency at or below 200 ms", async () => {
  const state = createDepartureRuntimeState();
  let resolverCalls = 0;
  const resolve = async () => {
    resolverCalls += 1;
    if (resolverCalls === 1) return snapshot(CLOCK_SEC);
    throw new Error("upstream must never run in the cache-hit loop");
  };
  expectDeparture(await requestDepartures({
    serviceId: "p95-service",
    requestId: "p95-warm",
    apiKey: KEY_A,
    state,
    resolve,
  }));

  const durations: number[] = [];
  for (let index = 0; index < 1000; index += 1) {
    const startedAt = performance.now();
    const result = await requestDepartures({
      serviceId: "p95-service",
      requestId: `p95-${index}`,
      apiKey: KEY_A,
      state,
      resolve,
    });
    durations.push(performance.now() - startedAt);
    expectDeparture(result);
  }
  durations.sort((left, right) => left - right);
  const p95 = durations[Math.ceil(durations.length * 0.95) - 1]!;
  assert.ok(
    p95 <= 200,
    `cache-hit p95 ${p95.toFixed(3)}ms exceeds the 200ms budget`,
  );
});
