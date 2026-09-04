import {
  KEY_STATUS,
  LIMITS,
  SCHEMA_VERSION,
  boundedString,
  isWireLanguage,
  utf8Bytes
} from "./contracts.js";

export const WATCH_CONFIGURATION_KEY = "lapinFuteWatchConfig";
export const WATCH_CONFIGURATION_MAX_BYTES = 8192;

const STORAGE_FORMAT = "LFW1";
const STORAGE_SEPARATOR = "\u001f";
function owns(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function validInteger(value) {
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
}

function validFavorite(favorite) {
  if (!favorite || typeof favorite !== "object" || Array.isArray(favorite)) return false;
  let keyCount = 0;
  for (const key in favorite) {
    if (!owns(favorite, key)) continue;
    keyCount += 1;
    if (key !== "id"
        && key !== "serviceId"
        && key !== "displayName"
        && key !== "stopLabel"
        && key !== "lineLabel"
        && key !== "destinationLabel"
        && key !== "sortOrder") return false;
  }
  if (keyCount < 6
      || keyCount > 7
      || !owns(favorite, "id")
      || !owns(favorite, "serviceId")
      || !owns(favorite, "stopLabel")
      || !owns(favorite, "lineLabel")
      || !owns(favorite, "destinationLabel")
      || !owns(favorite, "sortOrder")) return false;
  return boundedString(favorite.id, LIMITS.idUtf8Bytes)
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
  for (let index = 0; index < favorites.length; index += 1) {
    const favorite = favorites[index];
    if (!validFavorite(favorite)) return false;
    for (let previous = 0; previous < index; previous += 1) {
      if (favorites[previous].id === favorite.id) return false;
    }
  }
  return true;
}

function validConfiguration(configuration) {
  if (!configuration
      || typeof configuration !== "object"
      || Array.isArray(configuration)) return false;
  let keyCount = 0;
  for (const key in configuration) {
    if (!owns(configuration, key)) continue;
    keyCount += 1;
    if (key !== "keyStatus" && key !== "language" && key !== "favorites") return false;
  }
  return keyCount === 3
    && owns(configuration, "keyStatus")
    && owns(configuration, "language")
    && owns(configuration, "favorites")
    && (configuration.keyStatus === KEY_STATUS.MISSING
      || configuration.keyStatus === KEY_STATUS.CONFIGURED
      || configuration.keyStatus === KEY_STATUS.INVALID)
    && isWireLanguage(configuration.language)
    && validFavorites(configuration.favorites);
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

function matchesText(state, value) {
  if (state.offset + value.length > state.serialized.length) return false;
  for (let index = 0; index < value.length; index += 1) {
    if (state.serialized.charCodeAt(state.offset + index) !== value.charCodeAt(index)) {
      return false;
    }
  }
  state.offset += value.length;
  return true;
}

function matchesToken(state, value) {
  return matchesText(state, String(value))
    && matchesText(state, STORAGE_SEPARATOR);
}

function matchesString(state, value) {
  return value === undefined
    ? matchesToken(state, "-")
    : matchesToken(state, value.length) && matchesText(state, value);
}

function matchesConfiguration(serialized, configuration) {
  const state = { serialized, offset: 0 };
  if (!matchesToken(state, STORAGE_FORMAT)
      || !matchesToken(state, SCHEMA_VERSION)
      || !matchesToken(state, configuration.keyStatus)
      || !matchesToken(state, configuration.language)
      || !matchesToken(state, configuration.favorites.length)) return false;
  for (let index = 0; index < configuration.favorites.length; index += 1) {
    const favorite = configuration.favorites[index];
    if (!matchesToken(state, favorite.sortOrder)
        || !matchesString(state, favorite.id)
        || !matchesString(state, favorite.serviceId)
        || !matchesString(state, favorite.displayName)
        || !matchesString(state, favorite.stopLabel)
        || !matchesString(state, favorite.lineLabel)
        || !matchesString(state, favorite.destinationLabel)) return false;
  }
  return state.offset === serialized.length;
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
  return configuration;
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
  let serialized = null;
  let writeAttempted = false;
  try {
    serialized = serializeWatchConfiguration(configuration);
    if (serialized === null) return false;
    previous = storage.getItem(WATCH_CONFIGURATION_KEY);
    writeAttempted = true;
    storage.setItem(WATCH_CONFIGURATION_KEY, serialized);
    serialized = null;
    const written = storage.getItem(WATCH_CONFIGURATION_KEY);
    if (typeof written === "string"
        && matchesConfiguration(written, configuration)) return true;
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
