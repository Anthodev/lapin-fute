"use strict";

var contracts = require("./contracts");
var CONFIG_STORAGE_KEY = "lapinFuteConfig";
var RESULTS_STORAGE_KEY = "lapinFuteResults";
// Phone-local cache version. Version 1 used the obsolete direction-based matcher.
var CACHE_SCHEMA_VERSION = 2;
var INVALID_KEY_STATUS_STORAGE_KEY = "lapinFuteInvalidKeyStatus";
var CONFIG_RECORD_KEYS = ["schemaVersion", "favorites", "primApiKey", "keyStatus"];
var CACHE_RECORD_KEYS = ["schemaVersion", "overview", "trafficDetails"];
var OVERVIEW_ENTRY_KEYS = [
  "favoriteId",
  "serviceId",
  "resultStoredAt",
  "result",
  "trafficStoredAt",
  "traffic",
  "refreshError"
];
var TRAFFIC_DETAIL_ENTRY_KEYS = ["serviceId", "language", "storedAt", "result"];
var INVALID_KEY_STATUS_RECORD_KEYS = [
  "schemaVersion",
  "keyStatus",
  "configurationFingerprint"
];
var UPDATE_KEYS = ["schemaVersion", "favorites", "apiKeyUpdate", "forceFullSync"];
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
var ROUTING_STRING_KEYS = [
  "monitoringRef",
  "lineRef",
  "destinationRef"
];

function emptyConfiguration() {
  return {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: [],
    primApiKey: null,
    keyStatus: contracts.KEY_STATUS.MISSING
  };
}

function copyConfiguration(value) {
  return {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: value.favorites.map(contracts.copyPhoneFavorite),
    primApiKey: value.primApiKey,
    keyStatus: value.keyStatus
  };
}

function emptyCache() {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    overview: [],
    trafficDetails: []
  };
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
  if (!contracts.isObject(favorite.routing)) return true;
  for (field = 0; field < ROUTING_STRING_KEYS.length; field += 1) {
    value = favorite.routing[ROUTING_STRING_KEYS[field]];
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
    favorites: value.favorites.map(function (favorite) {
      var projection = contracts.copyFavorite(favorite);
      delete projection.sortOrder;
      return projection;
    }),
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
      || !contracts.isPhoneFavoriteList(value.favorites)) return false;
  if (value.primApiKey === null) {
    return value.keyStatus === contracts.KEY_STATUS.MISSING;
  }
  return contracts.isPersonalApiKey(value.primApiKey)
    && (value.keyStatus === contracts.KEY_STATUS.CONFIGURED
      || value.keyStatus === contracts.KEY_STATUS.INVALID)
    && areFavoritesSecretFree(value.favorites, value.primApiKey, null);
}

function recoverStoredConfiguration(value) {
  if (!contracts.isObject(value) || !Array.isArray(value.favorites)) return null;
  // This freshly parsed record is private to restoration. Routing is replaceable
  // catalog enrichment; preserve every other field for ordinary validation.
  value.favorites.forEach(function (favorite) {
    if (contracts.isObject(favorite)
        && Object.prototype.hasOwnProperty.call(favorite, "routing")
        && !contracts.isServiceRouting(favorite.routing)) delete favorite.routing;
  });
  return isStoredConfiguration(value) ? value : null;
}

function isConfigurationUpdate(value) {
  return contracts.isObject(value)
    && contracts.hasOnlyKeys(value, UPDATE_KEYS)
    && value.schemaVersion === contracts.SCHEMA_VERSION
    && contracts.isPhoneFavoriteList(value.favorites)
    && contracts.isApiKeyUpdate(value.apiKeyUpdate)
    && (!Object.prototype.hasOwnProperty.call(value, "forceFullSync")
      || typeof value.forceFullSync === "boolean");
}

function isStoredAt(value) {
  return typeof value === "number"
    && isFinite(value)
    && Math.floor(value) === value
    && value >= 0
    && value <= MAX_SAFE_INTEGER;
}

function copyOverviewError(error) {
  var copy = { code: error.code, occurredAt: error.occurredAt };
  if (typeof error.retryAfterSeconds !== "undefined") {
    copy.retryAfterSeconds = error.retryAfterSeconds;
  }
  return copy;
}

function copyTrafficSummary(traffic) {
  var copy = { state: traffic.state, checkedAt: traffic.checkedAt };
  if (typeof traffic.sourceUpdatedAt !== "undefined") {
    copy.sourceUpdatedAt = traffic.sourceUpdatedAt;
  }
  return copy;
}

function copyTrafficDetail(result, requestId, favoriteId) {
  var copy = {
    schemaVersion: contracts.SCHEMA_VERSION,
    requestId: typeof requestId === "string" ? requestId : result.requestId,
    favoriteId: typeof favoriteId === "string" ? favoriteId : result.favoriteId,
    state: result.state,
    checkedAt: result.checkedAt
  };
  if (typeof result.sourceUpdatedAt !== "undefined") copy.sourceUpdatedAt = result.sourceUpdatedAt;
  if (typeof result.title !== "undefined") copy.title = result.title;
  if (typeof result.text !== "undefined") copy.text = result.text;
  if (typeof result.validFrom !== "undefined") copy.validFrom = result.validFrom;
  if (typeof result.validUntil !== "undefined") copy.validUntil = result.validUntil;
  return copy;
}

function departureSnapshot(result) {
  var copy = contracts.copyDepartureResult(result);
  delete copy.schemaVersion;
  delete copy.requestId;
  delete copy.favoriteId;
  return copy;
}

function departureResult(snapshot, requestId, favoriteId) {
  var result = {
    schemaVersion: contracts.SCHEMA_VERSION,
    requestId: requestId,
    favoriteId: favoriteId,
    fetchedAt: snapshot.fetchedAt,
    freshness: snapshot.freshness,
    departures: snapshot.departures
  };
  if (typeof snapshot.sourceUpdatedAt !== "undefined") {
    result.sourceUpdatedAt = snapshot.sourceUpdatedAt;
  }
  return contracts.copyDepartureResult(result);
}

function isOverviewEntry(value) {
  var hasResult;
  var hasResultStoredAt;
  var transferItem;
  if (!contracts.isObject(value)
      || !contracts.hasOnlyKeys(value, OVERVIEW_ENTRY_KEYS)
      || !Object.prototype.hasOwnProperty.call(value, "favoriteId")
      || !Object.prototype.hasOwnProperty.call(value, "trafficStoredAt")
      || !Object.prototype.hasOwnProperty.call(value, "traffic")
      || !contracts.boundedString(value.favoriteId, contracts.LIMITS.idUtf8Bytes)
      || (Object.prototype.hasOwnProperty.call(value, "serviceId")
        && !contracts.boundedString(value.serviceId, contracts.LIMITS.idUtf8Bytes))
      || !isStoredAt(value.trafficStoredAt)) return false;
  hasResult = Object.prototype.hasOwnProperty.call(value, "result");
  hasResultStoredAt = Object.prototype.hasOwnProperty.call(value, "resultStoredAt");
  if (hasResult !== hasResultStoredAt
      || (hasResult && (!isStoredAt(value.resultStoredAt)
        || !contracts.isDepartureResult(value.result)
        || value.result.favoriteId !== value.favoriteId))) return false;
  transferItem = {
    favoriteId: value.favoriteId,
    traffic: value.traffic
  };
  if (hasResult) transferItem.snapshot = departureSnapshot(value.result);
  if (Object.prototype.hasOwnProperty.call(value, "refreshError")) {
    transferItem.refreshError = value.refreshError;
  }
  return contracts.isOverviewTransfer({
    schemaVersion: contracts.SCHEMA_VERSION,
    requestId: "cache-validation",
    items: [transferItem]
  });
}

function isTrafficDetailEntry(value) {
  return contracts.isObject(value)
    && contracts.hasOnlyKeys(value, TRAFFIC_DETAIL_ENTRY_KEYS)
    && Object.keys(value).length === TRAFFIC_DETAIL_ENTRY_KEYS.length
    && contracts.boundedString(value.serviceId, contracts.LIMITS.idUtf8Bytes)
    && (value.language === contracts.WIRE_LANGUAGE.EN
      || value.language === contracts.WIRE_LANGUAGE.FR)
    && isStoredAt(value.storedAt)
    && contracts.isTrafficDetailResult(value.result);
}

function isStoredCache(value) {
  var overviewSeen = Object.create(null);
  var trafficSeen = Object.create(null);
  if (!contracts.isObject(value)
      || !contracts.hasOnlyKeys(value, CACHE_RECORD_KEYS)
      || Object.keys(value).length !== CACHE_RECORD_KEYS.length
      || value.schemaVersion !== CACHE_SCHEMA_VERSION
      || !Array.isArray(value.overview)
      || value.overview.length > contracts.LIMITS.favorites
      || !Array.isArray(value.trafficDetails)
      || value.trafficDetails.length > contracts.LIMITS.favorites) return false;
  if (!value.overview.every(function (entry) {
    if (!isOverviewEntry(entry) || overviewSeen[entry.favoriteId]) return false;
    overviewSeen[entry.favoriteId] = true;
    return true;
  })) return false;
  return value.trafficDetails.every(function (entry) {
    var key;
    if (!isTrafficDetailEntry(entry)) return false;
    key = entry.serviceId + "\n" + entry.language;
    if (trafficSeen[key]) return false;
    trafficSeen[key] = true;
    return true;
  });
}

function copyOverviewEntry(entry, requestId) {
  var copy = {
    favoriteId: entry.favoriteId,
    trafficStoredAt: entry.trafficStoredAt,
    traffic: copyTrafficSummary(entry.traffic)
  };
  if (Object.prototype.hasOwnProperty.call(entry, "serviceId")) {
    copy.serviceId = entry.serviceId;
  }
  if (Object.prototype.hasOwnProperty.call(entry, "result")) {
    copy.resultStoredAt = entry.resultStoredAt;
    copy.result = contracts.copyDepartureResult(entry.result, requestId);
  }
  if (Object.prototype.hasOwnProperty.call(entry, "refreshError")) {
    copy.refreshError = copyOverviewError(entry.refreshError);
  }
  return copy;
}

function copyTrafficDetailEntry(entry, requestId, favoriteId) {
  return {
    serviceId: entry.serviceId,
    language: entry.language,
    storedAt: entry.storedAt,
    result: copyTrafficDetail(entry.result, requestId, favoriteId)
  };
}

function copyCache(value) {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    overview: value.overview.map(function (entry) { return copyOverviewEntry(entry); }),
    trafficDetails: value.trafficDetails.map(function (entry) {
      return copyTrafficDetailEntry(entry);
    })
  };
}

function cacheIsSecretFree(value, secret) {
  if (typeof secret !== "string" || secret.length === 0) return true;
  if (typeof value === "string") return value.indexOf(secret) === -1;
  if (value === null || typeof value !== "object") return true;
  return Object.keys(value).every(function (key) {
    return key.indexOf(secret) === -1 && cacheIsSecretFree(value[key], secret);
  });
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

function loadConfiguration(storage) {
  var current = parseStored(storage, CONFIG_STORAGE_KEY);
  var invalidMarker = parseStored(storage, INVALID_KEY_STATUS_STORAGE_KEY).value;
  var loaded;
  if (!current.present) return emptyConfiguration();
  loaded = recoverStoredConfiguration(current.value);
  if (loaded === null) return null;
  loaded = copyConfiguration(loaded);
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

function pruneCache(value, favorites) {
  var overviewByFavorite = Object.create(null);
  var services = Object.create(null);
  var normalized = emptyCache();
  if (!isStoredCache(value) || !contracts.isPhoneFavoriteList(favorites)) return normalized;
  value.overview.forEach(function (entry) {
    overviewByFavorite[entry.favoriteId] = entry;
  });
  favorites.forEach(function (favorite) {
    var entry = overviewByFavorite[favorite.id];
    services[favorite.serviceId] = true;
    if (!entry) return;
    // A rebinding (routing change to another service) invalidates the cached
    // overview of the old binding; unstamped entries are preserved.
    if (Object.prototype.hasOwnProperty.call(entry, "serviceId")
        && entry.serviceId !== favorite.serviceId) return;
    normalized.overview.push(copyOverviewEntry(entry));
  });
  value.trafficDetails.forEach(function (entry) {
    if (services[entry.serviceId]
        && normalized.trafficDetails.length < contracts.LIMITS.favorites) {
      normalized.trafficDetails.push(copyTrafficDetailEntry(entry));
    }
  });
  return normalized;
}

function loadCache(storage, favorites) {
  var stored = parseStored(storage, RESULTS_STORAGE_KEY);
  var normalized;
  if (!stored.present || !isStoredCache(stored.value)) return emptyCache();
  normalized = pruneCache(stored.value, favorites);
  if (JSON.stringify(normalized) !== JSON.stringify(stored.value)) {
    verifiedWrite(storage, RESULTS_STORAGE_KEY, normalized);
  }
  return normalized;
}

function saveCache(storage, value, secret) {
  return isStoredCache(value)
    && cacheIsSecretFree(value, secret)
    && verifiedWrite(storage, RESULTS_STORAGE_KEY, copyCache(value));
}

function mergeOverview(value, favorites, result, storedAt) {
  var request;
  var favoriteById = Object.create(null);
  var existing = Object.create(null);
  var next;
  if (!isStoredCache(value)
      || !contracts.isPhoneFavoriteList(favorites)
      || !isStoredAt(storedAt)
      || !contracts.isObject(result)
      || !Array.isArray(result.items)) return null;
  request = {
    schemaVersion: contracts.SCHEMA_VERSION,
    requestId: result.requestId,
    language: contracts.WIRE_LANGUAGE.EN,
    favorites: favorites.filter(function (favorite) {
      return result.items.some(function (item) {
        return contracts.isObject(item) && item.favoriteId === favorite.id;
      });
    }).map(function (favorite) {
      return { favoriteId: favorite.id, serviceId: favorite.serviceId };
    })
  };
  if (!contracts.isOverviewResult(result, request)) return null;
  favorites.forEach(function (favorite) { favoriteById[favorite.id] = favorite; });
  next = pruneCache(value, favorites);
  next.overview.forEach(function (entry) {
    existing[entry.favoriteId] = entry;
  });
  result.items.forEach(function (item) {
    var previous = existing[item.favoriteId];
    var favorite = favoriteById[item.favoriteId];
    var entry = {
      favoriteId: item.favoriteId,
      trafficStoredAt: storedAt,
      traffic: copyTrafficSummary(item.traffic)
    };
    if (favorite) entry.serviceId = favorite.serviceId;
    if (item.departures.status === "AVAILABLE") {
      entry.resultStoredAt = storedAt;
      entry.result = departureResult(
        item.departures.data,
        result.requestId,
        item.favoriteId
      );
    } else {
      if (previous && Object.prototype.hasOwnProperty.call(previous, "result")) {
        entry.resultStoredAt = previous.resultStoredAt;
        entry.result = contracts.copyDepartureResult(previous.result);
      }
      entry.refreshError = copyOverviewError(item.departures.error);
    }
    existing[item.favoriteId] = entry;
  });
  next.overview = favorites.filter(function (favorite) {
    return Object.prototype.hasOwnProperty.call(existing, favorite.id);
  }).map(function (favorite) {
    return existing[favorite.id];
  });
  return isStoredCache(next) ? next : null;
}

function findOverview(value, favoriteId, requestId) {
  var index;
  if (!isStoredCache(value)) return null;
  for (index = 0; index < value.overview.length; index += 1) {
    if (value.overview[index].favoriteId === favoriteId) {
      return copyOverviewEntry(value.overview[index], requestId);
    }
  }
  return null;
}

function putTrafficDetail(value, favorites, request, result, storedAt) {
  var next;
  var favoriteMatches = false;
  if (!isStoredCache(value)
      || !contracts.isPhoneFavoriteList(favorites)
      || !contracts.isTrafficDetailRequest(request)
      || !contracts.isTrafficDetailResult(result)
      || result.requestId !== request.requestId
      || result.favoriteId !== request.favoriteId
      || !isStoredAt(storedAt)) return null;
  favorites.forEach(function (favorite) {
    if (favorite.id === request.favoriteId
        && favorite.serviceId === request.serviceId) favoriteMatches = true;
  });
  if (!favoriteMatches) return null;
  next = pruneCache(value, favorites);
  next.trafficDetails = next.trafficDetails.filter(function (entry) {
    return entry.serviceId !== request.serviceId || entry.language !== request.language;
  });
  next.trafficDetails.push({
    serviceId: request.serviceId,
    language: request.language,
    storedAt: storedAt,
    result: copyTrafficDetail(result)
  });
  if (next.trafficDetails.length > contracts.LIMITS.favorites) {
    next.trafficDetails = next.trafficDetails.slice(
      next.trafficDetails.length - contracts.LIMITS.favorites
    );
  }
  return isStoredCache(next) ? next : null;
}

function findTrafficDetail(value, serviceId, language, requestId, favoriteId) {
  var index;
  if (!isStoredCache(value)) return null;
  for (index = 0; index < value.trafficDetails.length; index += 1) {
    if (value.trafficDetails[index].serviceId === serviceId
        && value.trafficDetails[index].language === language) {
      return copyTrafficDetailEntry(
        value.trafficDetails[index],
        requestId,
        favoriteId
      );
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
    favorites: update.favorites.map(contracts.copyPhoneFavorite),
    primApiKey: primApiKey,
    keyStatus: keyStatus
  };
}

function parseCloseFragment(response) {
  var fragment;
  var parsed;
  var closePrefix = "pebblejs://close#";
  if (typeof response !== "string"
      || response.length === 0
      || response.length > MAX_CLOSE_RESPONSE_LENGTH
      || response === "CANCELLED") return null;
  fragment = response.indexOf(closePrefix) === 0
    ? response.slice(closePrefix.length)
    : response;
  if (fragment.charAt(0) === "#") fragment = fragment.slice(1);
  if (fragment.length === 0 || fragment === "CANCELLED") return null;
  try {
    parsed = JSON.parse(fragment);
  } catch (ignored) {
    try {
      parsed = JSON.parse(decodeURIComponent(fragment));
    } catch (alsoIgnored) {
      return null;
    }
  }
  if (!isConfigurationUpdate(parsed)) return null;
  return {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: parsed.favorites.map(contracts.copyPhoneFavorite),
    apiKeyUpdate: parsed.apiKeyUpdate.action === "REPLACE"
      ? { schemaVersion: contracts.SCHEMA_VERSION, action: "REPLACE", value: parsed.apiKeyUpdate.value }
      : { schemaVersion: contracts.SCHEMA_VERSION, action: parsed.apiKeyUpdate.action },
    forceFullSync: parsed.forceFullSync === true
  };
}

function configurationPageState(value, language) {
  return {
    hasKey: value.primApiKey !== null,
    favorites: value.favorites.map(contracts.copyPhoneFavorite),
    language: typeof language === "string" && language.length > 0 ? language : "en"
  };
}

function configurationUrl(baseUrl, value, language) {
  var withoutFragment;
  var encodedFragment;
  if (typeof baseUrl !== "string" || baseUrl.length === 0 || !isStoredConfiguration(value)) return null;
  // The page bounds the encoded opening fragment at the same 32768 characters
  // as this close channel; never emit an opening it would have to discard.
  // Unpaired surrogates make encodeURIComponent throw (URIError) on some
  // engines: such a configuration can never round-trip, so fail closed.
  try {
    encodedFragment = encodeURIComponent(JSON.stringify(configurationPageState(value, language)));
  } catch (ignored) {
    return null;
  }
  if (encodedFragment.length > MAX_CLOSE_RESPONSE_LENGTH) return null;
  withoutFragment = baseUrl.split("#")[0];
  return withoutFragment + "#" + encodedFragment;
}

module.exports = {
  CONFIG_STORAGE_KEY: CONFIG_STORAGE_KEY,
  RESULTS_STORAGE_KEY: RESULTS_STORAGE_KEY,
  INVALID_KEY_STATUS_STORAGE_KEY: INVALID_KEY_STATUS_STORAGE_KEY,
  MAX_CLOSE_RESPONSE_LENGTH: MAX_CLOSE_RESPONSE_LENGTH,
  emptyConfiguration: emptyConfiguration,
  emptyCache: emptyCache,
  isStoredConfiguration: isStoredConfiguration,
  isConfigurationUpdate: isConfigurationUpdate,
  isStoredCache: isStoredCache,
  isFavoriteSecretFree: isFavoriteSecretFree,
  areFavoritesSecretFree: areFavoritesSecretFree,
  normalizeLanguage: normalizeLanguage,
  activeWatchLanguage: activeWatchLanguage,
  loadConfiguration: loadConfiguration,
  saveConfiguration: saveConfiguration,
  saveInvalidConfiguration: saveInvalidConfiguration,
  clearInvalidKeyStatus: clearInvalidKeyStatus,
  loadCache: loadCache,
  saveCache: saveCache,
  cacheIsSecretFree: cacheIsSecretFree,
  pruneCache: pruneCache,
  mergeOverview: mergeOverview,
  findOverview: findOverview,
  putTrafficDetail: putTrafficDetail,
  findTrafficDetail: findTrafficDetail,
  applyConfigurationUpdate: applyConfigurationUpdate,
  parseCloseFragment: parseCloseFragment,
  configurationPageState: configurationPageState,
  configurationUrl: configurationUrl
};
