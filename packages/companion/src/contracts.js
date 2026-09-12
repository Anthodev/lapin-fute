"use strict";

var SCHEMA_VERSION = 1;
var LIMITS = Object.freeze({
  apiKeyUtf8Bytes: 512,
  idUtf8Bytes: 64,
  labelUtf8Bytes: 96,
  favorites: 6,
  departures: 4,
  httpTimeoutMs: 8000,
  httpResponseBytes: 262144,
  catalogQueryMinCharacters: 2,
  catalogQueryMaxCharacters: 100,
  catalogSearchResults: 20,
  trafficTitleUtf8Bytes: 96,
  trafficTextUtf8Bytes: 384
});
var CACHE_FRESH_SECONDS = 60;
var USEFUL_STALE_SECONDS = 15 * 60;
var FAVORITE_SETTLE_MS = 500;
var APP_MESSAGE_INBOX_BYTES = 768;
var APP_MESSAGE_OUTBOX_BYTES = 192;
var CONFIG_MODE = Object.freeze({ DIFF: 0, FULL: 1 });
var FRESHNESS = Object.freeze(["REALTIME", "SCHEDULED", "MIXED", "STALE"]);
var DEPARTURE_STATUS = Object.freeze(["ON_TIME", "DELAYED", "CANCELLED", "UNKNOWN"]);
var TRAFFIC_STATE = Object.freeze(["NORMAL", "DELAYED", "STOPPED", "UNKNOWN"]);
var ERROR_CODE = Object.freeze([
  "API_KEY_REQUIRED",
  "API_KEY_INVALID",
  "INVALID_SERVICE",
  "SOURCE_UNAVAILABLE",
  "RATE_LIMITED",
  "INVALID_RESPONSE",
  "NO_CACHED_DATA"
]);
var TRANSPORT_MODE = Object.freeze(["BUS", "METRO", "TRAM", "RER", "TRANSILIEN"]);
var API_KEY_ACTION = Object.freeze(["KEEP", "REPLACE", "REMOVE"]);
var KEY_STATUS = Object.freeze({ MISSING: 0, CONFIGURED: 1, INVALID: 2 });
var REQUEST_TRIGGER = Object.freeze({ APP_OPEN: 0, FAVORITE_SELECTION: 1, MANUAL_SELECT: 2, CACHE_ONLY: 5 });
// DISPLAY_WIRE_VERSION 2 governs the watch display dictionaries only; domain
// data keeps SCHEMA_VERSION 1. The two numbers are never interchangeable.
var DISPLAY_WIRE_VERSION = 2;
var MESSAGE_TYPE = Object.freeze({
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
  DISPLAY_READY: 21
});
// Explicit alias -> numeric AppMessage ID from the frozen D2 wire contract.
// Index-derived tables and the retired v1 keys 4..9/13..23/25..34 have no
// aliases here; IDs are never recycled to new meanings.
var APP_MESSAGE_KEYS = Object.freeze({
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
});
// D2 record domains, packed and validated in display-layout (phone) and the
// watch receiver; contracts only bounds their wire presence.
var DISPLAY_APPEARANCE_MAX_UTF8_BYTES = 448;
var DISPLAY_DEPARTURE_MAX_UTF8_BYTES = 64;
var DISPLAY_TRAFFIC_FRAGMENT_MAX_UTF8_BYTES = 640;
var DISPLAY_EPOCH_UTF8_BYTES = 15;
var DISPLAY_REQUEST_ID_UTF8_BYTES = 24;
var UINT32_MAX = 4294967295;
var FAVORITE_KEYS = [
  "schemaVersion",
  "id",
  "serviceId",
  "displayName",
  "stopLabel",
  "lineLabel",
  "destinationLabel",
  "lineMode",
  "lineColor",
  "lineTextColor",
  "sortOrder"
];
var PHONE_FAVORITE_KEYS = FAVORITE_KEYS.concat(["routing"]);
var SERVICE_ROUTING_KEYS = ["monitoringRef", "lineRef", "destinationRef"];
var DEPARTURE_KEYS = ["expectedAt", "aimedAt", "minutes", "status", "nextIntervalMinutes"];
var RESULT_KEYS = [
  "schemaVersion",
  "requestId",
  "favoriteId",
  "fetchedAt",
  "sourceUpdatedAt",
  "freshness",
  "departures"
];
var ERROR_KEYS = [
  "schemaVersion",
  "requestId",
  "favoriteId",
  "code",
  "occurredAt",
  "retryAfterSeconds"
];
var KEY_UPDATE_KEYS = ["schemaVersion", "action", "value"];
var DEPARTURE_SNAPSHOT_KEYS = ["fetchedAt", "sourceUpdatedAt", "freshness", "departures"];
var OVERVIEW_REQUEST_ITEM_KEYS = ["favoriteId", "serviceId"];
var OVERVIEW_REQUEST_KEYS = ["schemaVersion", "requestId", "language", "favorites"];
var OVERVIEW_ITEM_ERROR_KEYS = ["code", "occurredAt", "retryAfterSeconds"];
var DEPARTURE_OUTCOME_KEYS = ["status", "data", "error"];
var TRAFFIC_OBSERVED_KEYS = ["state", "checkedAt", "sourceUpdatedAt"];
var TRAFFIC_UNKNOWN_KEYS = ["state", "checkedAt"];
var FAVORITE_OVERVIEW_ITEM_KEYS = ["favoriteId", "departures", "traffic"];
var OVERVIEW_RESULT_KEYS = ["schemaVersion", "requestId", "items"];
var OVERVIEW_TRANSFER_ITEM_KEYS = ["favoriteId", "traffic", "snapshot", "refreshError"];
var OVERVIEW_TRANSFER_KEYS = ["schemaVersion", "requestId", "items"];
var TRAFFIC_DETAIL_REQUEST_KEYS = ["schemaVersion", "requestId", "favoriteId", "serviceId", "language"];
var TRAFFIC_DETAIL_NORMAL_KEYS = ["schemaVersion", "requestId", "favoriteId", "state", "checkedAt", "sourceUpdatedAt"];
var TRAFFIC_DETAIL_UNKNOWN_KEYS = ["schemaVersion", "requestId", "favoriteId", "state", "checkedAt"];
var TRAFFIC_DETAIL_DISRUPTED_KEYS = ["schemaVersion", "requestId", "favoriteId", "state", "checkedAt", "sourceUpdatedAt", "title", "text", "validFrom", "validUntil"];
var WIRE_LANGUAGE = Object.freeze({ EN: "en", FR: "fr" });

function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value, allowed) {
  return Object.keys(value).every(function (key) {
    return allowed.indexOf(key) !== -1;
  });
}

function utf8Bytes(value) {
  var total = 0;
  var index;
  var code;
  var next;
  for (index = 0; index < value.length; index += 1) {
    code = value.charCodeAt(index);
    if (code <= 127) {
      total += 1;
    } else if (code <= 2047) {
      total += 2;
    } else if (code >= 55296 && code <= 56319) {
      next = value.charCodeAt(index + 1);
      if (next >= 56320 && next <= 57343) {
        total += 4;
        index += 1;
      } else {
        total += 3;
      }
    } else {
      total += 3;
    }
  }
  return total;
}

function boundedString(value, maximum) {
  var size;
  if (typeof value !== "string") return false;
  size = utf8Bytes(value);
  return size >= 1 && size <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function trafficTitle(value) {
  return typeof value === "string"
    && utf8Bytes(value) >= 1
    && utf8Bytes(value) <= LIMITS.trafficTitleUtf8Bytes
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
}

function trafficText(value) {
  return typeof value === "string"
    && utf8Bytes(value) >= 1
    && utf8Bytes(value) <= LIMITS.trafficTextUtf8Bytes
    && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(value);
}

function isLineColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/.test(value);
}

function uint32(value) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value && value >= 0 && value <= UINT32_MAX;
}

function optionalUint32(value) {
  return typeof value === "undefined" || uint32(value);
}

// Phone domain favorite. serviceId/displayName/sortOrder and the appearance
// colors stay phone-owned data; the D2 display seam consumes only id, labels
// and appearance colors and never transfers service metadata to the watch.
function hasFavorite(value) {
  var hasLineColor;
  var hasLineMode;
  var hasLineTextColor;
  hasLineMode = Object.prototype.hasOwnProperty.call(value, "lineMode");
  hasLineColor = Object.prototype.hasOwnProperty.call(value, "lineColor");
  hasLineTextColor = Object.prototype.hasOwnProperty.call(value, "lineTextColor");
  if (hasLineMode !== hasLineColor || hasLineMode !== hasLineTextColor) return false;
  return value.schemaVersion === SCHEMA_VERSION
    && boundedString(value.id, LIMITS.idUtf8Bytes)
    && boundedString(value.serviceId, LIMITS.idUtf8Bytes)
    && (typeof value.displayName === "undefined" || boundedString(value.displayName, LIMITS.labelUtf8Bytes))
    && boundedString(value.stopLabel, LIMITS.labelUtf8Bytes)
    && boundedString(value.lineLabel, LIMITS.labelUtf8Bytes)
    && boundedString(value.destinationLabel, LIMITS.labelUtf8Bytes)
    && (!hasLineMode || (
      TRANSPORT_MODE.indexOf(value.lineMode) !== -1
      && isLineColor(value.lineColor)
      && isLineColor(value.lineTextColor)
    ))
    && typeof value.sortOrder === "number"
    && Math.floor(value.sortOrder) === value.sortOrder
    && value.sortOrder >= 0
    && value.sortOrder < LIMITS.favorites;
}

function isFavorite(value) {
  return isObject(value) && hasOnlyKeys(value, FAVORITE_KEYS) && hasFavorite(value);
}

function isServiceRouting(value) {
  return isObject(value)
    && hasOnlyKeys(value, SERVICE_ROUTING_KEYS)
    && SERVICE_ROUTING_KEYS.every(function (key) {
      return typeof value[key] === "string" && value[key].length > 0;
    });
}

function isPhoneFavorite(value) {
  return isObject(value)
    && hasOnlyKeys(value, PHONE_FAVORITE_KEYS)
    && hasFavorite(value)
    && (!Object.prototype.hasOwnProperty.call(value, "routing") || isServiceRouting(value.routing));
}

function isPhoneFavoriteList(value) {
  var seen = Object.create(null);
  if (!Array.isArray(value) || value.length > LIMITS.favorites) return false;
  return value.every(function (favorite) {
    if (!isPhoneFavorite(favorite) || seen[favorite.id]) return false;
    seen[favorite.id] = true;
    return true;
  });
}

function isFavoriteList(value) {
  var seen = Object.create(null);
  if (!Array.isArray(value) || value.length > LIMITS.favorites) return false;
  return value.every(function (favorite) {
    if (!isFavorite(favorite) || seen[favorite.id]) return false;
    seen[favorite.id] = true;
    return true;
  });
}

function isDeparture(value) {
  return isObject(value)
    && hasOnlyKeys(value, DEPARTURE_KEYS)
    && uint32(value.expectedAt)
    && optionalUint32(value.aimedAt)
    && typeof value.minutes === "number"
    && Math.floor(value.minutes) === value.minutes
    && value.minutes >= -1440
    && value.minutes <= 1440
    && DEPARTURE_STATUS.indexOf(value.status) !== -1
    && (typeof value.nextIntervalMinutes === "undefined"
      || (typeof value.nextIntervalMinutes === "number"
        && Math.floor(value.nextIntervalMinutes) === value.nextIntervalMinutes
        && value.nextIntervalMinutes >= 0
        && value.nextIntervalMinutes <= 1440));
}

function hasDepartureSnapshot(value) {
  return uint32(value.fetchedAt)
    && optionalUint32(value.sourceUpdatedAt)
    && FRESHNESS.indexOf(value.freshness) !== -1
    && Array.isArray(value.departures)
    && value.departures.length <= LIMITS.departures
    && value.departures.every(isDeparture);
}

function isDepartureSnapshot(value) {
  return isObject(value)
    && hasOnlyKeys(value, DEPARTURE_SNAPSHOT_KEYS)
    && hasDepartureSnapshot(value);
}

function isDepartureResult(value) {
  return isObject(value)
    && hasOnlyKeys(value, RESULT_KEYS)
    && value.schemaVersion === SCHEMA_VERSION
    && boundedString(value.requestId, LIMITS.idUtf8Bytes)
    && boundedString(value.favoriteId, LIMITS.idUtf8Bytes)
    && hasDepartureSnapshot(value);
}

function isOverviewRequestItem(value) {
  return isObject(value)
    && hasOnlyKeys(value, OVERVIEW_REQUEST_ITEM_KEYS)
    && boundedString(value.favoriteId, LIMITS.idUtf8Bytes)
    && boundedString(value.serviceId, LIMITS.idUtf8Bytes);
}

function isOverviewRequest(value) {
  var seen = Object.create(null);
  if (!isObject(value)
      || !hasOnlyKeys(value, OVERVIEW_REQUEST_KEYS)
      || value.schemaVersion !== SCHEMA_VERSION
      || !boundedString(value.requestId, LIMITS.idUtf8Bytes)
      || (value.language !== WIRE_LANGUAGE.EN && value.language !== WIRE_LANGUAGE.FR)
      || !Array.isArray(value.favorites)
      || value.favorites.length < 1
      || value.favorites.length > LIMITS.favorites) return false;
  return value.favorites.every(function (favorite) {
    if (!isOverviewRequestItem(favorite) || seen[favorite.favoriteId]) return false;
    seen[favorite.favoriteId] = true;
    return true;
  });
}

function isOverviewItemError(value) {
  return isObject(value)
    && hasOnlyKeys(value, OVERVIEW_ITEM_ERROR_KEYS)
    && value.code !== "API_KEY_REQUIRED"
    && ERROR_CODE.indexOf(value.code) !== -1
    && uint32(value.occurredAt)
    && optionalUint32(value.retryAfterSeconds);
}

function isLineTrafficSummary(value) {
  if (!isObject(value) || TRAFFIC_STATE.indexOf(value.state) === -1) return false;
  if (value.state === "UNKNOWN") {
    return hasOnlyKeys(value, TRAFFIC_UNKNOWN_KEYS) && uint32(value.checkedAt);
  }
  return hasOnlyKeys(value, TRAFFIC_OBSERVED_KEYS)
    && uint32(value.checkedAt)
    && optionalUint32(value.sourceUpdatedAt);
}

function isDepartureOutcome(value) {
  if (!isObject(value) || !hasOnlyKeys(value, DEPARTURE_OUTCOME_KEYS)) return false;
  if (value.status === "AVAILABLE") {
    return typeof value.error === "undefined" && isDepartureSnapshot(value.data);
  }
  return value.status === "UNAVAILABLE"
    && typeof value.data === "undefined"
    && isOverviewItemError(value.error);
}

function isFavoriteOverviewItem(value) {
  return isObject(value)
    && hasOnlyKeys(value, FAVORITE_OVERVIEW_ITEM_KEYS)
    && boundedString(value.favoriteId, LIMITS.idUtf8Bytes)
    && isDepartureOutcome(value.departures)
    && isLineTrafficSummary(value.traffic);
}

function isOverviewResult(value, request) {
  if (!isOverviewRequest(request)
      || !isObject(value)
      || !hasOnlyKeys(value, OVERVIEW_RESULT_KEYS)
      || value.schemaVersion !== SCHEMA_VERSION
      || value.requestId !== request.requestId
      || !Array.isArray(value.items)
      || value.items.length !== request.favorites.length) return false;
  return value.items.every(function (item, index) {
    return isFavoriteOverviewItem(item)
      && item.favoriteId === request.favorites[index].favoriteId;
  });
}

function isOverviewTransferItem(value) {
  var hasSnapshot;
  var hasRefreshError;
  if (!isObject(value)
      || !hasOnlyKeys(value, OVERVIEW_TRANSFER_ITEM_KEYS)
      || !boundedString(value.favoriteId, LIMITS.idUtf8Bytes)
      || !isLineTrafficSummary(value.traffic)) return false;
  hasSnapshot = Object.prototype.hasOwnProperty.call(value, "snapshot");
  hasRefreshError = Object.prototype.hasOwnProperty.call(value, "refreshError");
  return (hasSnapshot || hasRefreshError)
    && (!hasSnapshot || isDepartureSnapshot(value.snapshot))
    && (!hasRefreshError || isOverviewItemError(value.refreshError));
}

function isOverviewTransfer(value) {
  var seen = Object.create(null);
  if (!isObject(value)
      || !hasOnlyKeys(value, OVERVIEW_TRANSFER_KEYS)
      || value.schemaVersion !== SCHEMA_VERSION
      || !boundedString(value.requestId, LIMITS.idUtf8Bytes)
      || !Array.isArray(value.items)
      || value.items.length > LIMITS.favorites) return false;
  return value.items.every(function (item) {
    if (!isOverviewTransferItem(item) || seen[item.favoriteId]) return false;
    seen[item.favoriteId] = true;
    return true;
  });
}

function isTrafficDetailRequest(value) {
  return isObject(value)
    && hasOnlyKeys(value, TRAFFIC_DETAIL_REQUEST_KEYS)
    && value.schemaVersion === SCHEMA_VERSION
    && boundedString(value.requestId, LIMITS.idUtf8Bytes)
    && boundedString(value.favoriteId, LIMITS.idUtf8Bytes)
    && boundedString(value.serviceId, LIMITS.idUtf8Bytes)
    && (value.language === WIRE_LANGUAGE.EN || value.language === WIRE_LANGUAGE.FR);
}

function isTrafficDetailResult(value) {
  if (!isObject(value)
      || value.schemaVersion !== SCHEMA_VERSION
      || !boundedString(value.requestId, LIMITS.idUtf8Bytes)
      || !boundedString(value.favoriteId, LIMITS.idUtf8Bytes)
      || !uint32(value.checkedAt)) return false;
  if (value.state === "UNKNOWN") {
    return hasOnlyKeys(value, TRAFFIC_DETAIL_UNKNOWN_KEYS);
  }
  if (value.state === "NORMAL") {
    return hasOnlyKeys(value, TRAFFIC_DETAIL_NORMAL_KEYS)
      && optionalUint32(value.sourceUpdatedAt);
  }
  return (value.state === "DELAYED" || value.state === "STOPPED")
    && hasOnlyKeys(value, TRAFFIC_DETAIL_DISRUPTED_KEYS)
    && optionalUint32(value.sourceUpdatedAt)
    && trafficTitle(value.title)
    && trafficText(value.text)
    && optionalUint32(value.validFrom)
    && optionalUint32(value.validUntil);
}

function isErrorResult(value) {
  return isObject(value)
    && hasOnlyKeys(value, ERROR_KEYS)
    && value.schemaVersion === SCHEMA_VERSION
    && boundedString(value.requestId, LIMITS.idUtf8Bytes)
    && (typeof value.favoriteId === "undefined" || boundedString(value.favoriteId, LIMITS.idUtf8Bytes))
    && ERROR_CODE.indexOf(value.code) !== -1
    && uint32(value.occurredAt)
    && optionalUint32(value.retryAfterSeconds);
}

function isPersonalApiKey(value) {
  return boundedString(value, LIMITS.apiKeyUtf8Bytes) && value.indexOf("\r") === -1 && value.indexOf("\n") === -1;
}

function isApiKeyUpdate(value) {
  if (!isObject(value) || !hasOnlyKeys(value, KEY_UPDATE_KEYS) || value.schemaVersion !== SCHEMA_VERSION) return false;
  if (value.action === "REPLACE") return isPersonalApiKey(value.value);
  return (value.action === "KEEP" || value.action === "REMOVE") && typeof value.value === "undefined";
}

function copyFavorite(favorite) {
  var copy = {
    schemaVersion: SCHEMA_VERSION,
    id: favorite.id,
    serviceId: favorite.serviceId,
    stopLabel: favorite.stopLabel,
    lineLabel: favorite.lineLabel,
    destinationLabel: favorite.destinationLabel
  };
  if (Object.prototype.hasOwnProperty.call(favorite, "lineMode")) {
    copy.lineMode = favorite.lineMode;
    copy.lineColor = favorite.lineColor;
    copy.lineTextColor = favorite.lineTextColor;
  }
  copy.sortOrder = favorite.sortOrder;
  if (typeof favorite.displayName !== "undefined") copy.displayName = favorite.displayName;
  return copy;
}

function copyPhoneFavorite(favorite) {
  var copy = copyFavorite(favorite);
  if (Object.prototype.hasOwnProperty.call(favorite, "routing")) {
    copy.routing = {
      monitoringRef: favorite.routing.monitoringRef,
      lineRef: favorite.routing.lineRef,
      destinationRef: favorite.routing.destinationRef
    };
  }
  return copy;
}

function copyDeparture(departure) {
  var copy = {
    expectedAt: departure.expectedAt,
    minutes: departure.minutes,
    status: departure.status
  };
  if (typeof departure.aimedAt !== "undefined") copy.aimedAt = departure.aimedAt;
  if (typeof departure.nextIntervalMinutes !== "undefined") copy.nextIntervalMinutes = departure.nextIntervalMinutes;
  return copy;
}

function copyDepartureResult(result, requestId) {
  var copy = {
    schemaVersion: SCHEMA_VERSION,
    requestId: typeof requestId === "string" ? requestId : result.requestId,
    favoriteId: result.favoriteId,
    fetchedAt: result.fetchedAt,
    freshness: result.freshness,
    departures: result.departures.map(copyDeparture)
  };
  if (typeof result.sourceUpdatedAt !== "undefined") copy.sourceUpdatedAt = result.sourceUpdatedAt;
  return copy;
}

function isWireLanguage(value) {
  return value === "en" || value === "fr";
}
function isDisplayHash(value) {
  return typeof value === "string" && value.length === 16 && /^[0-9a-f]{16}$/u.test(value);
}
function isDisplayEpoch(value) {
  return typeof value === "string" && value.length === DISPLAY_EPOCH_UTF8_BYTES && /^[0-9a-f]{15}$/u.test(value) && value !== "000000000000000";
}
function isDataRequestId(value) {
  return typeof value === "string" && value.length === DISPLAY_REQUEST_ID_UTF8_BYTES && isDisplayEpoch(value.slice(0, 15)) && value[15] === "r" && /^[0-9a-f]{8}$/u.test(value.slice(16)) && value.slice(16) !== "00000000";
}
function isConfigurationRequestId(value) {
  return typeof value === "string" && value.length === DISPLAY_REQUEST_ID_UTF8_BYTES && isDisplayEpoch(value.slice(0, 15)) && value[15] === "c" && /^[0-9a-f]{8}$/u.test(value.slice(16)) && value.slice(16) !== "00000000";
}
function isDisplayCorrelationToken(value) {
  return typeof value === "string" && value.length > 0 && value.length <= DISPLAY_REQUEST_ID_UTF8_BYTES && !/[^\x21-\x7e]/u.test(value);
}
function displayInteger(value, minimum, maximum) {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}
function displayText(value, maximum, multiline = false) {
  if (typeof value !== "string" || value.length === 0)
    return false;
  let bytes = 0;
  for (let i = 0;i < value.length; ) {
    const point = value.codePointAt(i);
    if (point >= 55296 && point <= 57343 || point < 32 && !(multiline && point === 10) || point >= 127 && point <= 159)
      return false;
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
    if (bytes > maximum)
      return false;
    i += point > 65535 ? 2 : 1;
  }
  return true;
}
function displayAppearance(record) {
  if (!displayText(record, DISPLAY_APPEARANCE_MAX_UTF8_BYTES))
    return false;
  let offset = 0;
  const lengths = [];
  for (let field = 0;field < 5; field++) {
    const prefix = record.slice(offset, offset + 3);
    if (!/^[0-9a-f]{3}$/u.test(prefix))
      return false;
    const length = parseInt(prefix, 16);
    if (length === 0)
      return false;
    const start = offset + 3;
    offset = start;
    for (let i = 0;i < length; i++) {
      if (offset >= record.length)
        return false;
      offset += record.codePointAt(offset) > 65535 ? 2 : 1;
    }
    const text = record.slice(start, offset);
    if (!displayText(text, field === 0 ? LIMITS.idUtf8Bytes : field === 1 ? 16 : LIMITS.labelUtf8Bytes) || field === 1 && !isDisplayHash(text))
      return false;
    lengths.push(length);
  }
  const suffix = record.slice(offset);
  if (suffix.length !== 39 || !/^[0-9a-f]{39}$/u.test(suffix))
    return false;
  const mask = parseInt(suffix.slice(36), 16);
  for (let slot = 0;slot < 12; slot++) {
    const end = parseInt(suffix.slice(12 + slot * 2, 14 + slot * 2), 16);
    const length = lengths[slot < 4 ? 2 : slot < 9 ? 3 : 4];
    if (end > length || !(mask & 1 << slot) && end !== length)
      return false;
  }
  return true;
}
function displayDeparture(record, maximum) {
  if (typeof record !== "string" || record.length < 23 || record.length > DISPLAY_DEPARTURE_MAX_UTF8_BYTES || !/^[0-9a-f]+$/u.test(record))
    return false;
  const flags = parseInt(record.slice(0, 2), 16), count = parseInt(record[22], 16);
  if (flags > 3 || count > maximum || !(flags & 1) && count !== 0 || record.length !== 23 + 9 * count || parseInt(record[10], 16) > 3 || parseInt(record.slice(11, 13), 16) > 7 || parseInt(record[13], 16) > 3)
    return false;
  for (let i = 0;i < count; i++)
    if (parseInt(record[31 + 9 * i], 16) > 3)
      return false;
  return true;
}
const displayFields = {
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
  21: []
};
function isAppMessage(value) {
  if (!isObject(value) || value.SCHEMA_VERSION !== DISPLAY_WIRE_VERSION || !displayInteger(value.MESSAGE_TYPE, 1, 21))
    return false;
  const type = value.MESSAGE_TYPE, fields = displayFields[type];
  if (!fields || !fields.every((key) => Object.prototype.hasOwnProperty.call(value, key)) || !Object.prototype.hasOwnProperty.call(value, "REQUEST_ID"))
    return false;
  const bound = type === MESSAGE_TYPE.DISPLAY_BEGIN && (value.DISPLAY_KIND === 1 || value.DISPLAY_KIND === 2);
  if (!Object.keys(value).every((key) => key === "SCHEMA_VERSION" || key === "MESSAGE_TYPE" || key === "REQUEST_ID" || fields.includes(key) || bound && key === "FAVORITE_ID") || bound && !displayText(value.FAVORITE_ID, LIMITS.idUtf8Bytes))
    return false;
  if (type === MESSAGE_TYPE.DISPLAY_READY || type === MESSAGE_TYPE.DISPLAY_HELLO) {
    return isDisplayCorrelationToken(value.REQUEST_ID) && (type === MESSAGE_TYPE.DISPLAY_READY || displayInteger(value.DISPLAY_PROFILE, 0, 1) && displayInteger(value.CLOCK_12H, 0, 1) && isDisplayCorrelationToken(value.WATCH_SESSION_ID) && isDisplayEpoch(value.DISPLAY_EPOCH));
  }
  if (!displayInteger(value.DISPLAY_GENERATION, 1, UINT32_MAX))
    return false;
  const configuration = type === 2 || type === 3 || type === 4 || type === 15 || type === 16;
  if (configuration) {
    if (!isConfigurationRequestId(value.REQUEST_ID) || parseInt(value.REQUEST_ID.slice(16), 16) !== value.DISPLAY_GENERATION)
      return false;
  } else if (!isDataRequestId(value.REQUEST_ID))
    return false;
  switch (type) {
    case MESSAGE_TYPE.REQUEST:
      return displayText(value.FAVORITE_ID, LIMITS.idUtf8Bytes) && (value.REQUEST_TRIGGER === 1 || value.REQUEST_TRIGGER === 2 || value.REQUEST_TRIGGER === 5);
    case MESSAGE_TYPE.OVERVIEW_REQUEST:
      return value.REQUEST_TRIGGER === 0 || value.REQUEST_TRIGGER === 2 || value.REQUEST_TRIGGER === 5;
    case MESSAGE_TYPE.TRAFFIC_REQUEST:
      return displayText(value.FAVORITE_ID, LIMITS.idUtf8Bytes);
    case MESSAGE_TYPE.CONFIG_BEGIN:
      return displayInteger(value.KEY_STATUS, 0, 2) && displayInteger(value.ITEM_COUNT, 0, LIMITS.favorites) && displayInteger(value.CONFIG_MODE, 0, 1) && isWireLanguage(value.LANGUAGE) && displayInteger(value.DISPLAY_PROFILE, 0, 1);
    case MESSAGE_TYPE.CONFIG_ENTRY:
      return displayInteger(value.ITEM_INDEX, 0, LIMITS.favorites - 1) && displayText(value.FAVORITE_ID, LIMITS.idUtf8Bytes) && isDisplayHash(value.DISPLAY_HASH);
    case MESSAGE_TYPE.FAVORITE:
      return displayInteger(value.ITEM_INDEX, 0, LIMITS.favorites - 1) && displayAppearance(value.DISPLAY_RECORD);
    case MESSAGE_TYPE.CONFIG_NEED:
      return displayInteger(value.CONFIG_NEED_MASK, 0, (1 << LIMITS.favorites) - 1) && displayInteger(value.DISPLAY_PROFILE, 0, 1) && displayInteger(value.CLOCK_12H, 0, 1);
    case MESSAGE_TYPE.CONFIG_COMMIT:
      return true;
    case MESSAGE_TYPE.DISPLAY_BEGIN:
      return value.DISPLAY_KIND === 0 ? displayInteger(value.ITEM_COUNT, 0, LIMITS.favorites) : value.DISPLAY_KIND === 1 ? value.ITEM_COUNT === 1 : value.DISPLAY_KIND === 2 && displayInteger(value.ITEM_COUNT, 1, 2);
    case MESSAGE_TYPE.DISPLAY_RECORD:
      if (value.DISPLAY_KIND === 0)
        return displayInteger(value.ITEM_INDEX, 0, LIMITS.favorites - 1) && displayDeparture(value.DISPLAY_RECORD, 1);
      if (value.DISPLAY_KIND === 1)
        return value.ITEM_INDEX === 0 && displayDeparture(value.DISPLAY_RECORD, LIMITS.departures);
      if (value.DISPLAY_KIND !== 2 || !displayInteger(value.ITEM_INDEX, 0, 1) || !displayText(value.DISPLAY_RECORD, DISPLAY_TRAFFIC_FRAGMENT_MAX_UTF8_BYTES, true))
        return false;
      return value.ITEM_INDEX === 1 || (value.DISPLAY_RECORD[0] === "e" ? /^e0[134567]$/u.test(value.DISPLAY_RECORD) && value.DISPLAY_RECORD.length === 3 : /^[0-3]/u.test(value.DISPLAY_RECORD));
    case MESSAGE_TYPE.DISPLAY_COMMIT:
      return displayInteger(value.DISPLAY_KIND, 0, 2);
    default:
      return false;
  }
}

function dictionaryBytes(dataSizes) {
  if (!dataSizes.every(size => Number.isInteger(size) && size >= 0)) {
    throw new TypeError("Dictionary data sizes must be non-negative integers");
  }
  return 1 + 7 * dataSizes.length + dataSizes.reduce((total, size) => total + size, 0);
}

function cstringBytes(value) {
  return utf8Bytes(value) + 1;
}

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  LIMITS: LIMITS,
  CACHE_FRESH_SECONDS: CACHE_FRESH_SECONDS,
  USEFUL_STALE_SECONDS: USEFUL_STALE_SECONDS,
  FAVORITE_SETTLE_MS: FAVORITE_SETTLE_MS,
  APP_MESSAGE_INBOX_BYTES: APP_MESSAGE_INBOX_BYTES,
  APP_MESSAGE_OUTBOX_BYTES: APP_MESSAGE_OUTBOX_BYTES,
  CONFIG_MODE: CONFIG_MODE,
  FRESHNESS: FRESHNESS,
  DEPARTURE_STATUS: DEPARTURE_STATUS,
  TRAFFIC_STATE: TRAFFIC_STATE,
  ERROR_CODE: ERROR_CODE,
  TRANSPORT_MODE: TRANSPORT_MODE,
  API_KEY_ACTION: API_KEY_ACTION,
  KEY_STATUS: KEY_STATUS,
  REQUEST_TRIGGER: REQUEST_TRIGGER,
  MESSAGE_TYPE: MESSAGE_TYPE,
  DISPLAY_WIRE_VERSION: DISPLAY_WIRE_VERSION,
  APP_MESSAGE_KEYS: APP_MESSAGE_KEYS,
  DISPLAY_APPEARANCE_MAX_UTF8_BYTES: DISPLAY_APPEARANCE_MAX_UTF8_BYTES,
  DISPLAY_DEPARTURE_MAX_UTF8_BYTES: DISPLAY_DEPARTURE_MAX_UTF8_BYTES,
  DISPLAY_TRAFFIC_FRAGMENT_MAX_UTF8_BYTES: DISPLAY_TRAFFIC_FRAGMENT_MAX_UTF8_BYTES,
  DISPLAY_EPOCH_UTF8_BYTES: DISPLAY_EPOCH_UTF8_BYTES,
  DISPLAY_REQUEST_ID_UTF8_BYTES: DISPLAY_REQUEST_ID_UTF8_BYTES,
  WIRE_LANGUAGE: WIRE_LANGUAGE,
  utf8Bytes: utf8Bytes,
  dictionaryBytes: dictionaryBytes,
  cstringBytes: cstringBytes,
  uint32: uint32,
  isObject: isObject,
  hasOnlyKeys: hasOnlyKeys,
  boundedString: boundedString,
  isDisplayHash: isDisplayHash,
  isFavorite: isFavorite,
  isFavoriteList: isFavoriteList,
  isServiceRouting: isServiceRouting,
  isPhoneFavorite: isPhoneFavorite,
  isPhoneFavoriteList: isPhoneFavoriteList,
  isAppMessage: isAppMessage,
  isDisplayEpoch: isDisplayEpoch,
  isDataRequestId: isDataRequestId,
  isConfigurationRequestId: isConfigurationRequestId,
  isDisplayCorrelationToken: isDisplayCorrelationToken,
  isWireLanguage: isWireLanguage,
  isLineColor: isLineColor,
  isDeparture: isDeparture,
  isDepartureResult: isDepartureResult,
  isDepartureSnapshot: isDepartureSnapshot,
  isOverviewRequest: isOverviewRequest,
  isOverviewResult: isOverviewResult,
  isOverviewTransfer: isOverviewTransfer,
  isTrafficDetailRequest: isTrafficDetailRequest,
  isTrafficDetailResult: isTrafficDetailResult,
  isErrorResult: isErrorResult,
  isPersonalApiKey: isPersonalApiKey,
  isApiKeyUpdate: isApiKeyUpdate,
  copyFavorite: copyFavorite,
  copyPhoneFavorite: copyPhoneFavorite,
  copyDepartureResult: copyDepartureResult
};
