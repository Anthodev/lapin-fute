// Pure state and serialization for the Lapin Futé configuration page.
//
// This module is deliberately DOM-free and dependency-free: it loads as an ES
// module in the browser (via index.html) and runs under node --test.
//
// Secret boundary: the personal PRIM key exists only in the page input value
// and in the one-time close fragment built from it. It is never persisted,
// never sent over HTTP, never placed in any path or query, and never logged.
// The opening fragment carries only the non-secret hasKey flag plus the watch
// language and the current favorites list.
//
// Canonical contract: packages/contracts/src/index.ts (schemaVersion 1). The
// mirrored constants below are asserted equal to the canonical module by
// test/config-page.test.ts; never change one side without the other.

export const SCHEMA_VERSION = 1;

export const LIMITS = {
  apiKeyUtf8Bytes: 512,
  idUtf8Bytes: 64,
  labelUtf8Bytes: 96,
  favorites: 8,
};

const FAVORITE_FIELDS = [
  "schemaVersion",
  "id",
  "serviceId",
  "displayName",
  "stopLabel",
  "lineLabel",
  "destinationLabel",
  "sortOrder",
];

const encoder = new TextEncoder();

export function utf8Bytes(value) {
  return encoder.encode(value).byteLength;
}

function boundedString(value, maximum) {
  return typeof value === "string" && utf8Bytes(value) >= 1 && utf8Bytes(value) <= maximum;
}

// --- Locale -----------------------------------------------------------------
// French authored product copy is selected by any language tag beginning
// "fr"; every other (or unknown) value falls back to English. User-authored
// favorite labels and backend transport labels never appear in this copy and
// always cross the page verbatim.

export function selectLocale(language) {
  return typeof language === "string" && language.toLowerCase().startsWith("fr") ? "fr" : "en";
}

export const COPY = {
  en: {
    pageTitle: "Lapin Futé — Settings",
    keyTitle: "PRIM API key",
    keyStatusConfigured: "A key is configured on your phone.",
    keyStatusMissing: "No API key is configured.",
    keyLabel: "API key",
    keyPlaceholder: "Enter a new key",
    keyShow: "Show",
    keyHide: "Hide",
    keyRemove: "Remove key",
    keyUndoRemove: "Keep key",
    keyRemovePending: "The key will be removed when you save.",
    keyErrorTooLong: "The key must be at most 512 bytes.",
    keyErrorNewline: "The key must not contain line breaks.",
    favoritesTitle: "Favorites",
    favoritesEmpty: "No favorites yet.",
    favoriteMoveUp: "Move up",
    favoriteMoveDown: "Move down",
    favoriteRemove: "Remove",
    save: "Save",
  },
  fr: {
    pageTitle: "Lapin Futé — Réglages",
    keyTitle: "Clé API PRIM",
    keyStatusConfigured: "Une clé est configurée sur votre téléphone.",
    keyStatusMissing: "Aucune clé API n’est configurée.",
    keyLabel: "Clé API",
    keyPlaceholder: "Saisir une nouvelle clé",
    keyShow: "Afficher",
    keyHide: "Masquer",
    keyRemove: "Supprimer la clé",
    keyUndoRemove: "Conserver la clé",
    keyRemovePending: "La clé sera supprimée à l’enregistrement.",
    keyErrorTooLong: "La clé doit contenir au maximum 512 octets.",
    keyErrorNewline: "La clé ne doit pas contenir de retour à la ligne.",
    favoritesTitle: "Favoris",
    favoritesEmpty: "Aucun favori pour le moment.",
    favoriteMoveUp: "Monter",
    favoriteMoveDown: "Descendre",
    favoriteRemove: "Supprimer",
    save: "Enregistrer",
  },
};

export function copyFor(language) {
  return COPY[selectLocale(language)];
}

// --- Favorites ---------------------------------------------------------------

export function isFavoriteShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!Object.keys(value).every((field) => FAVORITE_FIELDS.includes(field))) return false;
  return (
    value.schemaVersion === SCHEMA_VERSION &&
    boundedString(value.id, LIMITS.idUtf8Bytes) &&
    boundedString(value.serviceId, LIMITS.idUtf8Bytes) &&
    (value.displayName === undefined || boundedString(value.displayName, LIMITS.labelUtf8Bytes)) &&
    boundedString(value.stopLabel, LIMITS.labelUtf8Bytes) &&
    boundedString(value.lineLabel, LIMITS.labelUtf8Bytes) &&
    boundedString(value.destinationLabel, LIMITS.labelUtf8Bytes) &&
    Number.isInteger(value.sortOrder)
  );
}

function renumber(favorites) {
  return favorites.map((favorite, sortOrder) => ({ ...favorite, sortOrder }));
}

// --- Opening fragment --------------------------------------------------------
// Expected shape (all values non-secret):
//   #<encodeURIComponent(JSON.stringify({ hasKey, favorites, language }))>
// hasKey is the only credential-related field; the stored key itself is never
// present. Any other top-level shape is rejected before it can enter page state.

const OPENING_FIELDS = ["hasKey", "favorites", "language"];
const MAX_OPENING_FRAGMENT_LENGTH = 32768;

function emptyOpeningState() {
  return { hasKey: false, language: "en", locale: "en", favorites: [] };
}

export function parseConfigFragment(hash) {
  let fragment;
  let parsed;
  if (typeof hash !== "string" || hash.length === 0 || hash.length > MAX_OPENING_FRAGMENT_LENGTH + 1) {
    return emptyOpeningState();
  }
  fragment = hash.charAt(0) === "#" ? hash.slice(1) : hash;
  if (fragment.length === 0 || fragment.length > MAX_OPENING_FRAGMENT_LENGTH) return emptyOpeningState();
  try {
    parsed = JSON.parse(decodeURIComponent(fragment));
  } catch {
    return emptyOpeningState();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return emptyOpeningState();
  if (Object.keys(parsed).length !== OPENING_FIELDS.length
      || !Object.keys(parsed).every((field) => OPENING_FIELDS.includes(field))) return emptyOpeningState();
  if (typeof parsed.hasKey !== "boolean"
      || !Array.isArray(parsed.favorites)
      || typeof parsed.language !== "string") return emptyOpeningState();
  return {
    hasKey: parsed.hasKey,
    language: parsed.language,
    locale: selectLocale(parsed.language),
    favorites: parsed.favorites.filter(isFavoriteShape).map((favorite) => ({ ...favorite })),
  };
}

// --- State -------------------------------------------------------------------

export const EMPTY_KEY_DRAFT = { value: "", removeRequested: false };

export function initialConfigState(query) {
  return {
    hasKey: query.hasKey,
    keyDraft: { ...EMPTY_KEY_DRAFT },
    favorites: query.favorites,
  };
}

// Last intent wins: typing a non-empty draft cancels a pending removal, and
// requesting removal clears the draft. Favorite edits renumber sortOrder over
// the whole list so display order stays dense and atomic.

export function reduceConfigState(state, action) {
  switch (action.type) {
    case "key-draft": {
      const value = typeof action.value === "string" ? action.value : "";
      const removeRequested = value.length > 0 ? false : state.keyDraft.removeRequested;
      return { ...state, keyDraft: { value, removeRequested } };
    }
    case "key-remove-requested":
      if (!state.hasKey) return state;
      return { ...state, keyDraft: { value: "", removeRequested: true } };
    case "key-remove-cancelled":
      return { ...state, keyDraft: { ...state.keyDraft, removeRequested: false } };
    case "favorite-remove": {
      if (!state.favorites.some((favorite) => favorite.id === action.id)) return state;
      return {
        ...state,
        favorites: renumber(state.favorites.filter((favorite) => favorite.id !== action.id)),
      };
    }
    case "favorite-move": {
      const from = state.favorites.findIndex((favorite) => favorite.id === action.id);
      if (from < 0) return state;
      const to = Math.min(Math.max(from + action.delta, 0), state.favorites.length - 1);
      if (to === from) return state;
      const favorites = state.favorites.slice();
      const [moved] = favorites.splice(from, 1);
      favorites.splice(to, 0, moved);
      return { ...state, favorites: renumber(favorites) };
    }
    default:
      return state;
  }
}

// --- Key update planning ------------------------------------------------------
// No key ever enters this module except through the draft; the planned
// ApiKeyUpdate carries the value only for REPLACE.

export function apiKeyError(value) {
  if (/[\r\n]/u.test(value)) return "keyErrorNewline";
  if (utf8Bytes(value) > LIMITS.apiKeyUtf8Bytes) return "keyErrorTooLong";
  return null;
}

export function planApiKeyUpdate(hasKey, keyDraft) {
  if (keyDraft.value.length > 0) {
    return { schemaVersion: SCHEMA_VERSION, action: "REPLACE", value: keyDraft.value };
  }
  if (keyDraft.removeRequested && hasKey) {
    return { schemaVersion: SCHEMA_VERSION, action: "REMOVE" };
  }
  return { schemaVersion: SCHEMA_VERSION, action: "KEEP" };
}

// Plans the full configuration payload: the key decision plus the whole
// favorite list (atomic replacement, capped at the contract maximum).

export function planConfigResult(state) {
  const apiKeyUpdate = planApiKeyUpdate(state.hasKey, state.keyDraft);
  if (apiKeyUpdate.action === "REPLACE") {
    const error = apiKeyError(apiKeyUpdate.value);
    if (error !== null) return { ok: false, error };
  }
  return {
    ok: true,
    payload: {
      schemaVersion: SCHEMA_VERSION,
      apiKeyUpdate,
      favorites: state.favorites.slice(0, LIMITS.favorites).map(stampFavorite),
    },
  };
}

function stampFavorite(favorite, sortOrder) {
  const stamped = {
    schemaVersion: SCHEMA_VERSION,
    id: favorite.id,
    serviceId: favorite.serviceId,
    stopLabel: favorite.stopLabel,
    lineLabel: favorite.lineLabel,
    destinationLabel: favorite.destinationLabel,
    sortOrder,
  };
  if (favorite.displayName !== undefined) stamped.displayName = favorite.displayName;
  return stamped;
}

// --- One-time close fragment --------------------------------------------------
// The documented Pebble return channel: navigate exactly once to
// pebblejs://close#<encodeURIComponent(JSON.stringify(payload))>. The mobile
// app intercepts this navigation; it is not an HTTP request. A session
// refuses a second send.

export const CLOSE_PREFIX = "pebblejs://close#";

export function encodeCloseFragment(payload) {
  return CLOSE_PREFIX + encodeURIComponent(JSON.stringify(payload));
}

export function createCloseSession() {
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    close(payload) {
      if (closed) return null;
      closed = true;
      return encodeCloseFragment(payload);
    },
  };
}
