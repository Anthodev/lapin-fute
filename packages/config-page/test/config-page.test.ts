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
  type Favorite,
} from "../../contracts/src/index.ts";
import {
  CLOSE_PREFIX,
  COPY,
  EMPTY_KEY_DRAFT,
  LIMITS,
  SCHEMA_VERSION,
  apiKeyError,
  copyFor,
  createCloseSession,
  encodeCloseFragment,
  favoriteFromService,
  initialConfigState,
  isFavoriteShape,
  isPlaceSearchResult,
  isServiceOptionsResult,
  parseConfigFragment,
  planApiKeyUpdate,
  planConfigResult,
  reduceConfigState,
  selectLocale,
  utf8Bytes,
} from "../src/config-core.js";
import {
  SEARCH_DEBOUNCE_MS,
  CatalogClientError,
  createCatalogClient,
} from "../src/catalog-client.js";
import { RECORDED_PREVIEW } from "../src/preview-fixture.js";
import { lineBadgeAssetUrl } from "../src/line-badge-assets.js";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const companionConfiguration = require("../../companion/src/configuration.js");

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

function legacyFavorite(id: string, sortOrder: number): Favorite {
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
test("legacy favorites round trip without inventing presentation properties and partial groups reject", () => {
  const legacy = legacyFavorite("legacy", 0);
  const parsed = parseConfigFragment(fragmentWith([legacy]));
  const presentationFields = ["lineMode", "lineColor", "lineTextColor"] as const;

  assert.equal(isFavorite(legacy), true);
  assert.equal(isFavoriteShape(legacy), true);
  assert.deepEqual(parsed.favorites, [legacy]);
  for (const field of presentationFields) {
    assert.equal(Object.hasOwn(parsed.favorites[0], field), false);
  }

  const partials = [
    { ...legacy, lineMode: "METRO" },
    { ...legacy, lineMode: "METRO", lineColor: "#ffbe00" },
    { ...legacy, lineColor: "#ffbe00", lineTextColor: "#000000" },
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
  assert.equal(isFavorite({ ...legacy, lineMode: undefined }), false);
  assert.equal(isFavoriteShape({ ...legacy, lineMode: undefined }), false);

  const outcome = planConfigResult(initialConfigState(parsed));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.payload.favorites, [legacy]);
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

test("payload favorites are capped at the contract maximum", () => {
  const many = Array.from({ length: LIMITS.favorites + 1 }, (_, index) => favorite(`f${index}`, index));
  const outcome = planConfigResult(initialConfigState(parseConfigFragment(fragmentWith(many))));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.payload.favorites.length, LIMITS.favorites);
  for (const entry of outcome.payload.favorites) {
    assert.equal(isFavorite(entry), true);
  }
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
    { serviceId: "svc-a", stopLabel: "Châtelet", lineLabel: "4", destinationLabel: "Bagneux", lineMode: "METRO", lineColor: "#be418d", lineTextColor: "#ffffff" },
    { serviceId: "svc-b", stopLabel: "République", lineLabel: "96", destinationLabel: "Porte des Lilas", lineMode: "BUS", lineColor: "#007852", lineTextColor: "#ffffff" },
    { serviceId: "svc-c", stopLabel: "Nation", lineLabel: "A", destinationLabel: "Cergy", lineMode: "RER", lineColor: "#e3051c", lineTextColor: "#ffffff" },
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
  if (outcome.ok) assert.equal(outcome.payload.favorites.every(isFavorite), true);
});

test("catalog response guards reject identifiers and malformed or oversized collections", () => {
  const place = { placeId: "plc-a", stopLabel: "Châtelet", localityLabel: "Paris", mode: "METRO" };
  const service = { serviceId: "svc-a", stopLabel: "Châtelet", lineLabel: "4", destinationLabel: "Bagneux", lineMode: "METRO", lineColor: "#be418d", lineTextColor: "#ffffff" };
  assert.equal(isPlaceSearchResult({ schemaVersion: 1, places: [place] }), true);
  assert.equal(isPlaceSearchResult({ schemaVersion: 1, places: Array(21).fill(place) }), false);
  assert.equal(isPlaceSearchResult({ schemaVersion: 1, places: [{ ...place, monitoringRef: "raw" }] }), false);
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: "plc-a", services: [service] }, "plc-a"), true);
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: "other", services: [service] }, "plc-a"), false);
  assert.equal(favoriteFromService("cfg-a", { ...service, lineRef: "raw" }, 0), null);
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: "plc-a", services: [{ ...service, lineColor: "#BE418D" }] }, "plc-a"), false);
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: "plc-a", services: [{ ...service, lineMode: "metro" }] }, "plc-a"), false);
  const { lineTextColor: _missingTextColor, ...missingTextColor } = service;
  assert.equal(favoriteFromService("cfg-a", missingTextColor, 0), null);
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
test("catalog search waits 300 ms, cancels superseded work, and validates responses", async () => {
  const timers = new Map<number, () => void>();
  const delays: number[] = [];
  let nextTimer = 0;
  const requests: string[] = [];
  const client = createCatalogClient({
    setTimer(callback: () => void, delay: number) {
      const id = ++nextTimer;

      delays.push(delay);
      timers.set(id, callback);
      return id;
    },
    clearTimer(id: number) {
      timers.delete(id);
    },
    async fetchImpl(url: string) {
      requests.push(url);
      return {
        ok: true,
        async json() {
          return { schemaVersion: 1, places: [] };
        },
      };
    },
  });
  const superseded = client.searchPlaces("ch");
  const latest = client.searchPlaces("cha");
  await assert.rejects(superseded, (error: unknown) => error instanceof DOMException && error.name === "AbortError");
  assert.deepEqual(delays, [SEARCH_DEBOUNCE_MS, SEARCH_DEBOUNCE_MS]);
  assert.equal(timers.size, 1);
  [...timers.values()][0]!();
  assert.deepEqual(await latest, []);
  assert.deepEqual(requests, ["/api/catalog/places?q=cha"]);

  const invalid = createCatalogClient({
    setTimer(callback: () => void) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimer() {},
    async fetchImpl() {
      return { ok: true, async json() { return { schemaVersion: 1, places: [{ placeId: "leak" }] }; } };
    },
  });
  await assert.rejects(invalid.searchPlaces("invalid"), (error: unknown) =>
    error instanceof CatalogClientError && error.code === "BACKEND_UNAVAILABLE");
});

test("page keeps secrets out of durable and observable surfaces", () => {
  const core = readFileSync(join(here, "../src/config-core.js"), "utf8");
  const controller = readFileSync(join(here, "../src/config-page.js"), "utf8");
  const client = readFileSync(join(here, "../src/catalog-client.js"), "utf8");
  const html = readFileSync(join(here, "../index.html"), "utf8");
  for (const source of [core, controller, client]) {
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\\.cookie|WebSocket|console\\./u);
  }
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
    "88 Colin P. Kelly Jr. St.",
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

test("legacy favorites resolve no official image and use an accessible neutral fallback", () => {
  const legacy = legacyFavorite("legacy-badge", 0);
  const controller = readFileSync(join(here, "../src/config-page.js"), "utf8");

  assert.equal(lineBadgeAssetUrl(legacy.lineMode, legacy.lineLabel), undefined);
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

test("the first-load gzip metric includes the eagerly imported badge resolver", () => {
  const measurement = readFileSync(join(here, "../../../scripts/measure-config-page.mjs"), "utf8");
  assert.match(measurement, /packages\/config-page\/src\/line-badge-assets\.js/u);
});
