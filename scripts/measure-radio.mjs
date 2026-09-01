import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const codec = require("../packages/companion/src/codec.js");
const contracts = require("../packages/companion/src/contracts.js");
const configuration = require("../packages/companion/src/configuration.js");
import {
  serializeWatchConfiguration,
  WATCH_CONFIGURATION_MAX_BYTES,
} from "../packages/watch/src/embeddedjs/storage.js";
const fixture = JSON.parse(readFileSync(
  new URL("../fixtures/departures/foundation.json", import.meta.url),
  "utf8"
));

// Wire-size accounting follows Pebble's measured-data formula: one header
// byte per dictionary, seven bytes per key, then value bytes (utf8 plus the
// c-string terminator for strings, four bytes for numeric values).
function dictionarySize(dictionary) {
  const sizes = Object.values(dictionary).map((value) => (
    typeof value === "string" ? Buffer.byteLength(value, "utf8") + 1 : 4
  ));
  return 1 + (7 * sizes.length) + sizes.reduce((total, size) => total + size, 0);
}

function maximumEncodedString(byteLimit, suffix = "") {
  return "\\".repeat(byteLimit - Buffer.byteLength(suffix, "utf8")) + suffix;
}

// Longest contract enum labels maximize the serialized bound.
function longestLabel(values) {
  return values.reduce((longest, value) => (value.length > longest.length ? value : longest));
}

// AppMessage capacity actually configured by the watch app. The watch
// bootstrap (packages/watch/src/embeddedjs/main.js) constructs
// `new Message({ keys: APP_MESSAGE_KEY_MAP, ... })` with no input/output
// bound, so the Moddable bridge
// (RePebble SDK 4.33.1 toolchain/moddable/build/devices/pebble/modules/
// message/pebble-appmessage.c) opens
// app_message_open(app_message_inbox_size_maximum(),
// app_message_outbox_size_maximum()). On the SDK 4.33.1 firmware those
// return 2026 (0x7ea) and 654 (0x28e) bytes for a JS-allowed app; both
// constants disassemble identically from the emery and gabbro qemu
// *_sdk_debug.elf images. A phone companion advertising the 8k message
// capability lifts both maxima to 8200 (0x2008), which this budget does not
// assume. AppMessage buffers live in the application heap (pebble.h), inside
// the 56 KiB XS arena budget enforced at compile time in mdbl.c.
const appMessageInboxBytes = 2026;
const appMessageOutboxBytes = 654;
const appMessageEightKilobyteBytes = 8200;

// Maximal frozen DepartureResult bounds from the contracts validators
// (packages/companion/src/contracts.js): requestId/favoriteId at
// LIMITS.idUtf8Bytes utf8 bytes, fetchedAt/sourceUpdatedAt at the uint32
// maximum accepted by uint32()/optionalUint32(), freshness/status at their
// longest enum labels, LIMITS.departures departures with expectedAt/aimedAt
// at the uint32 maximum, minutes at the isDeparture floor of -1440,
// nextIntervalMinutes at its isDeparture ceiling of 1440, and both optional
// fields present.
const UINT32_MAX = 4294967295;
const maximumDeparture = {
  expectedAt: UINT32_MAX,
  aimedAt: UINT32_MAX,
  minutes: -1440,
  status: longestLabel(contracts.DEPARTURE_STATUS),
  nextIntervalMinutes: 1440,
};

function maximumResult(favoriteId) {
  return {
    schemaVersion: contracts.SCHEMA_VERSION,
    requestId: maximumEncodedString(contracts.LIMITS.idUtf8Bytes),
    favoriteId,
    fetchedAt: UINT32_MAX,
    sourceUpdatedAt: UINT32_MAX,
    freshness: longestLabel(contracts.FRESHNESS),
    departures: Array.from(
      { length: contracts.LIMITS.departures },
      () => maximumDeparture,
    ),
  };
}

const request = codec.encodeRequest({
  requestId: fixture.result.requestId,
  favoriteId: fixture.favorite.id,
  trigger: contracts.REQUEST_TRIGGER.APP_OPEN,
});
const response = codec.encodeResult(fixture.result);
const maximumApiKey = maximumEncodedString(contracts.LIMITS.apiKeyUtf8Bytes);
const maximumFavorites = Array.from({ length: contracts.LIMITS.favorites }, (_, index) => {
  const suffix = String(index).padStart(2, "0");
  return {
    ...fixture.favorite,
    id: maximumEncodedString(contracts.LIMITS.idUtf8Bytes, suffix),
    serviceId: maximumEncodedString(contracts.LIMITS.idUtf8Bytes, suffix),
    displayName: maximumEncodedString(contracts.LIMITS.labelUtf8Bytes),
    stopLabel: maximumEncodedString(contracts.LIMITS.labelUtf8Bytes),
    lineLabel: maximumEncodedString(contracts.LIMITS.labelUtf8Bytes),
    destinationLabel: maximumEncodedString(contracts.LIMITS.labelUtf8Bytes),
    sortOrder: index,
  };
});
const configurationMessages = codec.encodeConfiguration(
  "config-maximum",
  maximumFavorites,
  contracts.KEY_STATUS.CONFIGURED,
  contracts.WIRE_LANGUAGE.FR,
);

// Maximal lapinFuteResults record per the configuration validators
// (packages/companion/src/configuration.js isStoredResults/isResultEntry):
// one entry per favorite with favoriteId bounded at LIMITS.idUtf8Bytes,
// matching result.favoriteId, and storedAt at Number.MAX_SAFE_INTEGER
// (isStoredAt ceiling).
const maximumResultEntries = maximumFavorites.map((favorite) => ({
  favoriteId: favorite.id,
  storedAt: Number.MAX_SAFE_INTEGER,
  result: maximumResult(favorite.id),
}));
if (!maximumResultEntries.every((entry) => contracts.isDepartureResult(entry.result))) {
  throw new Error("maximum result must satisfy the frozen DepartureResult contract");
}

const messages = [request, ...response];
const configurationSizes = configurationMessages.map(dictionarySize);
const sizes = messages.map(dictionarySize);
const bytes = sizes.reduce((total, size) => total + size, 0);
const largestPhoneDictionaryBytes = Math.max(...sizes.slice(1));
const largestConfigurationDictionaryBytes = Math.max(...configurationSizes);
const configurationEncodedBytes = configurationSizes.reduce((total, size) => total + size, 0);
const phoneRecordBytes = Buffer.byteLength(JSON.stringify({
  schemaVersion: contracts.SCHEMA_VERSION,
  favorites: maximumFavorites,
  primApiKey: maximumApiKey,
  keyStatus: contracts.KEY_STATUS.CONFIGURED,
}), "utf8");
const watchSerialized = serializeWatchConfiguration({
  favorites: maximumFavorites.map((favorite) => ({
    id: favorite.id,
    serviceId: favorite.serviceId,
    displayName: favorite.displayName,
    stopLabel: favorite.stopLabel,
    lineLabel: favorite.lineLabel,
    destinationLabel: favorite.destinationLabel,
    sortOrder: favorite.sortOrder,
  })),
  keyStatus: contracts.KEY_STATUS.CONFIGURED,
  language: contracts.WIRE_LANGUAGE.FR,
});
if (watchSerialized === null) throw new Error("maximum watch configuration exceeds storage");
const watchRecordBytes = Buffer.byteLength(watchSerialized, "utf8");
const resultsRecordBytes = Buffer.byteLength(JSON.stringify({
  schemaVersion: contracts.SCHEMA_VERSION,
  results: maximumResultEntries,
}), "utf8");
// Failure journal (configuration.js saveInvalidConfiguration): the recovery
// record is written under lapinFuteInvalidKeyStatus only while an INVALID
// configuration write cannot be verified and is removed on success. Its
// serialized shape is exactly { schemaVersion, keyStatus: INVALID,
// configurationFingerprint }, where the fingerprint is always 16 lowercase
// hex characters (two fixed-width 8-character halves; validated by
// /^[0-9a-f]{16}$/ in invalidKeyStatusMatches), so the derived maximum is
// exact.
const invalidKeyStatusRecordBytes = Buffer.byteLength(JSON.stringify({
  schemaVersion: contracts.SCHEMA_VERSION,
  keyStatus: contracts.KEY_STATUS.INVALID,
  configurationFingerprint: "f".repeat(16),
}), "utf8");
const phoneStorageBytes = phoneRecordBytes + resultsRecordBytes
  + invalidKeyStatusRecordBytes;
const openingFragmentCharacters = encodeURIComponent(JSON.stringify({
  hasKey: true,
  favorites: maximumFavorites,
  language: contracts.WIRE_LANGUAGE.FR,
})).length;
const closeFragmentCharacters = encodeURIComponent(JSON.stringify({
  schemaVersion: contracts.SCHEMA_VERSION,
  favorites: maximumFavorites,
  apiKeyUpdate: {
    schemaVersion: contracts.SCHEMA_VERSION,
    action: "REPLACE",
    value: maximumApiKey,
  },
})).length;

// Every bound the gate enforces, each with its repository or platform source.
// The pass expression is computed from these values only.
const capacities = {
  steadyStateMessages: {
    value: 7,
    source: "README.md quality gates: two-departure refresh at most 7 dictionaries (request + RESULT_BEGIN + LIMITS.departures departures + RESULT_COMMIT)",
  },
  steadyStateEncodedBytes: {
    value: 2048,
    source: "README.md quality gates: two-departure refresh at most 2048 encoded bytes",
  },
  requestBytes: {
    value: 192,
    source: "README.md quality gates: watch request at most 192 encoded bytes; travels watch-to-phone through the 654-byte outbox",
  },
  phoneDictionaryBytes: {
    value: 768,
    source: "README.md quality gates: phone-to-watch dictionary at most 768 encoded bytes; the frozen repository budget, tighter than the 2026-byte watch inbox actually configured by the watch app",
  },
  configurationMessages: {
    value: contracts.LIMITS.favorites + 2,
    source: "codec.encodeConfiguration emits CONFIG_BEGIN + LIMITS.favorites favorites + CONFIG_COMMIT, so an atomic batch is LIMITS.favorites + 2 dictionaries",
  },
  configurationEncodedBytes: {
    value: 8192,
    source: "frozen v1 configuration-batch budget carried from the foundation measurement plan in this script (power-of-two batch headroom); the binding per-dictionary gate is appMessageInboxBytes",
  },
  appMessageInboxBytes: {
    value: appMessageInboxBytes,
    source: "watch inbox capacity configured by the watch app: main.js passes no Message input bound, so Moddable pebble-appmessage.c opens app_message_open(app_message_inbox_size_maximum(), app_message_outbox_size_maximum()); RePebble SDK 4.33.1 emery/gabbro firmware returns 2026 bytes (0x7ea) for a JS-allowed app (disassembled from both qemu *_sdk_debug.elf images; 126 bytes for non-JS apps)",
  },
  appMessageOutboxBytes: {
    value: appMessageOutboxBytes,
    source: "watch outbox capacity from app_message_outbox_size_maximum() in the same RePebble SDK 4.33.1 emery/gabbro firmware images: 654 bytes (0x28e) without the 8k phone capability",
  },
  appMessageEightKilobyteBytes: {
    value: appMessageEightKilobyteBytes,
    source: "phone companions advertising the 8k message capability (prv_supports_8k) lift both AppMessage maxima to 8200 bytes (0x2008); not assumed by this budget",
  },
  watchUnsentQueueMessages: {
    value: 4,
    source: "watch contracts LIMITS.requestQueue enforced by the MessageQueue constructor (packages/watch/src/embeddedjs/message-queue.js); README watch unsent queue gate of four messages",
  },
  xsArenaBudgetBytes: {
    value: 56 * 1024,
    source: "mdbl.c XS_STACK_BYTES + XS_SLOT_BYTES + XS_CHUNK_BYTES = 56 KiB enforced by a compile-time #error; README loaded image and RAM gate with XS arenas at least 25% free; AppMessage inbox/outbox buffers are allocated from this application heap (pebble.h)",
  },
  phoneRecordBytes: {
    value: 16384,
    source: "frozen v1 per-record budget from the foundation measurement plan for the lapinFuteConfig localStorage record (configuration.CONFIG_STORAGE_KEY); structural bound is LIMITS.favorites favorites plus LIMITS.apiKeyUtf8Bytes key bytes; far under the webview Web Storage origin quota",
  },
  watchRecordBytes: {
    value: WATCH_CONFIGURATION_MAX_BYTES,
    source: "installed RePebble Alloy SDK 4.33.1 storage-pebble.c opens the app SettingsFile with max_used_space 8192; storage.serializeWatchConfiguration enforces the same bound",
  },
  resultsRecordBytes: {
    value: 16384,
    source: "frozen v1 per-record budget from the foundation measurement plan for the lapinFuteResults localStorage record (configuration.RESULTS_STORAGE_KEY); structural bound is LIMITS.favorites entries of LIMITS.departures maximal departures",
  },
  invalidKeyStatusRecordBytes: {
    value: invalidKeyStatusRecordBytes,
    source: "derived maximum of the lapinFuteInvalidKeyStatus recovery journal (configuration.INVALID_KEY_STATUS_STORAGE_KEY), whose serialized shape is exactly { schemaVersion, keyStatus: INVALID, configurationFingerprint } per configuration.js saveInvalidConfiguration, with the fingerprint fixed at 16 lowercase hex characters (invalidKeyStatusMatches /^[0-9a-f]{16}$/)",
  },
  phoneStorageBytes: {
    value: (16384 * 2) + invalidKeyStatusRecordBytes,
    source: "sum of both frozen 16384-byte phone record budgets plus the exact recovery journal bound: total phone-local storage for configuration, cached results, and INVALID recovery",
  },
  openingFragmentCharacters: {
    value: 32768,
    source: "packages/config-page/src/config-core.js MAX_OPENING_FRAGMENT_LENGTH = 32768",
  },
  closeFragmentCharacters: {
    value: 32768,
    source: "packages/companion/src/configuration.js MAX_CLOSE_RESPONSE_LENGTH = 32768",
  },
};
const budget = Object.fromEntries(Object.entries(capacities).map(([name, entry]) => [
  name,
  entry.value,
]));

const report = {
  fixture: "fixtures/departures/foundation.json",
  favoriteLimit: contracts.LIMITS.favorites,
  steadyState: {
    messages: messages.length,
    encodedBytes: bytes,
    requestBytes: sizes[0],
    largestPhoneDictionaryBytes,
  },
  maximumConfiguration: {
    messages: configurationMessages.length,
    encodedBytes: configurationEncodedBytes,
    largestDictionaryBytes: largestConfigurationDictionaryBytes,
    phoneRecordBytes,
    watchRecordBytes,
    openingFragmentCharacters,
    closeFragmentCharacters,
  },
  maximumResults: {
    entries: maximumResultEntries.length,
    departuresPerEntry: contracts.LIMITS.departures,
    recordBytes: resultsRecordBytes,
  },
  phoneStorage: {
    configurationRecordBytes: phoneRecordBytes,
    resultsRecordBytes,
    invalidKeyStatusRecordBytes,
    totalBytes: phoneStorageBytes,
  },
  scenario: "steady-state request/result plus a complete maximum-favorite atomic configuration and a maximal cached-results record",
  capacities,
  budget,
  pass: messages.length <= budget.steadyStateMessages
    && bytes <= budget.steadyStateEncodedBytes
    && sizes[0] <= budget.requestBytes
    && largestPhoneDictionaryBytes <= budget.phoneDictionaryBytes
    && sizes[0] <= budget.appMessageOutboxBytes
    && configurationMessages.length <= budget.configurationMessages
    && configurationEncodedBytes <= budget.configurationEncodedBytes
    && largestConfigurationDictionaryBytes <= budget.appMessageInboxBytes
    && largestConfigurationDictionaryBytes <= budget.phoneDictionaryBytes
    && phoneRecordBytes <= budget.phoneRecordBytes
    && watchRecordBytes <= budget.watchRecordBytes
    && watchRecordBytes <= budget.xsArenaBudgetBytes
    && resultsRecordBytes <= budget.resultsRecordBytes
    && phoneStorageBytes <= budget.phoneStorageBytes
    && openingFragmentCharacters <= budget.openingFragmentCharacters
    && closeFragmentCharacters <= budget.closeFragmentCharacters,
};
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exit(1);
