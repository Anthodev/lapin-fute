import {
  KEY_STATUS,
  LIMITS,
  SCHEMA_VERSION,
  boundedString,
  enumHasValue,
  isWireLanguage,
  utf8Bytes
} from "./contracts.js";

export const WATCH_CONFIGURATION_KEY = "lapinFuteWatchConfig";
export const WATCH_CONFIGURATION_MAX_BYTES = 8192;

const STORAGE_FORMAT = "LFW1";
const STORAGE_SEPARATOR = "\u001f";
const CONFIGURATION_KEYS = Object.freeze(["keyStatus", "language", "favorites"]);
const FAVORITE_KEYS = Object.freeze([
  "id",
  "serviceId",
  "stopLabel",
  "lineLabel",
  "destinationLabel",
  "sortOrder"
]);

function exactKeys(value, required, optional = []) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length < required.length || keys.length > required.length + optional.length) {
    return false;
  }
  for (let index = 0; index < required.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, required[index])) return false;
  }
  for (let index = 0; index < keys.length; index += 1) {
    if (required.indexOf(keys[index]) === -1 && optional.indexOf(keys[index]) === -1) {
      return false;
    }
  }
  return true;
}

function validInteger(value) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
}

function validFavorite(favorite) {
  return exactKeys(favorite, FAVORITE_KEYS, ["displayName"])
    && boundedString(favorite.id, LIMITS.idUtf8Bytes)
    && boundedString(favorite.serviceId, LIMITS.idUtf8Bytes)
    && boundedString(favorite.stopLabel, LIMITS.labelUtf8Bytes)
    && boundedString(favorite.lineLabel, LIMITS.labelUtf8Bytes)
    && boundedString(favorite.destinationLabel, LIMITS.labelUtf8Bytes)
    && (favorite.displayName === undefined
      || boundedString(favorite.displayName, LIMITS.labelUtf8Bytes))
    && validInteger(favorite.sortOrder)
    && favorite.sortOrder >= 0
    && favorite.sortOrder < LIMITS.favorites;
}

function validFavorites(favorites) {
  if (!Array.isArray(favorites) || favorites.length > LIMITS.favorites) return false;
  const ids = [];
  for (let index = 0; index < favorites.length; index += 1) {
    const favorite = favorites[index];
    if (!validFavorite(favorite) || ids.indexOf(favorite.id) !== -1) return false;
    ids.push(favorite.id);
  }
  return true;
}

function validConfiguration(configuration) {
  return exactKeys(configuration, CONFIGURATION_KEYS)
    && enumHasValue(KEY_STATUS, configuration.keyStatus)
    && isWireLanguage(configuration.language)
    && validFavorites(configuration.favorites);
}

function copyFavorite(favorite) {
  const copy = {
    id: favorite.id,
    serviceId: favorite.serviceId,
    stopLabel: favorite.stopLabel,
    lineLabel: favorite.lineLabel,
    destinationLabel: favorite.destinationLabel,
    sortOrder: favorite.sortOrder
  };
  if (favorite.displayName !== undefined) copy.displayName = favorite.displayName;
  return copy;
}

function copyConfiguration(configuration) {
  return {
    keyStatus: configuration.keyStatus,
    language: configuration.language,
    favorites: configuration.favorites.map(copyFavorite)
  };
}

function appendToken(parts, value) {
  parts.push(String(value), STORAGE_SEPARATOR);
}

function appendString(parts, value) {
  if (value === undefined) {
    appendToken(parts, "-");
    return;
  }
  appendToken(parts, value.length);
  parts.push(value);
}

export function serializeWatchConfiguration(configuration) {
  if (!validConfiguration(configuration)) return null;
  const parts = [];
  appendToken(parts, STORAGE_FORMAT);
  appendToken(parts, SCHEMA_VERSION);
  appendToken(parts, configuration.keyStatus);
  appendToken(parts, configuration.language);
  appendToken(parts, configuration.favorites.length);
  for (let index = 0; index < configuration.favorites.length; index += 1) {
    const favorite = configuration.favorites[index];
    appendToken(parts, favorite.sortOrder);
    appendString(parts, favorite.id);
    appendString(parts, favorite.serviceId);
    appendString(parts, favorite.displayName);
    appendString(parts, favorite.stopLabel);
    appendString(parts, favorite.lineLabel);
    appendString(parts, favorite.destinationLabel);
  }
  const serialized = parts.join("");
  return utf8Bytes(serialized) <= WATCH_CONFIGURATION_MAX_BYTES ? serialized : null;
}

function readToken(state) {
  if (!state.valid) return null;
  const end = state.serialized.indexOf(STORAGE_SEPARATOR, state.offset);
  if (end === -1) {
    state.valid = false;
    return null;
  }
  const token = state.serialized.slice(state.offset, end);
  state.offset = end + 1;
  return token;
}

function readUnsigned(state) {
  const token = readToken(state);
  if (token === null || !/^(0|[1-9][0-9]*)$/u.test(token)) {
    state.valid = false;
    return null;
  }
  const value = Number(token);
  if (!validInteger(value) || value < 0) {
    state.valid = false;
    return null;
  }
  return value;
}

function readString(state, optional = false) {
  const token = readToken(state);
  if (optional && token === "-") return undefined;
  if (token === null || !/^(0|[1-9][0-9]*)$/u.test(token)) {
    state.valid = false;
    return null;
  }
  const length = Number(token);
  const end = state.offset + length;
  if (!validInteger(length) || length < 0 || end > state.serialized.length) {
    state.valid = false;
    return null;
  }
  const value = state.serialized.slice(state.offset, end);
  state.offset = end;
  return value;
}

export function deserializeWatchConfiguration(serialized) {
  if (typeof serialized !== "string"
      || utf8Bytes(serialized) > WATCH_CONFIGURATION_MAX_BYTES) return null;
  const state = { serialized, offset: 0, valid: true };
  if (readToken(state) !== STORAGE_FORMAT || readUnsigned(state) !== SCHEMA_VERSION) return null;
  const keyStatus = readUnsigned(state);
  const language = readToken(state);
  const count = readUnsigned(state);
  if (!state.valid || count === null || count > LIMITS.favorites) return null;
  const configuration = { keyStatus, language, favorites: [] };
  for (let index = 0; index < count; index += 1) {
    const favorite = {
      sortOrder: readUnsigned(state),
      id: readString(state),
      serviceId: readString(state)
    };
    const displayName = readString(state, true);
    if (displayName !== undefined) favorite.displayName = displayName;
    favorite.stopLabel = readString(state);
    favorite.lineLabel = readString(state);
    favorite.destinationLabel = readString(state);
    configuration.favorites.push(favorite);
  }
  if (!state.valid || state.offset !== serialized.length
      || !validConfiguration(configuration)) return null;
  return copyConfiguration(configuration);
}


function canRead(storage) {
  return storage && typeof storage.getItem === "function";
}

function canWrite(storage) {
  return canRead(storage)
    && typeof storage.setItem === "function"
    && typeof storage.removeItem === "function";
}

export function loadWatchConfiguration(storage) {
  if (!canRead(storage)) return null;
  try {
    return deserializeWatchConfiguration(storage.getItem(WATCH_CONFIGURATION_KEY));
  } catch (_) {
    return null;
  }
}

export function saveWatchConfiguration(storage, configuration) {
  if (!canWrite(storage)) return false;

  let previous = null;
  let writeAttempted = false;
  try {
    const serialized = serializeWatchConfiguration(configuration);
    if (serialized === null) return false;
    previous = storage.getItem(WATCH_CONFIGURATION_KEY);
    writeAttempted = true;
    storage.setItem(WATCH_CONFIGURATION_KEY, serialized);
    if (storage.getItem(WATCH_CONFIGURATION_KEY) === serialized) return true;
  } catch (_) {
    // Restore the prior bytes below when the adapter is still writable.
  }

  if (!writeAttempted) return false;
  try {
    if (previous === null) storage.removeItem(WATCH_CONFIGURATION_KEY);
    else storage.setItem(WATCH_CONFIGURATION_KEY, previous);
  } catch (_) {
    // The caller still rolls back its in-memory configuration.
  }
  return false;
}
