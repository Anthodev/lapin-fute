import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createConnection } from "node:net";
import test from "node:test";
import {
  LIMITS,
  PRIM_ORIGIN,
  SCHEMA_VERSION,
  isDepartureResult,
  isErrorResult,
  type DepartureResult,
  type ErrorResult,
} from "../../contracts/src/index.ts";
import {
  DEPARTURE_ENDPOINT_LIMITS,
  DEPARTURE_METRIC_NAME,
  DEPARTURE_ROUTE,
  createDepartureEndpoint,
  createDepartureHttpServer,
  type CatalogReader,
  type CatalogServiceResolution,
  type DepartureEndpoint,
  type DepartureEndpointBody,
  type DepartureEndpointRequest,
  type DepartureEndpointResponse,
  type DepartureMetricName,
  type DepartureMetrics,
  type PrimFetch,
  type PrimFetchInit,
  type PrimFetchResponse,
  type RelayTimer,
  type UpstreamLimiter,
} from "../src/index.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const CLOCK_MS = Date.parse("2026-01-15T08:30:00Z");
const CLOCK_SECONDS = CLOCK_MS / 1_000;
const SERVICE_ID = "svc-bus";
const KEY_A = "endpoint-personal-key-a";
const KEY_B = "endpoint-personal-key-b";
const AUTHORIZATION_A = `Bearer ${KEY_A}`;
const AUTHORIZATION_B = `Bearer ${KEY_B}`;
const BUS_FIXTURE = readFile(
  new URL("../../../fixtures/departures/prim/bus.json", import.meta.url),
);

const RESOLUTION: CatalogServiceResolution = {
  status: "RESOLVED",
  monitoringRef: "IDFM:SP:1001",
  lineRef: "IDFM:C1001",
  directionId: "IDFM:1001D",
  destinationRef: "IDFM:1001DST",
  destinationLabel: "Fixture destination",
};

interface CallCounts {
  catalog: number;
  relay: number;
}

interface RecordedMetric {
  readonly name: DepartureMetricName;
  readonly value: number;
}

function epochSeconds(value: string): number {
  return Date.parse(value) / 1_000;
}

function catalogFixture(counts: CallCounts): CatalogReader {
  return {
    searchPlaces: () => [],
    listServices: () => undefined,
    resolveService(serviceId) {
      counts.catalog += 1;
      return serviceId === SERVICE_ID
        ? RESOLUTION
        : { status: "UNRESOLVED", code: "INVALID_SERVICE" };
    },
  };
}

function metricsRecorder(): DepartureMetrics & { readonly entries: RecordedMetric[] } {
  const entries: RecordedMetric[] = [];
  return {
    entries,
    record(name, value) {
      entries.push({ name, value });
    },
  };
}

function primResponse(
  chunks: readonly Uint8Array[],
  status = 200,
  retryAfter?: string,
): PrimFetchResponse {
  return {
    status,
    headers: {
      get(name) {
        return name.toLowerCase() === "retry-after" && retryAfter !== undefined
          ? retryAfter
          : null;
      },
    },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

function requestBytes(
  requestId = "request-a",
  favoriteId = "favorite-a",
  serviceId = SERVICE_ID,
): Uint8Array {
  return encoder.encode(JSON.stringify({
    schemaVersion: SCHEMA_VERSION,
    requestId,
    favoriteId,
    serviceId,
  }));
}

function endpointRequest(
  body: DepartureEndpointBody,
  authorization = AUTHORIZATION_A,
  headers: DepartureEndpointRequest["headers"] = [["Authorization", authorization]],
): DepartureEndpointRequest {
  return {
    method: "POST",
    path: DEPARTURE_ROUTE,
    headers,
    body,
  };
}

function decodeResponse(response: DepartureEndpointResponse): DepartureResult | ErrorResult {
  assert.equal(response.headers["content-type"], "application/json");
  assert.ok(response.body instanceof Uint8Array);
  const parsed: unknown = JSON.parse(decoder.decode(response.body));
  assert.ok(isDepartureResult(parsed) || isErrorResult(parsed));
  return parsed;
}

function expectDeparture(response: DepartureEndpointResponse): DepartureResult {
  const parsed = decodeResponse(response);
  assert.equal(isDepartureResult(parsed), true);
  if (!isDepartureResult(parsed)) assert.fail("expected a departure result");
  return parsed;
}

function expectError(response: DepartureEndpointResponse): ErrorResult {
  const parsed = decodeResponse(response);
  assert.equal(isErrorResult(parsed), true);
  if (!isErrorResult(parsed)) assert.fail("expected an error result");
  return parsed;
}

function rawReadable(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function rawAsyncIterable(
  chunks: readonly Uint8Array[],
  closed?: () => void,
): AsyncIterable<Uint8Array> {
  return {
    [Symbol.asyncIterator]() {
      let index = 0;
      return {
        async next() {
          const value = chunks[index];
          index += 1;
          return value === undefined
            ? { done: true as const, value: undefined }
            : { done: false as const, value };
        },
        async return() {
          closed?.();
          return { done: true as const, value: undefined };
        },
      };
    },
  };
}

function successfulEndpoint(
  fixture: Uint8Array,
  counts: CallCounts,
): DepartureEndpoint {
  const fetch: PrimFetch = async () => {
    counts.relay += 1;
    return primResponse([fixture]);
  };
  return createDepartureEndpoint({
    catalog: catalogFixture(counts),
    fetch,
    clock: () => CLOCK_MS,
  });
}

function totalHeaderBytes(headers: DepartureEndpointRequest["headers"]): number {
  return headers.reduce(
    (total, [name, value]) =>
      total + encoder.encode(name).byteLength + 2 + encoder.encode(value).byteLength + 2,
    2,
  );
}

interface HttpResponseCapture {
  readonly status: number;
  readonly contentType: string | string[] | undefined;
  readonly body: Uint8Array;
}

function postOverHttp(
  port: number,
  body: Uint8Array,
  headers: Readonly<Record<string, string | string[]>>,
): Promise<HttpResponseCapture> {
  const { promise, resolve, reject } = Promise.withResolvers<HttpResponseCapture>();
  const request = httpRequest({
    host: "127.0.0.1",
    port,
    method: "POST",
    path: DEPARTURE_ROUTE,
    headers,
  }, (response) => {
    const chunks: Uint8Array[] = [];
    let byteLength = 0;
    response.on("data", (chunk: Uint8Array) => {
      chunks.push(chunk);
      byteLength += chunk.byteLength;
    });
    response.once("error", reject);
    response.once("end", () => {
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve({
        status: response.statusCode ?? 0,
        contentType: response.headers["content-type"],
        body: bytes,
      });
    });
  });
  request.once("error", reject);
  request.end(body);
  return promise;
}

function rawPersistentRequest(port: number, requestText: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const socket = createConnection({ host: "127.0.0.1", port });
  let responseText = "";
  let settled = false;
  const fail = (error: Error) => {
    if (settled) return;
    settled = true;
    socket.destroy();
    reject(error);
  };

  socket.setEncoding("latin1");
  // A protocol regression leaves this real socket open, so an event alone cannot bound the test.
  socket.setTimeout(1_000, () => {
    fail(new Error("raw HTTP connection did not close"));
  });
  socket.on("data", (chunk: string) => {
    responseText += chunk;
  });
  socket.once("connect", () => {
    socket.write(requestText);
  });
  socket.once("error", fail);
  socket.once("close", () => {
    if (settled) return;
    settled = true;
    resolve(responseText);
  });
  return promise;
}

test("production endpoint composes catalog, bounded relay, normalization, binding, and shared cache", async () => {
  const fixture = new Uint8Array(await BUS_FIXTURE);
  const counts: CallCounts = { catalog: 0, relay: 0 };
  const metrics = metricsRecorder();
  const captures: Array<{ readonly target: URL; readonly init: PrimFetchInit }> = [];
  const logs: string[] = [];
  let timerSets = 0;
  let timerClears = 0;
  let limiterRuns = 0;
  const timerHandle = Object.freeze({ timer: "endpoint" });
  const timer: RelayTimer = {
    set(_callback, delayMs) {
      assert.equal(delayMs, LIMITS.httpTimeoutMs);
      timerSets += 1;
      return timerHandle;
    },
    clear(handle) {
      assert.equal(handle, timerHandle);
      timerClears += 1;
    },
  };
  const limiter: UpstreamLimiter = {
    async run<T>(operation: () => Promise<T>): Promise<T> {
      limiterRuns += 1;
      return operation();
    },
  };
  const fetch: PrimFetch = async (target, init) => {
    counts.relay += 1;
    captures.push({ target, init });
    const midpoint = Math.floor(fixture.byteLength / 2);
    return primResponse([fixture.subarray(0, midpoint), fixture.subarray(midpoint)]);
  };
  const endpoint = createDepartureEndpoint({
    catalog: catalogFixture(counts),
    fetch,
    metrics,
    clock: () => CLOCK_MS,
    timer,
    limiter,
    logger(message) {
      logs.push(message);
    },
  });

  const firstBytes = requestBytes();
  const midpoint = Math.floor(firstBytes.byteLength / 2);
  const firstResponse = await endpoint(endpointRequest(rawReadable([
    firstBytes.subarray(0, midpoint),
    firstBytes.subarray(midpoint),
  ])));
  assert.equal(firstResponse.status, 200);
  assert.deepEqual(expectDeparture(firstResponse), {
    schemaVersion: SCHEMA_VERSION,
    requestId: "request-a",
    favoriteId: "favorite-a",
    fetchedAt: CLOCK_SECONDS,
    sourceUpdatedAt: CLOCK_SECONDS,
    freshness: "REALTIME",
    departures: [
      {
        expectedAt: epochSeconds("2026-01-15T08:32:00Z"),
        aimedAt: epochSeconds("2026-01-15T08:31:00Z"),
        minutes: 2,
        status: "ON_TIME",
        nextIntervalMinutes: 6,
      },
      {
        expectedAt: epochSeconds("2026-01-15T08:38:00Z"),
        aimedAt: epochSeconds("2026-01-15T08:37:30Z"),
        minutes: 8,
        status: "ON_TIME",
      },
    ],
  });

  assert.equal(counts.catalog, 1);
  assert.equal(counts.relay, 1);
  assert.equal(limiterRuns, 1);
  assert.equal(timerSets, 1);
  assert.equal(timerClears, 1);
  assert.deepEqual(logs, []);
  assert.equal(captures.length, 1);
  const firstRelay = captures[0]!;
  assert.equal(firstRelay.target.origin, PRIM_ORIGIN);
  assert.equal(firstRelay.target.hostname, "prim.iledefrance-mobilites.fr");
  assert.equal(firstRelay.target.pathname, "/marketplace/stop-monitoring");
  assert.deepEqual([...firstRelay.target.searchParams], [
    ["MonitoringRef", RESOLUTION.monitoringRef],
    ["LineRef", RESOLUTION.lineRef],
  ]);
  assert.equal(firstRelay.target.href.includes(KEY_A), false);
  assert.equal(firstRelay.init.method, "GET");
  assert.deepEqual(firstRelay.init.headers, {
    apikey: KEY_A,
    accept: "application/json",
    "accept-encoding": "gzip",
  });
  assert.deepEqual(Object.keys(firstRelay.init.headers), ["apikey", "accept", "accept-encoding"]);
  assert.equal(firstRelay.init.redirect, "manual");
  assert.equal(firstRelay.init.credentials, "omit");
  assert.equal(firstRelay.init.cache, "no-store");

  const secondResponse = await endpoint(endpointRequest(
    rawAsyncIterable([requestBytes("request-b", "favorite-b")]),
    AUTHORIZATION_B,
    [["aUtHoRiZaTiOn", AUTHORIZATION_B]],
  ));
  assert.equal(secondResponse.status, 200);
  const second = expectDeparture(secondResponse);
  assert.equal(second.requestId, "request-b");
  assert.equal(second.favoriteId, "favorite-b");
  assert.equal(counts.catalog, 1);
  assert.equal(counts.relay, 1);
  assert.equal(limiterRuns, 1);
  assert.equal(timerSets, 1);
  assert.equal(timerClears, 1);

  const metricNames = metrics.entries.map(({ name }) => name);
  assert.ok(metricNames.includes(DEPARTURE_METRIC_NAME.CACHE_MISS));
  assert.ok(metricNames.includes(DEPARTURE_METRIC_NAME.CACHE_HIT));
  assert.ok(metricNames.includes(DEPARTURE_METRIC_NAME.UPSTREAM_REQUEST));
  assert.ok(metricNames.includes(DEPARTURE_METRIC_NAME.UPSTREAM_STATUS));
  assert.ok(metricNames.includes(DEPARTURE_METRIC_NAME.UPSTREAM_LATENCY_MS));
  assert.ok(metricNames.includes(DEPARTURE_METRIC_NAME.NORMALIZED_RESPONSE_BYTES));
  assert.deepEqual(
    metrics.entries
      .filter(({ name }) => name === DEPARTURE_METRIC_NAME.UPSTREAM_STATUS)
      .map(({ value }) => value),
    [200],
  );

  for (const secret of [KEY_A, KEY_B, AUTHORIZATION_A, AUTHORIZATION_B]) {
    assert.equal(decoder.decode(firstResponse.body).includes(secret), false);
    assert.equal(decoder.decode(secondResponse.body).includes(secret), false);
    assert.equal(JSON.stringify(metrics.entries).includes(secret), false);
    assert.equal(JSON.stringify(logs).includes(secret), false);
  }
  assert.deepEqual(Object.keys(endpoint), []);
});

test("endpoint maps actual PRIM 401, 403, and 429 responses through JSON errors", async () => {
  const fixture = new Uint8Array(await BUS_FIXTURE);
  for (const status of [401, 403, 429] as const) {
    const counts: CallCounts = { catalog: 0, relay: 0 };
    const metrics = metricsRecorder();
    const fetch: PrimFetch = async () => {
      counts.relay += 1;
      return primResponse([fixture], status, status === 429 ? "37" : undefined);
    };
    const endpoint = createDepartureEndpoint({
      catalog: catalogFixture(counts),
      fetch,
      metrics,
      clock: () => CLOCK_MS,
    });

    const response = await endpoint(endpointRequest(requestBytes()));
    const error = expectError(response);
    assert.equal(response.status, status === 429 ? 429 : 401);
    assert.equal(error.code, status === 429 ? "RATE_LIMITED" : "API_KEY_INVALID");
    assert.equal(error.requestId, "request-a");
    assert.equal(error.favoriteId, "favorite-a");
    assert.equal(error.occurredAt, CLOCK_SECONDS);
    assert.equal(error.retryAfterSeconds, status === 429 ? 37 : undefined);
    assert.equal(counts.catalog, 1);
    assert.equal(counts.relay, 1);
    assert.deepEqual(
      metrics.entries
        .filter(({ name }) => name === DEPARTURE_METRIC_NAME.UPSTREAM_STATUS)
        .map(({ value }) => value),
      [status],
    );
    assert.equal(decoder.decode(response.body).includes(KEY_A), false);
    assert.equal(JSON.stringify(metrics.entries).includes(KEY_A), false);
  }
});

test("request body and total headers accept the exact byte limit and reject one byte more", async () => {
  const fixture = new Uint8Array(await BUS_FIXTURE);
  const compact = requestBytes();
  const bodyPadding = DEPARTURE_ENDPOINT_LIMITS.requestBodyBytes - compact.byteLength;
  assert.ok(bodyPadding >= 0);
  const exactBody = encoder.encode(`${decoder.decode(compact)}${" ".repeat(bodyPadding)}`);
  assert.equal(exactBody.byteLength, DEPARTURE_ENDPOINT_LIMITS.requestBodyBytes);

  const exactBodyCounts: CallCounts = { catalog: 0, relay: 0 };
  const exactBodyEndpoint = successfulEndpoint(fixture, exactBodyCounts);
  const exactBodyResponse = await exactBodyEndpoint(endpointRequest(
    exactBody,
    AUTHORIZATION_A,
    [
      ["Authorization", AUTHORIZATION_A],
      ["Content-Length", String(exactBody.byteLength)],
    ],
  ));
  assert.equal(exactBodyResponse.status, 200);
  assert.equal(exactBodyCounts.catalog, 1);
  assert.equal(exactBodyCounts.relay, 1);

  const oversizedBodyCounts: CallCounts = { catalog: 0, relay: 0 };
  const oversizedBodyEndpoint = successfulEndpoint(fixture, oversizedBodyCounts);
  const oversizedBody = new Uint8Array(DEPARTURE_ENDPOINT_LIMITS.requestBodyBytes + 1);
  const oversizedBodyResponse = await oversizedBodyEndpoint(endpointRequest(oversizedBody));
  assert.equal(oversizedBodyResponse.status, 400);
  assert.equal(expectError(oversizedBodyResponse).code, "INVALID_SERVICE");
  assert.deepEqual(oversizedBodyCounts, { catalog: 0, relay: 0 });

  const baseHeaders = [["Authorization", AUTHORIZATION_A]] as const;
  const paddingName = "X-Padding";
  const paddingLength = DEPARTURE_ENDPOINT_LIMITS.totalHeaderBytes
    - totalHeaderBytes([...baseHeaders, [paddingName, ""]]);
  assert.ok(paddingLength >= 0);
  const exactHeaders = [
    ...baseHeaders,
    [paddingName, "x".repeat(paddingLength)] as const,
  ];
  assert.equal(totalHeaderBytes(exactHeaders), DEPARTURE_ENDPOINT_LIMITS.totalHeaderBytes);

  const exactHeaderCounts: CallCounts = { catalog: 0, relay: 0 };
  const exactHeaderEndpoint = successfulEndpoint(fixture, exactHeaderCounts);
  const exactHeaderResponse = await exactHeaderEndpoint(endpointRequest(
    compact,
    AUTHORIZATION_A,
    exactHeaders,
  ));
  assert.equal(exactHeaderResponse.status, 200);
  assert.deepEqual(exactHeaderCounts, { catalog: 1, relay: 1 });

  const oversizedHeaderCounts: CallCounts = { catalog: 0, relay: 0 };
  const oversizedHeaderEndpoint = successfulEndpoint(fixture, oversizedHeaderCounts);
  const oversizedHeaders = [
    ...baseHeaders,
    [paddingName, "x".repeat(paddingLength + 1)] as const,
  ];
  assert.equal(
    totalHeaderBytes(oversizedHeaders),
    DEPARTURE_ENDPOINT_LIMITS.totalHeaderBytes + 1,
  );
  const oversizedHeaderResponse = await oversizedHeaderEndpoint(endpointRequest(
    compact,
    AUTHORIZATION_A,
    oversizedHeaders,
  ));
  assert.equal(oversizedHeaderResponse.status, 400);
  assert.equal(expectError(oversizedHeaderResponse).requestId, "invalid-request");
  assert.deepEqual(oversizedHeaderCounts, { catalog: 0, relay: 0 });

  const manySmallHeaderCounts: CallCounts = { catalog: 0, relay: 0 };
  const manySmallHeaders = [
    ...baseHeaders,
    ...Array.from(
      { length: 300 },
      (_, index) => [`X-${index % 10}`, ""] as const,
    ),
  ];
  const nameAndValueBytes = manySmallHeaders.reduce(
    (total, [name, value]) =>
      total + encoder.encode(name).byteLength + encoder.encode(value).byteLength,
    0,
  );
  assert.ok(nameAndValueBytes < DEPARTURE_ENDPOINT_LIMITS.totalHeaderBytes);
  assert.ok(totalHeaderBytes(manySmallHeaders) > DEPARTURE_ENDPOINT_LIMITS.totalHeaderBytes);
  const manySmallHeaderResponse = await successfulEndpoint(
    fixture,
    manySmallHeaderCounts,
  )(endpointRequest(compact, AUTHORIZATION_A, manySmallHeaders));
  assert.equal(manySmallHeaderResponse.status, 400);
  assert.deepEqual(manySmallHeaderCounts, { catalog: 0, relay: 0 });
});

test("Content-Length is strict, bounded before body access, and must match actual bytes", async () => {
  const fixture = new Uint8Array(await BUS_FIXTURE);
  const body = requestBytes();

  for (const headers of [
    [["Authorization", AUTHORIZATION_A], ["Content-Length", "12x"]],
    [["Authorization", AUTHORIZATION_A], ["Content-Length", "1"], ["content-length", "1"]],
  ] as const) {
    const counts: CallCounts = { catalog: 0, relay: 0 };
    let iterated = false;
    const lazyBody: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        iterated = true;
        return rawAsyncIterable([body])[Symbol.asyncIterator]();
      },
    };
    const response = await successfulEndpoint(fixture, counts)(endpointRequest(
      lazyBody,
      AUTHORIZATION_A,
      headers,
    ));
    assert.equal(response.status, 400);
    assert.equal(iterated, false);
    assert.deepEqual(counts, { catalog: 0, relay: 0 });
  }

  const overLimitCounts: CallCounts = { catalog: 0, relay: 0 };
  let overLimitIterated = false;
  const overLimitBody: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]() {
      overLimitIterated = true;
      return rawAsyncIterable([body])[Symbol.asyncIterator]();
    },
  };
  const overLimitResponse = await successfulEndpoint(fixture, overLimitCounts)(endpointRequest(
    overLimitBody,
    AUTHORIZATION_A,
    [
      ["Authorization", AUTHORIZATION_A],
      ["Content-Length", String(DEPARTURE_ENDPOINT_LIMITS.requestBodyBytes + 1)],
    ],
  ));
  assert.equal(overLimitResponse.status, 400);
  assert.equal(overLimitIterated, false);
  assert.deepEqual(overLimitCounts, { catalog: 0, relay: 0 });

  for (const declared of [body.byteLength - 1, body.byteLength + 1]) {
    const counts: CallCounts = { catalog: 0, relay: 0 };
    const response = await successfulEndpoint(fixture, counts)(endpointRequest(
      body,
      AUTHORIZATION_A,
      [
        ["Authorization", AUTHORIZATION_A],
        ["Content-Length", String(declared)],
      ],
    ));
    assert.equal(response.status, 400);
    assert.deepEqual(counts, { catalog: 0, relay: 0 });
  }
});

test("overflowing streamed bodies are cancelled before JSON parsing or resolution", async () => {
  const fixture = new Uint8Array(await BUS_FIXTURE);
  const fullChunk = new Uint8Array(DEPARTURE_ENDPOINT_LIMITS.requestBodyBytes);

  const streamCounts: CallCounts = { catalog: 0, relay: 0 };
  let streamCancelled = false;
  const overflowingStream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(fullChunk);
      controller.enqueue(Uint8Array.of(1));
    },
    cancel() {
      streamCancelled = true;
    },
  });
  const streamResponse = await successfulEndpoint(fixture, streamCounts)(
    endpointRequest(overflowingStream),
  );
  assert.equal(streamResponse.status, 400);
  assert.equal(streamCancelled, true);
  assert.deepEqual(streamCounts, { catalog: 0, relay: 0 });

  const iterableCounts: CallCounts = { catalog: 0, relay: 0 };
  let iteratorClosed = false;
  const iterableResponse = await successfulEndpoint(fixture, iterableCounts)(endpointRequest(
    rawAsyncIterable([fullChunk, Uint8Array.of(1)], () => {
      iteratorClosed = true;
    }),
  ));
  assert.equal(iterableResponse.status, 400);
  assert.equal(iteratorClosed, true);
  assert.deepEqual(iterableCounts, { catalog: 0, relay: 0 });
});

test("fatal UTF-8, JSON syntax, and duplicate or malformed Authorization reject without resolution", async () => {
  const fixture = new Uint8Array(await BUS_FIXTURE);
  const cases: ReadonlyArray<{
    readonly body: DepartureEndpointBody;
    readonly headers: DepartureEndpointRequest["headers"];
    readonly status: 400 | 401;
    readonly code: "INVALID_SERVICE" | "API_KEY_INVALID";
  }> = [
    {
      body: Uint8Array.of(0xc3, 0x28),
      headers: [["Authorization", AUTHORIZATION_A]],
      status: 400,
      code: "INVALID_SERVICE",
    },
    {
      body: encoder.encode("{\"schemaVersion\":"),
      headers: [["Authorization", AUTHORIZATION_A]],
      status: 400,
      code: "INVALID_SERVICE",
    },
    {
      body: requestBytes(),
      headers: [
        ["Authorization", AUTHORIZATION_A],
        ["authorization", AUTHORIZATION_A],
      ],
      status: 401,
      code: "API_KEY_INVALID",
    },
    {
      body: requestBytes(),
      headers: [["Authorization", `bearer ${KEY_A}`]],
      status: 401,
      code: "API_KEY_INVALID",
    },
  ];

  for (const fixtureCase of cases) {
    const counts: CallCounts = { catalog: 0, relay: 0 };
    const response = await successfulEndpoint(fixture, counts)({
      method: "POST",
      path: DEPARTURE_ROUTE,
      headers: fixtureCase.headers,
      body: fixtureCase.body,
    });
    assert.equal(response.status, fixtureCase.status);
    assert.equal(expectError(response).code, fixtureCase.code);
    assert.deepEqual(counts, { catalog: 0, relay: 0 });
  }
});

test("endpoint preserves the domain handler's exact path and POST status semantics", async () => {
  const fixture = new Uint8Array(await BUS_FIXTURE);
  const cases = [
    { method: "POST", path: `${DEPARTURE_ROUTE}/`, status: 404 },
    { method: "GET", path: DEPARTURE_ROUTE, status: 405 },
    { method: "post", path: DEPARTURE_ROUTE, status: 405 },
  ] as const;

  for (const fixtureCase of cases) {
    const counts: CallCounts = { catalog: 0, relay: 0 };
    const endpoint = successfulEndpoint(fixture, counts);
    const response = await endpoint({
      method: fixtureCase.method,
      path: fixtureCase.path,
      headers: [["Authorization", AUTHORIZATION_A]],
      body: requestBytes(),
    });
    assert.equal(response.status, fixtureCase.status);
    assert.equal(expectError(response).code, "INVALID_SERVICE");
    assert.deepEqual(counts, { catalog: 0, relay: 0 });
  }
});

test("node:http adapter registers the real POST route and preserves duplicate headers", async () => {
  const fixture = new Uint8Array(await BUS_FIXTURE);
  const counts: CallCounts = { catalog: 0, relay: 0 };
  const fetch: PrimFetch = async () => {
    counts.relay += 1;
    return primResponse([fixture]);
  };
  const server = createDepartureHttpServer({
    catalog: catalogFixture(counts),
    fetch,
    clock: () => CLOCK_MS,
  });
  assert.equal(server.listening, false);

  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  try {
    const address = server.address();
    assert.ok(address !== null && typeof address === "object");
    const firstBody = requestBytes("http-request-a", "http-favorite-a");
    const first = await postOverHttp(address.port, firstBody, {
      Authorization: AUTHORIZATION_A,
      "Content-Length": String(firstBody.byteLength),
    });
    assert.equal(first.status, 200, decoder.decode(first.body));
    assert.equal(first.contentType, "application/json");
    const firstResult: unknown = JSON.parse(decoder.decode(first.body));
    assert.equal(isDepartureResult(firstResult), true);
    if (!isDepartureResult(firstResult)) assert.fail("expected HTTP departure result");
    assert.equal(firstResult.requestId, "http-request-a");
    assert.equal(firstResult.favoriteId, "http-favorite-a");
    assert.equal(counts.catalog, 1);
    assert.equal(counts.relay, 1);

    const duplicateBody = requestBytes("http-request-b", "http-favorite-b");
    const duplicate = await postOverHttp(address.port, duplicateBody, {
      Authorization: [AUTHORIZATION_B, AUTHORIZATION_B],
      "Content-Length": String(duplicateBody.byteLength),
    });
    assert.equal(duplicate.status, 401);
    assert.equal(duplicate.contentType, "application/json");
    const duplicateResult: unknown = JSON.parse(decoder.decode(duplicate.body));
    assert.equal(isErrorResult(duplicateResult), true);
    if (!isErrorResult(duplicateResult)) assert.fail("expected duplicate-header error");
    assert.equal(duplicateResult.code, "API_KEY_INVALID");
    assert.equal(duplicateResult.requestId, "http-request-b");
    assert.equal(duplicateResult.favoriteId, "http-favorite-b");
    assert.equal(counts.catalog, 1);
    assert.equal(counts.relay, 1);
    const oversizedResponse = await rawPersistentRequest(
      address.port,
      `POST ${DEPARTURE_ROUTE} HTTP/1.1\r\n`
      + `Host: 127.0.0.1:${address.port}\r\n`
      + `Authorization: ${AUTHORIZATION_A}\r\n`
      + `Content-Length: ${DEPARTURE_ENDPOINT_LIMITS.requestBodyBytes + 1}\r\n`
      + "Expect: 100-continue\r\n"
      + "Connection: keep-alive\r\n\r\n",
    );
    assert.match(oversizedResponse, /^HTTP\/1\.1 400 Bad Request\r\n/u);
    assert.equal(oversizedResponse.includes("100 Continue"), false);
    assert.match(oversizedResponse.toLowerCase(), /\r\nconnection: close\r\n/u);
    assert.match(oversizedResponse, /"code":"INVALID_SERVICE"/u);
    assert.equal(counts.catalog, 1);
    assert.equal(counts.relay, 1);
  } finally {
    const closed = once(server, "close");
    server.close();
    await closed;
  }
});
