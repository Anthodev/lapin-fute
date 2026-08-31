import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  SCHEMA_VERSION,
  utf8Bytes,
  type ErrorResult,
  type ErrorCode,
} from "../../contracts/src/index.ts";
import type { CatalogReader } from "./catalog.ts";
import {
  createPrimDepartureResolver,
  type PrimDepartureRelayRequest,
  type UpstreamLimiter,
} from "./departure-service.ts";
import {
  createDepartureRuntimeState,
  handleDepartureHttpRequest,
  type DepartureClock,
  type DepartureHandlerDependencies,
  type DepartureHttpStatus,
  type DepartureMetrics,
} from "./departures.ts";
import {
  relayPrimRequest,
  type PrimFetch,
  type PrimRelayDependencies,
  type RelayLogger,
  type RelayTimer,
} from "./index.ts";

export const DEPARTURE_ENDPOINT_LIMITS = Object.freeze({
  requestBodyBytes: 2_048,
  totalHeaderBytes: 2_048,
} as const);

export type DepartureRawHeader = readonly [name: string, value: string];

export type DepartureEndpointBody =
  | Uint8Array
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

export interface DepartureEndpointRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: readonly DepartureRawHeader[];
  readonly body: DepartureEndpointBody;
}

export interface DepartureEndpointResponse {
  readonly status: DepartureHttpStatus;
  readonly headers: Readonly<{ "content-type": "application/json" }>;
  readonly body: Uint8Array;
}

export interface DepartureEndpointDependencies {
  readonly catalog: CatalogReader;
  readonly fetch: PrimFetch;
  readonly metrics?: DepartureMetrics;
  readonly clock?: DepartureClock;
  readonly timer?: RelayTimer;
  readonly logger?: RelayLogger;
  readonly limiter?: UpstreamLimiter;
}

export type DepartureEndpoint = (
  request: DepartureEndpointRequest,
) => Promise<DepartureEndpointResponse>;

interface ParsedHeaders {
  readonly authorization: unknown;
  readonly contentLength?: number;
}

const JSON_HEADERS = Object.freeze({ "content-type": "application/json" } as const);
const JSON_ENCODER = new TextEncoder();
const JSON_DECODER = new TextDecoder("utf-8", { fatal: true });
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const CONTENT_LENGTH = /^[0-9]+$/u;
const INVALID_AUTHORIZATION = Symbol("invalid-authorization");
const INVALID_REQUEST_ID = "invalid-request";
const UINT32_MAX = 0xffff_ffff;

function safeNowMilliseconds(clock: DepartureClock | undefined): number {
  try {
    const value = clock?.() ?? Date.now();
    if (Number.isFinite(value) && value >= 0) return value;
  } catch {
    // A boundary error must still produce a stable public response.
  }
  return Date.now();
}

function jsonResponse(
  status: DepartureHttpStatus,
  body: object,
): DepartureEndpointResponse {
  return {
    status,
    headers: JSON_HEADERS,
    body: JSON_ENCODER.encode(JSON.stringify(body)),
  };
}

function errorResponse(
  status: DepartureHttpStatus,
  code: ErrorCode,
  clock: DepartureClock | undefined,
): DepartureEndpointResponse {
  const body: ErrorResult = {
    schemaVersion: SCHEMA_VERSION,
    requestId: INVALID_REQUEST_ID,
    code,
    occurredAt: Math.min(UINT32_MAX, Math.floor(safeNowMilliseconds(clock) / 1_000)),
  };
  return jsonResponse(status, body);
}

function parseHeaders(headers: readonly DepartureRawHeader[]): ParsedHeaders | undefined {
  let totalBytes = 2;
  let authorization: unknown = undefined;
  let authorizationCount = 0;
  let contentLength: number | undefined;
  let contentLengthCount = 0;

  try {
    for (const header of headers) {
      if (!Array.isArray(header) || header.length !== 2) return undefined;
      const [name, value] = header;
      if (typeof name !== "string" || typeof value !== "string") return undefined;

      totalBytes += utf8Bytes(name) + 2 + utf8Bytes(value) + 2;
      if (totalBytes > DEPARTURE_ENDPOINT_LIMITS.totalHeaderBytes) return undefined;
      if (!HEADER_NAME.test(name) || /[\0\r\n]/u.test(value)) return undefined;

      const normalizedName = name.toLowerCase();
      if (normalizedName === "authorization") {
        authorizationCount += 1;
        authorization = authorizationCount === 1 ? value : INVALID_AUTHORIZATION;
      } else if (normalizedName === "content-length") {
        contentLengthCount += 1;
        if (contentLengthCount !== 1 || !CONTENT_LENGTH.test(value)) return undefined;
        const parsed = Number(value);
        if (
          !Number.isSafeInteger(parsed)
          || parsed > DEPARTURE_ENDPOINT_LIMITS.requestBodyBytes
        ) {
          return undefined;
        }
        contentLength = parsed;
      }
    }
  } catch {
    return undefined;
  }

  return {
    authorization,
    ...(contentLength === undefined ? {} : { contentLength }),
  };
}

function assembledBytes(chunks: readonly Uint8Array[], byteLength: number): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0] ?? new Uint8Array(0);

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>): void {
  try {
    void reader.cancel().catch(() => undefined);
  } catch {
    // The request rejection remains authoritative.
  }
}

async function readStreamBody(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
): Promise<Uint8Array | undefined> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    return undefined;
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) {
        cancelReader(reader);
        return undefined;
      }
      if (item.value.byteLength > maximum - byteLength) {
        cancelReader(reader);
        return undefined;
      }
      if (item.value.byteLength === 0) continue;
      byteLength += item.value.byteLength;
      chunks.push(item.value);
    }
  } catch {
    cancelReader(reader);
    return undefined;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // A failed release cannot replace the request result.
    }
  }

  return assembledBytes(chunks, byteLength);
}

function closeIterator(iterator: AsyncIterator<Uint8Array>): void {
  if (typeof iterator.return !== "function") return;
  try {
    void Promise.resolve(iterator.return()).catch(() => undefined);
  } catch {
    // The request rejection remains authoritative.
  }
}

async function readAsyncIterableBody(
  body: AsyncIterable<Uint8Array>,
  maximum: number,
): Promise<Uint8Array | undefined> {
  let iterator: AsyncIterator<Uint8Array>;
  try {
    iterator = body[Symbol.asyncIterator]();
  } catch {
    return undefined;
  }

  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const item = await iterator.next();
      if (item === null || typeof item !== "object") {
        closeIterator(iterator);
        return undefined;
      }
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) {
        closeIterator(iterator);
        return undefined;
      }
      if (item.value.byteLength > maximum - byteLength) {
        closeIterator(iterator);
        return undefined;
      }
      if (item.value.byteLength === 0) continue;
      byteLength += item.value.byteLength;
      chunks.push(item.value);
    }
  } catch {
    closeIterator(iterator);
    return undefined;
  }

  return assembledBytes(chunks, byteLength);
}

async function readRequestBody(
  body: DepartureEndpointBody,
  contentLength: number | undefined,
): Promise<Uint8Array | undefined> {
  const maximum = contentLength ?? DEPARTURE_ENDPOINT_LIMITS.requestBodyBytes;
  let bytes: Uint8Array | undefined;

  if (body instanceof Uint8Array) {
    bytes = body.byteLength <= maximum ? body : undefined;
  } else {
    try {
      if (typeof body === "object" && body !== null && typeof body.getReader === "function") {
        bytes = await readStreamBody(body, maximum);
      } else if (
        typeof body === "object"
        && body !== null
        && typeof body[Symbol.asyncIterator] === "function"
      ) {
        bytes = await readAsyncIterableBody(body, maximum);
      }
    } catch {
      return undefined;
    }
  }

  if (bytes === undefined) return undefined;
  if (contentLength !== undefined && bytes.byteLength !== contentLength) return undefined;
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown | undefined {
  try {
    return JSON.parse(JSON_DECODER.decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

export function createDepartureEndpoint(
  dependencies: DepartureEndpointDependencies,
): DepartureEndpoint {
  const relayDependencies: PrimRelayDependencies = {
    fetch: dependencies.fetch,
    ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
    ...(dependencies.timer === undefined ? {} : { timer: dependencies.timer }),
  };

  const relay = async ({ target, apiKey }: PrimDepartureRelayRequest) => {
    let authorization = `Bearer ${apiKey}`;
    try {
      return await relayPrimRequest({ target, authorization }, relayDependencies);
    } finally {
      authorization = "";
    }
  };

  const resolve = createPrimDepartureResolver({
    catalog: dependencies.catalog,
    relay,
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    ...(dependencies.limiter === undefined ? {} : { limiter: dependencies.limiter }),
    ...(dependencies.metrics === undefined ? {} : { metrics: dependencies.metrics }),
  });
  const handlerDependencies: DepartureHandlerDependencies = {
    resolve,
    state: createDepartureRuntimeState(),
    ...(dependencies.clock === undefined ? {} : { clock: dependencies.clock }),
    ...(dependencies.metrics === undefined ? {} : { metrics: dependencies.metrics }),
  };

  return async (request) => {
    let method: string;
    let path: string;
    let headers: readonly DepartureRawHeader[];
    try {
      method = request.method;
      path = request.path;
      headers = request.headers;
    } catch {
      return errorResponse(400, "INVALID_SERVICE", dependencies.clock);
    }
    if (typeof method !== "string" || typeof path !== "string" || !Array.isArray(headers)) {
      return errorResponse(400, "INVALID_SERVICE", dependencies.clock);
    }

    const parsedHeaders = parseHeaders(headers);
    if (parsedHeaders === undefined) {
      return errorResponse(400, "INVALID_SERVICE", dependencies.clock);
    }

    let source: DepartureEndpointBody;
    try {
      source = request.body;
    } catch {
      return errorResponse(400, "INVALID_SERVICE", dependencies.clock);
    }
    const bytes = await readRequestBody(source, parsedHeaders.contentLength);
    if (bytes === undefined) {
      return errorResponse(400, "INVALID_SERVICE", dependencies.clock);
    }

    const body = parseJson(bytes);
    if (body === undefined) {
      return errorResponse(400, "INVALID_SERVICE", dependencies.clock);
    }

    const response = await handleDepartureHttpRequest({
      method,
      path,
      authorization: parsedHeaders.authorization,
      body,
    }, handlerDependencies);
    return jsonResponse(response.status, response.body);
  };
}

function incomingHeaders(rawHeaders: readonly string[]): readonly DepartureRawHeader[] {
  if (rawHeaders.length % 2 !== 0) return [["", ""]];
  const headers: DepartureRawHeader[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index];
    const value = rawHeaders[index + 1];
    if (name === undefined || value === undefined) return [["", ""]];
    headers.push([name, value]);
  }
  return headers;
}

function writeHttpResponse(
  response: ServerResponse,
  result: DepartureEndpointResponse,
  closeConnection = false,
): void {
  if (response.destroyed) return;
  try {
    if (closeConnection) {
      response.shouldKeepAlive = false;
      response.setHeader("connection", "close");
    }
    response.writeHead(result.status, result.headers);
    response.end(result.body);
  } catch {
    response.destroy();
  }
}

function serveIncomingRequest(
  endpoint: DepartureEndpoint,
  dependencies: DepartureEndpointDependencies,
  request: IncomingMessage,
  response: ServerResponse,
  continueExpected: boolean,
): void {
  const headers = incomingHeaders(request.rawHeaders);
  if (parseHeaders(headers) === undefined) {
    writeHttpResponse(
      response,
      errorResponse(400, "INVALID_SERVICE", dependencies.clock),
      true,
    );
    return;
  }

  if (continueExpected) {
    try {
      response.writeContinue();
    } catch {
      response.destroy();
      return;
    }
  }

  void endpoint({
    method: request.method ?? "",
    path: request.url ?? "",
    headers,
    body: request as AsyncIterable<Uint8Array>,
  }).then(
    (result) => {
      writeHttpResponse(response, result);
    },
    () => {
      writeHttpResponse(
        response,
        errorResponse(503, "SOURCE_UNAVAILABLE", dependencies.clock),
        true,
      );
    },
  );
}

export function createDepartureHttpServer(
  dependencies: DepartureEndpointDependencies,
): Server {
  const endpoint = createDepartureEndpoint(dependencies);
  const server = createServer({
    maxHeaderSize: DEPARTURE_ENDPOINT_LIMITS.totalHeaderBytes,
  }, (request, response) => {
    serveIncomingRequest(endpoint, dependencies, request, response, false);
  });
  server.on("checkContinue", (request, response) => {
    serveIncomingRequest(endpoint, dependencies, request, response, true);
  });

  server.on("clientError", (_error, socket) => {
    if (!socket.writable) return;
    const result = errorResponse(400, "INVALID_SERVICE", dependencies.clock);
    try {
      socket.write(
        `HTTP/1.1 400 Bad Request\r\n`
        + `content-type: ${result.headers["content-type"]}\r\n`
        + `content-length: ${result.body.byteLength}\r\n`
        + "connection: close\r\n\r\n",
      );
      socket.end(result.body);
    } catch {
      socket.destroy();
    }
  });
  return server;
}
