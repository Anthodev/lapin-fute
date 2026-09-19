"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../src/contracts");
const configuration = require("../src/configuration");
const { FakeStorage } = require("./fakes");
const fixture = require("../../../fixtures/departures/foundation.json");
const KEY = "journey-storage-fixture-key";
const ARRIVAL = "plc_" + "a".repeat(43);
const ROUTING = { monitoringRef: "STIF:StopPoint:Q:1:", lineRef: "STIF:Line::1:", destinationRef: "STIF:StopPoint:Q:2:" };
function record(version = configuration.CONFIG_SCHEMA_VERSION) {
  const favorite = { ...fixture.favorite, arrivalPlaceId: ARRIVAL, routing: { ...ROUTING } };
  if (version === 1) delete favorite.arrivalPlaceId;
  const value = { schemaVersion: version, favorites: [favorite], primApiKey: KEY, keyStatus: C.KEY_STATUS.CONFIGURED };
  if (version === configuration.CONFIG_SCHEMA_VERSION) value.languagePreference = "auto";
  return value;
}
function storageFor(value) {
  const storage = new FakeStorage();
  storage.setItem(configuration.CONFIG_STORAGE_KEY, JSON.stringify(value));
  return storage;
}

test("both supported phone records migrate once to Automatic without losing favorites or credentials", () => {
  for (const version of [1, 2]) {
    const legacy = record(version), storage = storageFor(legacy);
    const expected = { ...legacy, schemaVersion: configuration.CONFIG_SCHEMA_VERSION, languagePreference: "auto",
      favorites: [{ ...legacy.favorites[0], arrivalPlaceId: version === 1 ? null : ARRIVAL }] };
    assert.deepEqual(configuration.loadConfiguration(storage), expected);
    assert.deepEqual(JSON.parse(storage.getItem(configuration.CONFIG_STORAGE_KEY)), expected);
    const writes = storage.writes.length;
    assert.deepEqual(configuration.loadConfiguration(storage), expected);
    assert.equal(storage.writes.length, writes);
    assert.equal(configuration.isStoredConfiguration(legacy), false);
  }
});

test("storage never treats malformed or missing v2 arrivals as a legacy omission", () => {
  for (const version of [1, 2, configuration.CONFIG_SCHEMA_VERSION]) {
    const value = record(version);
    value.favorites[0].arrivalPlaceId = "not-a-place";
    const storage = storageFor(value), before = storage.getItem(configuration.CONFIG_STORAGE_KEY);
    assert.equal(configuration.loadConfiguration(storage), null);
    assert.equal(storage.getItem(configuration.CONFIG_STORAGE_KEY), before);
  }
  const value = record(2); delete value.favorites[0].arrivalPlaceId;
  assert.equal(configuration.loadConfiguration(storageFor(value)), null);
  const inherited = record(); delete inherited.favorites[0].arrivalPlaceId;
  Object.setPrototypeOf(inherited.favorites[0], { arrivalPlaceId: ARRIVAL });
  assert.equal(configuration.isStoredConfiguration(inherited), false);
  const explicit = record(1);
  explicit.favorites[0].arrivalPlaceId = ARRIVAL;
  assert.deepEqual(configuration.loadConfiguration(storageFor(explicit)),
    { ...explicit, schemaVersion: configuration.CONFIG_SCHEMA_VERSION, languagePreference: "auto" });
});

test("routing recovery does not erase an explicit arrival and rejects unrelated corruption", () => {
  const value = record(); value.favorites[0].routing = { obsolete: true };
  const expected = record(); delete expected.favorites[0].routing;
  assert.deepEqual(configuration.loadConfiguration(storageFor(value)), expected);
  value.favorites[0].unexpected = true;
  assert.equal(configuration.loadConfiguration(storageFor(value)), null);
});

test("migration readback failure restores either old format and exposes no writable configuration", () => {
  for (const version of [1, 2]) {
    const storage = storageFor(record(version)), original = storage.getItem(configuration.CONFIG_STORAGE_KEY);
    const write = storage.setItem;
    let fail = true;
    storage.setItem = function (key, value) {
      if (key === configuration.CONFIG_STORAGE_KEY && fail) {
        fail = false;
        write.call(this, key, "corrupted-write");
      } else write.call(this, key, value);
    };
    assert.equal(configuration.loadConfiguration(storage), null);
    assert.equal(storage.getItem(configuration.CONFIG_STORAGE_KEY), original);
    assert.equal(configuration.applyConfigurationUpdate(null, { schemaVersion: 2, favorites: [],
      apiKeyUpdate: { schemaVersion: 1, action: "KEEP" } }), null);
    const restored = configuration.loadConfiguration(storage);
    assert.equal(restored.favorites[0].arrivalPlaceId, version === 1 ? null : ARRIVAL);
    assert.equal(restored.languagePreference, "auto");
  }
});

test("a durable invalid-key marker remains authoritative across legacy migration", () => {
  const value = record(), storage = storageFor(value), write = storage.setItem;
  storage.setItem = function (key, bytes) {
    if (key === configuration.CONFIG_STORAGE_KEY) throw new Error("interrupted configuration write");
    write.call(this, key, bytes);
  };
  assert.equal(configuration.saveInvalidConfiguration(storage, { ...value, keyStatus: C.KEY_STATUS.INVALID }), true);
  storage.setItem = write;
  const marker = storage.getItem(configuration.INVALID_KEY_STATUS_STORAGE_KEY);
  // Pre-migration schema-1 fingerprint for this fixture. Routing and arrival
  // never participated in that preimage.
  assert.equal(JSON.parse(marker).configurationFingerprint, "8466ba15b56d892b");
  storage.setItem(configuration.CONFIG_STORAGE_KEY, JSON.stringify(record(1)));
  const migrated = configuration.loadConfiguration(storage);
  assert.equal(migrated.keyStatus, C.KEY_STATUS.INVALID);
  assert.equal(migrated.primApiKey, KEY);
  assert.equal(migrated.favorites[0].arrivalPlaceId, null);
  assert.equal(storage.getItem(configuration.INVALID_KEY_STATUS_STORAGE_KEY), marker);
  assert.equal(JSON.parse(storage.getItem(configuration.CONFIG_STORAGE_KEY)).keyStatus, C.KEY_STATUS.INVALID);
});

test("v2 page envelopes preserve arrivals while a legacy empty close can never clear favorites", () => {
  const current = record();
  const opening = configuration.configurationPageState(current, "fr");
  assert.deepEqual(opening, { schemaVersion: 2, hasKey: true, favorites: current.favorites,
    language: "fr", languagePreference: "auto" });
  const update = { schemaVersion: 2, favorites: current.favorites, apiKeyUpdate: { schemaVersion: 1, action: "KEEP" } };
  const parsed = configuration.parseCloseFragment("pebblejs://close#" + encodeURIComponent(JSON.stringify(update)));
  assert.deepEqual(configuration.applyConfigurationUpdate(current, parsed), current);
  const legacy = { ...update, schemaVersion: 1, favorites: [] };
  assert.equal(configuration.parseCloseFragment(JSON.stringify(legacy)), null);
  assert.equal(configuration.applyConfigurationUpdate(current, legacy), null);
  assert.equal(configuration.areFavoritesSecretFree(current.favorites, "aaa", null), false);
});

test("stored language preferences survive restoration while malformed values never become Automatic", () => {
  for (const preference of ["auto", "en", "fr"]) {
    const value = { ...record(), languagePreference: preference }, storage = storageFor(value);
    assert.deepEqual(configuration.loadConfiguration(storage), value);
    assert.equal(configuration.configurationPageState(configuration.loadConfiguration(storage), "en").languagePreference, preference);
  }
  for (const version of [1, 2, configuration.CONFIG_SCHEMA_VERSION]) {
    for (const preference of ["fr-FR", "", null, false]) {
      const storage = storageFor({ ...record(version), languagePreference: preference });
      const original = storage.getItem(configuration.CONFIG_STORAGE_KEY);
      assert.equal(configuration.loadConfiguration(storage), null);
      assert.equal(storage.getItem(configuration.CONFIG_STORAGE_KEY), original);
    }
  }
  const missing = record(); delete missing.languagePreference;
  assert.equal(configuration.loadConfiguration(storageFor(missing)), null);
});

test("legacy saves preserve an override, explicit Automatic removes it, and invalid preferences reject the entire update", () => {
  const current = { ...record(), languagePreference: "fr" };
  const update = { schemaVersion: 2, favorites: current.favorites, apiKeyUpdate: { schemaVersion: 1, action: "KEEP" } };
  const parse = (value) => configuration.parseCloseFragment(encodeURIComponent(JSON.stringify(value)));
  assert.deepEqual(configuration.applyConfigurationUpdate(current, parse(update)), current);
  assert.equal(configuration.applyConfigurationUpdate(current, parse({ ...update, languagePreference: "auto" })).languagePreference, "auto");
  for (const preference of ["fr-FR", "", null, false, undefined]) {
    const invalid = { ...update, favorites: [], apiKeyUpdate: { schemaVersion: 1, action: "REMOVE" },
      languagePreference: preference };
    assert.equal(configuration.applyConfigurationUpdate(current, invalid), null);
    if (preference !== undefined) assert.equal(parse(invalid), null);
  }
  assert.equal(current.languagePreference, "fr");
  assert.deepEqual(current.favorites, record().favorites);
  assert.equal(current.primApiKey, KEY);
});

test("Automatic retains French normalization and English fallback without consulting the watch for overrides", () => {
  for (const [language, expected] of [["fr_FR", "fr"], ["FR-ca", "fr"], ["de_DE", "en"], [undefined, "en"]]) {
    assert.equal(configuration.effectiveWatchLanguage({ getActiveWatchInfo: () => ({ language }) }, "auto"), expected);
  }
  assert.equal(configuration.effectiveWatchLanguage({}, "auto"), "en");
  assert.equal(configuration.effectiveWatchLanguage({ getActiveWatchInfo: () => null }, "auto"), "en");
  const unavailable = { getActiveWatchInfo: () => { throw new Error("unavailable"); } };
  assert.equal(configuration.effectiveWatchLanguage(unavailable, "auto"), "en");
  assert.equal(configuration.effectiveWatchLanguage(unavailable, "en"), "en");
  assert.equal(configuration.effectiveWatchLanguage(unavailable, "fr"), "fr");
});

function overview(favorites) {
  const { schemaVersion, requestId, favoriteId, ...snapshot } = fixture.result;
  return {
    schemaVersion, requestId,
    items: favorites.map((favorite, index) => ({
      favoriteId: favorite.id,
      departures: { status: "AVAILABLE", data: { ...snapshot, departures: snapshot.departures.slice(index) } },
      traffic: { state: "NORMAL", checkedAt: snapshot.fetchedAt }
    }))
  };
}

function seededCache(favorites) {
  return configuration.mergeOverview(configuration.emptyCache(), favorites,
    overview(favorites), 1788000000000, favorites);
}

test("cache keeps distinct arrivals of one service and discards only the rebound overview", () => {
  const first = record().favorites[0];
  const second = { ...first, id: "other-arrival", sortOrder: 1, arrivalPlaceId: "plc_" + "b".repeat(43) };
  const favorites = [first, second];
  let cache = seededCache(favorites);
  assert.equal(configuration.findOverview(cache, first.id).result.departures.length, 2);
  assert.equal(configuration.findOverview(cache, second.id).result.departures.length, 1);
  const trafficRequest = { schemaVersion: 1, requestId: "traffic", favoriteId: first.id,
    serviceId: first.serviceId, language: C.WIRE_LANGUAGE.FR };
  const traffic = { schemaVersion: 1, requestId: "traffic", favoriteId: first.id,
    state: "NORMAL", checkedAt: fixture.result.fetchedAt };
  cache = configuration.putTrafficDetail(cache, favorites, trafficRequest, traffic, 1788000000000);
  const rebound = [{ ...first, arrivalPlaceId: second.arrivalPlaceId }, second];
  const pruned = configuration.pruneCache(cache, rebound);
  assert.equal(configuration.findOverview(pruned, first.id), null);
  assert.deepEqual(configuration.findOverview(pruned, second.id), configuration.findOverview(cache, second.id));
  assert.deepEqual(configuration.findTrafficDetail(pruned, first.serviceId, C.WIRE_LANGUAGE.FR).result, traffic);
  assert.equal(configuration.findTrafficDetail(pruned, first.serviceId, C.WIRE_LANGUAGE.EN), null);
  const storage = storageFor(record());
  assert.equal(configuration.saveCache(storage, cache, KEY), true);
  assert.deepEqual(configuration.loadCache(storage, rebound), pruned);
});

test("merging requires captured bindings and refuses old arrivals even when labels are unchanged", () => {
  const favorites = record().favorites;
  const result = overview(favorites), cache = seededCache(favorites);
  const rebound = [{ ...favorites[0], arrivalPlaceId: "plc_" + "b".repeat(43) }];
  assert.equal(configuration.mergeOverview(cache, rebound, result, 1788000060000, favorites), null);
  assert.equal(configuration.mergeOverview(cache, favorites, result, 1788000060000), null);
  assert.equal(configuration.mergeOverview(cache, favorites, result, 1788000060000, []), null);
  assert.equal(configuration.mergeOverview(cache, [{ ...favorites[0], serviceId: "other-service" }],
    result, 1788000060000, favorites), null);
  const renamed = [{ ...favorites[0], displayName: "Renamed without rebinding" }];
  assert.notEqual(configuration.mergeOverview(cache, renamed, result, 1788000060000, favorites), null);
});

test("unresolved bindings admit errors and traffic but never departure snapshots", () => {
  const favorites = [{ ...record().favorites[0], arrivalPlaceId: null }];
  const available = overview(favorites);
  assert.equal(configuration.mergeOverview(configuration.emptyCache(), favorites, available,
    1788000000000, favorites), null);
  const unavailable = { ...available, items: available.items.map(item => ({ ...item,
    departures: { status: "UNAVAILABLE", error: { code: "INVALID_SERVICE", occurredAt: fixture.result.fetchedAt } }
  })) };
  const cache = configuration.mergeOverview(configuration.emptyCache(), favorites, unavailable,
    1788000000000, favorites);
  const entry = configuration.findOverview(cache, favorites[0].id);
  assert.equal(entry.arrivalPlaceId, null);
  assert.equal(entry.refreshError.code, "INVALID_SERVICE");
  assert.equal(Object.hasOwn(entry, "result"), false);
  assert.equal(entry.traffic.state, "NORMAL");
  const resolved = [{ ...favorites[0], arrivalPlaceId: ARRIVAL }];
  assert.equal(configuration.mergeOverview(cache, resolved, unavailable, 1788000060000, favorites), null);
  const invalid = seededCache(resolved);
  invalid.overview[0].arrivalPlaceId = null;
  assert.equal(configuration.isStoredCache(invalid), false);
});

test("v3 cache requires own valid bindings and scans arrival identities for secrets", () => {
  const favorites = record().favorites, cache = seededCache(favorites);
  for (const field of ["serviceId", "arrivalPlaceId"]) {
    const invalid = structuredClone(cache);
    const inherited = invalid.overview[0][field];
    delete invalid.overview[0][field];
    assert.equal(configuration.isStoredCache(invalid), false);
    Object.setPrototypeOf(invalid.overview[0], { [field]: inherited });
    assert.equal(configuration.isStoredCache(invalid), false);
  }
  const malformed = structuredClone(cache);
  malformed.overview[0].arrivalPlaceId = "unknown";
  assert.equal(configuration.isStoredCache(malformed), false);
  const storage = new FakeStorage();
  assert.equal(configuration.saveCache(storage, cache, KEY), true);
  const bytes = storage.getItem(configuration.RESULTS_STORAGE_KEY);
  assert.equal(configuration.cacheIsSecretFree(cache, ARRIVAL), false);
  assert.equal(configuration.saveCache(storage, cache, ARRIVAL), false);
  assert.equal(storage.getItem(configuration.RESULTS_STORAGE_KEY), bytes);
  assert.equal(configuration.findOverview(configuration.loadCache(storage, favorites), favorites[0].id).arrivalPlaceId, ARRIVAL);
});

test("old result caches lose departures and traffic without changing configuration or credentials", () => {
  for (const schemaVersion of [1, 2]) {
    const value = record(), storage = storageFor(value);
    const before = storage.getItem(configuration.CONFIG_STORAGE_KEY);
    const cache = seededCache(value.favorites);
    cache.trafficDetails.push({ serviceId: value.favorites[0].serviceId, language: C.WIRE_LANGUAGE.EN,
      storedAt: 1788000000000, result: { schemaVersion: 1, requestId: "old-traffic",
        favoriteId: value.favorites[0].id, state: "NORMAL", checkedAt: fixture.result.fetchedAt } });
    cache.schemaVersion = schemaVersion;
    storage.setItem(configuration.RESULTS_STORAGE_KEY, JSON.stringify(cache));
    assert.deepEqual(configuration.loadCache(storage, value.favorites),
      { schemaVersion: 3, overview: [], trafficDetails: [] });
    assert.equal(storage.getItem(configuration.CONFIG_STORAGE_KEY), before);
    assert.deepEqual(configuration.loadConfiguration(storage), value);
  }
});
