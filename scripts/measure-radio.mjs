import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const codec = require("../packages/companion/src/codec.js");
const contracts = require("../packages/companion/src/contracts.js");
const configuration = require("../packages/companion/src/configuration.js");
import {
  APP_MESSAGE_INBOX_BYTES,
  APP_MESSAGE_OUTBOX_BYTES,
} from "../packages/watch/src/embeddedjs/contracts.js";
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

function dictionaryMaximumsByMessageType(messages) {
  const maximums = Object.fromEntries(
    Object.keys(contracts.MESSAGE_TYPE).map((name) => [name, null]),
  );
  for (const message of messages) {
    const name = Object.keys(contracts.MESSAGE_TYPE).find(
      (candidate) => contracts.MESSAGE_TYPE[candidate] === message.MESSAGE_TYPE,
    );
    if (name === undefined) throw new Error("codec emitted an unknown message type");
    const size = dictionarySize(message);
    maximums[name] = maximums[name] === null ? size : Math.max(maximums[name], size);
  }
  return maximums;
}

function maximumEncodedString(byteLimit, suffix = "") {
  return "\\".repeat(byteLimit - Buffer.byteLength(suffix, "utf8")) + suffix;
}

// Longest contract enum labels maximize the serialized bound.
function longestLabel(values) {
  return values.reduce((longest, value) => (value.length > longest.length ? value : longest));
}

// An explicit runtime bound prevents an 8k-capable phone connection from
// expanding both native Pebble buffers to 8200 bytes.
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

function maximumResult(requestId, favoriteId) {
  return {
    schemaVersion: contracts.SCHEMA_VERSION,
    requestId,
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

const maximumRequestId = maximumEncodedString(contracts.LIMITS.idUtf8Bytes, "request");
const maximumSequenceId = maximumEncodedString(contracts.LIMITS.idUtf8Bytes, "sequence");
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
const maximumFavoriteId = maximumFavorites[0].id;
const maximumRequestShape = {
  requestId: maximumRequestId,
  favoriteId: maximumFavoriteId,
  trigger: contracts.REQUEST_TRIGGER.MANUAL_SELECT,
};
const maximumDepartureResult = maximumResult(maximumRequestId, maximumFavoriteId);
const maximumErrorResult = {
  schemaVersion: contracts.SCHEMA_VERSION,
  requestId: maximumRequestId,
  favoriteId: maximumFavoriteId,
  code: longestLabel(contracts.ERROR_CODE),
  occurredAt: UINT32_MAX,
  retryAfterSeconds: UINT32_MAX,
};

const request = codec.encodeRequest({
  requestId: fixture.result.requestId,
  favoriteId: fixture.favorite.id,
  trigger: contracts.REQUEST_TRIGGER.APP_OPEN,
});
const response = codec.encodeResult(fixture.result);
const maximumWatchRequest = codec.encodeRequest(maximumRequestShape);
const maximumMirroredRequest = codec.encodeRequest(maximumRequestShape);
const configurationMessages = codec.encodeConfiguration(
  maximumSequenceId,
  maximumFavorites,
  contracts.KEY_STATUS.CONFIGURED,
  contracts.WIRE_LANGUAGE.FR,
);
const maximumResultMessages = codec.encodeResult(maximumDepartureResult);
const maximumErrorMessage = codec.encodeError(maximumErrorResult);
const maximumPhoneToWatchMessages = [
  ...configurationMessages,
  ...maximumResultMessages,
  maximumMirroredRequest,
  maximumErrorMessage,
];
const maximumWatchToPhoneMessages = [maximumWatchRequest];

// Maximal lapinFuteResults record per the configuration validators
// (packages/companion/src/configuration.js isStoredResults/isResultEntry):
// one entry per favorite with favoriteId bounded at LIMITS.idUtf8Bytes,
// matching result.favoriteId, and storedAt at Number.MAX_SAFE_INTEGER
// (isStoredAt ceiling).
const maximumResultEntries = maximumFavorites.map((favorite) => ({
  favoriteId: favorite.id,
  storedAt: Number.MAX_SAFE_INTEGER,
  result: maximumResult(maximumRequestId, favorite.id),
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
const maximumPhoneToWatchSizes = maximumPhoneToWatchMessages.map(dictionarySize);
const maximumWatchToPhoneSizes = maximumWatchToPhoneMessages.map(dictionarySize);
const maximumDictionaryBytesByMessageType = dictionaryMaximumsByMessageType([
  ...maximumWatchToPhoneMessages,
  ...maximumPhoneToWatchMessages,
]);
const allMaximumMessageTypesMeasured = Object.values(
  maximumDictionaryBytesByMessageType,
).every((size) => size !== null);
const maximumPhoneDictionariesFitInbox = maximumPhoneToWatchSizes.every(
  (size) => size <= APP_MESSAGE_INBOX_BYTES,
);
const maximumWatchRequestsFitOutbox = maximumWatchToPhoneSizes.every(
  (size) => size <= APP_MESSAGE_OUTBOX_BYTES,
);
const largestMaximumPhoneDictionaryBytes = Math.max(...maximumPhoneToWatchSizes);
const largestMaximumWatchDictionaryBytes = Math.max(...maximumWatchToPhoneSizes);
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
    value: APP_MESSAGE_OUTBOX_BYTES,
    source: "README.md watch-request gate, sourced from APP_MESSAGE_OUTBOX_BYTES and passed to main.js Message output",
  },
  phoneDictionaryBytes: {
    value: APP_MESSAGE_INBOX_BYTES,
    source: "README.md phone-to-watch dictionary gate, sourced from APP_MESSAGE_INBOX_BYTES and passed to main.js Message input",
  },
  configurationMessages: {
    value: contracts.LIMITS.favorites + 2,
    source: "codec.encodeConfiguration emits CONFIG_BEGIN + LIMITS.favorites favorites + CONFIG_COMMIT, so an atomic batch is LIMITS.favorites + 2 dictionaries",
  },
  configurationEncodedBytes: {
    value: 8192,
    source: "frozen v1 configuration-batch budget carried from the foundation measurement plan in this script (power-of-two batch headroom); the binding per-dictionary gate is APP_MESSAGE_INBOX_BYTES",
  },
  appMessageInboxBytes: {
    value: APP_MESSAGE_INBOX_BYTES,
    source: "packages/watch/src/embeddedjs/contracts.js APP_MESSAGE_INBOX_BYTES, passed to main.js Message input",
  },
  appMessageOutboxBytes: {
    value: APP_MESSAGE_OUTBOX_BYTES,
    source: "packages/watch/src/embeddedjs/contracts.js APP_MESSAGE_OUTBOX_BYTES, passed to main.js Message output",
  },
  appMessageEightKilobyteBytes: {
    value: appMessageEightKilobyteBytes,
    source: "phone companions advertising the 8k message capability can expose 8200-byte maxima, but explicit Message input/output bounds prevent those native allocations",
  },
  watchUnsentQueueMessages: {
    value: 4,
    source: "watch contracts LIMITS.requestQueue enforced by the MessageQueue constructor (packages/watch/src/embeddedjs/message-queue.js); README watch unsent queue gate of four messages",
  },
  xsArenaBudgetBytes: {
    value: 56 * 1024,
    source: "mdbl.c XS_STACK_BYTES + XS_SLOT_BYTES + XS_CHUNK_BYTES = 56 KiB enforced by a compile-time #error; native AppMessage inbox/outbox buffers are separate allocations from the same application heap, in addition to the XS arena total",
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
  maximumDictionaries: {
    bytesByMessageType: maximumDictionaryBytesByMessageType,
    phoneToWatch: {
      messages: maximumPhoneToWatchMessages.length,
      includesMirroredRequest: true,
      inboxBytes: APP_MESSAGE_INBOX_BYTES,
      largestDictionaryBytes: largestMaximumPhoneDictionaryBytes,
      allFit: maximumPhoneDictionariesFitInbox,
    },
    watchToPhone: {
      messages: maximumWatchToPhoneMessages.length,
      outboxBytes: APP_MESSAGE_OUTBOX_BYTES,
      largestDictionaryBytes: largestMaximumWatchDictionaryBytes,
      allFit: maximumWatchRequestsFitOutbox,
    },
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
  scenario: "recorded steady-state request/result plus every maximum directional dictionary and maximum storage records",
  capacities,
  budget,
  pass: messages.length <= budget.steadyStateMessages
    && allMaximumMessageTypesMeasured
    && maximumPhoneDictionariesFitInbox
    && maximumWatchRequestsFitOutbox
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
