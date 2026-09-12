import { createRequire } from "node:module";
import {
  APP_MESSAGE_KEYS, APP_MESSAGE_INBOX_BYTES, APP_MESSAGE_OUTBOX_BYTES,
  DISPLAY_WIRE_VERSION, LIMITS, MESSAGE_TYPE, isAppMessage, dictionaryBytes, cstringBytes,
} from "../packages/contracts/src/index.ts";

const require = createRequire(import.meta.url);
const codec = require("../packages/companion/src/codec.js");
const layout = require("../packages/companion/src/display-layout.js");

// Host sizing, not a captured radio trace. Four-byte integer tuples are a
// conservative bound for the numeric values in the D2 application schema.
// SDK15025 has its own native serialization and is not sized by this formula.
function dictionarySize(dictionary) {
  return dictionaryBytes(Object.values(dictionary).map(value => typeof value === "string" ? cstringBytes(value) : 4));
}

function summary(messages) {
  const sizes = messages.map(dictionarySize);
  return { dictionaries: messages.length, serializedBytesBound: sizes.reduce((sum, size) => sum + size, 0), largestDictionaryBytesBound: Math.max(0, ...sizes) };
}

const generation = 0xffffffff;
const epoch = "fffffffffffffff", configurationId = epoch + "cffffffff", requestId = epoch + "rffffffff";
const favoriteId = "F".repeat(64);
const base = (type, values) => ({ SCHEMA_VERSION: DISPLAY_WIRE_VERSION, MESSAGE_TYPE: type, REQUEST_ID: requestId, DISPLAY_GENERATION: generation, ...values });
const favorites = Array.from({ length: LIMITS.favorites }, (_, index) => ({
  id: "F".repeat(63) + index, lineLabel: "W".repeat(96), stopLabel: "W".repeat(96), destinationLabel: "W".repeat(96),
  lineColor: "#ffbe00", lineTextColor: "#000000",
}));
const variants = [];
for (const profile of [0, 1]) for (const language of ["en", "fr"]) {
  variants.push({ profile, language,
    appearances: favorites.map(favorite => layout.prepareAppearance(favorite, profile, language)),
    traffic: layout.prepareTraffic(2, generation, "W".repeat(96), "W".repeat(64), "W".repeat(384), profile),
  });
}
const largest = variants.reduce((winner, variant) => Math.max(...variant.appearances.map(layout.utf8Bytes)) > Math.max(...winner.appearances.map(layout.utf8Bytes)) ? variant : winner);
const appearances = largest.appearances;
const configContext = { requestId: configurationId, generation };
function configExchange(mask, full = false) {
  const messages = [codec.encodeConfigurationStart({ ...configContext, itemCount: LIMITS.favorites,
    keyStatus: 1, mode: full ? 1 : 0, language: largest.language, profile: largest.profile })];
  for (let index = 0; index < LIMITS.favorites; index++) {
    // IDs here are ASCII. The production presenter handles scalar lp3 fields.
    const hashStart = 3 + favorites[index].id.length + 3;
    messages.push(codec.encodeConfigurationEntry({ ...configContext, index, favoriteId: favorites[index].id,
      hash: appearances[index].slice(hashStart, hashStart + 16) }));
  }
  messages.push({ SCHEMA_VERSION: DISPLAY_WIRE_VERSION, MESSAGE_TYPE: MESSAGE_TYPE.CONFIG_NEED,
    REQUEST_ID: configurationId, DISPLAY_GENERATION: generation, CONFIG_NEED_MASK: mask,
    DISPLAY_PROFILE: largest.profile, CLOCK_12H: 1 });
  for (let index = 0; index < LIMITS.favorites; index++) if (mask & (1 << index)) {
    messages.push(codec.encodeFavoriteBody({ ...configContext, index, record: appearances[index] }));
  }
  messages.push(codec.encodeConfigurationCommit(configContext));
  return messages;
}

const ready = codec.encodeReady("p".repeat(24));
const hello = { SCHEMA_VERSION: DISPLAY_WIRE_VERSION, MESSAGE_TYPE: MESSAGE_TYPE.DISPLAY_HELLO,
  REQUEST_ID: "p".repeat(24), DISPLAY_PROFILE: 1, CLOCK_12H: 1,
  WATCH_SESSION_ID: "w".repeat(24), DISPLAY_EPOCH: epoch };
const detailRequest = base(MESSAGE_TYPE.REQUEST, { FAVORITE_ID: favoriteId, REQUEST_TRIGGER: 5 });
const overviewRequest = base(MESSAGE_TYPE.OVERVIEW_REQUEST, { REQUEST_TRIGGER: 5 });
const trafficRequest = base(MESSAGE_TYPE.TRAFFIC_REQUEST, { FAVORITE_ID: favoriteId });

function departure(count) {
  return "03ffffffff3073ffffffff" + layout.fixed(count, 1)
    + Array.from({ length: count }, (_, index) => "ffffffff" + layout.fixed(index, 1)).join("");
}
function transfer(kind, records) {
  const context = { requestId, generation, kind };
  return [codec.encodeDisplayBegin({ ...context, count: records.length, ...(kind ? { favoriteId } : {}) }),
    ...records.map((record, index) => codec.encodeDisplayRecord({ ...context, index, record })),
    codec.encodeDisplayCommit(context)];
}

// Separate schema-ceiling fixture: a valid successful document with a 768-byte
// body and matching 385-line count. This exercises the full 640-byte tuple
// even when preparation of the maximum original source needs fewer bytes.
const ceilingBody = "B\n".repeat(384);
const ceilingDocument = "3ffffffff000000181000000300" + ceilingBody;
const ceilingTraffic = [ceilingDocument.slice(0, 640), ceilingDocument.slice(640)];
const overview = transfer(0, favorites.map(() => departure(1)));
const detail = transfer(1, [departure(4)]);
const traffic = transfer(2, ceilingTraffic);
const trafficError = transfer(2, ["e07"]);
const allMask = (1 << LIMITS.favorites) - 1;
const full = configExchange(allMask, true), noop = configExchange(0), changed = configExchange(1);
const layoutTraffic = variants.flatMap(variant => transfer(2, variant.traffic));
const watchToPhone = [hello, detailRequest, overviewRequest, trafficRequest, full.find(message => message.MESSAGE_TYPE === MESSAGE_TYPE.CONFIG_NEED)];
const phoneToWatch = [ready, ...full.filter(message => message.MESSAGE_TYPE !== MESSAGE_TYPE.CONFIG_NEED), ...overview, ...detail, ...traffic, ...trafficError, ...layoutTraffic];
const messages = [...watchToPhone, ...phoneToWatch];
for (const message of messages) if (!isAppMessage(message)) throw new Error("D2 fixture fails the canonical schema: type " + message.MESSAGE_TYPE);
const types = Object.fromEntries(Object.entries(MESSAGE_TYPE).map(([name, type]) => {
  const candidates = messages.filter(message => message.MESSAGE_TYPE === type);
  if (!candidates.length) throw new Error("Missing radio fixture for " + name);
  return [name, Math.max(...candidates.map(dictionarySize))];
}));
const phoneMaximum = Math.max(...phoneToWatch.map(dictionarySize)), watchMaximum = Math.max(...watchToPhone.map(dictionarySize));
const startupD2 = [ready, hello, hello, ...full];
const report = {
  scope: "Host D2 tuple sizing and modeled exchanges; not observed native delivery or lifecycle evidence",
  domainSchemaVersion: 1,
  displayWireVersion: DISPLAY_WIRE_VERSION,
  favoriteLimit: LIMITS.favorites,
  appMessageKeys: APP_MESSAGE_KEYS,
  capacities: { inboxBytes: APP_MESSAGE_INBOX_BYTES, outboxBytes: APP_MESSAGE_OUTBOX_BYTES, queueCapacity: 4 },
  maximumPhoneDictionaryBytesBound: phoneMaximum,
  maximumWatchDictionaryBytesBound: watchMaximum,
  maximumDictionaryBytesBoundByType: types,
  preparedSources: variants.map(variant => ({ profile: variant.profile, language: variant.language,
    appearanceBytes: Math.max(...variant.appearances.map(layout.utf8Bytes)),
    trafficFragmentBytes: variant.traffic.map(layout.utf8Bytes) })),
  exchanges: {
    fullSix: summary(full), unchangedSix: summary(noop), reorderSix: summary(noop), oneChangedFavorite: summary(changed),
    initialD2: summary(startupD2), cacheOnlyOverview: summary([overviewRequest, ...overview]),
    cacheOnlyDetail: summary([detailRequest, ...detail]), trafficTwoFragments: summary([trafficRequest, ...traffic]),
    trafficError: summary([trafficRequest, ...trafficError]),
  },
  sdkTransport: {
    reservedKey: 15025, includedInD2: false,
    conditionalHandshake: { announcementDictionaries: 1, echoDictionaries: 1,
      combinedInitialDictionaryAttempts: startupD2.length + 2 },
    condition: "Only for exactly one observed SDK announcement/echo exchange plus the modeled initial D2 lifecycle; duplicate READYs and rekeys are additional events",
    serializedBytes: null, ackFrames: null,
    evidenceRequired: "Capture native SDK tuple widths/bytes, D2 attempted/delivered/NACK counts and transport ACKs separately",
  },
  eventContract: { localPagesAndMinuteTicks: "No application dictionaries; verify with native idle/page captures, not this host sizing script" },
  pass: phoneMaximum <= APP_MESSAGE_INBOX_BYTES && watchMaximum <= APP_MESSAGE_OUTBOX_BYTES
    && full.length === 15 && startupD2.length === 18 && !Object.values(APP_MESSAGE_KEYS).includes(15025),
};
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exit(1);
