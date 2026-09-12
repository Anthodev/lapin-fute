export const SCHEMA_VERSION = 1 as const;

export const LIMITS = {
  apiKeyUtf8Bytes: 512,
  idUtf8Bytes: 64,
  labelUtf8Bytes: 96,
  favorites: 6,
  departures: 4,
  httpTimeoutMs: 8_000,
  httpResponseBytes: 262_144,
  catalogQueryMinCharacters: 2,
  catalogQueryMaxCharacters: 100,
  catalogSearchResults: 20,
  trafficTitleUtf8Bytes: 96,
  trafficTextUtf8Bytes: 384,
} as const;

export const PRIM_ORIGIN = "https://prim.iledefrance-mobilites.fr" as const;
export const CACHE_FRESH_SECONDS = 60 as const;
export const FAVORITE_SETTLE_MS = 500 as const;
export const APP_MESSAGE_INBOX_BYTES = 768 as const;
export const APP_MESSAGE_OUTBOX_BYTES = 192 as const;
export const CONFIG_MODE = { DIFF: 0, FULL: 1 } as const;

export const FRESHNESS = ["REALTIME", "SCHEDULED", "MIXED", "STALE"] as const;
export const DEPARTURE_STATUS = ["ON_TIME", "DELAYED", "CANCELLED", "UNKNOWN"] as const;
export const TRAFFIC_STATE = ["NORMAL", "DELAYED", "STOPPED", "UNKNOWN"] as const;
export const ERROR_CODE = [
  "API_KEY_REQUIRED",
  "API_KEY_INVALID",
  "INVALID_SERVICE",
  "SOURCE_UNAVAILABLE",
  "RATE_LIMITED",
  "INVALID_RESPONSE",
  "NO_CACHED_DATA",
] as const;
export const TRANSPORT_MODE = ["BUS", "METRO", "TRAM", "RER", "TRANSILIEN"] as const;
export const CATALOG_ERROR_CODE = ["INVALID_QUERY", "PLACE_NOT_FOUND", "CATALOG_UNAVAILABLE", "METHOD_NOT_ALLOWED"] as const;
export const API_KEY_ACTION = ["KEEP", "REPLACE", "REMOVE"] as const;
export const KEY_STATUS = { MISSING: 0, CONFIGURED: 1, INVALID: 2 } as const;
export const REQUEST_TRIGGER = { APP_OPEN: 0, FAVORITE_SELECTION: 1, MANUAL_SELECT: 2, CACHE_ONLY: 5 } as const;
// D2 record domains, packed and validated in display-layout (phone) and the
// watch receiver; contracts only bounds their wire presence.
export const DISPLAY_APPEARANCE_MAX_UTF8_BYTES = 448 as const;
export const DISPLAY_DEPARTURE_MAX_UTF8_BYTES = 64 as const;
export const DISPLAY_TRAFFIC_FRAGMENT_MAX_UTF8_BYTES = 640 as const;
export const DISPLAY_EPOCH_UTF8_BYTES = 15 as const;
export const DISPLAY_REQUEST_ID_UTF8_BYTES = 24 as const;
// DISPLAY_WIRE_VERSION 2 governs the watch display dictionaries only; domain
// data keeps SCHEMA_VERSION 1. The two numbers are never interchangeable.
export const DISPLAY_WIRE_VERSION = 2 as const;
export const MESSAGE_TYPE = {
  REQUEST: 1,
  CONFIG_BEGIN: 2,
  FAVORITE: 3,
  CONFIG_COMMIT: 4,
  OVERVIEW_REQUEST: 9,
  TRAFFIC_REQUEST: 10,
  CONFIG_ENTRY: 15,
  CONFIG_NEED: 16,
  DISPLAY_BEGIN: 17,
  DISPLAY_RECORD: 18,
  DISPLAY_COMMIT: 19,
  DISPLAY_HELLO: 20,
  DISPLAY_READY: 21,
} as const;
// Explicit alias -> numeric AppMessage ID from the frozen D2 wire contract.
// Index-derived tables and the retired v1 keys 4..9/13..23/25..34 have no
// aliases here; IDs are never recycled to new meanings.
export const APP_MESSAGE_KEYS = {
  SCHEMA_VERSION: 0,
  MESSAGE_TYPE: 1,
  REQUEST_ID: 2,
  FAVORITE_ID: 3,
  KEY_STATUS: 10,
  ITEM_COUNT: 11,
  ITEM_INDEX: 12,
  REQUEST_TRIGGER: 24,
  CONFIG_NEED_MASK: 35,
  CONFIG_MODE: 36,
  LANGUAGE: 37,
  DISPLAY_RECORD: 38,
  DISPLAY_PROFILE: 39,
  DISPLAY_KIND: 40,
  DISPLAY_GENERATION: 41,
  CLOCK_12H: 42,
  DISPLAY_HASH: 43,
  WATCH_SESSION_ID: 44,
  DISPLAY_EPOCH: 45,
} as const;
export const WIRE_LANGUAGE = { EN: "en", FR: "fr" } as const;

export type Freshness = (typeof FRESHNESS)[number];
export type DepartureStatus = (typeof DEPARTURE_STATUS)[number];
export type TrafficState = (typeof TRAFFIC_STATE)[number];
export type ErrorCode = (typeof ERROR_CODE)[number];
export type TransportMode = (typeof TRANSPORT_MODE)[number];
export type CatalogErrorCode = (typeof CATALOG_ERROR_CODE)[number];
export type ApiKeyAction = (typeof API_KEY_ACTION)[number];
export type AppMessageKey = keyof typeof APP_MESSAGE_KEYS;
export type WireLanguage = (typeof WIRE_LANGUAGE)[keyof typeof WIRE_LANGUAGE];

// Phone domain favorite. serviceId/displayName/sortOrder and the appearance
// colors stay phone-owned data; the D2 display seam consumes only id, labels
// and appearance colors and never transfers service metadata to the watch.
export type Favorite = {
  schemaVersion: typeof SCHEMA_VERSION;
  id: string;
  serviceId: string;
  displayName?: string;
  stopLabel: string;
  lineLabel: string;
  destinationLabel: string;
  sortOrder: number;
} & (
  | {
    lineMode: TransportMode;
    lineColor: string;
    lineTextColor: string;
  }
  | {
    lineMode?: never;
    lineColor?: never;
    lineTextColor?: never;
  }
);

export interface ServiceRouting {
  monitoringRef: string;
  lineRef: string;
  destinationRef: string;
}

export type PhoneFavorite = Favorite & { routing?: ServiceRouting };

export interface Departure {
  expectedAt: number;
  aimedAt?: number;
  minutes: number;
  status: DepartureStatus;
  nextIntervalMinutes?: number;
}

export interface DepartureSnapshot {
  fetchedAt: number;
  sourceUpdatedAt?: number;
  freshness: Freshness;
  departures: Departure[];
}

export interface DepartureResult extends DepartureSnapshot {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  favoriteId: string;
}

export interface OverviewRequestItem {
  favoriteId: string;
  serviceId: string;
}

export interface OverviewRequest {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  language: WireLanguage;
  favorites: OverviewRequestItem[];
}

export type OverviewItemError = {
  code: Exclude<ErrorCode, "API_KEY_REQUIRED">;
  occurredAt: number;
  retryAfterSeconds?: number;
};

export type DepartureOutcome =
  | { status: "AVAILABLE"; data: DepartureSnapshot }
  | { status: "UNAVAILABLE"; error: OverviewItemError };

export type LineTrafficSummary =
  | {
    state: Exclude<TrafficState, "UNKNOWN">;
    checkedAt: number;
    sourceUpdatedAt?: number;
  }
  | {
    state: "UNKNOWN";
    checkedAt: number;
    sourceUpdatedAt?: never;
  };

export interface FavoriteOverviewItem {
  favoriteId: string;
  departures: DepartureOutcome;
  traffic: LineTrafficSummary;
}

export interface OverviewResult {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  items: FavoriteOverviewItem[];
}

type TrafficDetailCommon = {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  favoriteId: string;
  checkedAt: number;
};

export type TrafficDetailResult =
  | (TrafficDetailCommon & {
    state: "NORMAL";
    sourceUpdatedAt?: number;
    title?: never;
    text?: never;
    validFrom?: never;
    validUntil?: never;
  })
  | (TrafficDetailCommon & {
    state: "UNKNOWN";
    sourceUpdatedAt?: never;
    title?: never;
    text?: never;
    validFrom?: never;
    validUntil?: never;
  })
  | (TrafficDetailCommon & {
    state: "DELAYED" | "STOPPED";
    sourceUpdatedAt?: number;
    title: string;
    text: string;
    validFrom?: number;
    validUntil?: number;
  });

export type OverviewTransferItem = {
  favoriteId: string;
  traffic: LineTrafficSummary;
} & (
  | { snapshot: DepartureSnapshot; refreshError?: OverviewItemError }
  | { snapshot?: never; refreshError: OverviewItemError }
);

export interface OverviewTransfer {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  items: OverviewTransferItem[];
}

export interface TrafficDetailRequest {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  favoriteId: string;
  serviceId: string;
  language: WireLanguage;
}

export interface ErrorResult {
  schemaVersion: typeof SCHEMA_VERSION;
  requestId: string;
  favoriteId?: string;
  code: ErrorCode;
  occurredAt: number;
  retryAfterSeconds?: number;
}

/** Display metadata for one native line. Its mode is the enclosing place's mode. */
export interface PlaceLine {
  lineLabel: string;
  lineColor: string;
  lineTextColor: string;
}

export interface PlaceSearchItem {
  placeId: string;
  stopLabel: string;
  localityLabel?: string;
  mode: TransportMode;
  /**
   * All serving lines, nonempty and deduplicated by native line identity.
   * Natural label order, then native identity. Equal display labels remain distinct.
   */
  lines: PlaceLine[];
}

export interface PlaceSearchResult {
  schemaVersion: typeof SCHEMA_VERSION;
  places: PlaceSearchItem[];
}

export interface ServiceOption {
  serviceId: string;
  stopLabel: string;
  lineLabel: string;
  destinationLabel: string;
  lineMode: TransportMode;
  lineColor: string;
  lineTextColor: string;
  routing: ServiceRouting;
}

export interface ServiceOptionsResult {
  schemaVersion: typeof SCHEMA_VERSION;
  placeId: string;
  services: ServiceOption[];
}

export interface CatalogErrorResult {
  schemaVersion: typeof SCHEMA_VERSION;
  code: CatalogErrorCode;
}

export type ApiKeyUpdate =
  | { schemaVersion: typeof SCHEMA_VERSION; action: "KEEP" }
  | { schemaVersion: typeof SCHEMA_VERSION; action: "REMOVE" }
  | { schemaVersion: typeof SCHEMA_VERSION; action: "REPLACE"; value: string };

export type AppMessageValue = number | string;
export type DisplayProfile = 0 | 1;
export type DisplayKind = 0 | 1 | 2;
type DisplayEnvelope<T extends number> = {
  SCHEMA_VERSION: typeof DISPLAY_WIRE_VERSION;
  MESSAGE_TYPE: T;
  REQUEST_ID: string;
};
type DisplayGeneration = { DISPLAY_GENERATION: number };
export type AppMessage =
  | DisplayEnvelope<typeof MESSAGE_TYPE.DISPLAY_READY>
  | (DisplayEnvelope<typeof MESSAGE_TYPE.DISPLAY_HELLO> & {
    DISPLAY_PROFILE: DisplayProfile; CLOCK_12H: 0 | 1;
    WATCH_SESSION_ID: string; DISPLAY_EPOCH: string;
  })
  | (DisplayGeneration & (
    | (DisplayEnvelope<typeof MESSAGE_TYPE.REQUEST> & { FAVORITE_ID: string; REQUEST_TRIGGER: 1 | 2 | 5 })
    | (DisplayEnvelope<typeof MESSAGE_TYPE.OVERVIEW_REQUEST> & { REQUEST_TRIGGER: 0 | 2 | 5 })
    | (DisplayEnvelope<typeof MESSAGE_TYPE.TRAFFIC_REQUEST> & { FAVORITE_ID: string })
    | (DisplayEnvelope<typeof MESSAGE_TYPE.CONFIG_BEGIN> & {
      ITEM_COUNT: number; KEY_STATUS: 0 | 1 | 2; CONFIG_MODE: 0 | 1;
      LANGUAGE: WireLanguage; DISPLAY_PROFILE: DisplayProfile;
    })
    | (DisplayEnvelope<typeof MESSAGE_TYPE.CONFIG_ENTRY> & {
      ITEM_INDEX: number; FAVORITE_ID: string; DISPLAY_HASH: string;
    })
    | (DisplayEnvelope<typeof MESSAGE_TYPE.FAVORITE> & { ITEM_INDEX: number; DISPLAY_RECORD: string })
    | (DisplayEnvelope<typeof MESSAGE_TYPE.CONFIG_NEED> & {
      CONFIG_NEED_MASK: number; DISPLAY_PROFILE: DisplayProfile; CLOCK_12H: 0 | 1;
    })
    | DisplayEnvelope<typeof MESSAGE_TYPE.CONFIG_COMMIT>
    | (DisplayEnvelope<typeof MESSAGE_TYPE.DISPLAY_BEGIN> & (
      | { DISPLAY_KIND: 0; ITEM_COUNT: number; FAVORITE_ID?: never }
      | { DISPLAY_KIND: 1; ITEM_COUNT: 1; FAVORITE_ID: string }
      | { DISPLAY_KIND: 2; ITEM_COUNT: 1 | 2; FAVORITE_ID: string }
    ))
    | (DisplayEnvelope<typeof MESSAGE_TYPE.DISPLAY_RECORD> & {
      DISPLAY_KIND: DisplayKind; ITEM_INDEX: number; DISPLAY_RECORD: string;
    })
    | (DisplayEnvelope<typeof MESSAGE_TYPE.DISPLAY_COMMIT> & { DISPLAY_KIND: DisplayKind })
  ));

const encoder = new TextEncoder();
const UINT32_MAX = 0xffff_ffff;
const domainKeys = {
  favorite: ["schemaVersion", "id", "serviceId", "displayName", "stopLabel", "lineLabel", "destinationLabel", "lineMode", "lineColor", "lineTextColor", "sortOrder"],
  departure: ["expectedAt", "aimedAt", "minutes", "status", "nextIntervalMinutes"],
  result: ["schemaVersion", "requestId", "favoriteId", "fetchedAt", "sourceUpdatedAt", "freshness", "departures"],
  departureSnapshot: ["fetchedAt", "sourceUpdatedAt", "freshness", "departures"],
  overviewRequestItem: ["favoriteId", "serviceId"],
  overviewRequest: ["schemaVersion", "requestId", "language", "favorites"],
  overviewItemError: ["code", "occurredAt", "retryAfterSeconds"],
  departureOutcome: ["status", "data", "error"],
  trafficObserved: ["state", "checkedAt", "sourceUpdatedAt"],
  trafficUnknown: ["state", "checkedAt"],
  favoriteOverviewItem: ["favoriteId", "departures", "traffic"],
  overviewResult: ["schemaVersion", "requestId", "items"],
  overviewTransferItem: ["favoriteId", "traffic", "snapshot", "refreshError"],
  overviewTransfer: ["schemaVersion", "requestId", "items"],
  trafficDetailRequest: ["schemaVersion", "requestId", "favoriteId", "serviceId", "language"],
  trafficDetailNormal: ["schemaVersion", "requestId", "favoriteId", "state", "checkedAt", "sourceUpdatedAt"],
  trafficDetailUnknown: ["schemaVersion", "requestId", "favoriteId", "state", "checkedAt"],
  trafficDetailDisrupted: ["schemaVersion", "requestId", "favoriteId", "state", "checkedAt", "sourceUpdatedAt", "title", "text", "validFrom", "validUntil"],
  error: ["schemaVersion", "requestId", "favoriteId", "code", "occurredAt", "retryAfterSeconds"],
  keyUpdate: ["schemaVersion", "action", "value"],
  placeLine: ["lineLabel", "lineColor", "lineTextColor"],
  placeSearchItem: ["placeId", "stopLabel", "localityLabel", "mode", "lines"],
  placeSearchResult: ["schemaVersion", "places"],
  serviceOption: ["serviceId", "stopLabel", "lineLabel", "destinationLabel", "lineMode", "lineColor", "lineTextColor", "routing"],
  serviceOptionsResult: ["schemaVersion", "placeId", "services"],
  catalogError: ["schemaVersion", "code"],
} as const;
const phoneFavoriteKeys = [...domainKeys.favorite, "routing"];
const serviceRoutingKeys = ["monitoringRef", "lineRef", "destinationRef"];

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
  return typeof value === "string"
    && utf8Bytes(value) >= 1
    && utf8Bytes(value) <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function trafficTitle(value: unknown): value is string {
  return typeof value === "string"
    && utf8Bytes(value) >= 1
    && utf8Bytes(value) <= LIMITS.trafficTitleUtf8Bytes
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);
}

function trafficText(value: unknown): value is string {
  return typeof value === "string"
    && utf8Bytes(value) >= 1
    && utf8Bytes(value) <= LIMITS.trafficTextUtf8Bytes
    && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/u.test(value);
}

export function isLineColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/u.test(value);
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

function hasFavorite(value: Record<string, unknown>): boolean {
  const hasLineMode = Object.hasOwn(value, "lineMode");
  const hasLineColor = Object.hasOwn(value, "lineColor");
  const hasLineTextColor = Object.hasOwn(value, "lineTextColor");
  if (hasLineMode !== hasLineColor || hasLineMode !== hasLineTextColor) return false;
  return value.schemaVersion === SCHEMA_VERSION
    && boundedString(value.id, LIMITS.idUtf8Bytes)
    && boundedString(value.serviceId, LIMITS.idUtf8Bytes)
    && optionalBoundedString(value.displayName, LIMITS.labelUtf8Bytes)
    && boundedString(value.stopLabel, LIMITS.labelUtf8Bytes)
    && boundedString(value.lineLabel, LIMITS.labelUtf8Bytes)
    && boundedString(value.destinationLabel, LIMITS.labelUtf8Bytes)
    && (!hasLineMode || (
      TRANSPORT_MODE.includes(value.lineMode as TransportMode)
      && isLineColor(value.lineColor)
      && isLineColor(value.lineTextColor)
    ))
    && Number.isInteger(value.sortOrder)
    && Number(value.sortOrder) >= 0
    && Number(value.sortOrder) < LIMITS.favorites;
}

export function isFavorite(value: unknown): value is Favorite {
  return object(value) && exactKeys(value, domainKeys.favorite) && hasFavorite(value);
}

export function isServiceRouting(value: unknown): value is ServiceRouting {
  return object(value)
    && exactKeys(value, serviceRoutingKeys)
    && serviceRoutingKeys.every((key) => typeof value[key] === "string" && value[key].length > 0);
}

export function isPhoneFavorite(value: unknown): value is PhoneFavorite {
  return object(value)
    && exactKeys(value, phoneFavoriteKeys)
    && hasFavorite(value)
    && (!Object.hasOwn(value, "routing") || isServiceRouting(value.routing));
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

function hasDepartureSnapshot(value: Record<string, unknown>): boolean {
  return uint32(value.fetchedAt)
    && optionalUint32(value.sourceUpdatedAt)
    && FRESHNESS.includes(value.freshness as Freshness)
    && Array.isArray(value.departures)
    && value.departures.length <= LIMITS.departures
    && value.departures.every(isDeparture);
}

export function isDepartureSnapshot(value: unknown): value is DepartureSnapshot {
  return object(value)
    && exactKeys(value, domainKeys.departureSnapshot)
    && hasDepartureSnapshot(value);
}

export function isDepartureResult(value: unknown): value is DepartureResult {
  return object(value)
    && exactKeys(value, domainKeys.result)
    && value.schemaVersion === SCHEMA_VERSION
    && boundedString(value.requestId, LIMITS.idUtf8Bytes)
    && boundedString(value.favoriteId, LIMITS.idUtf8Bytes)
    && hasDepartureSnapshot(value);
}

function isOverviewRequestItem(value: unknown): value is OverviewRequestItem {
  return object(value)
    && exactKeys(value, domainKeys.overviewRequestItem)
    && boundedString(value.favoriteId, LIMITS.idUtf8Bytes)
    && boundedString(value.serviceId, LIMITS.idUtf8Bytes);
}

export function isOverviewRequest(value: unknown): value is OverviewRequest {
  if (!object(value)
      || !exactKeys(value, domainKeys.overviewRequest)
      || value.schemaVersion !== SCHEMA_VERSION
      || !boundedString(value.requestId, LIMITS.idUtf8Bytes)
      || !isWireLanguage(value.language)
      || !Array.isArray(value.favorites)
      || value.favorites.length < 1
      || value.favorites.length > LIMITS.favorites) return false;
  const seen = new Set<string>();
  return value.favorites.every((favorite) => {
    if (!isOverviewRequestItem(favorite) || seen.has(favorite.favoriteId)) return false;
    seen.add(favorite.favoriteId);
    return true;
  });
}

function isOverviewItemError(value: unknown): value is OverviewItemError {
  return object(value)
    && exactKeys(value, domainKeys.overviewItemError)
    && value.code !== "API_KEY_REQUIRED"
    && ERROR_CODE.includes(value.code as ErrorCode)
    && uint32(value.occurredAt)
    && optionalUint32(value.retryAfterSeconds);
}

function isLineTrafficSummary(value: unknown): value is LineTrafficSummary {
  if (!object(value) || !TRAFFIC_STATE.includes(value.state as TrafficState)) return false;
  if (value.state === "UNKNOWN") {
    return exactKeys(value, domainKeys.trafficUnknown) && uint32(value.checkedAt);
  }
  return exactKeys(value, domainKeys.trafficObserved)
    && uint32(value.checkedAt)
    && optionalUint32(value.sourceUpdatedAt);
}

function isDepartureOutcome(value: unknown): value is DepartureOutcome {
  if (!object(value) || !exactKeys(value, domainKeys.departureOutcome)) return false;
  if (value.status === "AVAILABLE") {
    return value.error === undefined && isDepartureSnapshot(value.data);
  }
  return value.status === "UNAVAILABLE"
    && value.data === undefined
    && isOverviewItemError(value.error);
}

function isFavoriteOverviewItem(value: unknown): value is FavoriteOverviewItem {
  return object(value)
    && exactKeys(value, domainKeys.favoriteOverviewItem)
    && boundedString(value.favoriteId, LIMITS.idUtf8Bytes)
    && isDepartureOutcome(value.departures)
    && isLineTrafficSummary(value.traffic);
}

export function isOverviewResult(value: unknown, request: unknown): value is OverviewResult {
  if (!isOverviewRequest(request)
      || !object(value)
      || !exactKeys(value, domainKeys.overviewResult)
      || value.schemaVersion !== SCHEMA_VERSION
      || value.requestId !== request.requestId
      || !Array.isArray(value.items)
      || value.items.length !== request.favorites.length) return false;
  return value.items.every((item, index) => (
    isFavoriteOverviewItem(item)
    && item.favoriteId === request.favorites[index]?.favoriteId
  ));
}

function isOverviewTransferItem(value: unknown): value is OverviewTransferItem {
  if (!object(value)
      || !exactKeys(value, domainKeys.overviewTransferItem)
      || !boundedString(value.favoriteId, LIMITS.idUtf8Bytes)
      || !isLineTrafficSummary(value.traffic)) return false;
  const hasSnapshot = Object.hasOwn(value, "snapshot");
  const hasRefreshError = Object.hasOwn(value, "refreshError");
  return (hasSnapshot || hasRefreshError)
    && (!hasSnapshot || isDepartureSnapshot(value.snapshot))
    && (!hasRefreshError || isOverviewItemError(value.refreshError));
}

export function isOverviewTransfer(value: unknown): value is OverviewTransfer {
  if (!object(value)
      || !exactKeys(value, domainKeys.overviewTransfer)
      || value.schemaVersion !== SCHEMA_VERSION
      || !boundedString(value.requestId, LIMITS.idUtf8Bytes)
      || !Array.isArray(value.items)
      || value.items.length > LIMITS.favorites) return false;
  const seen = new Set<string>();
  return value.items.every((item) => {
    if (!isOverviewTransferItem(item) || seen.has(item.favoriteId)) return false;
    seen.add(item.favoriteId);
    return true;
  });
}

export function isTrafficDetailRequest(value: unknown): value is TrafficDetailRequest {
  return object(value)
    && exactKeys(value, domainKeys.trafficDetailRequest)
    && value.schemaVersion === SCHEMA_VERSION
    && boundedString(value.requestId, LIMITS.idUtf8Bytes)
    && boundedString(value.favoriteId, LIMITS.idUtf8Bytes)
    && boundedString(value.serviceId, LIMITS.idUtf8Bytes)
    && isWireLanguage(value.language);
}

export function isTrafficDetailResult(value: unknown): value is TrafficDetailResult {
  if (!object(value)
      || value.schemaVersion !== SCHEMA_VERSION
      || !boundedString(value.requestId, LIMITS.idUtf8Bytes)
      || !boundedString(value.favoriteId, LIMITS.idUtf8Bytes)
      || !uint32(value.checkedAt)) return false;
  if (value.state === "UNKNOWN") {
    return exactKeys(value, domainKeys.trafficDetailUnknown);
  }
  if (value.state === "NORMAL") {
    return exactKeys(value, domainKeys.trafficDetailNormal)
      && optionalUint32(value.sourceUpdatedAt);
  }
  return (value.state === "DELAYED" || value.state === "STOPPED")
    && exactKeys(value, domainKeys.trafficDetailDisrupted)
    && optionalUint32(value.sourceUpdatedAt)
    && trafficTitle(value.title)
    && trafficText(value.text)
    && optionalUint32(value.validFrom)
    && optionalUint32(value.validUntil);
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

export function isPlaceLine(value: unknown): value is PlaceLine {
  return object(value)
    && exactKeys(value, domainKeys.placeLine)
    && domainKeys.placeLine.every((field) => Object.hasOwn(value, field))
    && boundedString(value.lineLabel, LIMITS.labelUtf8Bytes)
    && isLineColor(value.lineColor)
    && isLineColor(value.lineTextColor);
}

export function isPlaceSearchItem(value: unknown): value is PlaceSearchItem {
  if (!object(value) || !exactKeys(value, domainKeys.placeSearchItem)
    || !Object.hasOwn(value, "placeId") || !Object.hasOwn(value, "stopLabel")
    || !Object.hasOwn(value, "mode") || !Object.hasOwn(value, "lines")
    || !boundedString(value.placeId, LIMITS.idUtf8Bytes)
    || !boundedString(value.stopLabel, LIMITS.labelUtf8Bytes)
    || !optionalBoundedString(value.localityLabel, LIMITS.labelUtf8Bytes)
    || !TRANSPORT_MODE.includes(value.mode as TransportMode)
    || !Array.isArray(value.lines) || value.lines.length === 0) return false;
  for (const line of value.lines) if (!isPlaceLine(line)) return false;
  return true;
}

export function isPlaceSearchResult(value: unknown): value is PlaceSearchResult {
  if (!object(value) || !exactKeys(value, domainKeys.placeSearchResult)) return false;
  return value.schemaVersion === SCHEMA_VERSION
    && Array.isArray(value.places)
    && value.places.length <= LIMITS.catalogSearchResults
    && value.places.every(isPlaceSearchItem);
}

export function isServiceOption(value: unknown): value is ServiceOption {
  if (!object(value) || !exactKeys(value, domainKeys.serviceOption)) return false;
  return boundedString(value.serviceId, LIMITS.idUtf8Bytes)
    && boundedString(value.stopLabel, LIMITS.labelUtf8Bytes)
    && boundedString(value.lineLabel, LIMITS.labelUtf8Bytes)
    && boundedString(value.destinationLabel, LIMITS.labelUtf8Bytes)
    && TRANSPORT_MODE.includes(value.lineMode as TransportMode)
    && isLineColor(value.lineColor)
    && isLineColor(value.lineTextColor)
    && isServiceRouting(value.routing);
}

export function isServiceOptionsResult(value: unknown): value is ServiceOptionsResult {
  if (!object(value) || !exactKeys(value, domainKeys.serviceOptionsResult)) return false;
  return value.schemaVersion === SCHEMA_VERSION
    && boundedString(value.placeId, LIMITS.idUtf8Bytes)
    && Array.isArray(value.services)
    && value.services.every(isServiceOption);
}

export function isCatalogErrorResult(value: unknown): value is CatalogErrorResult {
  if (!object(value) || !exactKeys(value, domainKeys.catalogError)) return false;
  return value.schemaVersion === SCHEMA_VERSION
    && CATALOG_ERROR_CODE.includes(value.code as CatalogErrorCode);
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

export function isWireLanguage(value: unknown): value is WireLanguage {
  return value === "en" || value === "fr";
}

export function isDisplayHash(value: unknown): value is string {
  return typeof value === "string" && value.length === 16 && /^[0-9a-f]{16}$/u.test(value);
}

export function isDisplayEpoch(value: unknown): value is string {
  return typeof value === "string" && value.length === DISPLAY_EPOCH_UTF8_BYTES
    && /^[0-9a-f]{15}$/u.test(value) && value !== "000000000000000";
}

// Data tokens use the watch's r-counter; c-sequences belong only to configuration.
export function isDataRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length === DISPLAY_REQUEST_ID_UTF8_BYTES
    && isDisplayEpoch(value.slice(0, 15)) && value[15] === "r"
    && /^[0-9a-f]{8}$/u.test(value.slice(16)) && value.slice(16) !== "00000000";
}

export function isConfigurationRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length === DISPLAY_REQUEST_ID_UTF8_BYTES
    && isDisplayEpoch(value.slice(0, 15)) && value[15] === "c"
    && /^[0-9a-f]{8}$/u.test(value.slice(16)) && value.slice(16) !== "00000000";
}

export function isDisplayCorrelationToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0
    && value.length <= DISPLAY_REQUEST_ID_UTF8_BYTES && !/[^\x21-\x7e]/u.test(value);
}

function displayInteger(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

function displayText(value: unknown, maximum: number, multiline = false): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  let bytes = 0;
  for (let i = 0; i < value.length;) {
    const point = value.codePointAt(i)!;
    if ((point >= 0xd800 && point <= 0xdfff) || (point < 32 && !(multiline && point === 10))
        || (point >= 127 && point <= 159)) return false;
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
    if (bytes > maximum) return false;
    i += point > 0xffff ? 2 : 1;
  }
  return true;
}

// This dictionary has no profile/language. The receiver verifies its hash
// against the candidate configuration after these structural checks.
function displayAppearance(record: unknown): boolean {
  if (!displayText(record, DISPLAY_APPEARANCE_MAX_UTF8_BYTES)) return false;
  let offset = 0;
  const lengths: number[] = [];
  for (let field = 0; field < 5; field++) {
    const prefix = record.slice(offset, offset + 3);
    if (!/^[0-9a-f]{3}$/u.test(prefix)) return false;
    const length = parseInt(prefix, 16);
    if (length === 0) return false;
    const start = offset + 3;
    offset = start;
    for (let i = 0; i < length; i++) {
      if (offset >= record.length) return false;
      offset += record.codePointAt(offset)! > 0xffff ? 2 : 1;
    }
    const text = record.slice(start, offset);
    if (!displayText(text, field === 0 ? LIMITS.idUtf8Bytes : field === 1 ? 16 : LIMITS.labelUtf8Bytes)
        || (field === 1 && !isDisplayHash(text))) return false;
    lengths.push(length);
  }
  const suffix = record.slice(offset);
  if (suffix.length !== 39 || !/^[0-9a-f]{39}$/u.test(suffix)) return false;
  const mask = parseInt(suffix.slice(36), 16);
  for (let slot = 0; slot < 12; slot++) {
    const end = parseInt(suffix.slice(12 + slot * 2, 14 + slot * 2), 16);
    const length = lengths[slot < 4 ? 2 : slot < 9 ? 3 : 4]!;
    if (end > length || (!(mask & (1 << slot)) && end !== length)) return false;
  }
  return true;
}

function displayDeparture(record: unknown, maximum: number): boolean {
  if (typeof record !== "string" || record.length < 23 || record.length > DISPLAY_DEPARTURE_MAX_UTF8_BYTES
      || !/^[0-9a-f]+$/u.test(record)) return false;
  const flags = parseInt(record.slice(0, 2), 16), count = parseInt(record[22]!, 16);
  if (flags > 3 || count > maximum || (!(flags & 1) && count !== 0)
      || record.length !== 23 + 9 * count || parseInt(record[10]!, 16) > 3
      || parseInt(record.slice(11, 13), 16) > 7 || parseInt(record[13]!, 16) > 3) return false;
  for (let i = 0; i < count; i++) if (parseInt(record[31 + 9 * i]!, 16) > 3) return false;
  return true;
}

const displayFields: Readonly<Record<number, readonly AppMessageKey[]>> = {
  1: ["FAVORITE_ID", "REQUEST_TRIGGER", "DISPLAY_GENERATION"],
  2: ["KEY_STATUS", "ITEM_COUNT", "CONFIG_MODE", "LANGUAGE", "DISPLAY_PROFILE", "DISPLAY_GENERATION"],
  3: ["ITEM_INDEX", "DISPLAY_RECORD", "DISPLAY_GENERATION"],
  4: ["DISPLAY_GENERATION"],
  9: ["REQUEST_TRIGGER", "DISPLAY_GENERATION"],
  10: ["FAVORITE_ID", "DISPLAY_GENERATION"],
  15: ["FAVORITE_ID", "ITEM_INDEX", "DISPLAY_HASH", "DISPLAY_GENERATION"],
  16: ["CONFIG_NEED_MASK", "DISPLAY_PROFILE", "DISPLAY_GENERATION", "CLOCK_12H"],
  17: ["ITEM_COUNT", "DISPLAY_KIND", "DISPLAY_GENERATION"],
  18: ["ITEM_INDEX", "DISPLAY_RECORD", "DISPLAY_KIND", "DISPLAY_GENERATION"],
  19: ["DISPLAY_KIND", "DISPLAY_GENERATION"],
  20: ["DISPLAY_PROFILE", "CLOCK_12H", "WATCH_SESSION_ID", "DISPLAY_EPOCH"],
  21: [],
};

// Alias dictionaries only. Native numeric duplicates and SDK15025 belong to
// the transport boundary. Candidate/epoch admission remains receiver state.
export function isAppMessage(value: unknown): value is AppMessage {
  if (!object(value) || value.SCHEMA_VERSION !== DISPLAY_WIRE_VERSION
      || !displayInteger(value.MESSAGE_TYPE, 1, 21)) return false;
  const type = value.MESSAGE_TYPE, fields = displayFields[type];
  if (!fields || !fields.every((key) => Object.hasOwn(value, key))
      || !Object.hasOwn(value, "REQUEST_ID")) return false;
  const bound = type === MESSAGE_TYPE.DISPLAY_BEGIN && (value.DISPLAY_KIND === 1 || value.DISPLAY_KIND === 2);
  if (!Object.keys(value).every((key) => key === "SCHEMA_VERSION" || key === "MESSAGE_TYPE" || key === "REQUEST_ID"
      || fields.includes(key as AppMessageKey) || (bound && key === "FAVORITE_ID"))
      || (bound && !displayText(value.FAVORITE_ID, LIMITS.idUtf8Bytes))) return false;
  if (type === MESSAGE_TYPE.DISPLAY_READY || type === MESSAGE_TYPE.DISPLAY_HELLO) {
    return isDisplayCorrelationToken(value.REQUEST_ID) && (type === MESSAGE_TYPE.DISPLAY_READY || (
      displayInteger(value.DISPLAY_PROFILE, 0, 1) && displayInteger(value.CLOCK_12H, 0, 1)
      && isDisplayCorrelationToken(value.WATCH_SESSION_ID) && isDisplayEpoch(value.DISPLAY_EPOCH)
    ));
  }
  if (!displayInteger(value.DISPLAY_GENERATION, 1, UINT32_MAX)) return false;
  const configuration = type === 2 || type === 3 || type === 4 || type === 15 || type === 16;
  if (configuration) {
    if (!isConfigurationRequestId(value.REQUEST_ID)
        || parseInt(value.REQUEST_ID.slice(16), 16) !== value.DISPLAY_GENERATION) return false;
  } else if (!isDataRequestId(value.REQUEST_ID)) return false;
  switch (type) {
    case MESSAGE_TYPE.REQUEST:
      return displayText(value.FAVORITE_ID, LIMITS.idUtf8Bytes)
        && (value.REQUEST_TRIGGER === 1 || value.REQUEST_TRIGGER === 2 || value.REQUEST_TRIGGER === 5);
    case MESSAGE_TYPE.OVERVIEW_REQUEST:
      return value.REQUEST_TRIGGER === 0 || value.REQUEST_TRIGGER === 2 || value.REQUEST_TRIGGER === 5;
    case MESSAGE_TYPE.TRAFFIC_REQUEST:
      return displayText(value.FAVORITE_ID, LIMITS.idUtf8Bytes);
    case MESSAGE_TYPE.CONFIG_BEGIN:
      return displayInteger(value.KEY_STATUS, 0, 2) && displayInteger(value.ITEM_COUNT, 0, LIMITS.favorites)
        && displayInteger(value.CONFIG_MODE, 0, 1) && isWireLanguage(value.LANGUAGE)
        && displayInteger(value.DISPLAY_PROFILE, 0, 1);
    case MESSAGE_TYPE.CONFIG_ENTRY:
      return displayInteger(value.ITEM_INDEX, 0, LIMITS.favorites - 1)
        && displayText(value.FAVORITE_ID, LIMITS.idUtf8Bytes) && isDisplayHash(value.DISPLAY_HASH);
    case MESSAGE_TYPE.FAVORITE:
      return displayInteger(value.ITEM_INDEX, 0, LIMITS.favorites - 1) && displayAppearance(value.DISPLAY_RECORD);
    case MESSAGE_TYPE.CONFIG_NEED:
      return displayInteger(value.CONFIG_NEED_MASK, 0, (1 << LIMITS.favorites) - 1)
        && displayInteger(value.DISPLAY_PROFILE, 0, 1) && displayInteger(value.CLOCK_12H, 0, 1);
    case MESSAGE_TYPE.CONFIG_COMMIT:
      return true;
    case MESSAGE_TYPE.DISPLAY_BEGIN:
      return value.DISPLAY_KIND === 0 ? displayInteger(value.ITEM_COUNT, 0, LIMITS.favorites)
        : value.DISPLAY_KIND === 1 ? value.ITEM_COUNT === 1
        : value.DISPLAY_KIND === 2 && displayInteger(value.ITEM_COUNT, 1, 2);
    case MESSAGE_TYPE.DISPLAY_RECORD:
      if (value.DISPLAY_KIND === 0) return displayInteger(value.ITEM_INDEX, 0, LIMITS.favorites - 1)
        && displayDeparture(value.DISPLAY_RECORD, 1);
      if (value.DISPLAY_KIND === 1) return value.ITEM_INDEX === 0 && displayDeparture(value.DISPLAY_RECORD, LIMITS.departures);
      if (value.DISPLAY_KIND !== 2 || !displayInteger(value.ITEM_INDEX, 0, 1)
          || !displayText(value.DISPLAY_RECORD, DISPLAY_TRAFFIC_FRAGMENT_MAX_UTF8_BYTES, true)) return false;
      // Fragment 1 is arbitrary continuation; only the assembled receiver
      // can validate section counts, lp3 boundaries and the error union.
      return value.ITEM_INDEX === 1 || (value.DISPLAY_RECORD[0] === "e"
        ? /^e0[134567]$/u.test(value.DISPLAY_RECORD) && value.DISPLAY_RECORD.length === 3
        : /^[0-3]/u.test(value.DISPLAY_RECORD));
    case MESSAGE_TYPE.DISPLAY_COMMIT:
      return displayInteger(value.DISPLAY_KIND, 0, 2);
    default:
      return false;
  }
}
