import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  API_KEY_ACTION,
  APP_MESSAGE_INBOX_BYTES,
  APP_MESSAGE_KEYS,
  APP_MESSAGE_OUTBOX_BYTES,
  CATALOG_ERROR_CODE,
  DEPARTURE_STATUS,
  CONFIG_MODE,
  DISPLAY_WIRE_VERSION,
  ERROR_CODE,
  FRESHNESS,
  KEY_STATUS,
  LIMITS,
  MESSAGE_TYPE,
  REQUEST_TRIGGER,
  SCHEMA_VERSION,
  TRAFFIC_STATE,
  TRANSPORT_MODE,
  USEFUL_STALE_SECONDS,
  cstringBytes,
  dictionaryBytes,
  isApiKeyUpdate,
  isAppMessage,
  isCatalogErrorResult,
  isConfigurationRequestId,
  isDataRequestId,
  isDisplayCorrelationToken,
  isDisplayEpoch,
  isDisplayHash,
  isDepartureResult,
  isDepartureSnapshot,
  isErrorResult,
  isFavorite,
  isPhoneFavorite,
  isOverviewRequest,
  isOverviewResult,
  isPersonalApiKey,
  isPlaceLine,
  isPlaceSearchItem,
  isPlaceSearchResult,
  isServiceOption,
  isServiceRouting,
  isServiceOptionsResult,
  isTrafficDetailRequest,
  isTrafficDetailResult,
  utf8Bytes,
} from "../src/index.ts";

const companion = createRequire(import.meta.url)("../../companion/src/contracts.js");
const layout = createRequire(import.meta.url)("../../companion/src/display-layout.js");
const epoch = "123456789abcdef";
const requestId = epoch + "r00000001";
const configurationId = epoch + "c00000001";

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

const routing = {
  monitoringRef: "STIF:StopPoint:Q:12345:",
  lineRef: "STIF:Line::C01371:",
  destinationRef: "STIF:StopPoint:Q:67890:",
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

function message(type: number, values: Record<string, unknown> = {}): Record<string, unknown> {
  return { SCHEMA_VERSION: DISPLAY_WIRE_VERSION, MESSAGE_TYPE: type, ...values };
}

function acceptsWire(value: unknown, expected: boolean): void {
  assert.equal(isAppMessage(value), expected);
  assert.equal(companion.isAppMessage(value), expected);
}

function appearanceParts(record: string) {
  const scalars = Array.from(record);
  const fields: string[] = [];
  let offset = 0, hashStart = 0, hashEnd = 0;
  for (let i = 0; i < 5; i++) {
    const start = offset;
    const count = Number.parseInt(scalars.slice(offset, offset + 3).join(""), 16);
    offset += 3;
    fields.push(scalars.slice(offset, offset + count).join(""));
    offset += count;
    if (i === 1) { hashStart = start; hashEnd = offset; }
  }
  return {
    fields,
    suffix: scalars.slice(offset).join(""),
    withoutHash: scalars.slice(0, hashStart).join("") + scalars.slice(hashEnd).join(""),
  };
}

function departureRecord(count: number): string {
  return ["01", "00000001", "0", "00", "3", "00000001", count.toString(16)].join("")
    + "000000020".repeat(count);
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
    "NO_CACHED_DATA",
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

test("phone routing stays exact and separate from the canonical favorite", () => {
  const phoneFavorite = { ...favorite, routing };
  for (const validate of [isServiceRouting, companion.isServiceRouting]) {
    assert.equal(validate(routing), true);
    assert.equal(validate({ ...routing, monitoringRef: "x".repeat(4096) }), true);
    assert.equal(validate({ ...routing, apiKey: "secret" }), false);
    assert.equal(validate({ ...routing, lineRef: "" }), false);
    assert.equal(validate({ ...routing, directionId: "0" }), false);
    const { destinationRef: _destinationRef, ...partial } = routing;
    assert.equal(validate(partial), false);
  }
  for (const validate of [isPhoneFavorite, companion.isPhoneFavorite]) {
    assert.equal(validate(phoneFavorite), true);
    assert.equal(validate(favorite), true);
    assert.equal(validate({ ...favorite, routing: undefined }), false);
    assert.equal(validate({ ...favorite, routing: { ...routing, token: "secret" } }), false);
    assert.equal(validate({ ...phoneFavorite, lineColor: "#FFBE00" }), false);
    assert.equal(validate({ ...phoneFavorite, unexpected: true }), false);
  }
  assert.equal(isFavorite(phoneFavorite), false);
  assert.equal(companion.isFavorite(phoneFavorite), false);
  assert.equal(companion.isPhoneFavoriteList([phoneFavorite, phoneFavorite]), false);
  assert.equal(companion.isPhoneFavoriteList([phoneFavorite, { ...phoneFavorite, id: "work" }]), true);
  const phoneCopy = companion.copyPhoneFavorite(phoneFavorite);
  phoneCopy.routing.lineRef = "changed";
  assert.equal(phoneFavorite.routing.lineRef, "STIF:Line::C01371:");
  assert.deepEqual(companion.copyFavorite(phoneFavorite), favorite);
});

test("six favorites are accepted uniformly without relaxing required domain fields", () => {
  const six = Array.from({ length: 6 }, (_, sortOrder) => ({
    ...favorite, id: `favorite-${sortOrder}`, sortOrder,
  }));
  for (const validate of [companion.isFavoriteList, companion.isPhoneFavoriteList]) {
    assert.equal(validate(six), true);
    assert.equal(validate([...six, { ...favorite, id: "seventh", sortOrder: 0 }]), false);
  }
  for (const validate of [isFavorite, companion.isFavorite, isPhoneFavorite, companion.isPhoneFavorite]) {
    assert.equal(validate(six[5]), true);
    assert.equal(validate({ ...favorite, sortOrder: 6 }), false);
    const { serviceId: _serviceId, ...noService } = favorite;
    const { sortOrder: _sortOrder, ...noOrder } = favorite;
    assert.equal(validate(noService), false);
    assert.equal(validate(noOrder), false);
  }
});

test("D2 appearance hashes canonical UTF-8 bytes in both directions and counts scalar fields", () => {
  const unicode = {
    ...favorite, id: "home🚉", lineLabel: "A🚆",
    stopLabel: "Châtelet e\u0301 🚉", destinationLabel: "🇫🇷 La Défense",
  };
  for (const profile of [0, 1]) for (const language of ["en", "fr"]) {
    for (const value of [favorite, unicode]) {
      const record = layout.prepareAppearance(value, profile, language);
      const parsed = appearanceParts(record);
      const bytes = Buffer.from(`D2${profile}${language}${parsed.withoutHash}`, "utf8");
      const lane = (input: Buffer, seed: number) => input.reduce(
        (hash, byte) => Math.imul(hash ^ byte, 16777619) >>> 0, seed,
      ).toString(16).padStart(8, "0");
      assert.equal(parsed.fields[1], lane(bytes, 2166136261) + lane(Buffer.from(bytes).reverse(), 3335557771));
      assert.deepEqual(parsed.fields.filter((_, index) => index !== 1), [
        value.id, value.lineLabel, value.stopLabel, value.destinationLabel,
      ]);
      assert.ok(Buffer.byteLength(record, "utf8") <= 448);
      acceptsWire(message(MESSAGE_TYPE.FAVORITE, {
        REQUEST_ID: configurationId, DISPLAY_GENERATION: 1, ITEM_INDEX: 0, DISPLAY_RECORD: record,
      }), true);
    }
  }
  const original = layout.prepareAppearance(unicode, 0, "fr");
  assert.equal(layout.prepareAppearance({
    ...unicode, serviceId: "different-service", displayName: "Other", sortOrder: 5, routing,
  }, 0, "fr"), original);
  assert.notEqual(appearanceParts(layout.prepareAppearance({ ...unicode, lineColor: "#123456" }, 0, "fr")).fields[1],
    appearanceParts(original).fields[1]);
  assert.throws(() => layout.prepareAppearance({ ...unicode, id: "\ud800" }, 0, "fr"), TypeError);
});

test("appearance clip endpoints preserve supplementary glyph boundaries and fit native widths", () => {
  const value = {
    ...favorite, lineLabel: "🚉W".repeat(12), stopLabel: "🚆Châtelet ".repeat(5),
    destinationLabel: "🇫🇷 Défense ".repeat(4),
  };
  for (const profile of [0, 1]) {
    const parsed = appearanceParts(layout.prepareAppearance(value, profile, "fr"));
    const widths = [28, 36, 38, profile ? 73 : 72, profile ? 96 : 84, profile ? 83 : 71,
      profile ? 67 : 84, profile ? 54 : 71, profile ? 116 : 132,
      profile ? 86 : 74, profile ? 73 : 61, profile ? 106 : 122];
    const mask = Number.parseInt(parsed.suffix.slice(36), 16);
    for (let slot = 0; slot < 12; slot++) {
      const label = parsed.fields[slot < 4 ? 2 : slot < 9 ? 3 : 4];
      const end = Number.parseInt(parsed.suffix.slice(12 + slot * 2, 14 + slot * 2), 16);
      const scalars = Array.from(label);
      const rendered = scalars.slice(0, end).join("") + (mask & (1 << slot) ? "…" : "");
      assert.ok(end <= scalars.length);
      assert.ok(layout.measured(rendered, slot === 3 || slot >= 9 ? 0 : 1) <= widths[slot]);
    }
  }
});

test("D2 retains explicit non-contiguous application IDs without SDK or domain aliases", () => {
  const frozen = {
    SCHEMA_VERSION: 0, MESSAGE_TYPE: 1, REQUEST_ID: 2, FAVORITE_ID: 3,
    KEY_STATUS: 10, ITEM_COUNT: 11, ITEM_INDEX: 12, REQUEST_TRIGGER: 24,
    CONFIG_NEED_MASK: 35, CONFIG_MODE: 36, LANGUAGE: 37, DISPLAY_RECORD: 38,
    DISPLAY_PROFILE: 39, DISPLAY_KIND: 40, DISPLAY_GENERATION: 41, CLOCK_12H: 42,
    DISPLAY_HASH: 43, WATCH_SESSION_ID: 44, DISPLAY_EPOCH: 45,
  };
  assert.deepEqual(APP_MESSAGE_KEYS, frozen);
  assert.deepEqual(companion.APP_MESSAGE_KEYS, frozen);
  assert.deepEqual(KEY_STATUS, { MISSING: 0, CONFIGURED: 1, INVALID: 2 });
  assert.deepEqual(REQUEST_TRIGGER, { APP_OPEN: 0, FAVORITE_SELECTION: 1, MANUAL_SELECT: 2, CACHE_ONLY: 5 });
  assert.equal(APP_MESSAGE_INBOX_BYTES, 768);
  assert.equal(APP_MESSAGE_OUTBOX_BYTES, 192);
});

test("dictionary sizing follows Pebble's measured-data formula", () => {
  assert.equal(dictionaryBytes([]), 1);
  assert.equal(dictionaryBytes([1, 4, cstringBytes("é")]), 1 + (7 * 3) + 1 + 4 + 3);
  assert.throws(() => dictionaryBytes([-1]), TypeError);
});

test("D2 separates watch epochs, data counters, configuration generations and correlation tokens", () => {
  for (const validate of [isDisplayEpoch, companion.isDisplayEpoch]) {
    assert.equal(validate(epoch), true);
    for (const invalid of ["000000000000000", epoch + "f", epoch.toUpperCase(), "two words"]) {
      assert.equal(validate(invalid), false);
    }
  }
  for (const validate of [isDataRequestId, companion.isDataRequestId]) {
    assert.equal(validate(requestId), true);
    for (const invalid of [configurationId, epoch + "r00000000", "000000000000000r00000001", requestId + "0"]) {
      assert.equal(validate(invalid), false);
    }
  }
  for (const validate of [isConfigurationRequestId, companion.isConfigurationRequestId]) {
    assert.equal(validate(configurationId), true);
    assert.equal(validate(requestId), false);
    assert.equal(validate(epoch + "c00000000"), false);
  }
  for (const validate of [isDisplayCorrelationToken, companion.isDisplayCorrelationToken]) {
    assert.equal(validate("!".repeat(24)), true);
    for (const invalid of ["", "!".repeat(25), "with space", "é", "bad\n"]) assert.equal(validate(invalid), false);
  }
  for (const validate of [isDisplayHash, companion.isDisplayHash]) {
    assert.equal(validate("0123456789abcdef"), true);
    for (const invalid of ["0123456789abcde", "0123456789abcdeF", "0123456789abcdef\n"]) {
      assert.equal(validate(invalid), false);
    }
  }
  const ready = message(MESSAGE_TYPE.DISPLAY_READY, { REQUEST_ID: "phone-open-1" });
  acceptsWire(ready, true);
  acceptsWire({ ...ready, SCHEMA_VERSION: 1 }, false);
  acceptsWire({ ...ready, DISPLAY_GENERATION: 1 }, false);
  acceptsWire({ ...ready, 0: DISPLAY_WIRE_VERSION }, false);
  acceptsWire({ 15025: 1 }, false);
  const hello = message(MESSAGE_TYPE.DISPLAY_HELLO, {
    REQUEST_ID: "phone-open-1", WATCH_SESSION_ID: "watch-open-1", DISPLAY_PROFILE: 1, CLOCK_12H: 1, DISPLAY_EPOCH: epoch,
  });
  acceptsWire(hello, true);
  acceptsWire({ ...hello, DISPLAY_PROFILE: 2 }, false);
  acceptsWire({ ...hello, CLOCK_12H: 2 }, false);
  acceptsWire({ ...hello, DISPLAY_EPOCH: "000000000000000" }, false);
  const { WATCH_SESSION_ID: _session, ...missingSession } = hello;
  acceptsWire(missingSession, false);
});

test("configuration dictionaries require the c-generation and exact six-slot inventory bounds", () => {
  const context = { REQUEST_ID: configurationId, DISPLAY_GENERATION: 1 };
  const begin = message(MESSAGE_TYPE.CONFIG_BEGIN, {
    ...context, ITEM_COUNT: 6, KEY_STATUS: KEY_STATUS.CONFIGURED, CONFIG_MODE: CONFIG_MODE.DIFF,
    LANGUAGE: "fr", DISPLAY_PROFILE: 0,
  });
  const entry = message(MESSAGE_TYPE.CONFIG_ENTRY, {
    ...context, ITEM_INDEX: 5, FAVORITE_ID: "home", DISPLAY_HASH: "0123456789abcdef",
  });
  const need = message(MESSAGE_TYPE.CONFIG_NEED, {
    ...context, CONFIG_NEED_MASK: 63, DISPLAY_PROFILE: 0, CLOCK_12H: 0,
  });
  const commit = message(MESSAGE_TYPE.CONFIG_COMMIT, context);
  for (const dictionary of [begin, entry, need, commit]) {
    acceptsWire(dictionary, true);
    acceptsWire({ ...dictionary, REQUEST_ID: requestId }, false);
    acceptsWire({ ...dictionary, DISPLAY_GENERATION: 2 }, false);
    acceptsWire({ ...dictionary, SERVICE_ID: "not-on-watch" }, false);
  }
  acceptsWire({ ...begin, CONFIG_MODE: CONFIG_MODE.FULL, ITEM_COUNT: 0 }, true);
  acceptsWire({ ...begin, ITEM_COUNT: 7 }, false);
  acceptsWire({ ...begin, CONFIG_MODE: 2 }, false);
  acceptsWire({ ...begin, LANGUAGE: "fr_FR" }, false);
  const { DISPLAY_PROFILE: _profile, ...missingProfile } = begin;
  acceptsWire(missingProfile, false);
  acceptsWire({ ...entry, ITEM_INDEX: 6 }, false);
  acceptsWire({ ...entry, DISPLAY_HASH: "bad" }, false);
  acceptsWire({ ...need, CONFIG_NEED_MASK: 0 }, true);
  for (const mask of [-1, 64, 0.5, "1"]) acceptsWire({ ...need, CONFIG_NEED_MASK: mask }, false);
  acceptsWire({ ...commit, CONFIG_NEED_MASK: 0 }, false);
});

test("data request admission distinguishes user detail, overview and cache-only triggers", () => {
  const context = { REQUEST_ID: requestId, DISPLAY_GENERATION: 1 };
  const detail = message(MESSAGE_TYPE.REQUEST, { ...context, FAVORITE_ID: "home", REQUEST_TRIGGER: 1 });
  const overview = message(MESSAGE_TYPE.OVERVIEW_REQUEST, { ...context, REQUEST_TRIGGER: 0 });
  const traffic = message(MESSAGE_TYPE.TRAFFIC_REQUEST, { ...context, FAVORITE_ID: "home" });
  for (const dictionary of [detail, overview, traffic]) {
    acceptsWire(dictionary, true);
    acceptsWire({ ...dictionary, REQUEST_ID: configurationId }, false);
    acceptsWire({ ...dictionary, DISPLAY_GENERATION: 0 }, false);
    acceptsWire({ ...dictionary, DISPLAY_GENERATION: 0x100000000 }, false);
  }
  for (const trigger of [1, 2, 5]) acceptsWire({ ...detail, REQUEST_TRIGGER: trigger }, true);
  for (const trigger of [0, 2, 5]) acceptsWire({ ...overview, REQUEST_TRIGGER: trigger }, true);
  acceptsWire({ ...detail, REQUEST_TRIGGER: 0 }, false);
  acceptsWire({ ...overview, REQUEST_TRIGGER: 1 }, false);
  acceptsWire({ ...overview, FAVORITE_ID: "home" }, false);
  acceptsWire({ ...traffic, REQUEST_TRIGGER: 5 }, false);
});

test("catalog contracts freeze transport modes, error codes, and limits", () => {
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
  assert.equal(USEFUL_STALE_SECONDS, 15 * 60);
  assert.equal(companion.USEFUL_STALE_SECONDS, USEFUL_STALE_SECONDS);
});

test("place lines require complete display metadata within the existing label and color bounds", () => {
  const line = { lineLabel: "13", lineColor: "#82c8e6", lineTextColor: "#000000" };
  const place = { placeId: `plc_${"A".repeat(43)}`, stopLabel: "Université", mode: "METRO", lines: [line] };
  assert.equal(isPlaceLine(line), true);
  assert.equal(isPlaceSearchItem(place), true);
  assert.equal(isPlaceLine({ ...line, lineLabel: "é".repeat(LIMITS.labelUtf8Bytes / 2) }), true);

  const { lines: _lines, ...withoutLines } = place;
  assert.equal(isPlaceSearchItem(withoutLines), false);
  for (const invalid of [undefined, null, {}, line, [], [null], new Array(1)]) {
    assert.equal(isPlaceSearchItem({ ...place, lines: invalid }), false);
  }
  for (const field of ["lineLabel", "lineColor", "lineTextColor"] as const) {
    const missing: Partial<typeof line> = { ...line };
    delete missing[field];
    assert.equal(isPlaceLine(missing), false);
    assert.equal(isPlaceSearchItem({ ...place, lines: [missing] }), false);
  }
  for (const invalid of [
    { ...line, lineLabel: "" },
    { ...line, lineLabel: "é".repeat(LIMITS.labelUtf8Bytes / 2 + 1) },
    { ...line, lineLabel: "13\n" },
    { ...line, lineColor: "#82C8E6" },
    { ...line, lineColor: "#12345" },
    { ...line, lineTextColor: "transparent" },
    { ...line, lineMode: "METRO" },
    { ...line, lineRef: "STIF:Line::C01313:" },
    { ...line, destinationLabel: "Terminus" },
  ]) {
    assert.equal(isPlaceLine(invalid), false);
    assert.equal(isPlaceSearchItem({ ...place, lines: [invalid] }), false);
  }
  // The response byte bound, not an arbitrary line-count limit, controls transport size.
  assert.equal(isPlaceSearchItem({
    ...place,
    lines: Array.from({ length: 65 }, (_, index) => ({ ...line, lineLabel: String(index) })),
  }), true);
});

test("catalog validators require phone routing and keep place search display-only", () => {
  const opaque64 = "x".repeat(LIMITS.idUtf8Bytes);
  const placeItem = {
    placeId: `plc_${"A".repeat(43)}`,
    stopLabel: "Châtelet",
    localityLabel: "Paris",
    mode: "METRO",
    lines: [{ lineLabel: "4", lineColor: "#cf009e", lineTextColor: "#ffffff" }],
  };
  const serviceOption = {
    serviceId: `svc_${"B".repeat(43)}`,
    stopLabel: "Châtelet",
    lineLabel: "Métro 1",
    destinationLabel: "La Défense",
    lineMode: "METRO",
    lineColor: "#ffbe00",
    lineTextColor: "#000000",
    routing,
  };
  const requiredPlace = { placeId: placeItem.placeId, stopLabel: placeItem.stopLabel, mode: placeItem.mode, lines: placeItem.lines };

  assert.equal(isPlaceSearchItem(placeItem), true);
  assert.equal(isPlaceSearchItem(requiredPlace), true);
  assert.equal(isPlaceSearchItem({ ...placeItem, localityLabel: undefined }), true);
  assert.equal(isPlaceSearchItem({ ...placeItem, placeId: opaque64 }), true);
  assert.equal(isPlaceSearchResult({ schemaVersion: SCHEMA_VERSION, places: [placeItem] }), true);
  assert.equal(isPlaceSearchResult({ schemaVersion: SCHEMA_VERSION, places: [] }), true);
  assert.equal(isServiceOption(serviceOption), true);
  const { routing: _routing, ...unroutedService } = serviceOption;
  assert.equal(isServiceOption(unroutedService), false);
  assert.equal(isServiceOption({ ...serviceOption, routing: { ...routing, apiKey: "secret" } }), false);
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

test("overview contracts preserve request order and isolate per-favorite failures", () => {
  const request = {
    schemaVersion: SCHEMA_VERSION,
    requestId: "overview-1",
    language: "fr",
    favorites: [
      { favoriteId: "home", serviceId: "shared-service" },
      { favoriteId: "work", serviceId: "shared-service" },
    ],
  };
  const snapshot = {
    fetchedAt: 1_788_000_000,
    sourceUpdatedAt: 1_787_999_990,
    freshness: "REALTIME",
    departures: result.departures,
  };
  const overview = {
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    items: [
      {
        favoriteId: "home",
        departures: { status: "AVAILABLE", data: snapshot },
        traffic: {
          state: "DELAYED",
          checkedAt: 1_788_000_001,
          sourceUpdatedAt: 1_787_999_980,
        },
      },
      {
        favoriteId: "work",
        departures: {
          status: "UNAVAILABLE",
          error: {
            code: "SOURCE_UNAVAILABLE",
            occurredAt: 1_788_000_002,
            retryAfterSeconds: 30,
          },
        },
        traffic: { state: "UNKNOWN", checkedAt: 1_788_000_002 },
      },
    ],
  };
  const maximumFavorites = Array.from({ length: LIMITS.favorites }, (_, index) => ({
    favoriteId: `favorite-${index}`,
    serviceId: "one-shared-service",
  }));

  assert.deepEqual(TRAFFIC_STATE, ["NORMAL", "DELAYED", "STOPPED", "UNKNOWN"]);
  assert.equal(LIMITS.trafficTitleUtf8Bytes, 96);
  assert.equal(LIMITS.trafficTextUtf8Bytes, 384);
  assert.equal(isDepartureSnapshot(snapshot), true);
  assert.equal(isDepartureResult(result), true);
  assert.equal(isOverviewRequest(request), true);
  assert.equal(isOverviewRequest({ ...request, favorites: maximumFavorites }), true);
  assert.equal(isOverviewResult(overview, request), true);

  assert.equal(isOverviewRequest({ ...request, favorites: [] }), false);
  assert.equal(isOverviewRequest({
    ...request,
    favorites: [...maximumFavorites, { favoriteId: "extra", serviceId: "one-shared-service" }],
  }), false);
  assert.equal(isOverviewRequest({
    ...request,
    favorites: [
      { favoriteId: "home", serviceId: "service-a" },
      { favoriteId: "home", serviceId: "service-b" },
    ],
  }), false);
  assert.equal(isOverviewRequest({
    ...request,
    favorites: [{ favoriteId: "home", serviceId: "service", sortOrder: 0 }],
  }), false);
  assert.equal(isOverviewRequest({ ...request, language: "fr_FR" }), false);
  assert.equal(isOverviewRequest({ ...request, requestId: "x".repeat(LIMITS.idUtf8Bytes + 1) }), false);
  assert.equal(isOverviewRequest({ ...request, extra: true }), false);

  assert.equal(isOverviewResult({ ...overview, requestId: "other" }, request), false);
  assert.equal(isOverviewResult({ ...overview, items: overview.items.slice(0, 1) }, request), false);
  assert.equal(isOverviewResult({
    ...overview,
    items: [overview.items[1], overview.items[0]],
  }, request), false);
  assert.equal(isOverviewResult({
    ...overview,
    items: [
      {
        ...overview.items[0],
        departures: {
          status: "UNAVAILABLE",
          error: { code: "API_KEY_REQUIRED", occurredAt: 1 },
        },
      },
      overview.items[1],
    ],
  }, request), false);
  assert.equal(isOverviewResult({
    ...overview,
    items: [
      overview.items[0],
      {
        ...overview.items[1],
        traffic: {
          state: "UNKNOWN",
          checkedAt: 1,
          sourceUpdatedAt: 1,
        },
      },
    ],
  }, request), false);
  assert.equal(isOverviewResult({
    ...overview,
    items: [
      {
        ...overview.items[0],
        departures: {
          status: "AVAILABLE",
          data: { ...snapshot, privateLineRef: "IDFM:C01742" },
        },
      },
      overview.items[1],
    ],
  }, request), false);
  assert.equal(isOverviewResult({ ...overview, internal: true }, request), false);
});

test("traffic detail contracts enforce discriminants, UTF-8 bounds, and plain text", () => {
  const request = {
    schemaVersion: SCHEMA_VERSION,
    requestId: "traffic-1",
    favoriteId: "home",
    serviceId: "opaque-service",
    language: "en",
  };
  const delayed = {
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    favoriteId: request.favoriteId,
    state: "DELAYED",
    checkedAt: 0xffff_ffff,
    sourceUpdatedAt: 0xffff_ffff,
    validFrom: 0,
    validUntil: 0xffff_ffff,
    title: "é".repeat(48),
    text: `\t\n${"é".repeat(191)}`,
  };

  assert.equal(utf8Bytes(delayed.title), LIMITS.trafficTitleUtf8Bytes);
  assert.equal(utf8Bytes(delayed.text), LIMITS.trafficTextUtf8Bytes);
  assert.equal(isTrafficDetailRequest(request), true);
  assert.equal(isTrafficDetailResult(delayed), true);
  assert.equal(isTrafficDetailResult({ ...delayed, state: "STOPPED" }), true);
  assert.equal(isTrafficDetailResult({
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    favoriteId: request.favoriteId,
    state: "NORMAL",
    checkedAt: 1,
    sourceUpdatedAt: 1,
  }), true);
  assert.equal(isTrafficDetailResult({
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    favoriteId: request.favoriteId,
    state: "UNKNOWN",
    checkedAt: 1,
  }), true);

  assert.equal(isTrafficDetailRequest({ ...request, language: "EN" }), false);
  assert.equal(isTrafficDetailRequest({ ...request, serviceId: "" }), false);
  assert.equal(isTrafficDetailRequest({ ...request, extra: true }), false);
  assert.equal(isTrafficDetailResult({ ...delayed, title: "" }), false);
  assert.equal(isTrafficDetailResult({ ...delayed, title: `${delayed.title}x` }), false);
  assert.equal(isTrafficDetailResult({ ...delayed, title: "two\nlines" }), false);
  assert.equal(isTrafficDetailResult({ ...delayed, title: "tab\tinside" }), false);
  assert.equal(isTrafficDetailResult({ ...delayed, title: "line\u2028break" }), false);
  assert.equal(isTrafficDetailResult({ ...delayed, title: "control\u0085char" }), false);
  assert.equal(isTrafficDetailResult({ ...delayed, text: `${delayed.text}x` }), false);
  assert.equal(isTrafficDetailResult({ ...delayed, text: "bad\rcarriage-return" }), false);
  assert.equal(isTrafficDetailResult({ ...delayed, text: "bad\u000bvertical-tab" }), false);
  assert.equal(isTrafficDetailResult({ ...delayed, text: "bad\u0085control" }), false);
  assert.equal(isTrafficDetailResult({ ...delayed, checkedAt: 0x1_0000_0000 }), false);
  assert.equal(isTrafficDetailResult({ ...delayed, validFrom: -1 }), false);
  assert.equal(isTrafficDetailResult({
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    favoriteId: request.favoriteId,
    state: "NORMAL",
    checkedAt: 1,
    title: "No disruption",
  }), false);
  assert.equal(isTrafficDetailResult({
    schemaVersion: SCHEMA_VERSION,
    requestId: request.requestId,
    favoriteId: request.favoriteId,
    state: "UNKNOWN",
    checkedAt: 1,
    sourceUpdatedAt: 1,
  }), false);
  assert.equal(isTrafficDetailResult({ ...delayed, debug: true }), false);
});

test("packed result dictionaries enforce kind-specific counts and favorite binding", () => {
  const context = { REQUEST_ID: requestId, DISPLAY_GENERATION: 1 };
  const overview = message(MESSAGE_TYPE.DISPLAY_BEGIN, { ...context, DISPLAY_KIND: 0, ITEM_COUNT: 6 });
  const detail = message(MESSAGE_TYPE.DISPLAY_BEGIN, {
    ...context, DISPLAY_KIND: 1, ITEM_COUNT: 1, FAVORITE_ID: "home",
  });
  const traffic = message(MESSAGE_TYPE.DISPLAY_BEGIN, {
    ...context, DISPLAY_KIND: 2, ITEM_COUNT: 2, FAVORITE_ID: "home",
  });
  for (const dictionary of [overview, detail, traffic]) acceptsWire(dictionary, true);
  acceptsWire({ ...overview, ITEM_COUNT: 7 }, false);
  acceptsWire({ ...overview, FAVORITE_ID: "home" }, false);
  acceptsWire({ ...detail, ITEM_COUNT: 2 }, false);
  acceptsWire({ ...traffic, ITEM_COUNT: 3 }, false);
  const { FAVORITE_ID: _favoriteId, ...unbound } = detail;
  acceptsWire(unbound, false);
  const record = message(MESSAGE_TYPE.DISPLAY_RECORD, {
    ...context, DISPLAY_KIND: 1, ITEM_INDEX: 0, DISPLAY_RECORD: departureRecord(4),
  });
  acceptsWire(record, true);
  acceptsWire({ ...record, DISPLAY_KIND: 0 }, false);
  acceptsWire({ ...record, DISPLAY_KIND: 0, ITEM_INDEX: 5, DISPLAY_RECORD: departureRecord(1) }, true);
  acceptsWire({ ...record, DISPLAY_KIND: 0, ITEM_INDEX: 6, DISPLAY_RECORD: departureRecord(1) }, false);
  acceptsWire({ ...record, ITEM_INDEX: 1 }, false);
  acceptsWire({ ...record, DISPLAY_RECORD: departureRecord(4) + "0" }, false);
  acceptsWire({ ...record, DISPLAY_RECORD: "04" + departureRecord(1).slice(2) }, false);
  acceptsWire({ ...record, DISPLAY_RECORD: departureRecord(1).slice(0, -1) + "4" }, false);
  acceptsWire({ ...record, FAVORITE_ID: "home" }, false);
  acceptsWire(message(MESSAGE_TYPE.DISPLAY_COMMIT, { ...context, DISPLAY_KIND: 2 }), true);
});

test("traffic fragment validation allows continuations but keeps error and UTF-8 bounds strict", () => {
  const record = message(MESSAGE_TYPE.DISPLAY_RECORD, {
    REQUEST_ID: requestId, DISPLAY_GENERATION: 1, DISPLAY_KIND: 2, ITEM_INDEX: 0, DISPLAY_RECORD: "e07",
  });
  for (const code of ["e01", "e03", "e04", "e05", "e06", "e07"]) acceptsWire({ ...record, DISPLAY_RECORD: code }, true);
  for (const code of ["e00", "e02", "e08", "e07x", "E07"]) acceptsWire({ ...record, DISPLAY_RECORD: code }, false);
  acceptsWire({ ...record, ITEM_INDEX: 1, DISPLAY_RECORD: "continuation\n🚉" }, true);
  acceptsWire({ ...record, ITEM_INDEX: 1, DISPLAY_RECORD: "🚉".repeat(160) }, true);
  acceptsWire({ ...record, ITEM_INDEX: 1, DISPLAY_RECORD: "🚉".repeat(160) + "a" }, false);
  acceptsWire({ ...record, ITEM_INDEX: 1, DISPLAY_RECORD: "\ud800" }, false);
  acceptsWire({ ...record, ITEM_INDEX: 1, DISPLAY_RECORD: "bad\tcontrol" }, false);
  acceptsWire({ ...record, ITEM_INDEX: 2 }, false);
});

test("phone traffic preparation preserves palette, scalar sections and LF wrapping without padding fragments", () => {
  for (const palette of [1, 2]) {
    const fragments = layout.prepareTraffic(palette, 1, "🚉", "", "A\n\nB", 0);
    assert.deepEqual(fragments, [`${palette}00000001001000003001🚉000004A\n\nB`]);
  }
  const fragments = layout.prepareTraffic(3, 0xffffffff, "W".repeat(96), "W".repeat(64), "W".repeat(380) + "🚉", 1);
  const document = fragments.join("");
  for (const fragment of fragments) {
    assert.ok(Buffer.byteLength(fragment, "utf8") <= 640);
    assert.equal(Buffer.from(fragment, "utf8").toString("utf8"), fragment);
  }
  const scalars = Array.from(document);
  let offset = 18;
  const sections: string[] = [];
  for (let i = 0; i < 3; i++) {
    const count = Number.parseInt(scalars.slice(offset, offset + 3).join(""), 16);
    offset += 3;
    sections.push(scalars.slice(offset, offset + count).join(""));
    offset += count;
  }
  assert.equal(offset, scalars.length);
  assert.equal(sections[0].replaceAll("\n", ""), "W".repeat(96));
  assert.equal(sections[1].replaceAll("\n", ""), "W".repeat(64));
  assert.equal(sections[2].replaceAll("\n", ""), "W".repeat(380) + "🚉");
  for (let i = 0; i < 3; i++) {
    assert.equal(Number.parseInt(document.slice(9 + 3 * i, 12 + 3 * i), 16), sections[i].split("\n").length);
  }
  assert.throws(() => layout.prepareTraffic(0, 1, "", "", "W".repeat(385), 0), TypeError);
  assert.throws(() => layout.prepareTraffic(0, 1, "", "", "\ud800", 0), TypeError);
});

test("traffic wrapping converts allowed source tabs without emitting packed controls", () => {
  const source = "A\t🚉\tB";
  const expected = "A 🚉 B";
  assert.equal(layout.wrap(source, 0, 180), expected);
  const fragments = layout.prepareTraffic(1, 1, "", "", source, 0);
  assert.deepEqual(fragments, ["1" + "00000001" + "000000001" + "000000005" + expected]);
  acceptsWire(message(MESSAGE_TYPE.DISPLAY_RECORD, {
    REQUEST_ID: requestId, DISPLAY_GENERATION: 1, DISPLAY_KIND: 2, ITEM_INDEX: 0, DISPLAY_RECORD: fragments[0],
  }), true);
  assert.throws(() => layout.wrap("A\u000bB", 0, 180), TypeError);
  assert.throws(() => layout.wrap("A\t\ud800", 0, 180), TypeError);
});

test("traffic wrapping distinguishes an empty section from explicit trailing blank lines", () => {
  for (const { text, lines } of [{ text: "", lines: 0 }, { text: "\n", lines: 2 }, { text: "A\n\n", lines: 3 }]) {
    assert.equal(layout.wrap(text, 0, 180), text);
    const document = layout.prepareTraffic(0, 1, "", "", text, 0).join("");
    assert.equal(document, "0" + "00000001" + "000000" + lines.toString(16).padStart(3, "0")
      + "000000" + text.length.toString(16).padStart(3, "0") + text);
  }
});

