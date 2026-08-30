import {
  CACHE_FRESH_SECONDS,
  LIMITS,
  PRIM_ORIGIN,
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

export const REDACTED_SECRET = "[REDACTED]" as const;

export const BACKEND_ERROR_CODE = {
  API_KEY_REQUIRED: "API_KEY_REQUIRED",
  API_KEY_INVALID: "API_KEY_INVALID",
  INVALID_PRIM_URL: "INVALID_PRIM_URL",
  PRIM_ORIGIN_REJECTED: "PRIM_ORIGIN_REJECTED",
  PRIM_CREDENTIAL_IN_URL: "PRIM_CREDENTIAL_IN_URL",
  PRIM_TIMEOUT: "PRIM_TIMEOUT",
  PRIM_REDIRECT_REJECTED: "PRIM_REDIRECT_REJECTED",
  PRIM_RESPONSE_TOO_LARGE: "PRIM_RESPONSE_TOO_LARGE",
  PRIM_INVALID_RESPONSE: "PRIM_INVALID_RESPONSE",
  PRIM_REQUEST_FAILED: "PRIM_REQUEST_FAILED",
} as const;

export type BackendErrorCode = (typeof BACKEND_ERROR_CODE)[keyof typeof BACKEND_ERROR_CODE];

const ERROR_MESSAGES: Readonly<Record<BackendErrorCode, string>> = {
  API_KEY_REQUIRED: "Authorization header is required",
  API_KEY_INVALID: "Authorization header must contain one valid Bearer credential",
  INVALID_PRIM_URL: "PRIM target URL is invalid",
  PRIM_ORIGIN_REJECTED: "PRIM target origin is not allowed",
  PRIM_CREDENTIAL_IN_URL: "PRIM credentials are forbidden in URLs",
  PRIM_TIMEOUT: `PRIM request timed out after ${LIMITS.httpTimeoutMs} ms`,
  PRIM_REDIRECT_REJECTED: "PRIM redirects are not allowed",
  PRIM_RESPONSE_TOO_LARGE: `PRIM response exceeded ${LIMITS.httpResponseBytes} bytes`,
  PRIM_INVALID_RESPONSE: "PRIM returned an invalid response",
  PRIM_REQUEST_FAILED: "PRIM request failed",
};

export class BackendBoundaryError extends Error {
  readonly code: BackendErrorCode;

  constructor(code: BackendErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "BackendBoundaryError";
    this.code = code;
  }
}

const BEARER_PREFIX = "Bearer ";

export function parseBearerAuthorization(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    throw new BackendBoundaryError(BACKEND_ERROR_CODE.API_KEY_REQUIRED);
  }

  if (
    typeof value !== "string"
    || !value.startsWith(BEARER_PREFIX)
    || value.length === BEARER_PREFIX.length
    || value.charCodeAt(BEARER_PREFIX.length) === 0x20
  ) {
    throw new BackendBoundaryError(BACKEND_ERROR_CODE.API_KEY_INVALID);
  }

  const apiKey = value.slice(BEARER_PREFIX.length);
  if (!isPersonalApiKey(apiKey)) {
    throw new BackendBoundaryError(BACKEND_ERROR_CODE.API_KEY_INVALID);
  }

  return apiKey;
}

function addEncodedVariants(variants: Set<string>, secret: string): void {
  try {
    const encoded = encodeURIComponent(secret);
    const lowerEscapes = encoded.replace(/%[0-9A-F]{2}/gu, (escape) => escape.toLowerCase());
    variants.add(encoded);
    variants.add(lowerEscapes);
    variants.add(encoded.replaceAll("%20", "+"));
    variants.add(lowerEscapes.replaceAll("%20", "+").replaceAll("%20".toLowerCase(), "+"));
  } catch {
    // encodeURIComponent rejects lone surrogates. The literal and JSON forms still get redacted.
  }

  const json = JSON.stringify(secret);
  if (json !== undefined) {
    variants.add(json.slice(1, -1));
  }
}

export function redactSecrets(value: string, secrets: readonly string[]): string {
  const variants = new Set<string>();
  for (const secret of secrets) {
    if (secret.length === 0) continue;
    variants.add(secret);
    addEncodedVariants(variants, secret);
  }

  const ordered = [...variants].filter(Boolean).sort((left, right) => right.length - left.length);
  let redacted = value;
  for (const secret of ordered) {
    redacted = redacted.split(secret).join(REDACTED_SECRET);
  }
  return redacted;
}

export function redactError(error: unknown, secrets: readonly string[]): string {
  let message = "Unknown PRIM failure";
  if (error instanceof Error) {
    message = error.message || error.name || message;
  } else if (typeof error === "string" && error.length > 0) {
    message = error;
  }
  return redactSecrets(message, secrets);
}

export type RelayLogger = (message: string) => void;

export function createRedactingLogger(
  logger: RelayLogger | undefined,
  secrets: readonly string[],
): RelayLogger {
  if (logger === undefined) return () => undefined;

  return (message) => {
    try {
      logger(redactSecrets(message, secrets));
    } catch {
      // Logging must neither expose a credential nor alter relay behavior.
    }
  };
}

export interface PrimFetchInit {
  readonly method: "GET";
  readonly headers: Readonly<{ apikey: string }>;
  readonly redirect: "manual";
  readonly credentials: "omit";
  readonly cache: "no-store";
  readonly signal: AbortSignal;
}

export interface PrimFetchResponse {
  readonly status: number;
  readonly redirected?: boolean;
  readonly type?: string;
  readonly body: ReadableStream<Uint8Array> | null;
}

export type PrimFetch = (target: URL, init: PrimFetchInit) => Promise<PrimFetchResponse>;

export interface RelayTimer {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

export interface PrimRelayDependencies {
  readonly fetch: PrimFetch;
  readonly logger?: RelayLogger;
  readonly timer?: RelayTimer;
}

export interface PrimRelayRequest {
  readonly target: string | URL;
  readonly authorization: unknown;
}

export interface PrimRelayResponse {
  readonly status: number;
  readonly bytes: Uint8Array;
}

const SYSTEM_TIMER: RelayTimer = {
  set(callback, delayMs) {
    return setTimeout(callback, delayMs);
  },
  clear(handle) {
    clearTimeout(handle as number);
  },
};

const MAX_URL_DECODE_PASSES = 4;
const PERCENT_ENCODED_BYTES = /(?:%[0-9A-Fa-f]{2})+/gu;
const URL_COMPONENT_DECODER = new TextDecoder();

function decodePercentBytes(value: string): string {
  const bytes = new Uint8Array(value.length / 3);
  for (let index = 0; index < bytes.length; index += 1) {
    const offset = index * 3;
    bytes[index] = Number.parseInt(value.slice(offset + 1, offset + 3), 16);
  }
  return URL_COMPONENT_DECODER.decode(bytes);
}

function decodePercentLayer(value: string): string {
  return value.replace(PERCENT_ENCODED_BYTES, decodePercentBytes);
}

function decodedUrlComponent(value: string): string {
  let candidate = value;
  for (let pass = 0; pass < MAX_URL_DECODE_PASSES; pass += 1) {
    const next = decodePercentLayer(candidate);
    if (next === candidate) break;
    candidate = next;
  }
  return candidate;
}

function containsDecodedSubstring(value: string, apiKey: string): boolean {
  let candidate = value;
  for (let pass = 0; pass <= MAX_URL_DECODE_PASSES; pass += 1) {
    if (candidate.includes(apiKey)) return true;
    if (pass === MAX_URL_DECODE_PASSES) break;
    const next = decodePercentLayer(candidate);
    if (next === candidate) break;
    candidate = next;
  }
  return false;
}

function containsCredential(target: URL, apiKey: string): boolean {
  if (target.username.length > 0 || target.password.length > 0) return true;

  for (const component of [target.href, target.pathname, target.search, target.hash]) {
    if (containsDecodedSubstring(component, apiKey)) return true;
  }

  for (const [name, value] of target.searchParams) {
    const normalizedName = decodedUrlComponent(name).toLowerCase();
    if (normalizedName === "apikey" || normalizedName === "authorization") return true;
    if (containsDecodedSubstring(name, apiKey) || containsDecodedSubstring(value, apiKey)) {
      return true;
    }
  }

  return false;
}

function parsePrimTarget(value: string | URL, apiKey: string): URL {
  let target: URL;
  try {
    target = new URL(value instanceof URL ? value.href : value);
  } catch {
    throw new BackendBoundaryError(BACKEND_ERROR_CODE.INVALID_PRIM_URL);
  }

  if (target.origin !== PRIM_ORIGIN) {
    throw new BackendBoundaryError(BACKEND_ERROR_CODE.PRIM_ORIGIN_REJECTED);
  }
  if (containsCredential(target, apiKey)) {
    throw new BackendBoundaryError(BACKEND_ERROR_CODE.PRIM_CREDENTIAL_IN_URL);
  }

  return target;
}

function isRedirect(response: PrimFetchResponse): boolean {
  return response.redirected === true
    || response.type === "opaqueredirect"
    || (Number.isInteger(response.status) && response.status >= 300 && response.status < 400);
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  controller: AbortController,
): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  if (typeof body.getReader !== "function") {
    throw new BackendBoundaryError(BACKEND_ERROR_CODE.PRIM_INVALID_RESPONSE);
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;

  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) {
        throw new BackendBoundaryError(BACKEND_ERROR_CODE.PRIM_INVALID_RESPONSE);
      }
      if (item.value.byteLength > LIMITS.httpResponseBytes - byteLength) {
        controller.abort();
        try {
          void reader.cancel().catch(() => undefined);
        } catch {
          // The size error remains authoritative even if cancellation fails.
        }
        throw new BackendBoundaryError(BACKEND_ERROR_CODE.PRIM_RESPONSE_TOO_LARGE);
      }
      if (item.value.byteLength === 0) continue;
      byteLength += item.value.byteLength;
      chunks.push(item.value);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed release cannot expose data and must not replace the relay result.
    }
  }

  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) {
    const onlyChunk = chunks[0];
    if (onlyChunk !== undefined) return onlyChunk;
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function performRelay(
  target: URL,
  apiKey: string,
  fetch: PrimFetch,
  controller: AbortController,
): Promise<PrimRelayResponse> {
  const response = await fetch(target, {
    method: "GET",
    headers: Object.freeze({ apikey: apiKey }),
    redirect: "manual",
    credentials: "omit",
    cache: "no-store",
    signal: controller.signal,
  });

  if (response === null || typeof response !== "object") {
    throw new BackendBoundaryError(BACKEND_ERROR_CODE.PRIM_INVALID_RESPONSE);
  }
  if (isRedirect(response)) {
    throw new BackendBoundaryError(BACKEND_ERROR_CODE.PRIM_REDIRECT_REJECTED);
  }
  if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
    throw new BackendBoundaryError(BACKEND_ERROR_CODE.PRIM_INVALID_RESPONSE);
  }

  return {
    status: response.status,
    bytes: await readBoundedBody(response.body, controller),
  };
}

export async function relayPrimRequest(
  request: PrimRelayRequest,
  dependencies: PrimRelayDependencies,
): Promise<PrimRelayResponse> {
  const apiKey = parseBearerAuthorization(request.authorization);
  const target = parsePrimTarget(request.target, apiKey);
  const controller = new AbortController();
  const timer = dependencies.timer ?? SYSTEM_TIMER;
  const log = createRedactingLogger(dependencies.logger, [apiKey]);

  let timedOut = false;
  let timerHandle: unknown;
  let timerScheduled = false;
  const timeout = new Promise<never>((_, reject) => {
    timerHandle = timer.set(() => {
      timedOut = true;
      controller.abort();
      reject(new BackendBoundaryError(BACKEND_ERROR_CODE.PRIM_TIMEOUT));
    }, LIMITS.httpTimeoutMs);
    timerScheduled = true;
  });

  try {
    return await Promise.race([
      performRelay(target, apiKey, dependencies.fetch, controller),
      timeout,
    ]);
  } catch (failure) {
    const error = failure instanceof BackendBoundaryError
      ? failure
      : new BackendBoundaryError(
        timedOut ? BACKEND_ERROR_CODE.PRIM_TIMEOUT : BACKEND_ERROR_CODE.PRIM_REQUEST_FAILED,
      );
    log(`PRIM relay failed (${error.code})`);
    throw error;
  } finally {
    if (timerScheduled) {
      try {
        timer.clear(timerHandle);
      } catch {
        // Timer cleanup cannot replace a completed relay result.
      }
    }
  }
}

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

export interface DepartureHandlerDependencies {
  readonly resolve: DepartureResolver;
  readonly nowMilliseconds?: () => number;
}

export type DepartureHandlerResponse = DepartureResult | ErrorResult;

interface DepartureBinding {
  readonly requestId: string;
  readonly favoriteId?: string;
}

interface CachedDeparture {
  readonly storedAtMilliseconds: number;
  readonly data: PublicDepartureData;
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
const DEPARTURE_CACHE = new Map<string, CachedDeparture>();

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function boundedId(value: unknown): value is string {
  return typeof value === "string"
    && utf8Bytes(value) >= 1
    && utf8Bytes(value) <= LIMITS.idUtf8Bytes;
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

function isDepartureRequestBody(value: unknown): value is DepartureRequestBody {
  if (!record(value)) return false;

  try {
    return hasOnlyKeys(value, DEPARTURE_REQUEST_KEYS)
      && value.schemaVersion === SCHEMA_VERSION
      && boundedId(value.requestId)
      && boundedId(value.favoriteId)
      && boundedId(value.serviceId);
  } catch {
    return false;
  }
}

function isPublicDepartureData(value: unknown): value is PublicDepartureData {
  if (!record(value)) return false;

  try {
    return hasOnlyKeys(value, PUBLIC_DEPARTURE_KEYS)
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
    return hasOnlyKeys(value, PUBLIC_ERROR_KEYS)
      && isErrorResult({ ...value, requestId: INVALID_REQUEST_ID });
  } catch {
    return false;
  }
}

function nowMilliseconds(dependencies: DepartureHandlerDependencies): number {
  const fallback = Date.now();
  try {
    const value = dependencies.nowMilliseconds?.() ?? fallback;
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  } catch {
    return fallback;
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

function copyDeparture(value: Departure): Departure {
  const copy: Departure = {
    expectedAt: value.expectedAt,
    minutes: value.minutes,
    status: value.status,
  };
  if (value.aimedAt !== undefined) copy.aimedAt = value.aimedAt;
  if (value.nextIntervalMinutes !== undefined) {
    copy.nextIntervalMinutes = value.nextIntervalMinutes;
  }
  return copy;
}

function normalizePublicDeparture(value: PublicDepartureData): PublicDepartureData {
  const normalized: PublicDepartureData = {
    schemaVersion: SCHEMA_VERSION,
    fetchedAt: value.fetchedAt,
    freshness: value.freshness,
    departures: value.departures.map(copyDeparture),
  };
  if (value.sourceUpdatedAt !== undefined) {
    normalized.sourceUpdatedAt = value.sourceUpdatedAt;
  }
  return normalized;
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
  if (error.retryAfterSeconds !== undefined) {
    result.retryAfterSeconds = error.retryAfterSeconds;
  }
  return result;
}

function cachedDeparture(
  serviceId: string,
  milliseconds: number,
): PublicDepartureData | undefined {
  const cached = DEPARTURE_CACHE.get(serviceId);
  if (cached === undefined) return undefined;

  const age = milliseconds - cached.storedAtMilliseconds;
  if (age < 0 || age >= DEPARTURE_CACHE_FRESH_MS) {
    DEPARTURE_CACHE.delete(serviceId);
    return undefined;
  }
  return cached.data;
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
  let apiKey: string;
  try {
    apiKey = parseBearerAuthorization(authorization);
  } catch (failure) {
    const code: ErrorCode = failure instanceof BackendBoundaryError
      && failure.code === BACKEND_ERROR_CODE.API_KEY_REQUIRED
      ? "API_KEY_REQUIRED"
      : "API_KEY_INVALID";
    return stableError(binding, code, nowMilliseconds(dependencies));
  }

  if (!isDepartureRequestBody(bodyValue)) {
    apiKey = "";
    return stableError(binding, "INVALID_SERVICE", nowMilliseconds(dependencies));
  }

  const requestBody = bodyValue;
  const currentMilliseconds = nowMilliseconds(dependencies);
  const cached = cachedDeparture(requestBody.serviceId, currentMilliseconds);
  if (cached !== undefined) {
    apiKey = "";
    const result = bindDeparture(cached, requestBody);
    return isDepartureResult(result)
      ? result
      : stableError(binding, "INVALID_RESPONSE", currentMilliseconds);
  }

  let resolved: unknown;
  try {
    resolved = await dependencies.resolve({
      serviceId: requestBody.serviceId,
      apiKey,
    });
  } catch {
    return stableError(binding, "SOURCE_UNAVAILABLE", nowMilliseconds(dependencies));
  } finally {
    apiKey = "";
  }

  if (isPublicDepartureData(resolved)) {
    const normalized = normalizePublicDeparture(resolved);
    const storedAtMilliseconds = nowMilliseconds(dependencies);
    DEPARTURE_CACHE.set(requestBody.serviceId, {
      storedAtMilliseconds,
      data: normalized,
    });
    const result = bindDeparture(normalized, requestBody);
    return isDepartureResult(result)
      ? result
      : stableError(binding, "INVALID_RESPONSE", storedAtMilliseconds);
  }

  if (isPublicDepartureError(resolved)) {
    const error = bindPublicError(resolved, requestBody);
    return isErrorResult(error)
      ? error
      : stableError(binding, "INVALID_RESPONSE", nowMilliseconds(dependencies));
  }

  return stableError(binding, "INVALID_RESPONSE", nowMilliseconds(dependencies));
}
