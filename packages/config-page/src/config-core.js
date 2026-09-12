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
  favorites: 6,
  httpResponseBytes: 262144,
  catalogQueryMinCharacters: 2,
  catalogQueryMaxCharacters: 100,
  catalogSearchResults: 20,
};

const FAVORITE_FIELDS = [
  "schemaVersion",
  "id",
  "serviceId",
  "displayName",
  "stopLabel",
  "lineLabel",
  "destinationLabel",
  "lineMode",
  "lineColor",
  "lineTextColor",
  "routing",
  "sortOrder",
];

const encoder = new TextEncoder();

export function utf8Bytes(value) {
  return encoder.encode(value).byteLength;
}

function boundedString(value, maximum) {
  return typeof value === "string"
    && utf8Bytes(value) >= 1
    && utf8Bytes(value) <= maximum
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

export function isLineColor(value) {
  return typeof value === "string" && /^#[0-9a-f]{6}$/u.test(value);
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
    pageTitle: "Lapin Futé settings",
    pageHeading: "Settings",
    intro: "Choose the departures you want at hand on your Pebble.",
    keyTitle: "PRIM access",
    keyStatusConfigured: "A key is saved on this phone. It is not verified against PRIM.",
    keyStatusMissing: "No key is configured.",
    keyExplanation: "Your personal key stays in plaintext on your phone. This page never receives the saved key.",
    keyLink: "Create a PRIM token",
    keyDocsLink: "Instructions",
    keyRequirement: "A personal PRIM token is required to retrieve live departures. You can prepare your favorites without one.",
    keyRequiredHint: "PRIM token required for live departures",
    keyLabel: "Replace with a new key",
    keyPlaceholder: "Paste a new key",
    keyShow: "Show",
    keyHide: "Hide",
    keyRemove: "Remove saved key",
    keyUndoRemove: "Keep saved key",
    keyRemovePending: "The saved key will be removed.",
    keyReplacementPending: "A replacement key is ready to save.",
    keyErrorTooLong: "The key must be at most 512 UTF-8 bytes.",
    keyErrorNewline: "The key must not contain control characters.",
    favoritesTitle: "Favorite departures",
    favoriteUsed: "used",
    favoritesUsed: "used",
    favoriteAvailable: "available",
    favoritesAvailable: "available",
    favoritesEmpty: "No favorites yet. Search for a stop to add one.",
    favoriteAddTitle: "Add a favorite",
    favoriteAddCaption: "Stop, line and direction",
    searchLabel: "Stop or station",
    searchPlaceholder: "Search by name",
    searchHint: "Enter at least 2 characters.",
    searchLoading: "Searching…",
    searchNoResults: "No matching stop or station.",
    backendUnavailable: "The service catalog is unavailable. Your edits are safe; try again.",
    invalidService: "This service is no longer available. Search again.",
    servicesLoading: "Loading lines and directions…",
    servicesLabel: "Line and direction",
    servicesEmpty: "No service is available for this stop.",
    previewRecorded: "Recorded example",
    minutesShort: "min",
    previewTitle: "Preview",
    favoriteNameLabel: "Favorite name (optional)",
    favoriteNamePlaceholder: "For example, Home",
    favoriteAdd: "Add favorite",
    favoriteLimit: "You have reached the 6-favorite limit.",
    favoriteMoveUp: "Move up",
    favoriteMoveDown: "Move down",
    favoriteRename: "Rename",
    favoriteRemove: "Remove",
    favoriteUnresolved: "Not found in the catalog anymore: remove it, then search for the stop again.",
    renamePrompt: "Favorite name",
    save: "Save settings",
    aboutOpen: "About",
    aboutBack: "Back to settings",
    aboutTitle: "About Lapin Futé",
    syncTitle: "Watch synchronization",
    syncCaption: "Transfer options",
    syncHint: "The watch normally receives only what changed. Tick this to resend everything if the watch shows outdated favorites.",
    forceSyncLabel: "Force a full synchronization at the next save",
    saveTooLarge: "These settings are too large to transfer. Remove the favorite with the longest entry and add it again.",
  },
  fr: {
    pageTitle: "Réglages Lapin Futé",
    pageHeading: "Réglages",
    intro: "Choisissez les prochains départs à garder sous la main sur votre Pebble.",
    keyTitle: "Accès PRIM",
    keyStatusConfigured: "Une clé est enregistrée sur ce téléphone. Elle n’est pas vérifiée auprès de PRIM.",
    keyDocsLink: "Instructions",
    keyRequirement: "Un jeton PRIM personnel est obligatoire pour récupérer les prochains départs en temps réel. Vous pouvez préparer vos favoris sans jeton.",
    keyRequiredHint: "Jeton PRIM requis pour les départs en temps réel",
    keyStatusMissing: "Aucune clé n’est configurée.",
    keyExplanation: "Votre clé personnelle reste en clair sur votre téléphone. Cette page ne reçoit jamais la clé enregistrée.",
    keyLink: "Créer un jeton PRIM",
    keyLabel: "Remplacer par une nouvelle clé",
    keyPlaceholder: "Coller une clé",
    keyShow: "Afficher",
    keyHide: "Masquer",
    keyRemove: "Supprimer la clé enregistrée",
    keyUndoRemove: "Conserver la clé enregistrée",
    keyRemovePending: "La clé enregistrée sera supprimée.",
    keyReplacementPending: "Une nouvelle clé est prête à être enregistrée.",
    keyErrorTooLong: "La clé doit contenir au maximum 512 octets UTF-8.",
    keyErrorNewline: "La clé ne doit pas contenir de caractère de contrôle.",
    favoritesTitle: "Départs favoris",
    favoriteUsed: "utilisé",
    favoritesUsed: "utilisés",
    favoriteAvailable: "disponible",
    favoritesAvailable: "disponibles",
    favoritesEmpty: "Aucun favori. Recherchez un arrêt pour en ajouter un.",
    favoriteAddTitle: "Ajouter un favori",
    favoriteAddCaption: "Arrêt, ligne et direction",
    searchLabel: "Arrêt ou gare",
    searchPlaceholder: "Rechercher par nom",
    searchHint: "Saisissez au moins 2 caractères.",
    searchLoading: "Recherche…",
    searchNoResults: "Aucun arrêt ni gare ne correspond.",
    backendUnavailable: "Le catalogue est indisponible. Vos modifications sont conservées ; réessayez.",
    invalidService: "Ce service n’est plus disponible. Relancez la recherche.",
    servicesLoading: "Chargement des lignes et directions…",
    servicesLabel: "Ligne et direction",
    servicesEmpty: "Aucun service n’est disponible pour cet arrêt.",
    previewRecorded: "Exemple enregistré",
    minutesShort: "min",
    previewTitle: "Aperçu",
    favoriteNameLabel: "Nom du favori (facultatif)",
    favoriteNamePlaceholder: "Par exemple, Maison",
    favoriteAdd: "Ajouter le favori",
    favoriteLimit: "Vous avez atteint la limite de 6 favoris.",
    favoriteMoveUp: "Monter",
    favoriteMoveDown: "Descendre",
    favoriteRename: "Renommer",
    favoriteRemove: "Supprimer",
    renamePrompt: "Nom du favori",
    favoriteUnresolved: "Introuvable dans le catalogue : supprimez-le, puis recherchez à nouveau l’arrêt.",
    save: "Enregistrer les réglages",
    aboutOpen: "À propos",
    aboutBack: "Retour aux réglages",
    aboutTitle: "À propos de Lapin Futé",
    syncTitle: "Synchronisation de la montre",
    syncCaption: "Options de transfert",
    syncHint: "La montre ne reçoit normalement que les changements. Cochez cette case pour tout renvoyer si la montre affiche des favoris obsolètes.",
    forceSyncLabel: "Forcer une synchronisation complète au prochain enregistrement",
    saveTooLarge: "Ces réglages sont trop volumineux pour être transférés. Supprimez le favori comportant l’entrée la plus longue, puis rajoutez-le.",
  },
};

export function copyFor(language) {
  return COPY[selectLocale(language)];
}

// --- Favorites ---------------------------------------------------------------

export function isFavoriteShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!Object.keys(value).every((field) => FAVORITE_FIELDS.includes(field))) return false;
  const hasLineMode = Object.hasOwn(value, "lineMode");
  const hasLineColor = Object.hasOwn(value, "lineColor");
  const hasLineTextColor = Object.hasOwn(value, "lineTextColor");
  if (hasLineMode !== hasLineColor || hasLineMode !== hasLineTextColor) return false;
  return (
    value.schemaVersion === SCHEMA_VERSION &&
    boundedString(value.id, LIMITS.idUtf8Bytes) &&
    boundedString(value.serviceId, LIMITS.idUtf8Bytes) &&
    (value.displayName === undefined || boundedString(value.displayName, LIMITS.labelUtf8Bytes)) &&
    boundedString(value.stopLabel, LIMITS.labelUtf8Bytes) &&
    boundedString(value.lineLabel, LIMITS.labelUtf8Bytes) &&
    boundedString(value.destinationLabel, LIMITS.labelUtf8Bytes) &&
    (!hasLineMode || (
      TRANSPORT_MODES.includes(value.lineMode) &&
      isLineColor(value.lineColor) &&
      isLineColor(value.lineTextColor)
    )) &&
    Number.isInteger(value.sortOrder)
  );
}

// --- Service routing -----------------------------------------------------------
// The accepted no-backend contract: routing references are exact-key objects of
// non-empty opaque strings. No per-reference byte cap is invented; the page and
// close fragment bounds (32768 characters) constrain total size.

const ROUTING_FIELDS = ["monitoringRef", "lineRef", "destinationRef"];

export function isServiceRouting(value) {
  return exactFields(value, ROUTING_FIELDS, ROUTING_FIELDS)
    && ROUTING_FIELDS.every((field) => typeof value[field] === "string" && value[field].length > 0);
}

// PhoneFavorite: a Favorite that may carry routing. Missing routing marks a
// routing-unresolved favorite and stays fully valid; a present routing must be
// exactly valid (present-but-undefined is rejected, mirroring lineMode).

export function isPhoneFavorite(value) {
  if (!isFavoriteShape(value)) return false;
  if (!Object.hasOwn(value, "routing")) return true;
  return isServiceRouting(value.routing);
}

// Storage/payload copy for the phone: unlike the watch projection this keeps a
// fresh copy of routing.

export function copyPhoneFavorite(favorite) {
  const copy = { ...favorite };
  if (Object.hasOwn(copy, "routing")) copy.routing = { ...copy.routing };
  return copy;
}

const PLACE_LINE_FIELDS = ["lineLabel", "lineColor", "lineTextColor"];
const PLACE_FIELDS = ["placeId", "stopLabel", "localityLabel", "mode", "lines"];
const SERVICE_FIELDS = ["serviceId", "stopLabel", "lineLabel", "destinationLabel", "lineMode", "lineColor", "lineTextColor", "routing"];
const TRANSPORT_MODES = ["BUS", "METRO", "TRAM", "RER", "TRANSILIEN"];

function exactFields(value, allowed, required) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).every((field) => allowed.includes(field))
    && required.every((field) => Object.hasOwn(value, field));
}

export function isPlaceLine(value) {
  return exactFields(value, PLACE_LINE_FIELDS, PLACE_LINE_FIELDS)
    && boundedString(value.lineLabel, LIMITS.labelUtf8Bytes)
    && isLineColor(value.lineColor)
    && isLineColor(value.lineTextColor);
}

// Producer-precomputed display lines for one search row: an entry per native
// line with no per-line mode or ref. The list is required and nonempty; the
// response byte bound (not a speculative count cap) limits its length. Holes
// are visited by for...of, which Array.prototype.every would silently skip.
function isPlaceLineList(lines) {
  if (!Array.isArray(lines) || lines.length === 0) return false;
  for (const line of lines) {
    if (!isPlaceLine(line)) return false;
  }
  return true;
}

export function isPlaceSearchItem(value) {
  return exactFields(value, PLACE_FIELDS, ["placeId", "stopLabel", "mode", "lines"])
    && boundedString(value.placeId, LIMITS.idUtf8Bytes)
    && boundedString(value.stopLabel, LIMITS.labelUtf8Bytes)
    && (value.localityLabel === undefined || boundedString(value.localityLabel, LIMITS.labelUtf8Bytes))
    && TRANSPORT_MODES.includes(value.mode)
    && isPlaceLineList(value.lines);
}

export function isPlaceSearchResult(value) {
  return exactFields(value, ["schemaVersion", "places"], ["schemaVersion", "places"])
    && value.schemaVersion === SCHEMA_VERSION
    && Array.isArray(value.places)
    && value.places.length <= LIMITS.catalogSearchResults
    && value.places.every(isPlaceSearchItem);
}

export function isServiceOption(value) {
  return exactFields(value, SERVICE_FIELDS, SERVICE_FIELDS)
    && boundedString(value.serviceId, LIMITS.idUtf8Bytes)
    && boundedString(value.stopLabel, LIMITS.labelUtf8Bytes)
    && boundedString(value.lineLabel, LIMITS.labelUtf8Bytes)
    && boundedString(value.destinationLabel, LIMITS.labelUtf8Bytes)
    && TRANSPORT_MODES.includes(value.lineMode)
    && isLineColor(value.lineColor)
    && isLineColor(value.lineTextColor)
    && isServiceRouting(value.routing);
}

export function isServiceOptionsResult(value, placeId) {
  return exactFields(value, ["schemaVersion", "placeId", "services"], ["schemaVersion", "placeId", "services"])
    && value.schemaVersion === SCHEMA_VERSION
    && value.placeId === placeId
    && Array.isArray(value.services)
    && value.services.every(isServiceOption);
}

export function favoriteFromService(id, service, sortOrder, displayName = undefined) {
  if (!boundedString(id, LIMITS.idUtf8Bytes) || !isServiceOption(service)
      || !Number.isInteger(sortOrder) || sortOrder < 0) return null;
  const favorite = {
    schemaVersion: SCHEMA_VERSION,
    id,
    serviceId: service.serviceId,
    stopLabel: service.stopLabel,
    lineLabel: service.lineLabel,
    destinationLabel: service.destinationLabel,
    lineMode: service.lineMode,
    lineColor: service.lineColor,
    lineTextColor: service.lineTextColor,
    routing: { ...service.routing },
    sortOrder,
  };
  if (displayName !== undefined && boundedString(displayName, LIMITS.labelUtf8Bytes)) {
    favorite.displayName = displayName;
  }
  return favorite;
}

function renumber(favorites) {
  return favorites.map((favorite, sortOrder) => ({ ...favorite, sortOrder }));
}

// --- Opening fragment --------------------------------------------------------
// Expected shape (all values non-secret):
//   #<encodeURIComponent(JSON.stringify({ hasKey, favorites, language }))>
// hasKey is the only credential-related field; the stored key itself is never
// present. Any other top-level shape is rejected before it can enter page state.

export const MAX_OPENING_FRAGMENT_LENGTH = 32768;
const OPENING_FIELDS = ["hasKey", "favorites", "language"];

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
    favorites: parsed.favorites.filter(isPhoneFavorite).map(copyPhoneFavorite),
  };
}

// --- State -------------------------------------------------------------------

export const EMPTY_KEY_DRAFT = { value: "", removeRequested: false };

export function initialConfigState(query) {
  return {
    hasKey: query.hasKey,
    keyDraft: { ...EMPTY_KEY_DRAFT },
    favorites: query.favorites,
    forceFullSync: false,
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
    case "favorite-add": {
      if (state.favorites.length >= LIMITS.favorites || !isPhoneFavorite(action.favorite)
          || state.favorites.some((favorite) => favorite.id === action.favorite.id)) return state;
      const candidate = renumber([...state.favorites, { ...action.favorite }]);
      // A favorite whose routing would overflow the one-shot close bound is
      // rejected whole: neither the list nor the session is disturbed.
      if (!favoritesFitCloseBound(candidate)) return state;
      return { ...state, favorites: candidate };
    }
    case "favorite-rename": {
      const displayName = typeof action.displayName === "string" ? action.displayName.trim() : "";
      if (displayName.length > 0 && !boundedString(displayName, LIMITS.labelUtf8Bytes)) return state;
      let changed = false;
      const favorites = state.favorites.map((favorite) => {
        if (favorite.id !== action.id) return favorite;
        changed = true;
        const renamed = { ...favorite };
        if (displayName.length === 0) delete renamed.displayName;
        else renamed.displayName = displayName;
        return renamed;
      });
      return changed ? { ...state, favorites } : state;
    }
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
    case "favorite-hydrate": {
      // Routing recovery: a known serviceId gains routing in place; unknown,
      // malformed, or bound-overflowing hydration never deletes or reorders
      // the stored favorite.
      if (!isPhoneFavorite(action.favorite) || action.favorite.id !== action.id) return state;
      if (!state.favorites.some((favorite) => favorite.id === action.id)) return state;
      const candidate = renumber(state.favorites.map((favorite) => (
        favorite.id === action.id ? action.favorite : favorite
      )));
      if (!favoritesFitCloseBound(candidate)) return state;
      return { ...state, favorites: candidate };
    }
    case "force-full-sync":
      return { ...state, forceFullSync: action.value === true };
    default:
      return state;
  }
}

// --- Key update planning ------------------------------------------------------
// No key ever enters this module except through the draft; the planned
// ApiKeyUpdate carries the value only for REPLACE.

export function apiKeyError(value) {
  if (/[\u0000-\u001f\u007f]/u.test(value)) return "keyErrorNewline";
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
// favorite list (atomic replacement; an oversized list is rejected, never
// silently truncated).

export function planConfigResult(state) {
  const apiKeyUpdate = planApiKeyUpdate(state.hasKey, state.keyDraft);
  if (apiKeyUpdate.action === "REPLACE") {
    const error = apiKeyError(apiKeyUpdate.value);
    if (error !== null) return { ok: false, error };
  }
  if (state.favorites.length > LIMITS.favorites) {
    return { ok: false, error: "favoriteLimit" };
  }
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    apiKeyUpdate,
    favorites: state.favorites.map(stampFavorite),
  };
  // One-shot full resync: absent unless explicitly requested on the settings page.
  if (state.forceFullSync === true) payload.forceFullSync = true;
  return { ok: true, payload };
}

function stampFavorite(favorite, sortOrder) {
  const stamped = {
    schemaVersion: SCHEMA_VERSION,
    id: favorite.id,
    serviceId: favorite.serviceId,
    stopLabel: favorite.stopLabel,
    lineLabel: favorite.lineLabel,
    destinationLabel: favorite.destinationLabel,
  };
  if (Object.hasOwn(favorite, "lineMode")) {
    stamped.lineMode = favorite.lineMode;
    stamped.lineColor = favorite.lineColor;
    stamped.lineTextColor = favorite.lineTextColor;
  }
  if (Object.hasOwn(favorite, "routing")) {
    stamped.routing = { ...favorite.routing };
  }
  stamped.sortOrder = sortOrder;
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

// The phone accepts at most 32768 characters of "pebblejs://close#" plus the
// encoded payload (its MAX_CLOSE_RESPONSE_LENGTH). Producers enforce the
// complete encoded bound before any one-shot close or list mutation so an
// oversized selection can never empty favorites or burn the session.

export const MAX_CLOSE_PAYLOAD_LENGTH = 32768;

export function closePayloadFits(payload) {
  try {
    return CLOSE_PREFIX.length + encodeURIComponent(JSON.stringify(payload)).length
      <= MAX_CLOSE_PAYLOAD_LENGTH;
  } catch {
    // Unpaired surrogates make encodeURIComponent throw on some engines; such
    // a payload can never round-trip, so report it as not fitting.
    return false;
  }
}

// Early-rejection envelope for selection/hydration. The true permitted worst
// case composes both escaping layers: JSON.stringify turns one backslash into
// two, and encodeURIComponent then turns each into %5C, so one key byte
// becomes six encoded characters (quotes behave identically; canonical
// boundedString excludes control characters, and every other byte inflates
// at most threefold). A 512-byte key of backslashes therefore bounds every
// key the page can plan; the flag adds only a fixed tail. If this envelope
// fits, every real save payload fits too; the actual payload is still checked
// authoritatively at close time.

function favoritesFitCloseBound(favorites) {
  return closePayloadFits({
    schemaVersion: SCHEMA_VERSION,
    apiKeyUpdate: {
      schemaVersion: SCHEMA_VERSION,
      action: "REPLACE",
      value: "\\".repeat(LIMITS.apiKeyUtf8Bytes),
    },
    favorites,
    forceFullSync: true,
  });
}

export function createCloseSession() {
  let closed = false;
  return {
    get closed() {
      return closed;
    },
    close(payload) {
      if (closed) return null;
      // An oversized payload never consumes the one-shot session.
      if (!closePayloadFits(payload)) return null;
      closed = true;
      return encodeCloseFragment(payload);
    },
  };
}
