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
// Canonical contract: packages/contracts/src/index.ts. Domain objects, the
// favorites nested inside every envelope, and ApiKeyUpdate keep
// SCHEMA_VERSION 1. Only the stored configuration and the page open/close
// envelopes use CONFIGURATION_VERSION 2; a close fragment on the old version
// is always rejected by the phone, so an outdated page can never wipe the
// stored configuration. The mirrored constants below are asserted equal to
// the canonical module by test/config-page.test.ts; never change one side
// without the other.

// Shared journey helper, browser build: the generated wrapper of the
// canonical CommonJS module (packages/companion/src/journey-patterns.js).
// Arrival labels are truncated by exactly the rule the phone applies, and
// journey text bounds stay aligned with the catalog admission limits.
import { JOURNEY_LIMITS, arrivalLabel } from "./generated/journey-patterns.js";

export const SCHEMA_VERSION = 1;

// Version of the stored configuration and of the opening/closing page
// envelopes only. Never used for domain objects.
export const CONFIGURATION_VERSION = 2;

// Journey place identities are catalog-computed plc_ + SHA-256 base64url;
// the page only validates their form.
const PLACE_ID = /^plc_[A-Za-z0-9_-]{43}$/;

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
  "arrivalPlaceId",
  "lineMode",
  "lineColor",
  "lineTextColor",
  "routing",
  "sortOrder",
];

// A pre-journey (v1) PhoneFavorite as carried by an old opening fragment:
// exactly the previous fields plus optional routing, never arrivalPlaceId.
const LEGACY_FAVORITE_FIELDS = [
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
    intro: "Choose the stops you want at hand on your Pebble.",
    keyTitle: "PRIM access",
    keyStatusConfigured: "A key is saved on this phone. It is not verified against PRIM.",
    keyStatusMissing: "No key is configured.",
    keyExplanation: "Your personal key stays in plaintext on your phone. This page never receives the saved key.",
    keyLink: "Create a PRIM token",
    keyDocsLink: "Instructions",
    keyRequirement: "A personal PRIM token is required to retrieve live arrivals. You can prepare your favorites without one.",
    keyRequiredHint: "PRIM token required for live arrivals",
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
    favoritesTitle: "Favorite stops",
    favoriteUsed: "used",
    favoritesUsed: "used",
    favoriteAvailable: "available",
    favoritesAvailable: "available",
    favoritesEmpty: "No favorites yet. Search for a stop to add one.",
    favoriteAddTitle: "Add a favorite",
    favoriteAddCaption: "Departure, line and arrival",
    searchLabel: "Departure stop or station",
    searchPlaceholder: "Search by name",
    searchHint: "Enter at least 2 characters.",
    searchLoading: "Searching…",
    searchNoResults: "No matching stop or station.",
    backendUnavailable: "The service catalog is unavailable. Your edits are safe; try again.",
    invalidService: "This service is no longer available. Search again.",
    servicesLoading: "Loading lines…",
    servicesLabel: "Line and boarding point",
    arrivalsLabel: "Arrival stop or station",
    arrivalsLoading: "Loading arrival stops…",
    arrivalsEmpty: "No arrival is available from this boarding point.",
    arrivalsUnavailable: "Arrival stops are unavailable. Select the line again to try again.",
    journeyHint: "Full and short-turn services that serve your arrival are combined.",
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
    configurationUpgradeRequired: "Update Lapin Futé on your Pebble to edit these settings.",
  },
  fr: {
    pageTitle: "Réglages Lapin Futé",
    pageHeading: "Réglages",
    intro: "Choisissez les arrêts à garder sous la main sur votre Pebble.",
    keyTitle: "Accès PRIM",
    keyStatusConfigured: "Une clé est enregistrée sur ce téléphone. Elle n’est pas vérifiée auprès de PRIM.",
    keyDocsLink: "Instructions",
    keyRequirement: "Un jeton PRIM personnel est obligatoire pour récupérer les prochains passages en temps réel. Vous pouvez préparer vos favoris sans jeton.",
    keyRequiredHint: "Jeton PRIM requis pour les passages en temps réel",
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
    favoritesTitle: "Arrêts favoris",
    favoriteUsed: "utilisé",
    favoritesUsed: "utilisés",
    favoriteAvailable: "disponible",
    favoritesAvailable: "disponibles",
    favoritesEmpty: "Aucun favori. Recherchez un arrêt pour en ajouter un.",
    favoriteAddTitle: "Ajouter un favori",
    favoriteAddCaption: "Départ, ligne et arrivée",
    searchLabel: "Arrêt ou gare de départ",
    searchPlaceholder: "Rechercher par nom",
    searchHint: "Saisissez au moins 2 caractères.",
    searchLoading: "Recherche…",
    searchNoResults: "Aucun arrêt ni gare ne correspond.",
    backendUnavailable: "Le catalogue est indisponible. Vos modifications sont conservées ; réessayez.",
    invalidService: "Ce service n’est plus disponible. Relancez la recherche.",
    servicesLoading: "Chargement des lignes…",
    servicesLabel: "Ligne et point de départ",
    arrivalsLabel: "Arrêt ou gare d’arrivée",
    arrivalsLoading: "Chargement des arrêts d’arrivée…",
    arrivalsEmpty: "Aucune arrivée n’est disponible depuis ce point de départ.",
    arrivalsUnavailable: "Les arrêts d’arrivée sont indisponibles. Resélectionnez la ligne pour réessayer.",
    journeyHint: "Les passages des services complets et partiels desservant votre arrivée sont réunis.",
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
    configurationUpgradeRequired: "Mettez à jour Lapin Futé sur votre Pebble pour modifier ces réglages.",
  },
};

export function copyFor(language) {
  return COPY[selectLocale(language)];
}

// --- Favorites ----------------------------------------------------------------

// Shared value checks for both favorite generations. `hasArrival` selects the
// journey contract: a current favorite carries a required arrivalPlaceId that
// is either null (not yet resolved) or a catalog plc_ identity; a legacy
// favorite never carries the field at all.
function favoriteValuesValid(value, hasArrival) {
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
    (!hasArrival || value.arrivalPlaceId === null ||
      (typeof value.arrivalPlaceId === "string" && value.arrivalPlaceId.length === 47 && PLACE_ID.test(value.arrivalPlaceId))) &&
    (!hasLineMode || (
      TRANSPORT_MODES.includes(value.lineMode) &&
      isLineColor(value.lineColor) &&
      isLineColor(value.lineTextColor)
    )) &&
    Number.isInteger(value.sortOrder) && value.sortOrder >= 0 && value.sortOrder < LIMITS.favorites
  );
}

export function isFavoriteShape(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!Object.keys(value).every((field) => FAVORITE_FIELDS.includes(field))) return false;
  // The field is required and present-but-undefined is rejected: a v2 favorite
  // without a usable arrival value is invalid, never silently migrated.
  if (!Object.hasOwn(value, "arrivalPlaceId") || value.arrivalPlaceId === undefined) return false;
  return favoriteValuesValid(value, true);
}

// JourneyPlace as published in catalog journey groups: the arrival value the
// page passes to favoriteFromService. Only the form is checked here; the
// group-level referential integrity is the catalog's contract.
export function isJourneyPlace(value) {
  return exactFields(value, ["kind", "placeId", "label"], ["kind", "placeId", "label"])
    && value.kind === "place"
    && typeof value.placeId === "string" && value.placeId.length === 47 && PLACE_ID.test(value.placeId)
    && boundedString(value.label, JOURNEY_LIMITS.textUtf8Bytes);
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
// exactly valid (present-but-undefined is rejected, mirroring lineMode). The
// arrival is part of the shape itself: null means not yet resolved, never a
// legacy absence.

export function isPhoneFavorite(value) {
  if (!isFavoriteShape(value)) return false;
  if (!Object.hasOwn(value, "routing")) return true;
  return isServiceRouting(value.routing);
}

function isPhoneFavoriteList(value) {
  if (!Array.isArray(value) || value.length > LIMITS.favorites) return false;
  const seen = new Set();
  for (const favorite of value) {
    if (!isPhoneFavorite(favorite) || seen.has(favorite.id)) return false;
    seen.add(favorite.id);
  }
  return true;
}

// Pre-journey favorite for read-only display of an old opening fragment. The
// field set is exactly the historical one: an arrivalPlaceId key, even a valid
// one, makes the entry not-legacy and it is never shown from a v1 fragment.

function isLegacyFavorite(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (!Object.keys(value).every((field) => LEGACY_FAVORITE_FIELDS.includes(field))) return false;
  if (!favoriteValuesValid(value, false)) return false;
  return !Object.hasOwn(value, "routing") || isServiceRouting(value.routing);
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

// Builds a journey favorite from a selected catalog service and the arrival
// chosen among reachableArrivals(group, routing.monitoringRef). The arrival is
// mandatory and must be a resolved JourneyPlace: no caller ever creates a null
// arrival here. destinationLabel displays the chosen arrival (truncated by the
// shared helper exactly as the phone truncates it for storage), while the
// service still anchors catalog lookups through its routing copy.

export function favoriteFromService(id, service, arrival, sortOrder, displayName = undefined) {
  if (!boundedString(id, LIMITS.idUtf8Bytes) || !isServiceOption(service)
      || !isJourneyPlace(arrival)
      || !Number.isInteger(sortOrder) || sortOrder < 0) return null;
  const favorite = {
    schemaVersion: SCHEMA_VERSION,
    id,
    serviceId: service.serviceId,
    stopLabel: service.stopLabel,
    lineLabel: service.lineLabel,
    destinationLabel: arrivalLabel(arrival.label),
    lineMode: service.lineMode,
    lineColor: service.lineColor,
    lineTextColor: service.lineTextColor,
    routing: { ...service.routing },
    arrivalPlaceId: arrival.placeId,
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
// Expected shapes (all values non-secret):
//   #<encodeURIComponent(JSON.stringify({ schemaVersion: 2, hasKey, favorites, language }))>
//   #<encodeURIComponent(JSON.stringify({ hasKey, favorites, language }))>   (old phone)
// hasKey is the only credential-related field; the stored key itself is never
// present. A complete v2 envelope with only valid favorites opens an editable
// session. Any older (or unversioned) envelope is decoded for read-only
// display only: it is never hydrated, never converted, and never editable —
// the watch app must be updated. An absent or malformed fragment is likewise
// non-editable; previews always pass a real v2 envelope.

export const MAX_OPENING_FRAGMENT_LENGTH = 32768;
const OPENING_FIELDS = ["schemaVersion", "hasKey", "favorites", "language"];

function emptyOpeningState() {
  return { hasKey: false, language: "en", locale: "en", favorites: [], editable: false };
}

function openingState(hasKey, language, favorites, editable) {
  return {
    hasKey,
    language,
    locale: selectLocale(language),
    favorites,
    editable,
  };
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
  if (typeof parsed.hasKey !== "boolean"
      || !Array.isArray(parsed.favorites)
      || typeof parsed.language !== "string") return emptyOpeningState();
  if (!Object.keys(parsed).every((field) => OPENING_FIELDS.includes(field))) return emptyOpeningState();
  if (parsed.schemaVersion === CONFIGURATION_VERSION) {
    // An invalid v2 favorite never yields an editable subset: the session
    // stays read-only, and only entries that are individually valid are
    // displayed.
    if (!isPhoneFavoriteList(parsed.favorites)) {
      return openingState(
        parsed.hasKey,
        parsed.language,
        parsed.favorites.filter(isPhoneFavorite).map(copyPhoneFavorite),
        false,
      );
    }
    return openingState(
      parsed.hasKey,
      parsed.language,
      parsed.favorites.map(copyPhoneFavorite),
      true,
    );
  }
  if (parsed.schemaVersion === undefined || parsed.schemaVersion === SCHEMA_VERSION) {
    // Old or unversioned phone: read-only favorites display, nothing else.
    return openingState(
      parsed.hasKey,
      parsed.language,
      parsed.favorites.filter(isLegacyFavorite).map(copyPhoneFavorite),
      false,
    );
  }
  return emptyOpeningState();
}

// --- State -------------------------------------------------------------------

export const EMPTY_KEY_DRAFT = { value: "", removeRequested: false };

export function initialConfigState(query) {
  return {
    hasKey: query.hasKey,
    keyDraft: { ...EMPTY_KEY_DRAFT },
    favorites: query.favorites,
    forceFullSync: false,
    // Fail closed: only an explicitly editable session (a complete v2
    // opening) may mutate anything or save.
    editable: query.editable === true,
  };
}

// Last intent wins: typing a non-empty draft cancels a pending removal, and
// requesting removal clears the draft. Favorite edits renumber sortOrder over
// the whole list so display order stays dense and atomic. A read-only session
// (legacy, unversioned, malformed opening, or any invalid v2 favorite) stays
// inert regardless of what the DOM enables.

export function reduceConfigState(state, action) {
  switch (action.type) {
    case "key-draft": {
      if (state.editable !== true) return state;
      const value = typeof action.value === "string" ? action.value : "";
      const removeRequested = value.length > 0 ? false : state.keyDraft.removeRequested;
      return { ...state, keyDraft: { value, removeRequested } };
    }
    case "key-remove-requested":
      if (state.editable !== true) return state;
      if (!state.hasKey) return state;
      return { ...state, keyDraft: { value: "", removeRequested: true } };
    case "key-remove-cancelled":
      if (state.editable !== true) return state;
      return { ...state, keyDraft: { ...state.keyDraft, removeRequested: false } };
    case "favorite-add": {
      if (state.editable !== true) return state;
      if (state.favorites.length >= LIMITS.favorites || !isPhoneFavorite(action.favorite)
          || state.favorites.some((favorite) => favorite.id === action.favorite.id)) return state;
      const candidate = renumber([...state.favorites, { ...action.favorite }]);
      // A favorite whose routing would overflow the one-shot close bound is
      // rejected whole: neither the list nor the session is disturbed.
      if (!favoritesFitCloseBound(candidate)) return state;
      return { ...state, favorites: candidate };
    }
    case "favorite-rename": {
      if (state.editable !== true) return state;
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
      if (state.editable !== true) return state;
      if (!state.favorites.some((favorite) => favorite.id === action.id)) return state;
      return {
        ...state,
        favorites: renumber(state.favorites.filter((favorite) => favorite.id !== action.id)),
      };
    }
    case "favorite-move": {
      if (state.editable !== true) return state;
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
      // Catalog recovery: a known serviceId fills only what is unresolved —
      // missing routing, and an arrival still null. Presentation (labels,
      // colors, custom name), order, identity, and every resolved value stay
      // exactly as stored; unknown, mismatched, or bound-overflowing
      // hydration never deletes or reorders the stored favorite. A hydrate
      // that changes nothing keeps the state identity stable.
      if (state.editable !== true) return state;
      if (!isPhoneFavorite(action.favorite) || action.favorite.id !== action.id) return state;
      const index = state.favorites.findIndex((favorite) => favorite.id === action.id);
      if (index < 0) return state;
      const current = state.favorites[index];
      if (action.favorite.serviceId !== current.serviceId) return state;
      const merged = copyPhoneFavorite(current);
      let changed = false;
      if (!Object.hasOwn(current, "routing") && Object.hasOwn(action.favorite, "routing")) {
        merged.routing = { ...action.favorite.routing };
        changed = true;
      }
      if (current.arrivalPlaceId === null && action.favorite.arrivalPlaceId !== null) {
        merged.arrivalPlaceId = action.favorite.arrivalPlaceId;
        changed = true;
      }
      if (!changed) return state;
      const candidates = state.favorites.slice();
      candidates[index] = merged;
      const candidate = renumber(candidates);
      if (!favoritesFitCloseBound(candidate)) return state;
      return { ...state, favorites: candidate };
    }
    case "force-full-sync":
      if (state.editable !== true) return state;
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
// silently truncated). A read-only session is refused here too, independent
// of the DOM: legacy, malformed, or invalid-favorite openings can never save.

export function planConfigResult(state) {
  if (state.editable !== true) return { ok: false, error: "configurationUpgradeRequired" };
  const apiKeyUpdate = planApiKeyUpdate(state.hasKey, state.keyDraft);
  if (apiKeyUpdate.action === "REPLACE") {
    const error = apiKeyError(apiKeyUpdate.value);
    if (error !== null) return { ok: false, error };
  }
  if (Array.isArray(state.favorites) && state.favorites.length > LIMITS.favorites) {
    return { ok: false, error: "favoriteLimit" };
  }
  if (!isPhoneFavoriteList(state.favorites)) {
    return { ok: false, error: "configurationUpgradeRequired" };
  }
  const payload = {
    schemaVersion: CONFIGURATION_VERSION,
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
    arrivalPlaceId: favorite.arrivalPlaceId,
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
// refuses a second send. The envelope itself is CONFIGURATION_VERSION 2 —
// an old phone rejects it whole rather than misreading a journey payload —
// while the nested favorites and ApiKeyUpdate keep SCHEMA_VERSION 1.

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
    schemaVersion: CONFIGURATION_VERSION,
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
