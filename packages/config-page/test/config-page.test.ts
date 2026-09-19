import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import {
  API_KEY_ACTION,
  CONFIGURATION_VERSION as CANONICAL_CONFIGURATION_VERSION,
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
  CONFIGURATION_VERSION,
  EMPTY_KEY_DRAFT,
  LIMITS,
  MAX_CLOSE_PAYLOAD_LENGTH,
  SCHEMA_VERSION,
  apiKeyError,
  closePayloadFits,
  copyFor,
  copyPhoneFavorite,
  createCloseSession,
  encodeCloseFragment,
  favoriteFromService,
  initialConfigState,
  isFavoriteShape,
  isJourneyPlace,
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

// Journey place identities as computed by the catalog: plc_ + 43 base64url
// characters. Tests derive stable ids from short seeds.
function journeyPlaceId(seed: string): string {
  return `plc_${(seed + "0".repeat(43)).slice(0, 43)}`;
}

function arrival(placeId: string, label = "Porte de Clignancourt") {
  return { kind: "place" as const, placeId, label };
}

const ARRIVAL_A = arrival(journeyPlaceId("a"));
const ARRIVAL_B = arrival(journeyPlaceId("b"), "Hôpital Européen");

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
    arrivalPlaceId: journeyPlaceId(id),
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
    arrivalPlaceId: journeyPlaceId(id),
    sortOrder,
  };
}

const fixtureList: Favorite[] = [favorite("home", 0), { ...favorite("work", 1), displayName: "Bureau" }];

// A pre-journey favorite: exactly the historical fields, never arrivalPlaceId.
type LegacyFavorite = Omit<Favorite, "arrivalPlaceId">;

function legacyFavorite(id: string, sortOrder: number): LegacyFavorite {
  const { arrivalPlaceId: _arrivalPlaceId, ...withoutArrival } = favorite(id, sortOrder);
  return withoutArrival;
}

const EMPTY_READONLY_STATE = {
  hasKey: false,
  language: "en",
  locale: "en",
  favorites: [],
  editable: false,
  languagePreference: "auto",
  languagePreferenceSupported: false,
};

function openingFragment(value: Record<string, unknown>): string {
  return `#${encodeURIComponent(JSON.stringify(value))}`;
}

// Current phone: complete v2 opening envelope.
function fragmentWith(favorites: unknown[], overrides: Record<string, unknown> = {}): string {
  return openingFragment({
    schemaVersion: CONFIGURATION_VERSION,
    hasKey: true,
    favorites,
    language: "fr_FR",
    ...overrides,
  });
}

// Old or unversioned phone: legacy read-only opening envelope.
function legacyFragmentWith(favorites: unknown[], overrides: Record<string, unknown> = {}): string {
  return openingFragment({ hasKey: true, favorites, language: "fr_FR", ...overrides });
}

// A current phone-local record: CONFIG_SCHEMA_VERSION 3 with a required
// languagePreference. Older stored shapes only exist through the companion's
// migration and are never produced here.
function storedConfiguration(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: companionConfiguration.CONFIG_SCHEMA_VERSION,
    favorites: fixtureList,
    primApiKey: "stored-personal-key",
    keyStatus: 1,
    languagePreference: "auto",
    ...overrides,
  };
}

test("mirrored constants equal the canonical contract", () => {
  assert.equal(SCHEMA_VERSION, CANONICAL_SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 1);
  assert.equal(CONFIGURATION_VERSION, CANONICAL_CONFIGURATION_VERSION);
  assert.equal(CONFIGURATION_VERSION, 2);
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
  assert.equal(COPY.en.configurationUpgradeRequired, "Update Lapin Futé on your Pebble to edit these settings.");
  assert.equal(COPY.fr.configurationUpgradeRequired, "Mettez à jour Lapin Futé sur votre Pebble pour modifier ces réglages.");
});

test("authored and transport labels never appear in product copy", () => {
  const serialized = JSON.stringify(COPY);
  for (const label of ["Châtelet", "Métro 1", "La Défense", "Arrêt home", "Arrêt work", "Bureau"]) {
    assert.equal(serialized.includes(label), false);
  }
});

test("a complete v2 opening opens an editable session and validates favorites", () => {
  const query = parseConfigFragment(fragmentWith(fixtureList));
  assert.equal(query.hasKey, true);
  assert.equal(query.language, "fr_FR");
  assert.equal(query.locale, "fr");
  assert.equal(query.editable, true);
  assert.deepEqual(query.favorites, fixtureList);

  assert.equal(parseConfigFragment(fragmentWith([], { hasKey: false, language: "en_US" })).editable, true);
  assert.equal(
    parseConfigFragment(openingFragment({ schemaVersion: CONFIGURATION_VERSION, favorites: [], language: "en_US" })).hasKey,
    false,
  );
  assert.equal(
    parseConfigFragment(
      openingFragment({ schemaVersion: CONFIGURATION_VERSION, hasKey: "true", favorites: [], language: "en_US" }),
    ).hasKey,
    false,
  );

  const broken = parseConfigFragment(
    openingFragment({ schemaVersion: CONFIGURATION_VERSION, hasKey: true, favorites: "not-an-array", language: "en_US" }),
  );
  assert.deepEqual(broken, EMPTY_READONLY_STATE);

  // An invalid v2 favorite never yields an editable subset: the session stays
  // read-only and only individually valid entries are displayed.
  const invalid = parseConfigFragment(fragmentWith([
    favorite("ok", 0),
    { ...favorite("old", 1), schemaVersion: 2 },
    { ...favorite("huge", 2), stopLabel: "x".repeat(97) },
    { ...favorite("absent", 3), arrivalPlaceId: "not-a-place-id" },
    "junk",
  ]));
  assert.equal(invalid.editable, false);
  assert.deepEqual(invalid.favorites.map((entry) => entry.id), ["ok"]);
  assert.equal(planConfigResult(initialConfigState(invalid)).ok, false);
});

test("legacy and unversioned openings are decoded read-only for display only", () => {
  const legacy: LegacyFavorite[] = [
    legacyFavorite("old-1", 0),
    { ...legacyFavorite("old-2", 1), displayName: "Bureau" },
    { ...legacyFavorite("old-3", 2), routing: { ...SERVICE_ROUTING } },
  ];
  const query = parseConfigFragment(legacyFragmentWith(legacy));
  assert.equal(query.hasKey, true);
  assert.equal(query.editable, false);
  assert.deepEqual(query.favorites, legacy);

  // An explicit schemaVersion 1 gets the same read-only treatment.
  const marked = parseConfigFragment(legacyFragmentWith(legacy, { schemaVersion: SCHEMA_VERSION }));
  assert.equal(marked.editable, false);
  assert.deepEqual(marked.favorites, legacy);

  // Current favorites under a legacy envelope never display: the arrival
  // field marks them as not-old, not as migrated, and nothing hydrates.
  assert.deepEqual(parseConfigFragment(legacyFragmentWith(fixtureList)).favorites, []);

  // The state built from a legacy opening is inert (covered end to end in the
  // read-only governance test) and never reports favorites as editable.
  const state = initialConfigState(query);
  assert.equal(state.editable, false);
  assert.deepEqual(state.favorites, legacy);
});

test("absent or malformed openings are non-editable empty sessions", () => {
  assert.deepEqual(parseConfigFragment(""), EMPTY_READONLY_STATE);
  assert.deepEqual(parseConfigFragment("#"), EMPTY_READONLY_STATE);
  assert.deepEqual(parseConfigFragment("not-a-fragment"), EMPTY_READONLY_STATE);
  assert.deepEqual(parseConfigFragment(openingFragment({
    schemaVersion: 3,
    hasKey: true,
    favorites: fixtureList,
    language: "en_US",
  })), EMPTY_READONLY_STATE);
  assert.deepEqual(parseConfigFragment(openingFragment({
    schemaVersion: CONFIGURATION_VERSION,
    hasKey: true,
    favorites: fixtureList,
  })), EMPTY_READONLY_STATE);
  assert.deepEqual(parseConfigFragment(openingFragment({
    schemaVersion: CONFIGURATION_VERSION,
    hasKey: true,
    favorites: fixtureList,
    language: "en_US",
    extra: 1,
  })), EMPTY_READONLY_STATE);
});
test("minimal favorites round trip without inventing presentation properties and partial groups reject", () => {
  const minimal = minimalFavorite("minimal", 0);
  const parsed = parseConfigFragment(fragmentWith([minimal]));
  const presentationFields = ["lineMode", "lineColor", "lineTextColor"] as const;

  // The watch projection rejects the phone-local arrival and routing fields.
  assert.equal(isFavorite(minimal), false);
  assert.equal(isFavoriteShape(minimal), true);
  assert.equal(parsed.editable, true);
  assert.deepEqual(parsed.favorites, [minimal]);
  for (const field of presentationFields) {
    assert.equal(Object.hasOwn(parsed.favorites[0], field), false);
  }

  // A null arrival is a valid unresolved favorite, not a legacy absence.
  const unresolved = { ...minimal, arrivalPlaceId: null };
  assert.equal(isPhoneFavorite(unresolved), true);
  const unresolvedParsed = parseConfigFragment(fragmentWith([unresolved]));
  assert.equal(unresolvedParsed.editable, true);
  assert.deepEqual(unresolvedParsed.favorites, [unresolved]);

  const partials = [
    { ...minimal, lineMode: "METRO" },
    { ...minimal, lineMode: "METRO", lineColor: "#ffbe00" },
    { ...minimal, lineColor: "#ffbe00", lineTextColor: "#000000" },
  ];
  for (const partial of partials) {
    assert.equal(isFavorite(partial), false);
    assert.equal(isFavoriteShape(partial), false);
    assert.equal(parseConfigFragment(fragmentWith([partial])).editable, false);
    assert.deepEqual(parseConfigFragment(fragmentWith([partial])).favorites, []);
  }
  assert.equal(isFavorite({ ...minimal, lineMode: undefined }), false);
  assert.equal(isFavoriteShape({ ...minimal, lineMode: undefined }), false);
  // A missing arrival field is invalid: only null means unresolved.
  assert.equal(isFavoriteShape({ ...minimal, arrivalPlaceId: undefined }), false);

  const outcome = planConfigResult(initialConfigState(parsed));
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.payload.schemaVersion, CONFIGURATION_VERSION);
  assert.deepEqual(outcome.payload.favorites, [minimal]);
  for (const field of presentationFields) {
    assert.equal(Object.hasOwn(outcome.payload.favorites[0], field), false);
  }
});
test("the config page consumes the companion-produced opening fragment exactly", () => {
  const key = "stored-personal-key";
  const url = companionConfiguration.configurationUrl(
    "https://config.example.test/index.html",
    storedConfiguration({ favorites: fixtureList, primApiKey: key }),
    "fr_FR",
  );
  assert.equal(typeof url, "string");
  if (url === null) return;
  assert.equal(url.includes(key), false);

  const openingState = JSON.parse(decodeURIComponent(url.slice(url.indexOf("#") + 1)));
  assert.deepEqual(
    Object.keys(openingState),
    ["schemaVersion", "hasKey", "favorites", "languagePreference", "language"],
  );
  assert.deepEqual(openingState, {
    schemaVersion: CONFIGURATION_VERSION,
    hasKey: true,
    favorites: fixtureList,
    languagePreference: "auto",
    language: "fr_FR",
  });
  assert.deepEqual(parseConfigFragment(new URL(url).hash), {
    hasKey: true,
    language: "fr_FR",
    locale: "fr",
    favorites: fixtureList,
    editable: true,
    languagePreference: "auto",
    languagePreferenceSupported: true,
  });
});

test("an advertised languagePreference enables a strict selector round trip", () => {
  const parsed = parseConfigFragment(fragmentWith(fixtureList, { languagePreference: "fr" }));
  assert.equal(parsed.editable, true);
  assert.equal(parsed.languagePreference, "fr");
  assert.equal(parsed.languagePreferenceSupported, true);

  const state = initialConfigState(parsed);
  assert.equal(state.languagePreference, "fr");
  assert.equal(state.languagePreferenceSupported, true);

  // An untouched selector replays the launch value verbatim.
  const untouched = planConfigResult(state);
  assert.equal(untouched.ok, true);
  if (!untouched.ok) return;
  assert.equal(untouched.payload.languagePreference, "fr");
  assert.equal(closePayloadFits(untouched.payload), true);

  // Every supported value is accepted exactly, including an explicit "auto"
  // that clears the override, and nothing outside the trio is ever adopted.
  for (const value of ["auto", "en", "fr"]) {
    assert.equal(reduceConfigState(state, { type: "language-preference", value }).languagePreference, value);
  }
  assert.equal(reduceConfigState(state, { type: "language-preference", value: "de" }), state);

  // A preference-only save leaves favorites and the key decision untouched.
  const changed = planConfigResult(reduceConfigState(state, { type: "language-preference", value: "en" }));
  assert.equal(changed.ok, true);
  if (!changed.ok) return;
  assert.equal(changed.payload.languagePreference, "en");
  assert.deepEqual(changed.payload.favorites, untouched.payload.favorites);
  assert.deepEqual(changed.payload.apiKeyUpdate, untouched.payload.apiKeyUpdate);

  // A read-only session shows the launch preference but can never save.
  const readOnly = parseConfigFragment(fragmentWith(
    [{ ...favorite("bad", 0), stopLabel: "x".repeat(97) }],
    { languagePreference: "fr" },
  ));
  assert.equal(readOnly.editable, false);
  assert.equal(readOnly.languagePreference, "fr");
  assert.equal(readOnly.languagePreferenceSupported, true);
  assert.equal(planConfigResult(initialConfigState(readOnly)).ok, false);
});

test("an unadvertised launch keeps the selector inert and the close payload free of the preference", () => {
  // An older companion build emits the v2 envelope without the field.
  const parsed = parseConfigFragment(openingFragment({
    schemaVersion: CONFIGURATION_VERSION,
    hasKey: true,
    favorites: fixtureList,
    language: "fr_FR",
  }));
  assert.equal(parsed.editable, true);
  assert.equal(parsed.languagePreference, "auto");
  assert.equal(parsed.languagePreferenceSupported, false);

  const state = initialConfigState(parsed);
  // Even a supported value is ignored: the session never adopts a preference
  // the launch did not advertise.
  const changed = reduceConfigState(state, { type: "language-preference", value: "en" });
  assert.equal(changed, state);
  assert.equal(changed.languagePreference, "auto");

  const outcome = planConfigResult(state);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  // Omission is the compatibility contract: the phone preserves the stored
  // preference instead of receiving an unknown field it must reject whole.
  assert.deepEqual(Object.keys(outcome.payload).sort(), ["apiKeyUpdate", "favorites", "schemaVersion"]);
  const parsedUpdate = companionConfiguration.parseCloseFragment(encodeCloseFragment(outcome.payload));
  assert.notEqual(parsedUpdate, null);
  if (parsedUpdate === null) return;
  assert.equal(Object.hasOwn(parsedUpdate, "languagePreference"), false);

  // The same omission leaves an existing explicit override untouched.
  const applied = companionConfiguration.applyConfigurationUpdate(
    storedConfiguration({ languagePreference: "en" }),
    parsedUpdate,
  );
  assert.notEqual(applied, null);
  if (applied === null) return;
  assert.equal(applied.languagePreference, "en");

  // Legacy and unversioned envelopes are read-only and never advertise.
  assert.equal(parseConfigFragment(legacyFragmentWith(fixtureList)).languagePreferenceSupported, false);
});

test("an invalid present languagePreference rejects the whole opening without coercion", () => {
  for (const bad of ["de", "DE", "", "auto ", "fr-FR", 1, null, true]) {
    const parsed = parseConfigFragment(fragmentWith(fixtureList, { languagePreference: bad }));
    assert.deepEqual(parsed, EMPTY_READONLY_STATE);
    const outcome = planConfigResult(initialConfigState(parsed));
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(typeof COPY.en[outcome.error], "string");
  }
});

test("explicit choices stay distinct from automatic across a full save and reopen", () => {
  // A saved explicit French choice matching the system language must never
  // come back as Automatic.
  const stored = storedConfiguration({ languagePreference: "fr" });
  const opened = parseConfigFragment(new URL(
    companionConfiguration.configurationUrl("https://config.example.test/index.html", stored, "fr_FR") ?? "",
  ).hash);
  assert.equal(opened.languagePreference, "fr");
  assert.equal(opened.languagePreferenceSupported, true);
  assert.equal(opened.locale, "fr");

  // The user returns the selector to Automatic and saves.
  const state = reduceConfigState(initialConfigState(opened), { type: "language-preference", value: "auto" });
  const outcome = planConfigResult(state);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.payload.languagePreference, "auto");

  const parsedUpdate = companionConfiguration.parseCloseFragment(encodeCloseFragment(outcome.payload));
  assert.notEqual(parsedUpdate, null);
  if (parsedUpdate === null) return;
  assert.equal(parsedUpdate.languagePreference, "auto");

  // The commit keeps favorites and the key, and stores the explicit reset.
  const applied = companionConfiguration.applyConfigurationUpdate(stored, parsedUpdate);
  assert.notEqual(applied, null);
  if (applied === null) return;
  assert.equal(applied.languagePreference, "auto");
  assert.deepEqual(applied.favorites, stored.favorites);
  assert.equal(applied.primApiKey, stored.primApiKey);
  assert.equal(applied.keyStatus, stored.keyStatus);
  assert.equal(companionConfiguration.isStoredConfiguration(applied), true);

  // Reopening restores Automatic as the stored intent while the resolved
  // system language still drives the page copy.
  const reopened = parseConfigFragment(new URL(
    companionConfiguration.configurationUrl("https://config.example.test/index.html", applied, "fr_FR") ?? "",
  ).hash);
  assert.equal(reopened.languagePreference, "auto");
  assert.equal(reopened.languagePreferenceSupported, true);
  assert.equal(reopened.locale, "fr");
});


test("a planted key field never enters page state or the payload", () => {
  const parsed = parseConfigFragment(fragmentWith(fixtureList, { apiKey: "SECRET-VALUE" }));
  // The unknown top-level field makes the whole envelope malformed.
  assert.deepEqual(parsed, EMPTY_READONLY_STATE);
  assert.equal(JSON.stringify(parsed).includes("SECRET-VALUE"), false);
  const planned = planConfigResult(initialConfigState(parsed));
  assert.equal(JSON.stringify(planned).includes("SECRET-VALUE"), false);
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
    editable: true,
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
    editable: true,
    hasKey: true,
    keyDraft: { value: "a\nb", removeRequested: false },
    favorites: [],
  });
  assert.equal(newline.ok, false);
  if (newline.ok) return;
  assert.equal(newline.error, "keyErrorNewline");

  const boundary = planConfigResult({
    editable: true,
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

test("read-only sessions never mutate, save, or hydrate regardless of the DOM", () => {
  const readonlyStates = [
    initialConfigState(parseConfigFragment(legacyFragmentWith([legacyFavorite("old", 0)]))),
    initialConfigState(parseConfigFragment(legacyFragmentWith([]))),
    initialConfigState(parseConfigFragment("")),
    initialConfigState(parseConfigFragment(
      fragmentWith([{ ...favorite("bad", 0), stopLabel: "x".repeat(97) }]),
    )),
  ];
  for (const state of readonlyStates) {
    assert.equal(state.editable, false);
    assert.equal(reduceConfigState(state, { type: "key-draft", value: "typed-key" }), state);
    assert.equal(reduceConfigState(state, { type: "key-remove-requested" }), state);
    assert.equal(reduceConfigState(state, { type: "key-remove-cancelled" }), state);
    assert.equal(reduceConfigState(state, { type: "favorite-add", favorite: routingFavorite("new", 0) }), state);
    assert.equal(reduceConfigState(state, { type: "favorite-rename", id: "old", displayName: "X" }), state);
    assert.equal(reduceConfigState(state, { type: "favorite-remove", id: "old" }), state);
    assert.equal(reduceConfigState(state, { type: "favorite-move", id: "old", delta: 1 }), state);
    assert.equal(reduceConfigState(state, {
      type: "favorite-hydrate",
      id: "old",
      favorite: routingFavorite("old", 0),
    }), state);
    assert.equal(reduceConfigState(state, { type: "force-full-sync", value: true }), state);

    const outcome = planConfigResult(state);
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error, "configurationUpgradeRequired");
    for (const dictionary of [COPY.en, COPY.fr]) {
      assert.equal(typeof dictionary[outcome.error], "string");
    }
  }

  // A favorite-less v2 opening stays editable: an empty configuration must
  // remain savable, and its close carries the v2 envelope an old phone
  // rejects instead of wiping the stored configuration.
  const emptyEditable = initialConfigState(
    parseConfigFragment(fragmentWith([], { hasKey: false, language: "en_US" })),
  );
  assert.equal(emptyEditable.editable, true);
  const emptyOutcome = planConfigResult(emptyEditable);
  assert.equal(emptyOutcome.ok, true);
  if (!emptyOutcome.ok) return;
  assert.equal(emptyOutcome.payload.schemaVersion, CONFIGURATION_VERSION);
  assert.deepEqual(emptyOutcome.payload.favorites, []);
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
      arrivalPlaceId: journeyPlaceId("work"),
      lineMode: "METRO",
      lineColor: "#ffbe00",
      lineTextColor: "#000000",
      sortOrder: 0,
      displayName: "Bureau",
    },
  ]);
  for (const entry of outcome.payload.favorites) {
    // The close payload keeps phone-local routing and arrival: the watch
    // projection rejects both.
    assert.equal(isFavorite(entry), false);
    assert.equal(isFavoriteShape(entry), true);
    assert.equal(isPhoneFavorite(entry), true);
  }
});

test("malformed whole favorite lists stay read-only and cannot be normalized into a save", () => {
  const invalidLists = [
    [favorite("duplicate", 0), favorite("duplicate", 1)],
    Array.from({ length: LIMITS.favorites + 1 }, (_, index) => favorite(`f${index}`, index % LIMITS.favorites)),
    [{ ...favorite("newline", 0), arrivalPlaceId: `${ARRIVAL_A.placeId}\n` }],
    [favorite("negative", -1)],
    [favorite("outside", LIMITS.favorites)],
  ];
  const editable = initialConfigState(parseConfigFragment(fragmentWith([])));
  for (const favorites of invalidLists) {
    const opening = parseConfigFragment(fragmentWith(favorites));
    assert.equal(opening.editable, false);
    const state = initialConfigState(opening);
    assert.equal(planConfigResult(state).ok, false);
    assert.equal(reduceConfigState(state, { type: "favorite-remove", id: favorites[0].id }), state);
    // Save validates the original whole list even if a caller bypasses opening admission.
    assert.equal(planConfigResult({ ...editable, favorites }).ok, false);
  }
});

test("the seventh favorite is rejected by the add path while a valid six save whole", () => {
  let state = initialConfigState(parseConfigFragment(fragmentWith([])));
  for (let index = 0; index < LIMITS.favorites; index += 1) {
    const entry = favoriteFromService(`cfg-${index}`, serviceOption(`svc-${index}`), ARRIVAL_A, index);
    assert.ok(entry);
    state = reduceConfigState(state, { type: "favorite-add", favorite: entry });
  }
  assert.equal(state.favorites.length, LIMITS.favorites);

  const extra = favoriteFromService("cfg-extra", serviceOption("svc-extra"), ARRIVAL_A, 0);
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
  assert.equal(replaceOutcome.payload.schemaVersion, CONFIGURATION_VERSION);
  assert.equal(replaceOutcome.payload.apiKeyUpdate.schemaVersion, SCHEMA_VERSION);
  assert.equal(replaceOutcome.payload.favorites[0].schemaVersion, SCHEMA_VERSION);
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
    const entry = favoriteFromService(`cfg-${index}`, service, ARRIVAL_A, index);
    assert.ok(entry);
    state = reduceConfigState(state, { type: "favorite-add", favorite: entry });
  });
  assert.deepEqual(state.favorites.map((entry) => entry.serviceId), ["svc-a", "svc-b", "svc-c"]);
  // Every favorite carries the arrival chosen in the selection flow.
  assert.deepEqual(state.favorites.map((entry) => entry.arrivalPlaceId), [ARRIVAL_A.placeId, ARRIVAL_A.placeId, ARRIVAL_A.placeId]);
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
  // Routing and the arrival travel with every re-selected service into the
  // close payload.
  assert.deepEqual(
    outcome.payload.favorites.map((entry) => entry.routing?.lineRef),
    [SERVICE_ROUTING.lineRef, SERVICE_ROUTING.lineRef],
  );
  assert.deepEqual(
    outcome.payload.favorites.map((entry) => entry.arrivalPlaceId),
    [ARRIVAL_A.placeId, ARRIVAL_A.placeId],
  );
});

test("catalog response guards reject identifiers and malformed or oversized collections", () => {
  const placeLines = [{ lineLabel: "14", lineColor: "#62259d", lineTextColor: "#ffffff" }];
  const place = { placeId: journeyPlaceId("place-a"), stopLabel: "Châtelet", localityLabel: "Paris", mode: "METRO", lines: placeLines };
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
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: journeyPlaceId("place-a"), services: [service] }, journeyPlaceId("place-a")), true);
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: journeyPlaceId("place-a"), services: [service] }, "other"), false);
  const { routing: _routing, ...routingLess } = service;
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: journeyPlaceId("place-a"), services: [routingLess] }, journeyPlaceId("place-a")), false);
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: journeyPlaceId("place-a"), services: [
    { ...service, routing: { ...SERVICE_ROUTING, monitoringRef: "" } },
  ] }, journeyPlaceId("place-a")), false);
  assert.equal(favoriteFromService("cfg-a", { ...service, lineRef: "raw" }, ARRIVAL_A, 0), null);
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: journeyPlaceId("place-a"), services: [{ ...service, lineColor: "#BE418D" }] }, journeyPlaceId("place-a")), false);
  assert.equal(isServiceOptionsResult({ schemaVersion: 1, placeId: journeyPlaceId("place-a"), services: [{ ...service, lineMode: "metro" }] }, journeyPlaceId("place-a")), false);
  const { lineTextColor: _missingTextColor, ...missingTextColor } = service;
  assert.equal(favoriteFromService("cfg-a", missingTextColor, ARRIVAL_A, 0), null);

  // The arrival is mandatory and must be a well-formed journey place: no
  // caller ever creates an unresolved favorite from the selection flow.
  assert.equal(favoriteFromService("cfg-a", service, null, 0), null);
  assert.equal(favoriteFromService("cfg-a", service, undefined, 0), null);
  assert.equal(favoriteFromService("cfg-a", service, { ...ARRIVAL_A, kind: "terminal" }, 0), null);
  assert.equal(favoriteFromService("cfg-a", service, arrival("svc_malformed"), 0), null);
  assert.equal(favoriteFromService("cfg-a", service, arrival(`plc_${"0".repeat(42)}`), 0), null);
  assert.equal(favoriteFromService("cfg-a", service, { ...ARRIVAL_A, label: "" }, 0), null);
  assert.equal(favoriteFromService("cfg-a", service, { ...ARRIVAL_A, extra: 1 }, 0), null);
  assert.equal(favoriteFromService("cfg-a", service, { ...ARRIVAL_A, label: "x".repeat(257) }, 0), null);
});

test("journey places validate the catalog place identity shape exactly", () => {
  assert.equal(isJourneyPlace(ARRIVAL_A), true);
  assert.equal(isJourneyPlace(arrival(journeyPlaceId("z"), "")), false);
  assert.equal(isJourneyPlace({ ...ARRIVAL_A, kind: "terminal" }), false);
  assert.equal(isJourneyPlace({ ...ARRIVAL_A, extra: 1 }), false);
  assert.equal(isJourneyPlace({ kind: "place", placeId: ARRIVAL_A.placeId }), false);
  assert.equal(isJourneyPlace(arrival(`svc_${"0".repeat(43)}`)), false);
  assert.equal(isJourneyPlace(arrival(`plc_${"0".repeat(44)}`)), false);
  assert.equal(isJourneyPlace(arrival(`plc_${"!".repeat(43)}`)), false);
  assert.equal(isJourneyPlace(arrival(`${ARRIVAL_A.placeId}\n`)), false);
  assert.equal(isJourneyPlace({ ...ARRIVAL_A, label: "x".repeat(257) }), false);
  assert.equal(isJourneyPlace({ ...ARRIVAL_A, label: "x".repeat(256) }), true);
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
  // The watch projection rejects the phone-local arrival field.
  assert.equal(isFavorite(minimalFavorite("minimal", 0)), false);
});

test("favorites created from catalog services carry a fresh routing copy and the chosen arrival", () => {
  const service = serviceOption("svc-a");
  const entry = favoriteFromService("cfg-a", service, ARRIVAL_A, 0, "Maison");
  assert.ok(entry);
  assert.deepEqual(entry.routing, SERVICE_ROUTING);
  service.routing.monitoringRef = "MUTATED";
  assert.equal(entry.routing.monitoringRef, SERVICE_ROUTING.monitoringRef);
  // The arrival identifies and labels the favorite.
  assert.equal(entry.arrivalPlaceId, ARRIVAL_A.placeId);
  assert.equal(entry.destinationLabel, ARRIVAL_A.label);

  // A label too large for storage is truncated by the shared helper.
  const long = favoriteFromService("cfg-b", service, arrival(journeyPlaceId("c"), "x".repeat(120)), 1);
  assert.ok(long);
  assert.equal(long.destinationLabel, `${"x".repeat(93)}…`);
  const accented = favoriteFromService("cfg-c", service, arrival(journeyPlaceId("d"), "é".repeat(60)), 2);
  assert.ok(accented);
  assert.equal(accented.destinationLabel, `${"é".repeat(46)}…`);
  assert.equal(utf8Bytes(accented.destinationLabel) <= LIMITS.labelUtf8Bytes, true);

  assert.deepEqual(parseConfigFragment(fragmentWith([entry])).favorites, [entry]);
  // A favorite with malformed routing is dropped whole, and the session is
  // never an editable subset.
  const malformed = parseConfigFragment(fragmentWith([
    { ...entry, routing: { ...SERVICE_ROUTING, destinationRef: 3 } },
  ]));
  assert.equal(malformed.editable, false);
  assert.deepEqual(malformed.favorites, []);
});

test("routing and arrivals survive the full page round trip and phone-side validation", () => {
  const favorites: PhoneFavorite[] = [
    routingFavorite("home", 0),
    { ...routingFavorite("work", 1), displayName: "Bureau" },
  ];
  const state = initialConfigState(parseConfigFragment(fragmentWith(favorites)));
  const outcome = planConfigResult(state);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.deepEqual(outcome.payload.favorites, favorites);
  // The watch projection validator stays strict: routing and the arrival
  // never reach the watch.
  assert.equal(isFavorite(outcome.payload.favorites[0]), false);

  const parsedUpdate = companionConfiguration.parseCloseFragment(encodeCloseFragment(outcome.payload));
  assert.notEqual(parsedUpdate, null);
  assert.equal(parsedUpdate.schemaVersion, CONFIGURATION_VERSION);
  assert.equal(parsedUpdate.forceFullSync, false);
  assert.deepEqual(parsedUpdate.favorites, outcome.payload.favorites);
  const applied = companionConfiguration.applyConfigurationUpdate(
    companionConfiguration.emptyConfiguration(),
    parsedUpdate,
  );
  assert.notEqual(applied, null);
  assert.deepEqual(applied.favorites, outcome.payload.favorites);
  assert.equal(companionConfiguration.isStoredConfiguration(applied), true);

  // The companion-produced opening fragment carries routing and arrivals and
  // never the key.
  const stored = storedConfiguration({ favorites: outcome.payload.favorites });
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
    schemaVersion: CONFIGURATION_VERSION,
    apiKeyUpdate: { schemaVersion: SCHEMA_VERSION, action: "KEEP" },
    favorites: [{ ...favorites[0], routing: { ...SERVICE_ROUTING, monitoringRef: "x stored-personal-key" } }],
  }));
  assert.notEqual(leakParsed, null);
  assert.equal(companionConfiguration.applyConfigurationUpdate(stored, leakParsed), null);
  const replacementLeak = companionConfiguration.parseCloseFragment(encodeCloseFragment({
    schemaVersion: CONFIGURATION_VERSION,
    apiKeyUpdate: { schemaVersion: SCHEMA_VERSION, action: "REPLACE", value: "brand-new-key" },
    favorites: [{ ...favorites[0], routing: { ...SERVICE_ROUTING, lineRef: "leak brand-new-key" } }],
  }));
  assert.notEqual(replacementLeak, null);
  assert.equal(companionConfiguration.applyConfigurationUpdate(stored, replacementLeak), null);

  // A credential cannot hide in the arrival identity: the strict place-id
  // shape makes such a favorite invalid, so the phone rejects the update
  // whole instead of storing it.
  assert.equal(companionConfiguration.parseCloseFragment(encodeCloseFragment({
    schemaVersion: CONFIGURATION_VERSION,
    apiKeyUpdate: { schemaVersion: SCHEMA_VERSION, action: "KEEP" },
    favorites: [{ ...favorites[0], arrivalPlaceId: "plc_x stored-personal-key" }],
  })), null);
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
    schemaVersion: CONFIGURATION_VERSION,
    favorites: [],
    apiKeyUpdate: { schemaVersion: SCHEMA_VERSION, action: "KEEP" },
    forceFullSync: 1,
  }), false);
});

test("unresolved favorites hydrate in place or wait for explicit re-selection", () => {
  const unresolved = { ...minimalFavorite("unresolved", 0), arrivalPlaceId: null };
  let state = initialConfigState(parseConfigFragment(fragmentWith([unresolved, favorite("home", 1)])));
  assert.equal(Object.hasOwn(state.favorites[0], "routing"), false);
  assert.equal(state.editable, true);

  // Unknown, mismatched, malformed, or foreign-service hydration never
  // deletes or reorders.
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
  assert.equal(reduceConfigState(state, {
    type: "favorite-hydrate",
    id: "unresolved",
    favorite: { ...routingFavorite("unresolved", 0), serviceId: "service:elsewhere" },
  }), state);

  // Routing-only recovery: the stored favorite keeps its identity, labels,
  // arrival, and custom name; only validated routing is attached.
  const stored = state.favorites[0];
  const hydrated = copyPhoneFavorite(stored);
  hydrated.routing = { ...SERVICE_ROUTING };
  state = reduceConfigState(state, { type: "favorite-hydrate", id: "unresolved", favorite: hydrated });
  assert.deepEqual(state.favorites.map((entry) => entry.id), ["unresolved", "home"]);
  assert.deepEqual(state.favorites.map((entry) => entry.sortOrder), [0, 1]);
  assert.deepEqual(state.favorites[0], { ...stored, routing: SERVICE_ROUTING });

  // A null arrival fills once, from the exact service. The stored favorite
  // is copied verbatim — labels, colors, custom name — and nothing resolved
  // is ever overwritten, even by a different valid place.
  const renamed = reduceConfigState(state, { type: "favorite-rename", id: "unresolved", displayName: "Maison" });
  const relabeled = {
    ...copyPhoneFavorite(renamed.favorites[0]),
    stopLabel: "Autre arrêt",
    destinationLabel: "Autre terminus",
    arrivalPlaceId: ARRIVAL_B.placeId,
  };
  const filled = reduceConfigState(renamed, { type: "favorite-hydrate", id: "unresolved", favorite: relabeled });
  assert.equal(filled.favorites[0].arrivalPlaceId, ARRIVAL_B.placeId);
  assert.equal(filled.favorites[0].stopLabel, "Arrêt unresolved");
  assert.equal(filled.favorites[0].destinationLabel, "La Défense");
  assert.equal(filled.favorites[0].displayName, "Maison");
  assert.deepEqual(filled.favorites[0].routing, SERVICE_ROUTING);

  // The resolved arrival is never overwritten.
  assert.equal(reduceConfigState(filled, {
    type: "favorite-hydrate",
    id: "unresolved",
    favorite: { ...copyPhoneFavorite(filled.favorites[0]), arrivalPlaceId: ARRIVAL_A.placeId },
  }), filled);
  // Hydrating a complete favorite changes nothing and keeps state identity.
  assert.equal(reduceConfigState(filled, {
    type: "favorite-hydrate",
    id: "unresolved",
    favorite: copyPhoneFavorite(filled.favorites[0]),
  }), filled);

  const outcome = planConfigResult(filled);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.payload.favorites[0].routing !== undefined, true);
  assert.equal(outcome.payload.favorites[0].arrivalPlaceId, ARRIVAL_B.placeId);

  // A favorite with neither routing nor a resolved arrival stays valid and
  // unforced: hydration waits for the catalog, never guesses.
  const stillUnresolved = planConfigResult(initialConfigState(parseConfigFragment(
    fragmentWith([{ ...minimalFavorite("unresolved", 0), arrivalPlaceId: null }]),
  )));
  assert.equal(stillUnresolved.ok, true);
  if (!stillUnresolved.ok) return;
  assert.equal(Object.hasOwn(stillUnresolved.payload.favorites[0], "routing"), false);
  assert.equal(stillUnresolved.payload.favorites[0].arrivalPlaceId, null);
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
  const oversizedConfig = storedConfiguration({ favorites: [bloatedFavorite] });
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
  assert.equal(reduceConfigState(base, { type: "favorite-add", favorite: bloatedFavorite }), base);
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
    assert.doesNotMatch(source, /localStorage|sessionStorage|document\.cookie|WebSocket|console\./u);
  }
  // The controller itself may persist section open/closed booleans in
  // localStorage; every other durable or observable surface stays banned.
  assert.doesNotMatch(controller, /sessionStorage|document\.cookie|WebSocket|console\./u);
  assert.doesNotMatch(client, /prim\.iledefrance-mobilites/u);
  assert.match(html, /type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false"/u);
  assert.match(html, /connect-src 'self'/u);
  assert.match(html, /img-src 'self'/u);
  assert.doesNotMatch(html, /img-src 'none'/u);
});

test("bilingual About copy exposes the required legal, privacy, attribution, and safe-link facts", () => {
  const html = readFileSync(join(here, "../index.html"), "utf8");
  const controller = readFileSync(join(here, "../src/config-page.js"), "utf8");
  for (const fact of [
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

test("search result labels use the available row width and wrap line badges", () => {
  const css = readFileSync(join(here, "../styles/config-page.css"), "utf8");
  assert.match(css, /\.choice-labels \{[^}]*flex: 1 1 auto;[^}]*min-width: 0;/u);
  assert.match(css, /\.choice-lines \{[^}]*flex-wrap: wrap;[^}]*width: 100%;[^}]*min-width: 0;/u);
});

test("mirrored place search validation matches the canonical lines contract", () => {
  const line = { lineLabel: "13", lineColor: "#82c8e6", lineTextColor: "#000000" };
  const placeId = journeyPlaceId("place-search");
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
