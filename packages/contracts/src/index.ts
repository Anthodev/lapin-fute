export const SCHEMA_VERSION = 1 as const;

export const LIMITS = {
  apiKeyUtf8Bytes: 512,
  idUtf8Bytes: 64,
  labelUtf8Bytes: 96,
  favorites: 8,
  departures: 4,
  httpTimeoutMs: 8_000,
  httpResponseBytes: 262_144,
} as const;

export const PRIM_ORIGIN = "https://prim.iledefrance-mobilites.fr" as const;
export const CACHE_FRESH_SECONDS = 60 as const;
export const FAVORITE_SETTLE_MS = 500 as const;

export const FRESHNESS = ["REALTIME", "SCHEDULED", "MIXED", "STALE"] as const;
export const DEPARTURE_STATUS = ["ON_TIME", "DELAYED", "CANCELLED", "UNKNOWN"] as const;
export const ERROR_CODE = [
  "API_KEY_REQUIRED",
  "API_KEY_INVALID",
  "INVALID_SERVICE",
  "SOURCE_UNAVAILABLE",
  "RATE_LIMITED",
  "INVALID_RESPONSE",
] as const;
export const API_KEY_ACTION = ["KEEP", "REPLACE", "REMOVE"] as const;
export const KEY_STATUS = { MISSING: 0, CONFIGURED: 1, INVALID: 2 } as const;
export const REQUEST_TRIGGER = { APP_OPEN: 0, FAVORITE_SELECTION: 1, MANUAL_SELECT: 2 } as const;
export const MESSAGE_TYPE = {
  REQUEST: 1,
  CONFIG_BEGIN: 2,
  FAVORITE: 3,
  CONFIG_COMMIT: 4,
  RESULT_BEGIN: 5,
  DEPARTURE: 6,
  RESULT_COMMIT: 7,
  ERROR: 8,
} as const;
export const APP_MESSAGE_KEY_ORDER = [
  "SCHEMA_VERSION",
  "MESSAGE_TYPE",
  "REQUEST_ID",
  "FAVORITE_ID",
  "SERVICE_ID",
  "DISPLAY_NAME",
  "STOP_LABEL",
  "LINE_LABEL",
  "DESTINATION_LABEL",
  "SORT_ORDER",
  "KEY_STATUS",
  "ITEM_COUNT",
  "ITEM_INDEX",
  "FETCHED_AT",
  "SOURCE_UPDATED_AT",
  "FRESHNESS",
  "EXPECTED_AT",
  "AIMED_AT",
  "MINUTES",
  "DEPARTURE_STATUS",
  "NEXT_INTERVAL_MINUTES",
  "ERROR_CODE",
  "OCCURRED_AT",
  "RETRY_AFTER_SECONDS",
  "REQUEST_TRIGGER",
] as const;

export const APP_MESSAGE_KEY = {
  SCHEMA_VERSION: 0,
  MESSAGE_TYPE: 1,
  REQUEST_ID: 2,
  FAVORITE_ID: 3,
  SERVICE_ID: 4,
  DISPLAY_NAME: 5,
  STOP_LABEL: 6,
  LINE_LABEL: 7,
  DESTINATION_LABEL: 8,
  SORT_ORDER: 9,
  KEY_STATUS: 10,
  ITEM_COUNT: 11,
  ITEM_INDEX: 12,
  FETCHED_AT: 13,
  SOURCE_UPDATED_AT: 14,
  FRESHNESS: 15,
  EXPECTED_AT: 16,
  AIMED_AT: 17,
  MINUTES: 18,
  DEPARTURE_STATUS: 19,
  NEXT_INTERVAL_MINUTES: 20,
  ERROR_CODE: 21,
  OCCURRED_AT: 22,
  RETRY_AFTER_SECONDS: 23,
  REQUEST_TRIGGER: 24,
} as const;
export const WIRE_LANGUAGE = { EN: "en", FR: "fr" } as const;

export type Freshness = (typeof FRESHNESS)[number];
export type DepartureStatus = (typeof DEPARTURE_STATUS)[number];
export type ErrorCode = (typeof ERROR_CODE)[number];
export type ApiKeyAction = (typeof API_KEY_ACTION)[number];
export type AppMessageKey = (typeof APP_MESSAGE_KEY_ORDER)[number];
export type WireLanguage = (typeof WIRE_LANGUAGE)[keyof typeof WIRE_LANGUAGE];

export interface Favorite {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  serviceId: string;
  displayName?: string;
  stopLabel: string;
  lineLabel: string;
  destinationLabel: string;
  sortOrder: number;
}

export interface Departure {
  expectedAt: number;
  aimedAt?: number;
  minutes: number;
  status: DepartureStatus;
  nextIntervalMinutes?: number;
}

export interface DepartureResult {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  favoriteId: string;
  fetchedAt: number;
  sourceUpdatedAt?: number;
  freshness: Freshness;
  departures: Departure[];
}

export interface ErrorResult {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  favoriteId?: string;
  code: ErrorCode;
  occurredAt: number;
  retryAfterSeconds?: number;
}

export type ApiKeyUpdate =
  | { schemaVersion: typeof SCHEMA_VERSION; action: "KEEP" }
  | { schemaVersion: typeof SCHEMA_VERSION; action: "REMOVE" }
  | { schemaVersion: typeof SCHEMA_VERSION; action: "REPLACE"; value: string };

export type AppMessageValue = number | string;
export type AppMessage = Partial<Record<AppMessageKey, AppMessageValue>>;

const encoder = new TextEncoder();
const UINT32_MAX = 0xffff_ffff;
const domainKeys = {
  favorite: ["schemaVersion", "id", "serviceId", "displayName", "stopLabel", "lineLabel", "destinationLabel", "sortOrder"],
  departure: ["expectedAt", "aimedAt", "minutes", "status", "nextIntervalMinutes"],
  result: ["schemaVersion", "requestId", "favoriteId", "fetchedAt", "sourceUpdatedAt", "freshness", "departures"],
  error: ["schemaVersion", "requestId", "favoriteId", "code", "occurredAt", "retryAfterSeconds"],
  keyUpdate: ["schemaVersion", "action", "value"],
} as const;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

function boundedString(value: unknown, maximum: number): value is string {
  return typeof value === "string" && utf8Bytes(value) >= 1 && utf8Bytes(value) <= maximum;
}

function uint32(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= UINT32_MAX;
}

function optionalUint32(value: unknown): boolean {
  return value === undefined || uint32(value);
}

function optionalBoundedString(value: unknown, maximum: number): boolean {
  return value === undefined || boundedString(value, maximum);
}

export function isFavorite(value: unknown): value is Favorite {
  if (!object(value) || !exactKeys(value, domainKeys.favorite)) return false;
  return value.schemaVersion === SCHEMA_VERSION
    && boundedString(value.id, LIMITS.idUtf8Bytes)
    && boundedString(value.serviceId, LIMITS.idUtf8Bytes)
    && optionalBoundedString(value.displayName, LIMITS.labelUtf8Bytes)
    && boundedString(value.stopLabel, LIMITS.labelUtf8Bytes)
    && boundedString(value.lineLabel, LIMITS.labelUtf8Bytes)
    && boundedString(value.destinationLabel, LIMITS.labelUtf8Bytes)
    && Number.isInteger(value.sortOrder)
    && Number(value.sortOrder) >= 0
    && Number(value.sortOrder) < LIMITS.favorites;
}

export function isDeparture(value: unknown): value is Departure {
  if (!object(value) || !exactKeys(value, domainKeys.departure)) return false;
  return uint32(value.expectedAt)
    && optionalUint32(value.aimedAt)
    && Number.isInteger(value.minutes)
    && Number(value.minutes) >= -1_440
    && Number(value.minutes) <= 1_440
    && DEPARTURE_STATUS.includes(value.status as DepartureStatus)
    && (value.nextIntervalMinutes === undefined
      || (Number.isInteger(value.nextIntervalMinutes) && Number(value.nextIntervalMinutes) >= 0 && Number(value.nextIntervalMinutes) <= 1_440));
}

export function isDepartureResult(value: unknown): value is DepartureResult {
  if (!object(value) || !exactKeys(value, domainKeys.result)) return false;
  return value.schemaVersion === SCHEMA_VERSION
    && boundedString(value.requestId, LIMITS.idUtf8Bytes)
    && boundedString(value.favoriteId, LIMITS.idUtf8Bytes)
    && uint32(value.fetchedAt)
    && optionalUint32(value.sourceUpdatedAt)
    && FRESHNESS.includes(value.freshness as Freshness)
    && Array.isArray(value.departures)
    && value.departures.length <= LIMITS.departures
    && value.departures.every(isDeparture);
}

export function isErrorResult(value: unknown): value is ErrorResult {
  if (!object(value) || !exactKeys(value, domainKeys.error)) return false;
  return value.schemaVersion === SCHEMA_VERSION
    && boundedString(value.requestId, LIMITS.idUtf8Bytes)
    && optionalBoundedString(value.favoriteId, LIMITS.idUtf8Bytes)
    && ERROR_CODE.includes(value.code as ErrorCode)
    && uint32(value.occurredAt)
    && optionalUint32(value.retryAfterSeconds);
}

export function isApiKeyUpdate(value: unknown): value is ApiKeyUpdate {
  if (!object(value) || !exactKeys(value, domainKeys.keyUpdate) || value.schemaVersion !== SCHEMA_VERSION) return false;
  if (value.action === "REPLACE") return boundedString(value.value, LIMITS.apiKeyUtf8Bytes);
  return (value.action === "KEEP" || value.action === "REMOVE") && value.value === undefined;
}

export function isPersonalApiKey(value: unknown): value is string {
  return boundedString(value, LIMITS.apiKeyUtf8Bytes) && !/[\r\n]/u.test(value);
}

export function dictionaryBytes(dataSizes: readonly number[]): number {
  if (!dataSizes.every((size) => Number.isInteger(size) && size >= 0)) throw new TypeError("Dictionary data sizes must be non-negative integers");
  return 1 + (7 * dataSizes.length) + dataSizes.reduce((total, size) => total + size, 0);
}

export function cstringBytes(value: string): number {
  return utf8Bytes(value) + 1;
}

function hasNumber(message: AppMessage, key: AppMessageKey): boolean {
  return typeof message[key] === "number" && Number.isInteger(message[key]);
}

function hasString(message: AppMessage, key: AppMessageKey, max = LIMITS.idUtf8Bytes): boolean {
  return boundedString(message[key], max);
}

function onlyMessageKeys(message: AppMessage, allowed: readonly AppMessageKey[]): boolean {
  return Object.keys(message).every((key) => allowed.includes(key as AppMessageKey));
}

export function isWireLanguage(value: unknown): value is WireLanguage {
  return value === "en" || value === "fr";
}

export function isAppMessage(value: unknown): value is AppMessage {
  if (!object(value)) return false;
  const message = value as AppMessage;
  const type = message.MESSAGE_TYPE;
  if (message.SCHEMA_VERSION !== SCHEMA_VERSION || !Number.isInteger(type)) return false;
  const common = ["SCHEMA_VERSION", "MESSAGE_TYPE"] as const;
  switch (type) {
    case MESSAGE_TYPE.REQUEST:
      return onlyMessageKeys(message, [...common, "REQUEST_ID", "FAVORITE_ID", "REQUEST_TRIGGER"])
        && hasString(message, "REQUEST_ID")
        && hasString(message, "FAVORITE_ID")
        && Object.values(REQUEST_TRIGGER).includes(message.REQUEST_TRIGGER as 0 | 1 | 2);
    case MESSAGE_TYPE.CONFIG_BEGIN:
      return onlyMessageKeys(message, [...common, "REQUEST_ID", "ITEM_COUNT", "KEY_STATUS", "DISPLAY_NAME"])
        && hasString(message, "REQUEST_ID")
        && hasNumber(message, "ITEM_COUNT")
        && Number(message.ITEM_COUNT) >= 0
        && Number(message.ITEM_COUNT) <= LIMITS.favorites
        && Object.values(KEY_STATUS).includes(message.KEY_STATUS as 0 | 1 | 2)
        && (message.DISPLAY_NAME === undefined || isWireLanguage(message.DISPLAY_NAME));
    case MESSAGE_TYPE.FAVORITE:
      return onlyMessageKeys(message, [
        ...common,
        "REQUEST_ID",
        "ITEM_INDEX",
        "FAVORITE_ID",
        "SERVICE_ID",
        "DISPLAY_NAME",
        "STOP_LABEL",
        "LINE_LABEL",
        "DESTINATION_LABEL",
        "SORT_ORDER",
      ])
        && hasString(message, "REQUEST_ID")
        && hasNumber(message, "ITEM_INDEX")
        && Number(message.ITEM_INDEX) >= 0
        && Number(message.ITEM_INDEX) < LIMITS.favorites
        && hasString(message, "FAVORITE_ID")
        && hasString(message, "SERVICE_ID")
        && (message.DISPLAY_NAME === undefined || hasString(message, "DISPLAY_NAME", LIMITS.labelUtf8Bytes))
        && hasString(message, "STOP_LABEL", LIMITS.labelUtf8Bytes)
        && hasString(message, "LINE_LABEL", LIMITS.labelUtf8Bytes)
        && hasString(message, "DESTINATION_LABEL", LIMITS.labelUtf8Bytes)
        && hasNumber(message, "SORT_ORDER")
        && Number(message.SORT_ORDER) >= 0
        && Number(message.SORT_ORDER) < LIMITS.favorites;
    case MESSAGE_TYPE.CONFIG_COMMIT:
      return onlyMessageKeys(message, [...common, "REQUEST_ID"])
        && hasString(message, "REQUEST_ID");
    case MESSAGE_TYPE.RESULT_BEGIN:
      return onlyMessageKeys(message, [
        ...common,
        "REQUEST_ID",
        "FAVORITE_ID",
        "ITEM_COUNT",
        "FETCHED_AT",
        "SOURCE_UPDATED_AT",
        "FRESHNESS",
      ])
        && hasString(message, "REQUEST_ID")
        && hasString(message, "FAVORITE_ID")
        && hasNumber(message, "ITEM_COUNT")
        && Number(message.ITEM_COUNT) >= 0
        && Number(message.ITEM_COUNT) <= LIMITS.departures
        && uint32(message.FETCHED_AT)
        && optionalUint32(message.SOURCE_UPDATED_AT)
        && [0, 1, 2, 3].includes(message.FRESHNESS as number);
    case MESSAGE_TYPE.DEPARTURE:
      return onlyMessageKeys(message, [
        ...common,
        "REQUEST_ID",
        "FAVORITE_ID",
        "ITEM_INDEX",
        "EXPECTED_AT",
        "AIMED_AT",
        "MINUTES",
        "DEPARTURE_STATUS",
        "NEXT_INTERVAL_MINUTES",
      ])
        && hasString(message, "REQUEST_ID")
        && hasString(message, "FAVORITE_ID")
        && hasNumber(message, "ITEM_INDEX")
        && Number(message.ITEM_INDEX) >= 0
        && Number(message.ITEM_INDEX) < LIMITS.departures
        && uint32(message.EXPECTED_AT)
        && optionalUint32(message.AIMED_AT)
        && hasNumber(message, "MINUTES")
        && Number(message.MINUTES) >= -1_440
        && Number(message.MINUTES) <= 1_440
        && [0, 1, 2, 3].includes(message.DEPARTURE_STATUS as number)
        && (message.NEXT_INTERVAL_MINUTES === undefined
          || (hasNumber(message, "NEXT_INTERVAL_MINUTES")
            && Number(message.NEXT_INTERVAL_MINUTES) >= 0
            && Number(message.NEXT_INTERVAL_MINUTES) <= 1_440));
    case MESSAGE_TYPE.RESULT_COMMIT:
      return onlyMessageKeys(message, [...common, "REQUEST_ID", "FAVORITE_ID"])
        && hasString(message, "REQUEST_ID")
        && hasString(message, "FAVORITE_ID");
    case MESSAGE_TYPE.ERROR:
      return onlyMessageKeys(message, [
        ...common,
        "REQUEST_ID",
        "FAVORITE_ID",
        "ERROR_CODE",
        "OCCURRED_AT",
        "RETRY_AFTER_SECONDS",
      ])
        && hasString(message, "REQUEST_ID")
        && (message.FAVORITE_ID === undefined || hasString(message, "FAVORITE_ID"))
        && [0, 1, 2, 3, 4, 5].includes(message.ERROR_CODE as number)
        && uint32(message.OCCURRED_AT)
        && optionalUint32(message.RETRY_AFTER_SECONDS);
    default:
      return false;
  }
}

interface ConfigStaging {
  requestId: string;
  count: number;
  keyStatus: number;
  language: WireLanguage;
  items: AppMessage[];
}

interface ResultStaging {
  requestId: string;
  favoriteId: string;
  count: number;
  begin: AppMessage;
  items: AppMessage[];
}

export interface CommittedProtocolState {
  configuration?: {
    keyStatus: number;
    language: WireLanguage;
    favorites: AppMessage[];
  };
  result?: {
    begin: AppMessage;
    departures: AppMessage[];
  };
  error?: AppMessage;
}

function copyMessage(message: AppMessage): AppMessage {
  return { ...message };
}

export class ProtocolReceiver {
  readonly committed: CommittedProtocolState = {};
  #config?: ConfigStaging;
  #result?: ResultStaging;
  #expected?: { requestId: string; favoriteId: string };

  expectResponse(requestId: string, favoriteId: string): boolean {
    if (!boundedString(requestId, LIMITS.idUtf8Bytes)
        || !boundedString(favoriteId, LIMITS.idUtf8Bytes)) return false;
    this.#expected = { requestId, favoriteId };
    this.#result = undefined;
    return true;
  }

  cancelExpectedResponse(): void {
    this.#expected = undefined;
    this.#result = undefined;
  }

  discardStaging(): void {
    this.#config = undefined;
    this.#result = undefined;
  }

  snapshot(): CommittedProtocolState {
    const snapshot: CommittedProtocolState = {};
    if (this.committed.configuration) {
      snapshot.configuration = {
        keyStatus: this.committed.configuration.keyStatus,
        language: this.committed.configuration.language,
        favorites: this.committed.configuration.favorites.map(copyMessage),
      };
    }
    if (this.committed.result) {
      snapshot.result = {
        begin: copyMessage(this.committed.result.begin),
        departures: this.committed.result.departures.map(copyMessage),
      };
    }
    if (this.committed.error) snapshot.error = copyMessage(this.committed.error);
    return snapshot;
  }

  receive(value: unknown): boolean {
    if (!isAppMessage(value)) {
      this.discardStaging();
      return false;
    }
    const message = value;
    const type = message.MESSAGE_TYPE;
    const requestId = String(message.REQUEST_ID ?? "");
    if (type === MESSAGE_TYPE.CONFIG_BEGIN) {
      this.#config = {
        requestId,
        count: Number(message.ITEM_COUNT),
        keyStatus: Number(message.KEY_STATUS),
        language: isWireLanguage(message.DISPLAY_NAME) ? message.DISPLAY_NAME : "en",
        items: [],
      };
      return true;
    }
    if (type === MESSAGE_TYPE.FAVORITE) {
      const duplicate = this.#config?.items.some((item) => item.FAVORITE_ID === message.FAVORITE_ID) ?? false;
      if (!this.#config
          || this.#config.requestId !== requestId
          || Number(message.ITEM_INDEX) !== this.#config.items.length
          || this.#config.items.length >= this.#config.count
          || duplicate) {
        this.#config = undefined;
        return false;
      }
      this.#config.items.push(copyMessage(message));
      return true;
    }
    if (type === MESSAGE_TYPE.CONFIG_COMMIT) {
      if (!this.#config
          || this.#config.requestId !== requestId
          || this.#config.items.length !== this.#config.count) {
        this.#config = undefined;
        return false;
      }
      this.committed.configuration = {
        keyStatus: this.#config.keyStatus,
        language: this.#config.language,
        favorites: this.#config.items.map(copyMessage),
      };
      this.committed.result = undefined;
      this.committed.error = undefined;
      this.#config = undefined;
      this.cancelExpectedResponse();
      return true;
    }
    if (type === MESSAGE_TYPE.RESULT_BEGIN) {
      if (!this.#expected
          || this.#expected.requestId !== requestId
          || this.#expected.favoriteId !== message.FAVORITE_ID) {
        this.#result = undefined;
        return false;
      }
      this.#result = {
        requestId,
        favoriteId: String(message.FAVORITE_ID),
        count: Number(message.ITEM_COUNT),
        begin: copyMessage(message),
        items: [],
      };
      return true;
    }
    if (type === MESSAGE_TYPE.DEPARTURE) {
      if (!this.#result
          || !this.#expected
          || this.#result.requestId !== requestId
          || this.#result.favoriteId !== message.FAVORITE_ID
          || this.#expected.requestId !== requestId
          || this.#expected.favoriteId !== message.FAVORITE_ID
          || Number(message.ITEM_INDEX) !== this.#result.items.length
          || this.#result.items.length >= this.#result.count) {
        this.#result = undefined;
        return false;
      }
      this.#result.items.push(copyMessage(message));
      return true;
    }
    if (type === MESSAGE_TYPE.RESULT_COMMIT) {
      if (!this.#result
          || !this.#expected
          || this.#result.requestId !== requestId
          || this.#result.favoriteId !== message.FAVORITE_ID
          || this.#expected.requestId !== requestId
          || this.#expected.favoriteId !== message.FAVORITE_ID
          || this.#result.items.length !== this.#result.count) {
        this.#result = undefined;
        return false;
      }
      this.committed.result = {
        begin: copyMessage(this.#result.begin),
        departures: this.#result.items.map(copyMessage),
      };
      this.committed.error = undefined;
      this.cancelExpectedResponse();
      return true;
    }
    if (type === MESSAGE_TYPE.ERROR) {
      if (!this.#expected
          || this.#expected.requestId !== requestId
          || (message.FAVORITE_ID !== undefined
            && this.#expected.favoriteId !== message.FAVORITE_ID)) {
        this.#result = undefined;
        return false;
      }
      this.committed.error = copyMessage(message);
      this.cancelExpectedResponse();
      return true;
    }
    this.discardStaging();
    return false;
  }
}
