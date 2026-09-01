"use strict";

var SCHEMA_VERSION = 1;
var LIMITS = Object.freeze({
  apiKeyUtf8Bytes: 512,
  idUtf8Bytes: 64,
  labelUtf8Bytes: 96,
  favorites: 8,
  departures: 4,
  httpTimeoutMs: 8000,
  httpResponseBytes: 262144,
  catalogQueryMinCharacters: 2,
  catalogQueryMaxCharacters: 100,
  catalogSearchResults: 20
});
var CACHE_FRESH_SECONDS = 60;
var FAVORITE_SETTLE_MS = 500;
var FRESHNESS = Object.freeze(["REALTIME", "SCHEDULED", "MIXED", "STALE"]);
var DEPARTURE_STATUS = Object.freeze(["ON_TIME", "DELAYED", "CANCELLED", "UNKNOWN"]);
var ERROR_CODE = Object.freeze([
  "API_KEY_REQUIRED",
  "API_KEY_INVALID",
  "INVALID_SERVICE",
  "SOURCE_UNAVAILABLE",
  "RATE_LIMITED",
  "INVALID_RESPONSE"
]);
var TRANSPORT_MODE = Object.freeze(["BUS", "METRO", "TRAM", "RER", "TRANSILIEN"]);
var API_KEY_ACTION = Object.freeze(["KEEP", "REPLACE", "REMOVE"]);
var KEY_STATUS = Object.freeze({ MISSING: 0, CONFIGURED: 1, INVALID: 2 });
var REQUEST_TRIGGER = Object.freeze({ APP_OPEN: 0, FAVORITE_SELECTION: 1, MANUAL_SELECT: 2 });
var MESSAGE_TYPE = Object.freeze({
  REQUEST: 1,
  CONFIG_BEGIN: 2,
  FAVORITE: 3,
  CONFIG_COMMIT: 4,
  RESULT_BEGIN: 5,
  DEPARTURE: 6,
  RESULT_COMMIT: 7,
  ERROR: 8
});
var APP_MESSAGE_KEY_ORDER = Object.freeze([
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
  "REQUEST_TRIGGER"
]);

var APP_MESSAGE_KEY = Object.freeze({
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
  REQUEST_TRIGGER: 24
});

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
  return size >= 1 && size <= maximum;
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

function isFavorite(value) {
  var hasLineColor;
  var hasLineMode;
  var hasLineTextColor;
  if (!isObject(value) || !hasOnlyKeys(value, FAVORITE_KEYS)) return false;
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

function isDepartureResult(value) {
  return isObject(value)
    && hasOnlyKeys(value, RESULT_KEYS)
    && value.schemaVersion === SCHEMA_VERSION
    && boundedString(value.requestId, LIMITS.idUtf8Bytes)
    && boundedString(value.favoriteId, LIMITS.idUtf8Bytes)
    && uint32(value.fetchedAt)
    && optionalUint32(value.sourceUpdatedAt)
    && FRESHNESS.indexOf(value.freshness) !== -1
    && Array.isArray(value.departures)
    && value.departures.length <= LIMITS.departures
    && value.departures.every(isDeparture);
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

module.exports = {
  SCHEMA_VERSION: SCHEMA_VERSION,
  LIMITS: LIMITS,
  CACHE_FRESH_SECONDS: CACHE_FRESH_SECONDS,
  FAVORITE_SETTLE_MS: FAVORITE_SETTLE_MS,
  FRESHNESS: FRESHNESS,
  DEPARTURE_STATUS: DEPARTURE_STATUS,
  ERROR_CODE: ERROR_CODE,
  TRANSPORT_MODE: TRANSPORT_MODE,
  API_KEY_ACTION: API_KEY_ACTION,
  KEY_STATUS: KEY_STATUS,
  REQUEST_TRIGGER: REQUEST_TRIGGER,
  MESSAGE_TYPE: MESSAGE_TYPE,
  APP_MESSAGE_KEY_ORDER: APP_MESSAGE_KEY_ORDER,
  APP_MESSAGE_KEY: APP_MESSAGE_KEY,
  WIRE_LANGUAGE: WIRE_LANGUAGE,
  utf8Bytes: utf8Bytes,
  uint32: uint32,
  isObject: isObject,
  hasOnlyKeys: hasOnlyKeys,
  boundedString: boundedString,
  isLineColor: isLineColor,
  isFavorite: isFavorite,
  isFavoriteList: isFavoriteList,
  isDeparture: isDeparture,
  isDepartureResult: isDepartureResult,
  isErrorResult: isErrorResult,
  isPersonalApiKey: isPersonalApiKey,
  isApiKeyUpdate: isApiKeyUpdate,
  copyFavorite: copyFavorite,
  copyDepartureResult: copyDepartureResult
};
