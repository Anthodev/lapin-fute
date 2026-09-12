import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  API_KEY_ACTION,
  LIMITS as CANONICAL_LIMITS,
  SCHEMA_VERSION as CANONICAL_SCHEMA_VERSION,
  isApiKeyUpdate,
  isFavorite,
  isPersonalApiKey,
  isPlaceLine as canonicalIsPlaceLine,
  isPlaceSearchItem as canonicalIsPlaceSearchItem,
  type Favorite,
} from "../../contracts/src/index.ts";
import {
  CLOSE_PREFIX,
  COPY,
  EMPTY_KEY_DRAFT,
  LIMITS,
  MAX_CLOSE_PAYLOAD_LENGTH,
  SCHEMA_VERSION,
  apiKeyError,
  copyFor,
  closePayloadFits,
  createCloseSession,
  encodeCloseFragment,
  favoriteFromService,
  initialConfigState,
  isFavoriteShape,
  isPhoneFavorite,
  isPlaceLine,
  isPlaceSearchItem,
  isPlaceSearchResult,
  isServiceOptionsResult,
  isServiceRouting,
  parseConfigFragment,
  planApiKeyUpdate,
  planConfigResult,
  reduceConfigState,
  selectLocale,
  utf8Bytes,
  copyPhoneFavorite,
} from "../src/config-core.js";
import { RECORDED_PREVIEW } from "../src/preview-fixture.js";
import { lineBadgeAssetUrl } from "../src/line-badge-assets.js";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const companionConfiguration = require("../../companion/src/configuration.js");

const SERVICE_ROUTING = {
  monitoringRef: "MONITORING:A:1234567",
  lineRef: "IDFM:line:METRO:1",
  destinationRef: "IDFM:destination:LA_DEFENSE",
};

type ServiceRouting = typeof SERVICE_ROUTING;
type PhoneFavorite = Favorite & { routing?: ServiceRouting };

function routingFavorite(id: string, sortOrder: number): PhoneFavorite {
  return { ...favorite(id, sortOrder), routing: { ...SERVICE_ROUTING } };
}

function serviceOption(serviceId: string) {
  return {
    serviceId,
    stopLabel: "Châtelet",
    lineLabel: "4",
    destinationLabel: "Bagneux",
    lineMode: "METRO",
    lineColor: "#be418d",
    lineTextColor: "#ffffff",
    routing: { ...SERVICE_ROUTING },
  };
}

function favorite(id: string, sortOrder: number): Favorite {
  return {
    schemaVersion: 1,
    id,
    serviceId: `service:${id}`,
    stopLabel: `Arrêt ${id}`,
    lineLabel: "Métro 1",
    destinationLabel: "La Défense",
    lineMode: "METRO",
    lineColor: "#ffbe00",
    lineTextColor: "#000000",
    sortOrder,
  };
}

function minimalFavorite(id: string, sortOrder: number): Favorite {
  return {
    schemaVersion: 1,
    id,
    serviceId: `service:${id}`,
    stopLabel: `Arrêt ${id}`,
    lineLabel: "Métro 1",
    destinationLabel: "La Défense",
    sortOrder,
  };
}

const fixtureList: Favorite[] = [favorite("home", 0), { ...favorite("work", 1), displayName: "Bureau" }];

function openingFragment(value: Record<string, unknown>): string {
  return `#${encodeURIComponent(JSON.stringify(value))}`;
}

function fragmentWith(favorites: Favorite[], overrides: Record<string, unknown> = {}): string {
  return openingFragment({ hasKey: true, favorites, language: "fr_FR", ...overrides });
}

test("mirrored constants equal the canonical contract", () => {
  assert.equal(SCHEMA_VERSION, CANONICAL_SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(LIMITS.apiKeyUtf8Bytes, CANONICAL_LIMITS.apiKeyUtf8Bytes);
  assert.equal(LIMITS.idUtf8Bytes, CANONICAL_LIMITS.idUtf8Bytes);
  assert.equal(LIMITS.labelUtf8Bytes, CANONICAL_LIMITS.labelUtf8Bytes);
  assert.equal(LIMITS.favorites, CANONICAL_LIMITS.favorites);
  assert.equal(LIMITS.catalogQueryMinCharacters, CANONICAL_LIMITS.catalogQueryMinCharacters);
  assert.equal(LIMITS.catalogQueryMaxCharacters, CANONICAL_LIMITS.catalogQueryMaxCharacters);
  assert.equal(LIMITS.catalogSearchResults, CANONICAL_LIMITS.catalogSearchResults);
  assert.equal(LIMITS.httpResponseBytes, CANONICAL_LIMITS.httpResponseBytes);
  assert.equal(LIMITS.httpResponseBytes, 262144);
});

test("french language tags select french copy and everything else falls back to english", () => {
  for (const language of ["fr_FR", "fr", "fr-CA", "FR_fr"]) {
    assert.equal(selectLocale(language), "fr");
  }
  for (const language of ["en_US", "de_DE", "es-ES", "it_IT", "pt_PT", "", "xx_XX", undefined]) {
    assert.equal(selectLocale(language), "en");
  }
  assert.equal(copyFor("fr_FR"), COPY.fr);
  assert.equal(copyFor("en_US"), COPY.en);
  assert.equal(copyFor(undefined), COPY.en);
  assert.deepEqual(Object.keys(COPY.en).sort(), Object.keys(COPY.fr).sort());
  assert.notEqual(COPY.en.save, COPY.fr.save);
});

test("authored and transport labels never appear in product copy", () => {
  const serialized = JSON.stringify(COPY);
  for (const label of ["Châtelet", "Métro 1", "La Défense", "Arrêt home", "Arrêt work", "Bureau"]) {
    assert.equal(serialized.includes(label), false);
  }
});

test("opening fragment parsing is secret-free and validates favorites", () => {
  const query = parseConfigFragment(fragmentWith(fixtureList));
  assert.equal(query.hasKey, true);
  assert.equal(query.language, "fr_FR");
  assert.equal(query.locale, "fr");
  assert.deepEqual(query.favorites, fixtureList);

  assert.equal(parseConfigFragment(fragmentWith([], { hasKey: false, language: "en_US" })).hasKey, false);
  assert.equal(
    parseConfigFragment(openingFragment({ favorites: [], language: "en_US" })).hasKey,
    false,
  );
  assert.equal(
    parseConfigFragment(
      openingFragment({ hasKey: "true", favorites: [], language: "en_US" }),
    ).hasKey,
    false,
  );

  const broken = parseConfigFragment(
    openingFragment({ hasKey: true, favorites: "not-an-array", language: "en_US" }),
  );
  assert.deepEqual(broken.favorites, []);

  const invalid = parseConfigFragment(
    openingFragment({
      hasKey: true,
      favorites: [
        favorite("ok", 0),
        { ...favorite("old", 1), schemaVersion: 2 },
        { ...favorite("huge", 2), stopLabel: "x".repeat(97) },
        "junk",
      ],
      language: "fr_FR",
    }),
  );
  assert.deepEqual(invalid.favorites.map((entry) => entry.id), ["ok"]);
});
test("minimal favorites round trip without inventing presentation properties and partial groups reject", () => {
  const minimal = minimalFavorite("minimal", 0);
  const parsed = parseConfigFragment(fragmentWith([minimal]));
  const presentationFields = ["lineMode", "lineColor", "lineTextColor"] as const;

  assert.equal(isFavorite(minimal), true);
  assert.equal(isFavoriteShape(minimal), true);
  assert.deepEqual(parsed.favorites, [minimal]);
  for (const field of presentationFields) {
    assert.equal(Object.hasOwn(parsed.favorites[0], field), false);
  }

  const partials = [
    { ...minimal, lineMode: "METRO" },
    { ...minimal, lineMode: "METRO", lineColor: "#ffbe00" },
    { ...minimal, lineColor: "#ffbe00", lineTextColor: "#000000" },
  ];
  for (const partial of partials) {
    assert.equal(isFavorite(partial), false);
    assert.equal(isFavoriteShape(partial), false);
    assert.deepEqual(parseConfigFragment(openingFragment({
      hasKey: true,
      favorites: [partial],
      language: "fr_FR",
    })).favorites, []);
  }
  assert.equal(isFavorite({ ...minimal, lineMode: undefined }), false);
  assert.equal(isFavoriteShape({ ...minimal, lineMode: undefined }), false);

  const outcome = planConfigResult(initialConfigState(parsed));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.payload.favorites, [minimal]);
  for (const field of presentationFields) {
    assert.equal(Object.hasOwn(outcome.payload.favorites[0], field), false);
  }
});
test("the config page consumes the companion-produced opening fragment exactly", () => {
  const key = "stored-personal-key";
  const url = companionConfiguration.configurationUrl(
    "https://config.example.test/index.html",
    { schemaVersion: 1, favorites: fixtureList, primApiKey: key, keyStatus: 1 },
    "fr_FR",
  );
  assert.equal(typeof url, "string");
  if (url === null) return;
  assert.equal(url.includes(key), false);

  const openingState = JSON.parse(decodeURIComponent(url.slice(url.indexOf("#") + 1)));
  assert.deepEqual(Object.keys(openingState), ["hasKey", "favorites", "language"]);
  assert.deepEqual(openingState, { hasKey: true, favorites: fixtureList, language: "fr_FR" });
  assert.deepEqual(parseConfigFragment(new URL(url).hash), {
    hasKey: true,
    language: "fr_FR",
    locale: "fr",
    favorites: fixtureList,
  });
});


test("a planted key field never enters page state or the payload", () => {
  const parsed = parseConfigFragment(fragmentWith(fixtureList, { apiKey: "SECRET-VALUE" }));
  assert.equal(JSON.stringify(parsed).includes("SECRET-VALUE"), false);
  const outcome = planConfigResult(initialConfigState(parsed));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(JSON.stringify(outcome.payload).includes("SECRET-VALUE"), false);
});

test("key lifecycle plans KEEP, REPLACE, and REMOVE through pure state", () => {
  const missing = initialConfigState(
    parseConfigFragment(fragmentWith([], { hasKey: false, language: "en_US" })),
  );
  assert.deepEqual(planApiKeyUpdate(missing.hasKey, missing.keyDraft), {
    schemaVersion: 1,
    action: "KEEP",
  });
  assert.deepEqual(planApiKeyUpdate(true, EMPTY_KEY_DRAFT), { schemaVersion: 1, action: "KEEP" });

  const entered = reduceConfigState(missing, { type: "key-draft", value: "first-key" });
  assert.deepEqual(planApiKeyUpdate(entered.hasKey, entered.keyDraft), {
    schemaVersion: 1,
    action: "REPLACE",
    value: "first-key",
  });

  const configured = initialConfigState(parseConfigFragment(fragmentWith([], { language: "en_US" })));
  assert.deepEqual(planApiKeyUpdate(configured.hasKey, configured.keyDraft), {
    schemaVersion: 1,
    action: "KEEP",
  });

  const removing = reduceConfigState(configured, { type: "key-remove-requested" });
  assert.equal(removing.keyDraft.value, "");
  const removeUpdate = planApiKeyUpdate(removing.hasKey, removing.keyDraft);
  assert.deepEqual(removeUpdate, { schemaVersion: 1, action: "REMOVE" });
  assert.equal("value" in removeUpdate, false);

  const replaced = reduceConfigState(removing, { type: "key-draft", value: "second-key" });
  assert.deepEqual(planApiKeyUpdate(replaced.hasKey, replaced.keyDraft), {
    schemaVersion: 1,
    action: "REPLACE",
    value: "second-key",
  });

  const cleared = reduceConfigState(replaced, { type: "key-draft", value: "" });
  assert.equal(cleared.keyDraft.removeRequested, false);
  assert.deepEqual(planApiKeyUpdate(cleared.hasKey, cleared.keyDraft), {
    schemaVersion: 1,
    action: "KEEP",
  });

  const cancelled = reduceConfigState(removing, { type: "key-remove-cancelled" });
  assert.deepEqual(planApiKeyUpdate(cancelled.hasKey, cancelled.keyDraft), {
    schemaVersion: 1,
    action: "KEEP",
  });

  // Removal is impossible without a configured key.
  assert.equal(reduceConfigState(missing, { type: "key-remove-requested" }), missing);

  const keepUpdate = planApiKeyUpdate(true, { value: "", removeRequested: false });
  const replaceUpdate = planApiKeyUpdate(false, { value: "abc", removeRequested: false });
  assert.equal(isApiKeyUpdate(keepUpdate), true);
  assert.equal(isApiKeyUpdate(removeUpdate), true);
  assert.equal(isApiKeyUpdate(replaceUpdate), true);
  assert.ok(API_KEY_ACTION.includes(keepUpdate.action));
  assert.ok(API_KEY_ACTION.includes(replaceUpdate.action));
  assert.equal(isPersonalApiKey(replaceUpdate.value), true);
});

test("replace validation rejects oversized or control-bearing keys in both locales", () => {
  assert.equal(apiKeyError("k".repeat(LIMITS.apiKeyUtf8Bytes)), null);
  assert.equal(apiKeyError("k".repeat(LIMITS.apiKeyUtf8Bytes + 1)), "keyErrorTooLong");
  assert.equal(apiKeyError("é".repeat(256)), null);
  assert.equal(utf8Bytes("é".repeat(256)), LIMITS.apiKeyUtf8Bytes);
  assert.equal(apiKeyError("é".repeat(257)), "keyErrorTooLong");
  assert.equal(apiKeyError("line1\nline2"), "keyErrorNewline");
  assert.equal(apiKeyError("line1\rline2"), "keyErrorNewline");
  assert.equal(apiKeyError("key\u0001header"), "keyErrorNewline");

  const tooLong = planConfigResult({
    hasKey: false,
    keyDraft: { value: "k".repeat(LIMITS.apiKeyUtf8Bytes + 1), removeRequested: false },
    favorites: [],
  });
  assert.equal(tooLong.ok, false);
  if (tooLong.ok) return;
  assert.equal(tooLong.error, "keyErrorTooLong");
  for (const dictionary of [COPY.en, COPY.fr]) {
    assert.equal(typeof dictionary[tooLong.error], "string");
  }

  const newline = planConfigResult({
    hasKey: true,
    keyDraft: { value: "a\nb", removeRequested: false },
    favorites: [],
  });
  assert.equal(newline.ok, false);
  if (newline.ok) return;
  assert.equal(newline.error, "keyErrorNewline");

  const boundary = planConfigResult({
    hasKey: false,
    keyDraft: { value: "é".repeat(256), removeRequested: false },
    favorites: [],
  });
  assert.equal(boundary.ok, true);
  if (!boundary.ok) return;
  assert.equal(boundary.payload.apiKeyUpdate.action, "REPLACE");
  assert.equal(isPersonalApiKey(boundary.payload.apiKeyUpdate.value), true);
  assert.deepEqual(boundary.payload.favorites, []);
});

test("favorite edits replace the whole list atomically with renumbered order", () => {
  const state = initialConfigState(parseConfigFragment(fragmentWith(fixtureList)));

  const removed = reduceConfigState(state, { type: "favorite-remove", id: "home" });
  assert.deepEqual(removed.favorites, [{ ...fixtureList[1], sortOrder: 0 }]);

  const moved = reduceConfigState(state, { type: "favorite-move", id: "work", delta: -1 });
  assert.deepEqual(moved.favorites.map((entry) => entry.id), ["work", "home"]);
  assert.deepEqual(moved.favorites.map((entry) => entry.sortOrder), [0, 1]);

  assert.equal(reduceConfigState(state, { type: "favorite-remove", id: "nope" }), state);
  assert.equal(reduceConfigState(state, { type: "favorite-move", id: "home", delta: -1 }), state);
  assert.equal(reduceConfigState(state, { type: "favorite-move", id: "work", delta: 99 }), state);

  const outcome = planConfigResult(removed);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.payload.favorites, [
    {
      schemaVersion: 1,
      id: "work",
      serviceId: "service:work",
      stopLabel: "Arrêt work",
      lineLabel: "Métro 1",
      destinationLabel: "La Défense",
      lineMode: "METRO",
      lineColor: "#ffbe00",
      lineTextColor: "#000000",
      sortOrder: 0,
      displayName: "Bureau",
    },
  ]);
  for (const entry of outcome.payload.favorites) {
    assert.equal(isFavorite(entry), true);
    assert.equal(isFavoriteShape(entry), true);
  }
});

test("an oversized favorite list is rejected at save instead of truncated, preserving state", () => {
  const many = Array.from({ length: LIMITS.favorites + 1 }, (_, index) => favorite(`f${index}`, index));
  const state = initialConfigState(parseConfigFragment(fragmentWith(many)));
  const outcome = planConfigResult(state);
  assert.equal(outcome.ok, false);
  if (outcome.ok) return;
  assert.equal(outcome.error, "favoriteLimit");
  assert.equal(copyFor("en")[outcome.error].length > 0, true);
  assert.equal(copyFor("fr")[outcome.error].length > 0, true);
  // Rejection never mutates the list: the user keeps every entry and can
  // recover by removing one favorite, after which the save succeeds whole.
  assert.equal(state.favorites.length, LIMITS.favorites + 1);
  const recovered = planConfigResult(reduceConfigState(state, { type: "favorite-remove", id: "f0" }));
  assert.equal(recovered.ok, true);
  if (!recovered.ok) return;
  assert.equal(recovered.payload.favorites.length, LIMITS.favorites);
});

test("the seventh favorite is rejected by the add path while a valid six save whole", () => {
  let state = initialConfigState(parseConfigFragment(fragmentWith([])));
  for (let index = 0; index < LIMITS.favorites; index += 1) {
    const entry = favoriteFromService(`cfg-${index}`, serviceOption(`svc-${index}`), index);
    assert.ok(entry);
    state = reduceConfigState(state, { type: "favorite-add", favorite: entry });
  }
  assert.equal(state.favorites.length, LIMITS.favorites);

  const extra = favoriteFromService("cfg-extra", serviceOption("svc-extra"), LIMITS.favorites);
  assert.ok(extra);
  assert.equal(reduceConfigState(state, { type: "favorite-add", favorite: extra }), state);
  assert.equal(state.favorites.length, LIMITS.favorites);

  // The full valid six plans and round-trips the phone update untruncated.
  const outcome = planConfigResult(state);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.payload.favorites.map((entry) => entry.serviceId), state.favorites.map((entry) => entry.serviceId));
  const parsedUpdate = companionConfiguration.parseCloseFragment(encodeCloseFragment(outcome.payload));
  assert.notEqual(parsedUpdate, null);
  const applied = companionConfiguration.applyConfigurationUpdate(
    companionConfiguration.emptyConfiguration(),
    parsedUpdate,
  );
  assert.notEqual(applied, null);
  assert.deepEqual(applied.favorites.map((entry) => entry.serviceId), outcome.payload.favorites.map((entry) => entry.serviceId));
});

test("the close fragment carries the key value only for REPLACE and is one-shot", () => {
  const session = createCloseSession();
  assert.equal(session.closed, false);

  const entered = reduceConfigState(
    initialConfigState(parseConfigFragment(fragmentWith(fixtureList))),
    { type: "key-draft", value: "super-secret-key" },
  );
  const replaceOutcome = planConfigResult(entered);
  assert.equal(replaceOutcome.ok, true);
  if (!replaceOutcome.ok) return;
  assert.equal(isApiKeyUpdate(replaceOutcome.payload.apiKeyUpdate), true);
  assert.deepEqual(Object.keys(replaceOutcome.payload).sort(), [
    "apiKeyUpdate",
    "favorites",
    "schemaVersion",
  ]);
  assert.deepEqual(Object.keys(replaceOutcome.payload.apiKeyUpdate).sort(), [
    "action",
    "schemaVersion",
    "value",
  ]);

  const fragment = session.close(replaceOutcome.payload);
  assert.equal(session.closed, true);
  assert.ok(fragment !== null && fragment.startsWith(CLOSE_PREFIX));
  if (fragment === null) return;

  const encodedValue = encodeURIComponent(JSON.stringify(replaceOutcome.payload));
  assert.equal(fragment, CLOSE_PREFIX + encodedValue);

  const decoded = JSON.parse(decodeURIComponent(fragment.slice(CLOSE_PREFIX.length)));
  assert.deepEqual(decoded, replaceOutcome.payload);
  assert.equal(decoded.apiKeyUpdate.action, "REPLACE");
  assert.equal(decoded.apiKeyUpdate.value, "super-secret-key");

  assert.equal(session.close(replaceOutcome.payload), null);

  // KEEP and REMOVE never carry any key value.
  const keepOutcome = planConfigResult(initialConfigState(parseConfigFragment(fragmentWith(fixtureList))));
  assert.equal(keepOutcome.ok, true);
  if (!keepOutcome.ok) return;
  assert.equal(isApiKeyUpdate(keepOutcome.payload.apiKeyUpdate), true);
  assert.deepEqual(Object.keys(keepOutcome.payload.apiKeyUpdate).sort(), ["action", "schemaVersion"]);
  const keepFragment = encodeCloseFragment(keepOutcome.payload);
  assert.equal(keepFragment.includes("super-secret-key"), false);

  const removeOutcome = planConfigResult(
    reduceConfigState(initialConfigState(parseConfigFragment(fragmentWith([]))), {
      type: "key-remove-requested",
    }),
  );
  assert.equal(removeOutcome.ok, true);
  if (!removeOutcome.ok) return;
  assert.deepEqual(Object.keys(removeOutcome.payload.apiKeyUpdate).sort(), ["action", "schemaVersion"]);
  assert.equal(encodeCloseFragment(removeOutcome.payload).includes("super-secret-key"), false);
});

test("three backend services can be added, renamed, reordered, and removed atomically", () => {
  const services = [
    serviceOption("svc-a"),
    { ...serviceOption("svc-b"), stopLabel: "République", lineLabel: "96", destinationLabel: "Porte des Lilas", lineMode: "BUS", lineColor: "#007852" },
    { ...serviceOption("svc-c"), stopLabel: "Nation", lineLabel: "A", destinationLabel: "Cergy", lineMode: "RER", lineColor: "#e3051c" },
  ];
  let state = initialConfigState(parseConfigFragment(fragmentWith([])));
  services.forEach((service, index) => {
    const entry = favoriteFromService(`cfg-${index}`, service, index);
    assert.ok(entry);
    state = reduceConfigState(state, { type: "favorite-add", favorite: entry });
  });
  assert.deepEqual(state.favorites.map((entry) => entry.serviceId), ["svc-a", "svc-b", "svc-c"]);
  assert.deepEqual(
    state.favorites.map(({ lineMode, lineColor, lineTextColor }) => ({ lineMode, lineColor, lineTextColor })),
    services.map(({ lineMode, lineColor, lineTextColor }) => ({ lineMode, lineColor, lineTextColor })),
  );
  state = reduceConfigState(state, { type: "favorite-rename", id: "cfg-1", displayName: "Travail" });
  state = reduceConfigState(state, { type: "favorite-move", id: "cfg-2", delta: -2 });
  state = reduceConfigState(state, { type: "favorite-remove", id: "cfg-0" });
  assert.deepEqual(state.favorites.map((entry) => [entry.id, entry.sortOrder, entry.displayName]), [
    ["cfg-2", 0, undefined],
    ["cfg-1", 1, "Travail"],
  ]);
  const outcome = planConfigResult(state);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.payload.favorites.every(isPhoneFavorite), true);
  // Routing travels with every re-selected service into the close payload.
  assert.deepEqual(
    outcome.payload.favorites.map((entry) => entry.routing?.lineRef),
    [SERVICE_ROUTING.lineRef, SERVICE_ROUTING.lineRef],
  );
});

test("catalog response guards reject identifiers and malformed or oversized collections", () => {
  const placeLines = [{ lineLabel: "14", lineColor: "#62259d", lineTextColor: "#ffffff" }];
  const place = { placeId: "plc-a", stopLabel: "Châtelet", localityLabel: "Paris", mode: "METRO", lines: placeLines };
  const service = serviceOption("svc-a");
  assert.equal(isPlaceSearchResult({ schemaVersion: 1, places: [place] }), true);
  assert.equal(isPlaceSearchResult({ schemaVersion: 1, places: Array(21).fill(place) }), false);
  assert.equal(isPlaceSearchResult({ schemaVersion: 1, places: [{ ...place, monitoringRef: "raw" }] }), false);
  const { lines: _placeLines, ...withoutLines } = place;
  assert.equal(isPlaceSearchResult({ schemaVersion: 1, places: [withoutLines] }), false);
  assert.equal(isPlaceSearchResult({ schemaVersion: 1, places: [{ ...place, lines: [] }] }), false);
  const sparsePlaceLines: unknown[] = [placeLines[0]];
  sparsePlaceLines.length = 2;
  assert.equal(isPlaceSearchResult({ schemaVersion: 1, places: [{ ...place, lines: sparsePlaceLines }] }), false);
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: "plc-a", services: [service] }, "plc-a"), true);
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: "other", services: [service] }, "plc-a"), false);
  const { routing: _routing, ...routingLess } = service;
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: "plc-a", services: [routingLess] }, "plc-a"), false);
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: "plc-a", services: [
    { ...service, routing: { ...SERVICE_ROUTING, monitoringRef: "" } },
  ] }, "plc-a"), false);
  assert.equal(favoriteFromService("cfg-a", { ...service, lineRef: "raw" }, 0), null);
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: "plc-a", services: [{ ...service, lineColor: "#BE418D" }] }, "plc-a"), false);
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: "plc-a", services: [{ ...service, lineMode: "metro" }] }, "plc-a"), false);
  const { lineTextColor: _missingTextColor, ...missingTextColor } = service;
  assert.equal(favoriteFromService("cfg-a", missingTextColor, 0), null);
});

test("service routing validates exactly and only phone favorites may carry it", () => {
  assert.equal(isServiceRouting({ ...SERVICE_ROUTING }), true);
  assert.equal(isServiceRouting({ ...SERVICE_ROUTING, extra: "x" }), false);
  assert.equal(isServiceRouting({ ...SERVICE_ROUTING, lineRef: "" }), false);
  assert.equal(isServiceRouting({ ...SERVICE_ROUTING, directionId: "0" }), false);
  const { destinationRef: _missingRef, ...missingRef } = SERVICE_ROUTING;
  assert.equal(isServiceRouting(missingRef), false);
  // The accepted contract invents no per-reference byte cap.
  assert.equal(isServiceRouting({ ...SERVICE_ROUTING, monitoringRef: "M".repeat(4096) }), true);

  assert.equal(isPhoneFavorite(routingFavorite("r1", 0)), true);
  assert.equal(isPhoneFavorite({ ...routingFavorite("r1", 0), routing: { ...SERVICE_ROUTING, lineRef: "" } }), false);
  assert.equal(isPhoneFavorite({ ...routingFavorite("r1", 0), routing: undefined }), false);
  assert.equal(isPhoneFavorite(minimalFavorite("minimal", 0)), true);
  assert.equal(isFavoriteShape(minimalFavorite("minimal", 0)), true);
  assert.equal(isFavorite(minimalFavorite("minimal", 0)), true);
});

test("favorites created from catalog services carry a fresh routing copy", () => {
  const service = serviceOption("svc-a");
  const entry = favoriteFromService("cfg-a", service, 0, "Maison");
  assert.ok(entry);
  assert.deepEqual(entry.routing, SERVICE_ROUTING);
  service.routing.monitoringRef = "MUTATED";
  assert.equal(entry.routing.monitoringRef, SERVICE_ROUTING.monitoringRef);

  assert.deepEqual(parseConfigFragment(fragmentWith([entry])).favorites, [entry]);
  // A favorite with malformed routing is dropped whole, never half-kept.
  assert.deepEqual(
    parseConfigFragment(fragmentWith([
      { ...entry, routing: { ...SERVICE_ROUTING, destinationRef: 3 } },
    ])).favorites,
    [],
  );
});

test("routing survives the full page round trip and phone-side validation", () => {
  const favorites: PhoneFavorite[] = [
    routingFavorite("home", 0),
    { ...routingFavorite("work", 1), displayName: "Bureau" },
  ];
  const state = initialConfigState(parseConfigFragment(fragmentWith(favorites)));
  const outcome = planConfigResult(state);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.payload.favorites, favorites);
  // The watch projection validator stays strict: routing never reaches the watch.
  assert.equal(isFavorite(outcome.payload.favorites[0]), false);

  const parsedUpdate = companionConfiguration.parseCloseFragment(encodeCloseFragment(outcome.payload));
  assert.notEqual(parsedUpdate, null);
  assert.equal(parsedUpdate.forceFullSync, false);
  assert.deepEqual(parsedUpdate.favorites, outcome.payload.favorites);
  const applied = companionConfiguration.applyConfigurationUpdate(
    companionConfiguration.emptyConfiguration(),
    parsedUpdate,
  );
  assert.notEqual(applied, null);
  assert.deepEqual(applied.favorites, outcome.payload.favorites);
  assert.equal(companionConfiguration.isStoredConfiguration(applied), true);

  // The companion-produced opening fragment carries routing and never the key.
  const stored = {
    schemaVersion: 1,
    favorites: outcome.payload.favorites,
    primApiKey: "stored-personal-key",
    keyStatus: 1,
  };
  const url = companionConfiguration.configurationUrl(
    "https://config.example.test/index.html",
    stored,
    "fr_FR",
  );
  assert.equal(typeof url, "string");
  assert.equal(url.includes("stored-personal-key"), false);
  const openingState = JSON.parse(decodeURIComponent(url.slice(url.indexOf("#") + 1)));
  assert.deepEqual(openingState.favorites, outcome.payload.favorites);
  assert.deepEqual(parseConfigFragment(new URL(url).hash).favorites, outcome.payload.favorites);

  // Nested routing fields are scanned for key leakage on both channels.
  assert.equal(companionConfiguration.isStoredConfiguration({
    ...stored,
    favorites: [{ ...favorites[0], routing: { ...SERVICE_ROUTING, monitoringRef: "x stored-personal-key" } }],
  }), false);
  const leakParsed = companionConfiguration.parseCloseFragment(encodeCloseFragment({
    schemaVersion: SCHEMA_VERSION,
    apiKeyUpdate: { schemaVersion: SCHEMA_VERSION, action: "KEEP" },
    favorites: [{ ...favorites[0], routing: { ...SERVICE_ROUTING, monitoringRef: "x stored-personal-key" } }],
  }));
  assert.notEqual(leakParsed, null);
  assert.equal(companionConfiguration.applyConfigurationUpdate(stored, leakParsed), null);
  const replacementLeak = companionConfiguration.parseCloseFragment(encodeCloseFragment({
    schemaVersion: SCHEMA_VERSION,
    apiKeyUpdate: { schemaVersion: SCHEMA_VERSION, action: "REPLACE", value: "brand-new-key" },
    favorites: [{ ...favorites[0], routing: { ...SERVICE_ROUTING, lineRef: "leak brand-new-key" } }],
  }));
  assert.notEqual(replacementLeak, null);
  assert.equal(companionConfiguration.applyConfigurationUpdate(stored, replacementLeak), null);
});

test("force full synchronization is an explicit one-shot close flag", () => {
  const base = initialConfigState(parseConfigFragment(fragmentWith(fixtureList)));
  const quiet = planConfigResult(base);
  assert.equal(quiet.ok, true);
  if (!quiet.ok) return;
  assert.equal(Object.hasOwn(quiet.payload, "forceFullSync"), false);
  assert.deepEqual(Object.keys(quiet.payload).sort(), ["apiKeyUpdate", "favorites", "schemaVersion"]);

  const forcedState = reduceConfigState(base, { type: "force-full-sync", value: true });
  const forced = planConfigResult(forcedState);
  assert.equal(forced.ok, true);
  if (!forced.ok) return;
  assert.equal(forced.payload.forceFullSync, true);
  // Other pending changes are preserved alongside the flag.
  assert.deepEqual(forced.payload.favorites, quiet.payload.favorites);
  assert.deepEqual(forced.payload.apiKeyUpdate, quiet.payload.apiKeyUpdate);
  const toggledOff = planConfigResult(reduceConfigState(forcedState, { type: "force-full-sync", value: false }));
  assert.equal(toggledOff.ok, true);
  if (!toggledOff.ok) return;
  assert.equal(Object.hasOwn(toggledOff.payload, "forceFullSync"), false);

  const forcedParsed = companionConfiguration.parseCloseFragment(encodeCloseFragment(forced.payload));
  assert.notEqual(forcedParsed, null);
  assert.equal(forcedParsed.forceFullSync, true);
  const quietParsed = companionConfiguration.parseCloseFragment(encodeCloseFragment(quiet.payload));
  assert.notEqual(quietParsed, null);
  assert.equal(quietParsed.forceFullSync, false);
  const appliedForced = companionConfiguration.applyConfigurationUpdate(
    companionConfiguration.emptyConfiguration(),
    forcedParsed,
  );
  assert.notEqual(appliedForced, null);
  // One-shot: the flag is consumed by the phone and never stored.
  assert.equal(Object.hasOwn(appliedForced, "forceFullSync"), false);
  assert.equal(companionConfiguration.isStoredConfiguration(appliedForced), true);
  assert.equal(companionConfiguration.parseCloseFragment(encodeCloseFragment({
    ...forced.payload,
    forceFullSync: "yes",
  })), null);
  assert.equal(companionConfiguration.isConfigurationUpdate({
    schemaVersion: SCHEMA_VERSION,
    favorites: [],
    apiKeyUpdate: { schemaVersion: SCHEMA_VERSION, action: "KEEP" },
    forceFullSync: 1,
  }), false);
});

test("unresolved favorites hydrate in place or wait for explicit re-selection", () => {
  let state = initialConfigState(parseConfigFragment(fragmentWith([minimalFavorite("unresolved", 0), favorite("home", 1)])));
  assert.equal(Object.hasOwn(state.favorites[0], "routing"), false);

  // Unknown, mismatched, or malformed hydration never deletes or reorders.
  assert.equal(reduceConfigState(state, {
    type: "favorite-hydrate",
    id: "ghost",
    favorite: routingFavorite("ghost", 0),
  }), state);
  assert.equal(reduceConfigState(state, {
    type: "favorite-hydrate",
    id: "unresolved",
    favorite: routingFavorite("other", 0),
  }), state);
  assert.equal(reduceConfigState(state, {
    type: "favorite-hydrate",
    id: "unresolved",
    favorite: { ...routingFavorite("unresolved", 0), routing: { ...SERVICE_ROUTING, lineRef: "" } },
  }), state);

  // Routing-only recovery: the stored favorite is copied verbatim — labels,
  // colors, service binding, and the watch metadata hash — and only validated
  // routing is attached, exactly as the page app constructs it.
  const stored = state.favorites[0];
  const hydrated = copyPhoneFavorite(stored);
  hydrated.routing = { ...SERVICE_ROUTING };
  state = reduceConfigState(state, { type: "favorite-hydrate", id: "unresolved", favorite: hydrated });
  assert.deepEqual(state.favorites.map((entry) => entry.id), ["unresolved", "home"]);
  assert.deepEqual(state.favorites.map((entry) => entry.sortOrder), [0, 1]);
  assert.deepEqual(state.favorites[0], { ...stored, routing: SERVICE_ROUTING });

  const outcome = planConfigResult(state);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.payload.favorites[0].routing !== undefined, true);
  assert.equal(isFavorite(outcome.payload.favorites[1]), true);
  // A missing catalog ID keeps the favorite valid exactly as it is.
  const stillUnresolved = planConfigResult(initialConfigState(parseConfigFragment(
    fragmentWith([minimalFavorite("unresolved", 0)]),
  )));
  assert.equal(stillUnresolved.ok, true);
  if (!stillUnresolved.ok) return;
  assert.equal(Object.hasOwn(stillUnresolved.payload.favorites[0], "routing"), false);
});
test("encoded close and opening fragments enforce the 32768 bound at producers", () => {
  assert.equal(MAX_CLOSE_PAYLOAD_LENGTH, 32768);
  const small = planConfigResult(initialConfigState(parseConfigFragment(fragmentWith(fixtureList))));
  assert.equal(small.ok, true);
  if (!small.ok) return;
  assert.equal(closePayloadFits(small.payload), true);

  // A valid static service with an enormous reference fits every per-field
  // rule but must never reach the one-shot channel.
  const bloatedFavorite: PhoneFavorite = {
    ...routingFavorite("big", 0),
    routing: { ...SERVICE_ROUTING, monitoringRef: "M".repeat(33000) },
  };
  const bloated = { ...small.payload, favorites: [bloatedFavorite] };
  assert.equal(closePayloadFits(bloated), false);

  // The one-shot session refuses oversized payloads without being consumed.
  const session = createCloseSession();
  assert.equal(session.close(bloated), null);
  assert.equal(session.closed, false);
  assert.equal(session.close(small.payload)?.startsWith(CLOSE_PREFIX), true);
  assert.equal(session.closed, true);

  // The phone rejects the same bound on the close channel.
  assert.equal(companionConfiguration.parseCloseFragment(encodeCloseFragment(bloated)), null);

  // The opening producer never emits a fragment the page would discard.
  const oversizedConfig = {
    schemaVersion: 1,
    favorites: [bloatedFavorite],
    primApiKey: "stored-personal-key",
    keyStatus: 1,
  };
  assert.equal(companionConfiguration.isStoredConfiguration(oversizedConfig), true);
  assert.equal(
    companionConfiguration.configurationUrl("https://config.example.test/index.html", oversizedConfig, "en_US"),
    null,
  );
  const compactUrl = companionConfiguration.configurationUrl(
    "https://config.example.test/index.html",
    { ...oversizedConfig, favorites: fixtureList },
    "en_US",
  );
  assert.equal(typeof compactUrl, "string");
  assert.equal(
    (compactUrl ?? "").length <= "https://config.example.test/index.html#".length + MAX_CLOSE_PAYLOAD_LENGTH,
    true,
  );

  // Selecting or hydrating an oversized candidate is rejected whole: the list
  // is untouched and the session stays usable.
  const base = initialConfigState(parseConfigFragment(fragmentWith(fixtureList)));
  assert.equal(base.favorites.length, 2);
  const refusedAdd = reduceConfigState(base, { type: "favorite-add", favorite: bloatedFavorite });
  assert.equal(refusedAdd, base);
  const bloatedHydration = copyPhoneFavorite(base.favorites[0]);
  bloatedHydration.routing = { ...SERVICE_ROUTING, lineRef: "L".repeat(33000) };
  assert.equal(reduceConfigState(base, {
    type: "favorite-hydrate",
    id: base.favorites[0].id,
    favorite: bloatedHydration,
  }), base);

  assert.notEqual(COPY.en.saveTooLarge, undefined);
  assert.notEqual(COPY.fr.saveTooLarge, undefined);
  assert.notEqual(COPY.en.saveTooLarge, COPY.fr.saveTooLarge);
});
test("favorite preview uses the credential-free recorded departure fixture", () => {
  const recorded = JSON.parse(
    readFileSync(join(here, "../../../fixtures/departures/foundation.json"), "utf8"),
  );
  assert.deepEqual(
    RECORDED_PREVIEW,
    recorded.result.departures.map(({ minutes, status }: { minutes: number; status: string }) => ({ minutes, status })),
  );
  assert.equal(JSON.stringify(RECORDED_PREVIEW).includes(recorded.favorite.serviceId), false);
});

test("page keeps secrets out of durable and observable surfaces", () => {
  const core = readFileSync(join(here, "../src/config-core.js"), "utf8");
  const controller = readFileSync(join(here, "../src/config-page.js"), "utf8");
  const client = readFileSync(join(here, "../src/catalog-client.js"), "utf8");
  const html = readFileSync(join(here, "../index.html"), "utf8");
  for (const source of [core, client]) {
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\\.cookie|WebSocket|console\\./u);
  }
  // The controller itself may persist section open/closed booleans in
  // localStorage; every other durable or observable surface stays banned.
  assert.doesNotMatch(controller, /sessionStorage|document\\.cookie|WebSocket|console\\./u);
  assert.doesNotMatch(client, /prim\\.iledefrance-mobilites/u);
  assert.match(html, /type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"/u);
  assert.match(html, /connect-src 'self'/u);
  assert.doesNotMatch(html, /value=["'][^"']+["']/u);
  assert.match(html, /img-src 'self'/u);
  assert.doesNotMatch(html, /img-src 'none'/u);
});

test("bilingual About copy exposes the required legal, privacy, attribution, and safe-link facts", () => {
  const html = readFileSync(join(here, "../index.html"), "utf8");
  const controller = readFileSync(join(here, "../src/config-page.js"), "utf8");
  for (const fact of [
    "Version 0.1.0",
    "Publication director:",
    "Directeur de la publication :",
    "Anthodev",
    "BunnyWay d.o.o.",
    "Dunajska cesta 165",
    "https://bunny.net/privacy/",
    "localStorage",
    "no analytics or telemetry",
    "aucun cookie",
    "survives app updates and uninstall/reinstall",
    "Désinstaller l’application de la montre",
    "Référentiel des lignes",
    "conditions d’utilisation IDFM/PRIM",
    "search terms are sent",
    "termes saisis sont transmis",
    "ODbL 1.0",
    "github.com/Anthodev/lapin-fute",
  ]) assert.equal(html.includes(fact), true, fact);
  assert.doesNotMatch(html, /GitHub Pages|Lapin Futé backend|serveur Lapin Futé/iu);
  assert.match(html, /phone sends it directly to PRIM over HTTPS/u);
  assert.match(html, /téléphone l’envoie directement à PRIM en HTTPS/u);
  assert.doesNotMatch(html, /software licen[cs]e|licence du logiciel/iu);
  assert.equal((html.match(/target="_blank"/gu) ?? []).length, (html.match(/rel="noopener noreferrer"/gu) ?? []).length);
  assert.match(controller, /lineBadgeAssetUrl\(service\.lineMode, service\.lineLabel\)/u);
  assert.match(controller, /image\.addEventListener\("error"/u);
  assert.match(controller, /elements\.config_view\.hidden = true/u);
  assert.match(controller, /aboutReturnFocus\.focus\(\)/u);
});

test("official rail badges cover every RER and Transilien line", () => {
  for (const line of ["A", "B", "C", "D", "E"]) {
    assert.match(lineBadgeAssetUrl("RER", line) ?? "", new RegExp(`/rer-${line.toLowerCase()}\\.png$`, "u"));
  }
  for (const line of ["H", "J", "K", "L", "N", "P", "R", "U", "V"]) {
    assert.match(
      lineBadgeAssetUrl("TRANSILIEN", line) ?? "",
      new RegExp(`/transilien-${line.toLowerCase()}\\.png$`, "u"),
    );
  }
});

test("favorites without presentation fields resolve no official image and use an accessible neutral fallback", () => {
  const minimal = minimalFavorite("minimal-badge", 0);
  const controller = readFileSync(join(here, "../src/config-page.js"), "utf8");

  assert.equal(lineBadgeAssetUrl(minimal.lineMode, minimal.lineLabel), undefined);
  assert.match(
    controller,
    /const assetUrl = service\.lineMode === undefined\s+\? undefined\s+:\s+lineBadgeAssetUrl\(service\.lineMode, service\.lineLabel\)/u,
  );
  assert.match(controller, /const NEUTRAL_LINE_BACKGROUND = "#52616f"/u);
  assert.match(controller, /const NEUTRAL_LINE_TEXT = "#ffffff"/u);
  assert.match(controller, /const backgroundColor = service\.lineColor \?\? NEUTRAL_LINE_BACKGROUND/u);
  assert.match(controller, /const textColor = service\.lineTextColor \?\? NEUTRAL_LINE_TEXT/u);
  assert.match(controller, /svg\.setAttribute\("role", "img"\)/u);
  assert.match(controller, /svg\.setAttribute\("aria-label", service\.lineLabel\)/u);
});

test("mirrored place search validation matches the canonical lines contract", () => {
  const line = { lineLabel: "13", lineColor: "#82c8e6", lineTextColor: "#000000" };
  const placeId = `plc_${"0".repeat(43)}`;
  const valid = {
    placeId,
    stopLabel: "Saint-Denis - Université",
    localityLabel: "Saint-Denis",
    mode: "METRO",
    lines: [line, { lineLabel: "1611", lineColor: "#009645", lineTextColor: "#ffffff" }],
  };
  const sparse: unknown[] = [line];
  sparse.length = 2;
  const cases: Array<[unknown, boolean]> = [
    [valid, true],
    [{ ...valid, localityLabel: undefined }, true],
    [{ ...valid, lines: [{ ...line, lineLabel: "x".repeat(96) }] }, true],
    [{ ...valid, lines: [{ ...line, lineLabel: "é".repeat(48) }] }, true],
    [{ ...valid, lines: [] }, false],
    [{ ...valid, lines: undefined }, false],
    [{ ...valid, lines: "13" }, false],
    [{ ...valid, lines: sparse }, false],
    [{ ...valid, lines: [null] }, false],
    [{ ...valid, lines: [{ ...line, lineRef: "STIF:Line::C01393:" }] }, false],
    [{ ...valid, lines: [{ lineLabel: "13", lineColor: "#82c8e6" }] }, false],
    [{ ...valid, lines: [{ ...line, lineColor: "#82C8E6" }] }, false],
    [{ ...valid, lines: [{ ...line, lineTextColor: "#fff" }] }, false],
    [{ ...valid, lines: [{ ...line, lineLabel: "" }] }, false],
    [{ ...valid, lines: [{ ...line, lineLabel: "x".repeat(97) }] }, false],
    [{ ...valid, lines: [{ ...line, lineLabel: "é".repeat(49) }] }, false],
    [{ ...valid, lines: [{ ...line, lineLabel: "13\n" }] }, false],
    [{ ...valid, monitoringRef: "raw" }, false],
  ];
  for (const [value, expected] of cases) {
    assert.equal(isPlaceSearchItem(value), expected);
    assert.equal(canonicalIsPlaceSearchItem(value), expected);
  }
  assert.equal(isPlaceLine(line), true);
  assert.equal(canonicalIsPlaceLine(line), true);
  assert.equal(isPlaceLine({ ...line, extra: true }), false);
  assert.equal(canonicalIsPlaceLine({ ...line, extra: true }), false);
});

test("the first-load gzip metric includes the eagerly imported badge resolver", () => {
  const measurement = readFileSync(join(here, "../../../scripts/measure-config-page.mjs"), "utf8");
  assert.match(measurement, /packages\/config-page\/src\/line-badge-assets\.js/u);
});
