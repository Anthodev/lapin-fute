import test from "node:test";
import assert from "node:assert/strict";
import {
  CACHE_FRESH_SECONDS,
  LIMITS,
  PRIM_ORIGIN,
  SCHEMA_VERSION,
  isDepartureResult,
  isErrorResult,
} from "../../contracts/src/index.ts";
import {
  BACKEND_ERROR_CODE,
  REDACTED_SECRET,
  BackendBoundaryError,
  createRedactingLogger,
  handleDepartureRequest,
  parseBearerAuthorization,
  redactError,
  redactSecrets,
  relayPrimRequest,
  type BackendErrorCode,
  type DepartureRequestBody,
  type DepartureResolverRequest,
  type PrimFetch,
  type PrimFetchInit,
  type PrimFetchResponse,
  type PublicDepartureData,
  type RelayTimer,
} from "../src/index.ts";

const encoder = new TextEncoder();
const TEST_KEY = "test-only-personal-key";
const AUTHORIZATION = `Bearer ${TEST_KEY}`;

function boundaryCode(code: BackendErrorCode): (error: unknown) => boolean {
  return (error) => {
    assert.ok(error instanceof BackendBoundaryError);
    assert.equal(error.code, code);
    return true;
  };
}

function streamedResponse(chunks: readonly Uint8Array[], status = 200): PrimFetchResponse {
  return {
    status,
    redirected: false,
    type: "basic",
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

function fullyPercentEncoded(value: string): string {
  return [...encoder.encode(value)]
    .map((byte) => `%${byte.toString(16).padStart(2, "0")}`)
    .join("");
}

function departureBody(
  requestId: string,
  favoriteId: string,
  serviceId: string,
): DepartureRequestBody {
  return { schemaVersion: SCHEMA_VERSION, requestId, favoriteId, serviceId };
}

function publicDeparture(fetchedAt = 1_788_000_000): PublicDepartureData {
  return {
    schemaVersion: SCHEMA_VERSION,
    fetchedAt,
    sourceUpdatedAt: fetchedAt - 10,
    freshness: "REALTIME",
    departures: [{
      expectedAt: fetchedAt + 120,
      aimedAt: fetchedAt + 100,
      minutes: 2,
      status: "DELAYED",
      nextIntervalMinutes: 4,
    }],
  };
}

test("Authorization parsing requires exact Bearer casing, one separator, and canonical UTF-8 bounds", () => {
  assert.equal(parseBearerAuthorization(AUTHORIZATION), TEST_KEY);

  for (const value of [
    undefined,
    null,
    "",
  ]) {
    assert.throws(
      () => parseBearerAuthorization(value),
      boundaryCode(BACKEND_ERROR_CODE.API_KEY_REQUIRED),
    );
  }

  for (const value of [
    TEST_KEY,
    `bearer ${TEST_KEY}`,
    `BEARER ${TEST_KEY}`,
    `Bearer\t${TEST_KEY}`,
    `Bearer  ${TEST_KEY}`,
    "Bearer ",
    `Bearer ${TEST_KEY}\rignored`,
    `Bearer ${TEST_KEY}\nignored`,
  ]) {
    assert.throws(
      () => parseBearerAuthorization(value),
      boundaryCode(BACKEND_ERROR_CODE.API_KEY_INVALID),
    );
  }

  const exactUtf8Limit = "é".repeat(LIMITS.apiKeyUtf8Bytes / 2);
  assert.equal(parseBearerAuthorization(`Bearer ${exactUtf8Limit}`), exactUtf8Limit);
  assert.throws(
    () => parseBearerAuthorization(`Bearer ${exactUtf8Limit}x`),
    boundaryCode(BACKEND_ERROR_CODE.API_KEY_INVALID),
  );
});

test("relay sends a GET to the canonical origin with the key only in apikey", async () => {
  let capturedTarget: URL | undefined;
  let capturedInit: PrimFetchInit | undefined;
  const fetch: PrimFetch = async (target, init) => {
    capturedTarget = target;
    capturedInit = init;
    return streamedResponse([
      Uint8Array.of(1, 2),
      Uint8Array.of(3, 4),
    ], 206);
  };

  const response = await relayPrimRequest({
    target: `${PRIM_ORIGIN}/marketplace/stop-monitoring?MonitoringRef=opaque-service-id`,
    authorization: AUTHORIZATION,
  }, { fetch });

  assert.equal(capturedTarget?.origin, PRIM_ORIGIN);
  assert.equal(capturedTarget?.href.includes(TEST_KEY), false);
  assert.deepEqual(capturedInit?.headers, { apikey: TEST_KEY });
  assert.deepEqual(Object.keys(capturedInit?.headers ?? {}), ["apikey"]);
  assert.equal(capturedInit?.method, "GET");
  assert.equal(capturedInit?.redirect, "manual");
  assert.equal(capturedInit?.credentials, "omit");
  assert.equal(capturedInit?.cache, "no-store");
  assert.ok(capturedInit?.signal instanceof AbortSignal);
  assert.equal(response.status, 206);
  assert.deepEqual([...response.bytes], [1, 2, 3, 4]);
});

test("relay rejects non-canonical origins and credential substrings at every URL encoding layer", async () => {
  let fetchCalls = 0;
  const fetch: PrimFetch = async () => {
    fetchCalls += 1;
    throw new Error("network must remain unused");
  };

  for (const target of [
    "http://prim.iledefrance-mobilites.fr/path",
    "https://prim.iledefrance-mobilites.fr.evil.example/path",
    "https://evil.example/path",
  ]) {
    await assert.rejects(
      relayPrimRequest({ target, authorization: AUTHORIZATION }, { fetch }),
      boundaryCode(BACKEND_ERROR_CODE.PRIM_ORIGIN_REJECTED),
    );
  }

  const encodedKey = fullyPercentEncoded(TEST_KEY);
  const doubleEncodedKey = encodeURIComponent(encodedKey);
  for (const target of [
    `https://${TEST_KEY}@prim.iledefrance-mobilites.fr/path`,
    `${PRIM_ORIGIN}/prefix-${TEST_KEY}-suffix`,
    `${PRIM_ORIGIN}/prefix-${encodedKey}-suffix`,
    `${PRIM_ORIGIN}/prefix-%ff${encodedKey}-suffix`,
    `${PRIM_ORIGIN}/path?value=prefix-${encodedKey}-suffix`,
    `${PRIM_ORIGIN}/path?prefix-${doubleEncodedKey}-suffix=public`,
    `${PRIM_ORIGIN}/path#prefix-${TEST_KEY}-suffix`,
    `${PRIM_ORIGIN}/path#prefix-${doubleEncodedKey}-suffix`,
    `${PRIM_ORIGIN}/path?apikey=public`,
    `${PRIM_ORIGIN}/path?%2561pikey=public`,
  ]) {
    await assert.rejects(
      relayPrimRequest({ target, authorization: AUTHORIZATION }, { fetch }),
      boundaryCode(BACKEND_ERROR_CODE.PRIM_CREDENTIAL_IN_URL),
    );
  }

  assert.equal(fetchCalls, 0);
});

test("relay enforces the canonical timeout across the injected fetch", async () => {
  let scheduledDelay: number | undefined;
  let fireTimeout: (() => void) | undefined;
  let capturedSignal: AbortSignal | undefined;
  let cleared = 0;
  const handle = {};
  const timer: RelayTimer = {
    set(callback, delayMs) {
      fireTimeout = callback;
      scheduledDelay = delayMs;
      return handle;
    },
    clear(receivedHandle) {
      assert.equal(receivedHandle, handle);
      cleared += 1;
    },
  };
  const fetch: PrimFetch = (_target, init) => {
    capturedSignal = init.signal;
    return new Promise<never>(() => undefined);
  };

  const pending = relayPrimRequest({
    target: `${PRIM_ORIGIN}/marketplace/stop-monitoring`,
    authorization: AUTHORIZATION,
  }, { fetch, timer });

  assert.equal(scheduledDelay, LIMITS.httpTimeoutMs);
  assert.ok(fireTimeout);
  fireTimeout();
  await assert.rejects(pending, boundaryCode(BACKEND_ERROR_CODE.PRIM_TIMEOUT));
  assert.equal(capturedSignal?.aborted, true);
  assert.equal(cleared, 1);
});

test("relay accepts the byte limit and aborts while streaming the first excess byte", async () => {
  const atLimit = new Uint8Array(LIMITS.httpResponseBytes);
  const accepted = await relayPrimRequest({
    target: `${PRIM_ORIGIN}/marketplace/stop-monitoring`,
    authorization: AUTHORIZATION,
  }, {
    fetch: async () => streamedResponse([atLimit]),
  });
  assert.equal(accepted.bytes.byteLength, LIMITS.httpResponseBytes);

  let cancelled = false;
  let capturedSignal: AbortSignal | undefined;
  const oversizedBody = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(LIMITS.httpResponseBytes));
      controller.enqueue(Uint8Array.of(1));
    },
    cancel() {
      cancelled = true;
    },
  });
  const fetch: PrimFetch = async (_target, init) => {
    capturedSignal = init.signal;
    return { status: 200, redirected: false, type: "basic", body: oversizedBody };
  };

  await assert.rejects(
    relayPrimRequest({
      target: `${PRIM_ORIGIN}/marketplace/stop-monitoring`,
      authorization: AUTHORIZATION,
    }, { fetch }),
    boundaryCode(BACKEND_ERROR_CODE.PRIM_RESPONSE_TOO_LARGE),
  );
  assert.equal(capturedSignal?.aborted, true);
  assert.equal(cancelled, true);
});

test("relay requests manual redirects and rejects every redirect response", async () => {
  let redirectMode: PrimFetchInit["redirect"] | undefined;
  const fetch: PrimFetch = async (_target, init) => {
    redirectMode = init.redirect;
    return streamedResponse([], 302);
  };

  await assert.rejects(
    relayPrimRequest({
      target: `${PRIM_ORIGIN}/marketplace/stop-monitoring`,
      authorization: AUTHORIZATION,
    }, { fetch }),
    boundaryCode(BACKEND_ERROR_CODE.PRIM_REDIRECT_REJECTED),
  );
  assert.equal(redirectMode, "manual");
});

test("redaction helpers scrub secrets while relay logs only a stable failure code", async () => {
  const apiKey = "fake/key + value";
  const encodedKey = encodeURIComponent(apiKey);
  const unsafe = `upstream echoed ${apiKey} and ${encodedKey}`;
  assert.equal(redactSecrets(unsafe, [apiKey]).includes(apiKey), false);
  assert.equal(redactSecrets(unsafe, [apiKey]).includes(encodedKey), false);
  assert.equal(redactError(new Error(unsafe), [apiKey]).includes(apiKey), false);

  const helperLogs: string[] = [];
  createRedactingLogger((message) => helperLogs.push(message), [apiKey])(unsafe);
  assert.equal(helperLogs.length, 1);
  assert.equal(helperLogs[0]?.includes(apiKey), false);
  assert.equal(helperLogs[0]?.includes(encodedKey), false);
  assert.equal(helperLogs[0]?.includes(REDACTED_SECRET), true);

  const relayLogs: string[] = [];
  const fetch: PrimFetch = async () => {
    throw new Error(unsafe);
  };
  let caught: unknown;
  try {
    await relayPrimRequest({
      target: `${PRIM_ORIGIN}/marketplace/stop-monitoring`,
      authorization: `Bearer ${apiKey}`,
    }, {
      fetch,
      logger(message) {
        relayLogs.push(message);
      },
    });
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof BackendBoundaryError);
  assert.equal(caught.code, BACKEND_ERROR_CODE.PRIM_REQUEST_FAILED);
  assert.equal(String(caught).includes(apiKey), false);
  assert.equal(String(caught).includes(encodedKey), false);
  assert.deepEqual(relayLogs, ["PRIM relay failed (PRIM_REQUEST_FAILED)"]);
  assert.equal(relayLogs[0]?.includes("upstream echoed"), false);
  assert.deepEqual([...encoder.encode(apiKey)].length <= LIMITS.apiKeyUtf8Bytes, true);
});

test("departure handler validates authorization and the exact companion POST body before lookup", async () => {
  const now = 1_788_000_123_000;
  const body = departureBody("route-request", "route-favorite", "route-service");
  const resolverInputs: DepartureResolverRequest[] = [];
  const dependencies = {
    nowMilliseconds: () => now,
    resolve: async (input: DepartureResolverRequest) => {
      resolverInputs.push(input);
      return publicDeparture();
    },
  };

  const missingKey = await handleDepartureRequest({
    authorization: undefined,
    body,
  }, dependencies);
  assert.equal(isErrorResult(missingKey), true);
  assert.deepEqual(missingKey, {
    schemaVersion: SCHEMA_VERSION,
    requestId: body.requestId,
    favoriteId: body.favoriteId,
    code: "API_KEY_REQUIRED",
    occurredAt: Math.floor(now / 1_000),
  });

  const invalidKey = await handleDepartureRequest({
    authorization: `bearer ${TEST_KEY}`,
    body,
  }, dependencies);
  assert.equal(isErrorResult(invalidKey), true);
  assert.equal("code" in invalidKey ? invalidKey.code : undefined, "API_KEY_INVALID");

  for (const invalidBody of [
    { ...body, schemaVersion: SCHEMA_VERSION + 1 },
    { ...body, serviceId: "" },
    { ...body, requestId: "" },
    { ...body, unexpected: true },
    null,
  ]) {
    const result = await handleDepartureRequest({
      authorization: AUTHORIZATION,
      body: invalidBody,
    }, dependencies);
    assert.equal(isErrorResult(result), true);
    assert.equal("code" in result ? result.code : undefined, "INVALID_SERVICE");
  }
  assert.equal(resolverInputs.length, 0);

  const result = await handleDepartureRequest({
    authorization: AUTHORIZATION,
    body,
  }, dependencies);
  assert.equal(isDepartureResult(result), true);
  assert.equal(result.requestId, body.requestId);
  assert.equal(result.favoriteId, body.favoriteId);
  assert.deepEqual(resolverInputs, [{ serviceId: body.serviceId, apiKey: TEST_KEY }]);
  assert.deepEqual(Object.keys(resolverInputs[0] ?? {}).sort(), ["apiKey", "serviceId"]);
  assert.equal(JSON.stringify(result).includes(TEST_KEY), false);
});

test("departure cache is process-shared, public, service-only, and expires at exactly 60 seconds", async () => {
  const baseMilliseconds = 1_788_001_000_000;
  const secondKey = "second-test-only-personal-key";
  const serviceId = "shared-cache-service";
  let now = baseMilliseconds;
  let firstResolverCalls = 0;
  let secondResolverCalls = 0;

  const first = await handleDepartureRequest({
    authorization: AUTHORIZATION,
    body: departureBody("cache-request-1", "cache-favorite-1", serviceId),
  }, {
    nowMilliseconds: () => now,
    resolve: async (input) => {
      firstResolverCalls += 1;
      assert.deepEqual(Object.keys(input).sort(), ["apiKey", "serviceId"]);
      return publicDeparture(1_788_001_000);
    },
  });
  assert.equal(isDepartureResult(first), true);
  if (!isDepartureResult(first)) assert.fail("expected a departure result");
  first.departures[0]!.minutes = 999;

  now = baseMilliseconds + CACHE_FRESH_SECONDS * 1_000 - 1;
  const cached = await handleDepartureRequest({
    authorization: `Bearer ${secondKey}`,
    body: departureBody("cache-request-2", "cache-favorite-2", serviceId),
  }, {
    nowMilliseconds: () => now,
    resolve: async () => {
      secondResolverCalls += 1;
      return publicDeparture(1_788_001_060);
    },
  });
  assert.equal(isDepartureResult(cached), true);
  if (!isDepartureResult(cached)) assert.fail("expected a cached departure result");
  assert.equal(cached.requestId, "cache-request-2");
  assert.equal(cached.favoriteId, "cache-favorite-2");
  assert.equal(cached.fetchedAt, 1_788_001_000);
  assert.equal(cached.departures[0]?.minutes, 2);
  assert.equal(firstResolverCalls, 1);
  assert.equal(secondResolverCalls, 0);
  assert.equal(JSON.stringify(cached).includes(TEST_KEY), false);
  assert.equal(JSON.stringify(cached).includes(secondKey), false);

  now = baseMilliseconds + CACHE_FRESH_SECONDS * 1_000;
  const expired = await handleDepartureRequest({
    authorization: `Bearer ${secondKey}`,
    body: departureBody("cache-request-3", "cache-favorite-3", serviceId),
  }, {
    nowMilliseconds: () => now,
    resolve: async () => {
      secondResolverCalls += 1;
      return publicDeparture(1_788_001_060);
    },
  });
  assert.equal(isDepartureResult(expired), true);
  assert.equal("fetchedAt" in expired ? expired.fetchedAt : undefined, 1_788_001_060);
  assert.equal(secondResolverCalls, 1);
});

test("departure handler rebinds stable resolver errors and never caches or exposes failures", async () => {
  const now = 1_788_002_000_000;
  const body = departureBody("error-request-1", "error-favorite-1", "error-cache-service");
  let resolverCalls = 0;
  const dependencies = {
    nowMilliseconds: () => now,
    resolve: async () => {
      resolverCalls += 1;
      if (resolverCalls === 1) {
        return {
          schemaVersion: SCHEMA_VERSION,
          code: "RATE_LIMITED" as const,
          occurredAt: 1_788_001_999,
          retryAfterSeconds: 30,
        };
      }
      return publicDeparture(1_788_002_000);
    },
  };

  const rateLimited = await handleDepartureRequest({
    authorization: AUTHORIZATION,
    body,
  }, dependencies);
  assert.equal(isErrorResult(rateLimited), true);
  assert.deepEqual(rateLimited, {
    schemaVersion: SCHEMA_VERSION,
    requestId: body.requestId,
    favoriteId: body.favoriteId,
    code: "RATE_LIMITED",
    occurredAt: 1_788_001_999,
    retryAfterSeconds: 30,
  });

  const afterError = await handleDepartureRequest({
    authorization: AUTHORIZATION,
    body: departureBody("error-request-2", "error-favorite-2", body.serviceId),
  }, dependencies);
  assert.equal(isDepartureResult(afterError), true);
  assert.equal(resolverCalls, 2);

  const thrown = await handleDepartureRequest({
    authorization: AUTHORIZATION,
    body: departureBody("throw-request", "throw-favorite", "throw-service"),
  }, {
    nowMilliseconds: () => now,
    resolve: async () => {
      throw new Error(`arbitrary upstream failure containing ${TEST_KEY}`);
    },
  });
  assert.equal(isErrorResult(thrown), true);
  assert.equal("code" in thrown ? thrown.code : undefined, "SOURCE_UNAVAILABLE");
  assert.equal(JSON.stringify(thrown).includes(TEST_KEY), false);
  assert.equal(JSON.stringify(thrown).includes("arbitrary upstream"), false);

  const malformed = await handleDepartureRequest({
    authorization: AUTHORIZATION,
    body: departureBody("malformed-request", "malformed-favorite", "malformed-service"),
  }, {
    nowMilliseconds: () => now,
    resolve: async () => ({
      ...publicDeparture(),
      requestId: "resolver-must-not-bind-callers",
    }) as unknown as PublicDepartureData,
  });
  assert.equal(isErrorResult(malformed), true);
  assert.equal("code" in malformed ? malformed.code : undefined, "INVALID_RESPONSE");
});
