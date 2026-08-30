"use strict";

var contracts = require("./contracts");
var STORAGE_KEY = "lapin-fute.configuration.v1";
var RECORD_KEYS = ["schemaVersion", "favorites", "apiKey"];
var UPDATE_KEYS = ["schemaVersion", "favorites", "apiKeyUpdate"];
var MAX_CLOSE_RESPONSE_LENGTH = 32768;
var FAVORITE_STRING_KEYS = [
  "id",
  "serviceId",
  "displayName",
  "stopLabel",
  "lineLabel",
  "destinationLabel"
];

function emptyConfiguration() {
  return { schemaVersion: contracts.SCHEMA_VERSION, favorites: [], apiKey: null };
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
  return contracts.isObject(value)
    && contracts.hasOnlyKeys(value, RECORD_KEYS)
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

function copyConfiguration(configuration) {
  return {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: configuration.favorites.map(contracts.copyFavorite),
    apiKey: configuration.apiKey
  };
}

function loadConfiguration(storage) {
  var parsed;
  var serialized;
  try {
    serialized = storage.getItem(STORAGE_KEY);
    if (typeof serialized !== "string" || serialized.length === 0) return emptyConfiguration();
    parsed = JSON.parse(serialized);
  } catch (ignored) {
    return emptyConfiguration();
  }
  return isStoredConfiguration(parsed) ? copyConfiguration(parsed) : emptyConfiguration();
}

function saveConfiguration(storage, configuration) {
  if (!isStoredConfiguration(configuration)) return false;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(configuration));
    return true;
  } catch (ignored) {
    return false;
  }
}

function applyConfigurationUpdate(current, update) {
  var apiKey;
  var replacementKey = null;
  if (!isStoredConfiguration(current) || !isConfigurationUpdate(update)) return null;
  if (update.apiKeyUpdate.action === "REPLACE") replacementKey = update.apiKeyUpdate.value;
  if (!areFavoritesSecretFree(update.favorites, current.apiKey, replacementKey)) return null;
  apiKey = current.apiKey;
  if (replacementKey !== null) apiKey = replacementKey;
  if (update.apiKeyUpdate.action === "REMOVE") apiKey = null;
  return {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: update.favorites.map(contracts.copyFavorite),
    apiKey: apiKey
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

function configurationPageState(configuration, language) {
  return {
    hasKey: configuration.apiKey !== null,
    favorites: configuration.favorites.map(contracts.copyFavorite),
    language: typeof language === "string" && language.length > 0 ? language : "en"
  };
}

function configurationUrl(baseUrl, configuration, language) {
  var withoutFragment;
  if (typeof baseUrl !== "string" || baseUrl.length === 0 || !isStoredConfiguration(configuration)) return null;
  withoutFragment = baseUrl.split("#")[0];
  return withoutFragment + "#" + encodeURIComponent(JSON.stringify(configurationPageState(configuration, language)));
}

module.exports = {
  STORAGE_KEY: STORAGE_KEY,
  MAX_CLOSE_RESPONSE_LENGTH: MAX_CLOSE_RESPONSE_LENGTH,
  emptyConfiguration: emptyConfiguration,
  isStoredConfiguration: isStoredConfiguration,
  isConfigurationUpdate: isConfigurationUpdate,
  isFavoriteSecretFree: isFavoriteSecretFree,
  areFavoritesSecretFree: areFavoritesSecretFree,
  normalizeLanguage: normalizeLanguage,
  activeWatchLanguage: activeWatchLanguage,
  loadConfiguration: loadConfiguration,
  saveConfiguration: saveConfiguration,
  applyConfigurationUpdate: applyConfigurationUpdate,
  parseCloseFragment: parseCloseFragment,
  configurationPageState: configurationPageState,
  configurationUrl: configurationUrl
};
