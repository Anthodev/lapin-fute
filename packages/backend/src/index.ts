import {
  LIMITS,
  PRIM_ORIGIN,
  isPersonalApiKey,
} from "../../contracts/src/index.ts";

export {
  CatalogManager,
  SqliteCatalogReader,
  handleCatalogRequest,
  type CatalogHandlerResponse,
  type CatalogReader,
  type CatalogServiceResolution,
} from "./catalog.ts";

export * from "./departures.ts";
export * from "./prim-departures.ts";
export * from "./departure-service.ts";
export * from "./departure-endpoint.ts";

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
  readonly headers: Readonly<{
    apikey: string;
    accept: "application/json";
    "accept-encoding": "gzip";
  }>;
  readonly redirect: "manual";
  readonly credentials: "omit";
  readonly cache: "no-store";
  readonly signal: AbortSignal;
}

export interface PrimFetchResponse {
  readonly status: number;
  readonly redirected?: boolean;
  readonly type?: string;
  readonly headers?: {
    get(name: string): string | null;
  };
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
  readonly retryAfter?: string;
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
    headers: Object.freeze({
      apikey: apiKey,
      accept: "application/json",
      "accept-encoding": "gzip",
    }),
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

  let retryAfter: string | undefined;
  if (response.headers !== undefined) {
    let value: string | null;
    try {
      value = response.headers.get("retry-after");
    } catch {
      throw new BackendBoundaryError(BACKEND_ERROR_CODE.PRIM_INVALID_RESPONSE);
    }
    if (value !== null && typeof value !== "string") {
      throw new BackendBoundaryError(BACKEND_ERROR_CODE.PRIM_INVALID_RESPONSE);
    }
    if (value !== null) retryAfter = value;
  }

  return {
    status: response.status,
    bytes: await readBoundedBody(response.body, controller),
    ...(retryAfter === undefined ? {} : { retryAfter }),
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

