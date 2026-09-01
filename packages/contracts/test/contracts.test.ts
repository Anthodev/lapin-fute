import test from "node:test";
import assert from "node:assert/strict";
import {
  API_KEY_ACTION,
  APP_MESSAGE_KEY,
  APP_MESSAGE_KEY_ORDER,
  CATALOG_ERROR_CODE,
  CATALOG_ROUTE,
  DEPARTURE_STATUS,
  ERROR_CODE,
  FRESHNESS,
  KEY_STATUS,
  LIMITS,
  MESSAGE_TYPE,
  ProtocolReceiver,
  REQUEST_TRIGGER,
  SCHEMA_VERSION,
  TRANSPORT_MODE,
  cstringBytes,
  dictionaryBytes,
  isApiKeyUpdate,
  isAppMessage,
  isCatalogErrorResult,
  isDepartureResult,
  isErrorResult,
  isFavorite,
  isPersonalApiKey,
  isPlaceSearchItem,
  isPlaceSearchResult,
  isServiceOption,
  isServiceOptionsResult,
  utf8Bytes,
  type AppMessage,
} from "../src/index.ts";

const favorite = {
  schemaVersion: SCHEMA_VERSION,
  id: "home",
  serviceId: "opaque:service:1",
  displayName: "Maison",
  stopLabel: "Châtelet",
  lineLabel: "Métro 1",
  destinationLabel: "La Défense",
  lineMode: "METRO",
  lineColor: "#ffbe00",
  lineTextColor: "#000000",
  sortOrder: 0,
};

const result = {
  schemaVersion: SCHEMA_VERSION,
  requestId: "request-1",
  favoriteId: "home",
  fetchedAt: 1_788_000_000,
  sourceUpdatedAt: 1_787_999_990,
  freshness: "REALTIME",
  departures: [{
    expectedAt: 1_788_000_120,
    aimedAt: 1_788_000_100,
    minutes: 2,
    status: "DELAYED",
    nextIntervalMinutes: 4,
  }],
};

function message(type: number, values: AppMessage = {}): AppMessage {
  return { SCHEMA_VERSION, MESSAGE_TYPE: type, ...values };
}

test("domain contracts expose every frozen enum and accept every field", () => {
  assert.deepEqual(FRESHNESS, ["REALTIME", "SCHEDULED", "MIXED", "STALE"]);
  assert.deepEqual(DEPARTURE_STATUS, ["ON_TIME", "DELAYED", "CANCELLED", "UNKNOWN"]);
  assert.deepEqual(ERROR_CODE, [
    "API_KEY_REQUIRED",
    "API_KEY_INVALID",
    "INVALID_SERVICE",
    "SOURCE_UNAVAILABLE",
    "RATE_LIMITED",
    "INVALID_RESPONSE",
  ]);
  assert.deepEqual(API_KEY_ACTION, ["KEEP", "REPLACE", "REMOVE"]);
  assert.equal(isFavorite(favorite), true);
  assert.equal(isDepartureResult(result), true);
  assert.equal(isErrorResult({
    schemaVersion: 1,
    requestId: "r",
    favoriteId: "home",
    code: "API_KEY_INVALID",
    occurredAt: 1,
    retryAfterSeconds: 60,
  }), true);
});

test("domain validators enforce exact fields, versions, bounds, and secret rules", () => {
  assert.equal(isFavorite({ ...favorite, unknown: true }), false);
  assert.equal(isFavorite({ ...favorite, schemaVersion: 2 }), false);
  assert.equal(isFavorite({ ...favorite, stopLabel: "é".repeat(49) }), false);
  assert.equal(isFavorite({ ...favorite, stopLabel: "unsafe\u0001label" }), false);
  assert.equal(isFavorite({ ...favorite, lineMode: "metro" }), false);
  assert.equal(isFavorite({ ...favorite, lineColor: "#FFBE00" }), false);
  assert.equal(isFavorite({ ...favorite, lineTextColor: "000000" }), false);
  const {
    lineMode: _legacyLineMode,
    lineColor: _legacyLineColor,
    lineTextColor: _legacyLineTextColor,
    ...legacyFavorite
  } = favorite;
  assert.equal(isFavorite(legacyFavorite), true);
  assert.equal(isFavorite({ ...legacyFavorite, lineMode: favorite.lineMode }), false);
  assert.equal(isFavorite({
    ...legacyFavorite,
    lineMode: favorite.lineMode,
    lineColor: favorite.lineColor,
  }), false);
  assert.equal(isFavorite({ ...legacyFavorite, lineMode: undefined }), false);
  const { lineColor: _favoriteLineColor, ...favoriteWithoutColor } = favorite;
  assert.equal(isFavorite(favoriteWithoutColor), false);
  assert.equal(utf8Bytes("é".repeat(48)), LIMITS.labelUtf8Bytes);
  assert.equal(isDepartureResult({
    ...result,
    departures: Array.from({ length: LIMITS.departures + 1 }, () => result.departures[0]),
  }), false);
  assert.equal(isDepartureResult({ ...result, freshness: "FRESH" }), false);
  assert.equal(isErrorResult({
    schemaVersion: 1,
    requestId: "r",
    code: "SECRET",
    occurredAt: 1,
  }), false);
  assert.equal(isApiKeyUpdate({ schemaVersion: 1, action: "KEEP" }), true);
  assert.equal(isApiKeyUpdate({ schemaVersion: 1, action: "REMOVE" }), true);
  assert.equal(isApiKeyUpdate({
    schemaVersion: 1,
    action: "REPLACE",
    value: "personal-key",
  }), true);
  assert.equal(isApiKeyUpdate({ schemaVersion: 1, action: "KEEP", value: "secret" }), false);
  assert.equal(isPersonalApiKey("x".repeat(LIMITS.apiKeyUtf8Bytes)), true);
  assert.equal(isPersonalApiKey("x".repeat(LIMITS.apiKeyUtf8Bytes + 1)), false);
  assert.equal(isPersonalApiKey("key\nheader"), false);
  assert.equal(isPersonalApiKey("key\u0001header"), false);
});

test("symbolic payload aliases retain the frozen explicit numeric order", () => {
  assert.equal(APP_MESSAGE_KEY_ORDER.length, 25);
  APP_MESSAGE_KEY_ORDER.forEach((name, index) => {
    assert.equal(APP_MESSAGE_KEY[name], index);
  });
  assert.deepEqual(
    Object.values(APP_MESSAGE_KEY).sort((left, right) => left - right),
    Array.from({ length: 25 }, (_, index) => index),
  );
  assert.deepEqual(KEY_STATUS, { MISSING: 0, CONFIGURED: 1, INVALID: 2 });
  assert.deepEqual(REQUEST_TRIGGER, {
    APP_OPEN: 0,
    FAVORITE_SELECTION: 1,
    MANUAL_SELECT: 2,
  });
  assert.equal(Object.keys(APP_MESSAGE_KEY).some((name) => /API_KEY|SECRET|TOKEN/u.test(name)), false);
});

test("dictionary sizing follows Pebble's measured-data formula", () => {
  assert.equal(dictionaryBytes([]), 1);
  assert.equal(dictionaryBytes([1, 4, cstringBytes("é")]), 1 + (7 * 3) + 1 + 4 + 3);
  assert.throws(() => dictionaryBytes([-1]), TypeError);
});

test("AppMessage validation accepts aliases only and contextualizes DISPLAY_NAME", () => {
  const request = message(MESSAGE_TYPE.REQUEST, {
    REQUEST_ID: "request-1",
    FAVORITE_ID: "home",
    REQUEST_TRIGGER: REQUEST_TRIGGER.MANUAL_SELECT,
  });
  assert.equal(isAppMessage(request), true);
  assert.equal(isAppMessage({
    ...request,
    0: SCHEMA_VERSION,
  }), false);
  assert.equal(isAppMessage(message(MESSAGE_TYPE.CONFIG_BEGIN, {
    REQUEST_ID: "config-1",
    ITEM_COUNT: 0,
    KEY_STATUS: KEY_STATUS.CONFIGURED,
    DISPLAY_NAME: "fr",
  })), true);
  assert.equal(isAppMessage(message(MESSAGE_TYPE.CONFIG_BEGIN, {
    REQUEST_ID: "config-1",
    ITEM_COUNT: 0,
    KEY_STATUS: KEY_STATUS.CONFIGURED,
    DISPLAY_NAME: "fr_FR",
  })), false);
});

test("configuration commits language and favorites atomically", () => {
  const receiver = new ProtocolReceiver();
  assert.equal(receiver.receive(message(MESSAGE_TYPE.CONFIG_BEGIN, {
    REQUEST_ID: "config-1",
    ITEM_COUNT: 1,
    KEY_STATUS: KEY_STATUS.CONFIGURED,
    DISPLAY_NAME: "fr",
  })), true);
  assert.equal(receiver.receive(message(MESSAGE_TYPE.FAVORITE, {
    REQUEST_ID: "config-1",
    ITEM_INDEX: 0,
    FAVORITE_ID: "home",
    SERVICE_ID: "opaque:1",
    DISPLAY_NAME: "Maison",
    STOP_LABEL: "Châtelet",
    LINE_LABEL: "1",
    DESTINATION_LABEL: "La Défense",
    SORT_ORDER: 0,
  })), true);
  assert.equal(receiver.committed.configuration, undefined);
  assert.equal(receiver.receive(message(MESSAGE_TYPE.CONFIG_COMMIT, {
    REQUEST_ID: "config-1",
  })), true);
  assert.equal(receiver.committed.configuration?.language, "fr");
  assert.equal(receiver.committed.configuration?.favorites.length, 1);
});

test("result staging requires request and favorite binding and preserves committed state", () => {
  const receiver = new ProtocolReceiver();
  const begin = message(MESSAGE_TYPE.RESULT_BEGIN, {
    REQUEST_ID: "request-1",
    FAVORITE_ID: "home",
    ITEM_COUNT: 1,
    FETCHED_AT: 1_788_000_000,
    FRESHNESS: 0,
  });
  const item = message(MESSAGE_TYPE.DEPARTURE, {
    REQUEST_ID: "request-1",
    FAVORITE_ID: "home",
    ITEM_INDEX: 0,
    EXPECTED_AT: 1_788_000_120,
    MINUTES: 2,
    DEPARTURE_STATUS: 0,
  });
  const commit = message(MESSAGE_TYPE.RESULT_COMMIT, {
    REQUEST_ID: "request-1",
    FAVORITE_ID: "home",
  });

  assert.equal(receiver.receive(begin), false);
  assert.equal(receiver.expectResponse("request-1", "home"), true);
  assert.equal(receiver.receive(begin), true);
  assert.equal(receiver.receive(item), true);
  assert.equal(receiver.receive(commit), true);
  const committed = receiver.committed.result;

  assert.equal(receiver.expectResponse("request-2", "home"), true);
  assert.equal(receiver.receive({ ...begin, REQUEST_ID: "late-request" }), false);
  assert.equal(receiver.receive({ ...begin, SCHEMA_VERSION: 99 }), false);
  assert.equal(receiver.committed.result, committed);
});

test("catalog contracts freeze routes, transport modes, error codes, and limits", () => {
  assert.deepEqual(CATALOG_ROUTE, {
    places: "/api/catalog/places",
    placeServices: "/api/catalog/places/:placeId/services",
  });
  assert.equal(Object.values(CATALOG_ROUTE).every((route) => route.startsWith("/api/catalog/")), true);
  assert.deepEqual(TRANSPORT_MODE, ["BUS", "METRO", "TRAM", "RER", "TRANSILIEN"]);
  assert.deepEqual(CATALOG_ERROR_CODE, [
    "INVALID_QUERY",
    "PLACE_NOT_FOUND",
    "CATALOG_UNAVAILABLE",
    "METHOD_NOT_ALLOWED",
  ]);
  assert.equal(LIMITS.catalogQueryMinCharacters, 2);
  assert.equal(LIMITS.catalogQueryMaxCharacters, 100);
  assert.equal(LIMITS.catalogSearchResults, 20);
});

test("catalog validators enforce exact public fields, bounds, and no raw source identifiers", () => {
  const opaque64 = "x".repeat(LIMITS.idUtf8Bytes);
  const placeItem = {
    placeId: `plc_${"A".repeat(43)}`,
    stopLabel: "Châtelet",
    localityLabel: "Paris",
    mode: "METRO",
  };
  const serviceOption = {
    serviceId: `svc_${"B".repeat(43)}`,
    stopLabel: "Châtelet",
    lineLabel: "Métro 1",
    destinationLabel: "La Défense",
    lineMode: "METRO",
    lineColor: "#ffbe00",
    lineTextColor: "#000000",
  };
  const requiredPlace = { placeId: placeItem.placeId, stopLabel: placeItem.stopLabel, mode: placeItem.mode };

  assert.equal(isPlaceSearchItem(placeItem), true);
  assert.equal(isPlaceSearchItem(requiredPlace), true);
  assert.equal(isPlaceSearchItem({ ...placeItem, localityLabel: undefined }), true);
  assert.equal(isPlaceSearchItem({ ...placeItem, placeId: opaque64 }), true);
  assert.equal(isPlaceSearchResult({ schemaVersion: SCHEMA_VERSION, places: [placeItem] }), true);
  assert.equal(isPlaceSearchResult({ schemaVersion: SCHEMA_VERSION, places: [] }), true);
  assert.equal(isServiceOption(serviceOption), true);
  assert.equal(isServiceOptionsResult({
    schemaVersion: SCHEMA_VERSION,
    placeId: placeItem.placeId,
    services: [serviceOption],
  }), true);
  CATALOG_ERROR_CODE.forEach((code) => {
    assert.equal(isCatalogErrorResult({ schemaVersion: SCHEMA_VERSION, code }), true);
  });

  assert.equal(isPlaceSearchItem({ ...placeItem, placeId: "x".repeat(LIMITS.idUtf8Bytes + 1) }), false);
  assert.equal(isPlaceSearchItem({ ...placeItem, stopLabel: "" }), false);
  assert.equal(isPlaceSearchItem({ ...placeItem, stopLabel: "é".repeat(LIMITS.labelUtf8Bytes / 2 + 1) }), false);
  assert.equal(isPlaceSearchItem({ ...placeItem, mode: "TER" }), false);
  assert.equal(isPlaceSearchItem({ ...placeItem, mode: "bus" }), false);
  assert.equal(isPlaceSearchItem({ ...placeItem, monitoringRef: "StopPoint:Q-1" }), false);
  assert.equal(isPlaceSearchItem({ ...requiredPlace, lineRef: "C-01234" }), false);
  assert.equal(isPlaceSearchItem({ ...requiredPlace, q: "chatelet" }), false);

  const places20 = Array.from({ length: LIMITS.catalogSearchResults }, () => placeItem);
  assert.equal(isPlaceSearchResult({ schemaVersion: SCHEMA_VERSION, places: places20 }), true);
  assert.equal(isPlaceSearchResult({ schemaVersion: SCHEMA_VERSION, places: [...places20, placeItem] }), false);
  assert.equal(isPlaceSearchResult({ schemaVersion: SCHEMA_VERSION, places: [{ ...placeItem, unknown: true }] }), false);
  assert.equal(isPlaceSearchResult({ schemaVersion: 2, places: [] }), false);
  assert.equal(isPlaceSearchResult({ schemaVersion: SCHEMA_VERSION }), false);
  assert.equal(isPlaceSearchResult({ schemaVersion: SCHEMA_VERSION, places: [], extra: 1 }), false);

  assert.equal(isServiceOption({ ...serviceOption, serviceId: opaque64 }), true);
  assert.equal(isServiceOption({ ...serviceOption, destinationLabel: "" }), false);
  assert.equal(isServiceOption({ ...serviceOption, lineMode: "metro" }), false);
  assert.equal(isServiceOption({ ...serviceOption, lineMode: "TER" }), false);
  assert.equal(isServiceOption({ ...serviceOption, lineColor: "#FFBE00" }), false);
  assert.equal(isServiceOption({ ...serviceOption, lineColor: "#12345" }), false);
  assert.equal(isServiceOption({ ...serviceOption, lineTextColor: "transparent" }), false);
  const { lineTextColor: _lineTextColor, ...serviceWithoutTextColor } = serviceOption;
  assert.equal(isServiceOption(serviceWithoutTextColor), false);
  assert.equal(isServiceOption({ ...serviceOption, directionId: 1 }), false);
  assert.equal(isServiceOption({ ...serviceOption, destinationRef: "Q-1" }), false);
  assert.equal(isServiceOption({ serviceId: opaque64, stopLabel: "Châtelet", lineLabel: "1" }), false);
  const servicesBeyondLimit = Array.from({ length: LIMITS.catalogSearchResults + 1 }, () => serviceOption);
  assert.equal(isServiceOptionsResult({
    schemaVersion: SCHEMA_VERSION,
    placeId: opaque64,
    services: servicesBeyondLimit,
  }), true);
  assert.equal(isServiceOptionsResult({
    schemaVersion: SCHEMA_VERSION,
    placeId: placeItem.placeId,
    services: servicesBeyondLimit,
    apiKey: "secret",
  }), false);
  assert.equal(isServiceOptionsResult({ schemaVersion: SCHEMA_VERSION, placeId: placeItem.placeId, services: "all" }), false);

  assert.equal(isCatalogErrorResult({ schemaVersion: SCHEMA_VERSION, code: "INVALID_SERVICE" }), false);
  assert.equal(isCatalogErrorResult({ schemaVersion: SCHEMA_VERSION, code: "INVALID_QUERY", requestId: "r" }), false);
  assert.equal(isCatalogErrorResult({ code: "INVALID_QUERY" }), false);
});
