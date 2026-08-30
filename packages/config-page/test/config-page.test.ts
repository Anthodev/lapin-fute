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
  initialConfigState,
  isFavoriteShape,
  parseConfigFragment,
  planApiKeyUpdate,
  planConfigResult,
  reduceConfigState,
  selectLocale,
  utf8Bytes,
} from "../src/config-core.js";

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
test("the config page consumes the companion-produced opening fragment exactly", () => {
  const key = "stored-personal-key";
  const url = companionConfiguration.configurationUrl(
    "https://config.example.test/index.html",
    { schemaVersion: 1, favorites: fixtureList, apiKey: key },
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

test("replace validation rejects oversized or line-bearing keys in both locales", () => {
  assert.equal(apiKeyError("k".repeat(LIMITS.apiKeyUtf8Bytes)), null);
  assert.equal(apiKeyError("k".repeat(LIMITS.apiKeyUtf8Bytes + 1)), "keyErrorTooLong");
  assert.equal(apiKeyError("é".repeat(256)), null);
  assert.equal(utf8Bytes("é".repeat(256)), LIMITS.apiKeyUtf8Bytes);
  assert.equal(apiKeyError("é".repeat(257)), "keyErrorTooLong");
  assert.equal(apiKeyError("line1\nline2"), "keyErrorNewline");
  assert.equal(apiKeyError("line1\rline2"), "keyErrorNewline");

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

test("page sources contain no storage, network, timer, or logging surface", () => {
  const forbidden =
    /fetch\(|XMLHttpRequest|localStorage|sessionStorage|document\.cookie|WebSocket|console\.|setInterval|setTimeout\(/;
  for (const file of ["config-core.js", "config-page.js"]) {
    const source = readFileSync(join(here, "../src", file), "utf8");
    assert.doesNotMatch(source, forbidden);
  }
});
