export const SCHEMA_VERSION = 1;

export const APP_MESSAGE_INBOX_BYTES = 768;
export const APP_MESSAGE_OUTBOX_BYTES = 192;

export const LIMITS = Object.freeze({
  idUtf8Bytes: 64,
  labelUtf8Bytes: 96,
  favorites: 8,
  departures: 4,
  favoriteSettleMs: 500,
  requestQueue: 4
});

export const FRESHNESS = Object.freeze([
  "REALTIME",
  "SCHEDULED",
  "MIXED",
  "STALE"
]);

export const DEPARTURE_STATUS = Object.freeze([
  "ON_TIME",
  "DELAYED",
  "CANCELLED",
  "UNKNOWN"
]);

export const ERROR_CODE = Object.freeze([
  "API_KEY_REQUIRED",
  "API_KEY_INVALID",
  "INVALID_SERVICE",
  "SOURCE_UNAVAILABLE",
  "RATE_LIMITED",
  "INVALID_RESPONSE"
]);

export const KEY_STATUS = Object.freeze({
  MISSING: 0,
  CONFIGURED: 1,
  INVALID: 2
});

export const REQUEST_TRIGGER = Object.freeze({
  APP_OPEN: 0,
  FAVORITE_SELECTION: 1,
  MANUAL_SELECT: 2
});

export const MESSAGE_TYPE = Object.freeze({
  REQUEST: 1,
  CONFIG_BEGIN: 2,
  FAVORITE: 3,
  CONFIG_COMMIT: 4,
  RESULT_BEGIN: 5,
  DEPARTURE: 6,
  RESULT_COMMIT: 7,
  ERROR: 8
});

// SDK 4.33.1 auto-numbers array-form Message keys from 10000.
export const APP_MESSAGE_KEY_MAP = new Map([
  ["SCHEMA_VERSION", 0],
  ["MESSAGE_TYPE", 1],
  ["REQUEST_ID", 2],
  ["FAVORITE_ID", 3],
  ["SERVICE_ID", 4],
  ["DISPLAY_NAME", 5],
  ["STOP_LABEL", 6],
  ["LINE_LABEL", 7],
  ["DESTINATION_LABEL", 8],
  ["SORT_ORDER", 9],
  ["KEY_STATUS", 10],
  ["ITEM_COUNT", 11],
  ["ITEM_INDEX", 12],
  ["FETCHED_AT", 13],
  ["SOURCE_UPDATED_AT", 14],
  ["FRESHNESS", 15],
  ["EXPECTED_AT", 16],
  ["AIMED_AT", 17],
  ["MINUTES", 18],
  ["DEPARTURE_STATUS", 19],
  ["NEXT_INTERVAL_MINUTES", 20],
  ["ERROR_CODE", 21],
  ["OCCURRED_AT", 22],
  ["RETRY_AFTER_SECONDS", 23],
  ["REQUEST_TRIGGER", 24]
]);

export const LANGUAGE = Object.freeze({ EN: "en", FR: "fr" });

export function utf8Bytes(value) {
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) {
      total += 1;
    } else if (code <= 0x7ff) {
      total += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
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

export function boundedString(value, maximum) {
  if (typeof value !== "string") return false;
  const size = utf8Bytes(value);
  return size >= 1 && size <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function uint32(value) {
  return typeof value === "number"
    && isFinite(value)
    && Math.floor(value) === value
    && value >= 0
    && value <= 0xffffffff;
}

export function isWireLanguage(value) {
  return value === LANGUAGE.EN || value === LANGUAGE.FR;
}

export function enumHasValue(values, value) {
  const names = Object.keys(values);
  for (let index = 0; index < names.length; index += 1) {
    if (values[names[index]] === value) return true;
  }
  return false;
}
