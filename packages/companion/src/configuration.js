"use strict";

var contracts = require("./contracts");
var CONFIG_STORAGE_KEY = "lapinFuteConfig";
var LEGACY_CONFIG_STORAGE_KEY = "lapin-fute.configuration.v1";
var RESULTS_STORAGE_KEY = "lapinFuteResults";
var INVALID_KEY_STATUS_STORAGE_KEY = "lapinFuteInvalidKeyStatus";
var CONFIG_RECORD_KEYS = ["schemaVersion", "favorites", "primApiKey", "keyStatus"];
var LEGACY_CONFIG_RECORD_KEYS = ["schemaVersion", "favorites", "apiKey"];
var RESULTS_RECORD_KEYS = ["schemaVersion", "results"];
var RESULT_ENTRY_KEYS = ["favoriteId", "storedAt", "result"];
var INVALID_KEY_STATUS_RECORD_KEYS = [
  "schemaVersion",
  "keyStatus",
  "configurationFingerprint"
];
var UPDATE_KEYS = ["schemaVersion", "favorites", "apiKeyUpdate"];
var MAX_CLOSE_RESPONSE_LENGTH = 32768;
var MAX_SAFE_INTEGER = 9007199254740991;
var FAVORITE_STRING_KEYS = [
  "id",
  "serviceId",
  "displayName",
  "stopLabel",
  "lineLabel",
  "destinationLabel",
  "lineMode",
  "lineColor",
  "lineTextColor"
];

function emptyConfiguration() {
  return {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: [],
    primApiKey: null,
    keyStatus: contracts.KEY_STATUS.MISSING
  };
}

function emptyResults() {
  return { schemaVersion: contracts.SCHEMA_VERSION, results: [] };
}

function isFavoriteSecretFree(favorite, firstSecret, secondSecret) {
  var field;
  var value;
  for (field = 0; field < FAVORITE_STRING_KEYS.length; field += 1) {
    value = favorite[FAVORITE_STRING_KEYS[field]];
    if (typeof value !== "string") continue;
    if (typeof firstSecret === "string" && firstSecret.length > 0 && value.indexOf(firstSecret) !== -1) return false;
    if (typeof secondSecret === "string" && secondSecret.length > 0 && value.indexOf(secondSecret) !== -1) return false;
  }
  return true;
}

function areFavoritesSecretFree(favorites, firstSecret, secondSecret) {
  var index;
  for (index = 0; index < favorites.length; index += 1) {
    if (!isFavoriteSecretFree(favorites[index], firstSecret, secondSecret)) return false;
  }
  return true;
}

function fingerprintStep(hash, code) {
  hash ^= code & 255;
  hash = (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
  hash ^= code >>> 8;
  return (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
}

function fingerprintHex(value) {
  return ("00000000" + value.toString(16)).slice(-8);
}

function configurationFingerprint(value) {
  var forward = 2166136261;
  var reverse = 3335557771;
  var index;
  var source;
  if (!isStoredConfiguration(value) || value.primApiKey === null) return null;
  source = JSON.stringify({
    schemaVersion: value.schemaVersion,
    favorites: value.favorites.map(contracts.copyFavorite),
    primApiKey: value.primApiKey
  });
  for (index = 0; index < source.length; index += 1) {
    forward = fingerprintStep(forward, source.charCodeAt(index));
    reverse = fingerprintStep(reverse, source.charCodeAt(source.length - index - 1));
  }
  source = null;
  return fingerprintHex(forward) + fingerprintHex(reverse);
}

function invalidKeyStatusMatches(value, marker) {
  return contracts.isObject(marker)
    && contracts.hasOnlyKeys(marker, INVALID_KEY_STATUS_RECORD_KEYS)
    && marker.schemaVersion === contracts.SCHEMA_VERSION
    && marker.keyStatus === contracts.KEY_STATUS.INVALID
    && /^[0-9a-f]{16}$/.test(marker.configurationFingerprint)
    && marker.configurationFingerprint === configurationFingerprint(value);
}

function normalizeLanguage(value) {
  if (typeof value !== "string") return contracts.WIRE_LANGUAGE.EN;
  return value.toLowerCase().split(/[-_]/)[0] === contracts.WIRE_LANGUAGE.FR
    ? contracts.WIRE_LANGUAGE.FR
    : contracts.WIRE_LANGUAGE.EN;
}

function activeWatchLanguage(Pebble) {
  var info;
  try {
    if (!Pebble || typeof Pebble.getActiveWatchInfo !== "function") {
      return contracts.WIRE_LANGUAGE.EN;
    }
    info = Pebble.getActiveWatchInfo();
    if (!contracts.isObject(info)) return contracts.WIRE_LANGUAGE.EN;
    return normalizeLanguage(info.language);
  } catch (ignored) {
    return contracts.WIRE_LANGUAGE.EN;
  }
}

function isStoredConfiguration(value) {
  if (!contracts.isObject(value)
      || !contracts.hasOnlyKeys(value, CONFIG_RECORD_KEYS)
      || value.schemaVersion !== contracts.SCHEMA_VERSION
      || !contracts.isFavoriteList(value.favorites)) return false;
  if (value.primApiKey === null) {
    return value.keyStatus === contracts.KEY_STATUS.MISSING;
  }
  return contracts.isPersonalApiKey(value.primApiKey)
    && (value.keyStatus === contracts.KEY_STATUS.CONFIGURED
      || value.keyStatus === contracts.KEY_STATUS.INVALID)
    && areFavoritesSecretFree(value.favorites, value.primApiKey, null);
}

function isLegacyConfiguration(value) {
  return contracts.isObject(value)
    && contracts.hasOnlyKeys(value, LEGACY_CONFIG_RECORD_KEYS)
    && value.schemaVersion === contracts.SCHEMA_VERSION
    && contracts.isFavoriteList(value.favorites)
    && (value.apiKey === null || contracts.isPersonalApiKey(value.apiKey))
    && areFavoritesSecretFree(value.favorites, value.apiKey, null);
}

function isConfigurationUpdate(value) {
  return contracts.isObject(value)
    && contracts.hasOnlyKeys(value, UPDATE_KEYS)
    && value.schemaVersion === contracts.SCHEMA_VERSION
    && contracts.isFavoriteList(value.favorites)
    && contracts.isApiKeyUpdate(value.apiKeyUpdate);
}

function isStoredAt(value) {
  return typeof value === "number"
    && isFinite(value)
    && Math.floor(value) === value
    && value >= 0
    && value <= MAX_SAFE_INTEGER;
}

function isResultEntry(value) {
  return contracts.isObject(value)
    && contracts.hasOnlyKeys(value, RESULT_ENTRY_KEYS)
    && contracts.boundedString(value.favoriteId, contracts.LIMITS.idUtf8Bytes)
    && isStoredAt(value.storedAt)
    && contracts.isDepartureResult(value.result)
    && value.favoriteId === value.result.favoriteId;
}

function isStoredResults(value) {
  var seen = Object.create(null);
  if (!contracts.isObject(value)
      || !contracts.hasOnlyKeys(value, RESULTS_RECORD_KEYS)
      || value.schemaVersion !== contracts.SCHEMA_VERSION
      || !Array.isArray(value.results)
      || value.results.length > contracts.LIMITS.favorites) return false;
  return value.results.every(function (entry) {
    if (!isResultEntry(entry) || seen[entry.favoriteId]) return false;
    seen[entry.favoriteId] = true;
    return true;
  });
}

function copyConfiguration(value) {
  return {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: value.favorites.map(contracts.copyFavorite),
    primApiKey: value.primApiKey,
    keyStatus: value.keyStatus
  };
}

function copyResultEntry(entry, requestId) {
  return {
    favoriteId: entry.favoriteId,
    storedAt: entry.storedAt,
    result: contracts.copyDepartureResult(entry.result, requestId)
  };
}

function copyResults(value) {
  return {
    schemaVersion: contracts.SCHEMA_VERSION,
    results: value.results.map(function (entry) { return copyResultEntry(entry); })
  };
}

function verifiedWrite(storage, key, value) {
  var previous;
  var serialized;
  var writeAttempted = false;
  try {
    previous = storage.getItem(key);
    serialized = JSON.stringify(value);
    writeAttempted = true;
    storage.setItem(key, serialized);
    if (storage.getItem(key) === serialized) return true;
  } catch (ignored) {
    // Restore the prior bytes below when the adapter remains writable.
  }
  if (!writeAttempted) return false;
  try {
    if (previous === null || typeof previous === "undefined") storage.removeItem(key);
    else storage.setItem(key, previous);
  } catch (ignored) {
    // The caller retains its prior in-memory state and fails closed.
  }
  return false;
}

function verifiedRemove(storage, key) {
  var previous;
  var removeAttempted = false;
  try {
    previous = storage.getItem(key);
    if (previous === null || typeof previous === "undefined") return true;
    removeAttempted = true;
    storage.removeItem(key);
    if (storage.getItem(key) === null) return true;
  } catch (ignored) {
    // Restore the prior bytes below when the adapter remains writable.
  }
  if (!removeAttempted) return false;
  try {
    storage.setItem(key, previous);
  } catch (ignored) {
    // A remaining marker is fail-closed; an uncertain removal is never trusted.
  }
  return false;
}

function parseStored(storage, key) {
  var serialized;
  try {
    serialized = storage.getItem(key);
  } catch (ignored) {
    return { present: true, value: null };
  }
  if (serialized === null || typeof serialized === "undefined") {
    return { present: false, value: null };
  }
  if (typeof serialized !== "string" || serialized.length === 0) {
    return { present: true, value: null };
  }
  try {
    return { present: true, value: JSON.parse(serialized) };
  } catch (ignored) {
    return { present: true, value: null };
  }
}

function removeStored(storage, key) {
  try {
    if (typeof storage.removeItem === "function") storage.removeItem(key);
  } catch (ignored) {
    // A later successful load retries legacy cleanup.
  }
}

function loadConfiguration(storage) {
  var current = parseStored(storage, CONFIG_STORAGE_KEY);
  var invalidMarker = parseStored(storage, INVALID_KEY_STATUS_STORAGE_KEY).value;
  var legacy;
  var loaded;
  var migrated;
  if (current.present) {
    if (!isStoredConfiguration(current.value)) return null;
    removeStored(storage, LEGACY_CONFIG_STORAGE_KEY);
    loaded = copyConfiguration(current.value);
    if (invalidKeyStatusMatches(loaded, invalidMarker)) {
      loaded.keyStatus = contracts.KEY_STATUS.INVALID;
    }
    return loaded;
  }
  legacy = parseStored(storage, LEGACY_CONFIG_STORAGE_KEY);
  if (!legacy.present) return emptyConfiguration();
  if (!isLegacyConfiguration(legacy.value)) return null;
  migrated = {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: legacy.value.favorites.map(contracts.copyFavorite),
    primApiKey: legacy.value.apiKey,
    keyStatus: legacy.value.apiKey === null
      ? contracts.KEY_STATUS.MISSING
      : contracts.KEY_STATUS.CONFIGURED
  };
  if (verifiedWrite(storage, CONFIG_STORAGE_KEY, migrated)) {
    removeStored(storage, LEGACY_CONFIG_STORAGE_KEY);
  }
  loaded = copyConfiguration(migrated);
  if (invalidKeyStatusMatches(loaded, invalidMarker)) {
    loaded.keyStatus = contracts.KEY_STATUS.INVALID;
  }
  return loaded;
}

function saveConfiguration(storage, value) {
  return isStoredConfiguration(value)
    && verifiedWrite(storage, CONFIG_STORAGE_KEY, copyConfiguration(value));
}

function saveInvalidConfiguration(storage, value) {
  var fingerprint;
  var markerSaved;
  var configurationSaved;
  if (!isStoredConfiguration(value)
      || value.primApiKey === null
      || value.keyStatus !== contracts.KEY_STATUS.INVALID) return false;
  fingerprint = configurationFingerprint(value);
  markerSaved = verifiedWrite(storage, INVALID_KEY_STATUS_STORAGE_KEY, {
    schemaVersion: contracts.SCHEMA_VERSION,
    keyStatus: contracts.KEY_STATUS.INVALID,
    configurationFingerprint: fingerprint
  });
  fingerprint = null;
  configurationSaved = saveConfiguration(storage, value);
  if (configurationSaved) verifiedRemove(storage, INVALID_KEY_STATUS_STORAGE_KEY);
  return markerSaved || configurationSaved;
}

function clearInvalidKeyStatus(storage) {
  return verifiedRemove(storage, INVALID_KEY_STATUS_STORAGE_KEY);
}

function pruneResults(value, favorites) {
  var byFavorite = Object.create(null);
  var normalized = emptyResults();
  if (!isStoredResults(value) || !contracts.isFavoriteList(favorites)) return normalized;
  value.results.forEach(function (entry) {
    byFavorite[entry.favoriteId] = entry;
  });
  favorites.forEach(function (favorite) {
    if (byFavorite[favorite.id]) normalized.results.push(copyResultEntry(byFavorite[favorite.id]));
  });
  return normalized;
}

function loadResults(storage, favorites) {
  var stored = parseStored(storage, RESULTS_STORAGE_KEY);
  var normalized;
  if (!stored.present || !isStoredResults(stored.value)) return emptyResults();
  normalized = pruneResults(stored.value, favorites);
  if (JSON.stringify(normalized) !== JSON.stringify(stored.value)) {
    verifiedWrite(storage, RESULTS_STORAGE_KEY, normalized);
  }
  return normalized;
}

function saveResults(storage, value) {
  return isStoredResults(value)
    && verifiedWrite(storage, RESULTS_STORAGE_KEY, copyResults(value));
}

function putResult(value, favorites, result, storedAt) {
  var next;
  var found = false;
  var favoriteExists = false;
  if (!isStoredResults(value)
      || !contracts.isFavoriteList(favorites)
      || !contracts.isDepartureResult(result)
      || !isStoredAt(storedAt)) return null;
  favorites.forEach(function (favorite) {
    if (favorite.id === result.favoriteId) favoriteExists = true;
  });
  if (!favoriteExists) return null;
  next = pruneResults(value, favorites);
  next.results = next.results.map(function (entry) {
    if (entry.favoriteId !== result.favoriteId) return entry;
    found = true;
    return {
      favoriteId: result.favoriteId,
      storedAt: storedAt,
      result: contracts.copyDepartureResult(result)
    };
  });
  if (!found) {
    next.results.push({
      favoriteId: result.favoriteId,
      storedAt: storedAt,
      result: contracts.copyDepartureResult(result)
    });
    next = pruneResults(next, favorites);
  }
  return next;
}

function findResult(value, favoriteId, requestId) {
  var index;
  if (!isStoredResults(value)) return null;
  for (index = 0; index < value.results.length; index += 1) {
    if (value.results[index].favoriteId === favoriteId) {
      return copyResultEntry(value.results[index], requestId);
    }
  }
  return null;
}

function applyConfigurationUpdate(current, update) {
  var primApiKey;
  var keyStatus;
  var replacementKey = null;
  if (!isStoredConfiguration(current) || !isConfigurationUpdate(update)) return null;
  if (update.apiKeyUpdate.action === "REPLACE") replacementKey = update.apiKeyUpdate.value;
  if (!areFavoritesSecretFree(update.favorites, current.primApiKey, replacementKey)) return null;
  primApiKey = current.primApiKey;
  keyStatus = current.keyStatus;
  if (replacementKey !== null) {
    primApiKey = replacementKey;
    keyStatus = contracts.KEY_STATUS.CONFIGURED;
  }
  if (update.apiKeyUpdate.action === "REMOVE") {
    primApiKey = null;
    keyStatus = contracts.KEY_STATUS.MISSING;
  }
  return {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: update.favorites.map(contracts.copyFavorite),
    primApiKey: primApiKey,
    keyStatus: keyStatus
  };
}

function parseCloseFragment(response) {
  var fragment;
  var hashIndex;
  var parsed;
  if (typeof response !== "string"
      || response.length === 0
      || response.length > MAX_CLOSE_RESPONSE_LENGTH
      || response === "CANCELLED") return null;
  hashIndex = response.indexOf("#");
  fragment = hashIndex === -1 ? response : response.slice(hashIndex + 1);
  if (fragment.charAt(0) === "#") fragment = fragment.slice(1);
  if (fragment.length === 0 || fragment === "CANCELLED") return null;
  try {
    fragment = decodeURIComponent(fragment);
    parsed = JSON.parse(fragment);
  } catch (ignored) {
    return null;
  }
  if (!isConfigurationUpdate(parsed)) return null;
  return {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: parsed.favorites.map(contracts.copyFavorite),
    apiKeyUpdate: parsed.apiKeyUpdate.action === "REPLACE"
      ? { schemaVersion: contracts.SCHEMA_VERSION, action: "REPLACE", value: parsed.apiKeyUpdate.value }
      : { schemaVersion: contracts.SCHEMA_VERSION, action: parsed.apiKeyUpdate.action }
  };
}

function configurationPageState(value, language) {
  return {
    hasKey: value.primApiKey !== null,
    favorites: value.favorites.map(contracts.copyFavorite),
    language: typeof language === "string" && language.length > 0 ? language : "en"
  };
}

function configurationUrl(baseUrl, value, language) {
  var withoutFragment;
  if (typeof baseUrl !== "string" || baseUrl.length === 0 || !isStoredConfiguration(value)) return null;
  withoutFragment = baseUrl.split("#")[0];
  return withoutFragment + "#" + encodeURIComponent(JSON.stringify(configurationPageState(value, language)));
}

module.exports = {
  CONFIG_STORAGE_KEY: CONFIG_STORAGE_KEY,
  LEGACY_CONFIG_STORAGE_KEY: LEGACY_CONFIG_STORAGE_KEY,
  RESULTS_STORAGE_KEY: RESULTS_STORAGE_KEY,
  INVALID_KEY_STATUS_STORAGE_KEY: INVALID_KEY_STATUS_STORAGE_KEY,
  MAX_CLOSE_RESPONSE_LENGTH: MAX_CLOSE_RESPONSE_LENGTH,
  emptyConfiguration: emptyConfiguration,
  emptyResults: emptyResults,
  isStoredConfiguration: isStoredConfiguration,
  isLegacyConfiguration: isLegacyConfiguration,
  isConfigurationUpdate: isConfigurationUpdate,
  isStoredResults: isStoredResults,
  isFavoriteSecretFree: isFavoriteSecretFree,
  areFavoritesSecretFree: areFavoritesSecretFree,
  normalizeLanguage: normalizeLanguage,
  activeWatchLanguage: activeWatchLanguage,
  loadConfiguration: loadConfiguration,
  saveConfiguration: saveConfiguration,
  saveInvalidConfiguration: saveInvalidConfiguration,
  clearInvalidKeyStatus: clearInvalidKeyStatus,
  loadResults: loadResults,
  saveResults: saveResults,
  pruneResults: pruneResults,
  putResult: putResult,
  findResult: findResult,
  applyConfigurationUpdate: applyConfigurationUpdate,
  parseCloseFragment: parseCloseFragment,
  configurationPageState: configurationPageState,
  configurationUrl: configurationUrl
};
