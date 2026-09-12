import {
  LIMITS,
  apiKeyError,
  closePayloadFits,
  copyFor,
  copyPhoneFavorite,
  createCloseSession,
  favoriteFromService,
  initialConfigState,
  isServiceRouting,
  parseConfigFragment,
  planConfigResult,
  reduceConfigState,
  utf8Bytes,
} from "./config-core.js";
import { CatalogClientError, createCatalogClient } from "./catalog-client.js";
import { RECORDED_PREVIEW } from "./preview-fixture.js";
import { lineBadgeAssetUrl } from "./line-badge-assets.js";

function byId(id) {
  return document.getElementById(id);
}

const elements = Object.fromEntries([
  "page-title", "intro", "prim-section", "key-title", "key-status", "key-required", "key-explanation",
  "key-link", "key-docs-link", "key-required-hint", "key-label", "key-input", "key-toggle", "key-error",
  "key-pending", "key-remove", "favorites-section", "favorites-title", "favorites-count", "favorites-status", "favorites-empty",
  "favorites-list", "add-title", "search-label", "place-search", "search-hint", "catalog-status",
  "place-results", "service-step", "services-label", "service-select", "preview", "preview-title",
  "preview-line", "preview-stop", "preview-destination", "preview-departures", "favorite-name-label",
  "favorite-name", "favorite-add", "add-section", "save", "config-view", "sync-section", "sync-title", "sync-hint",
  "force-sync-label", "force-sync", "config-footer", "about-open", "about-view", "about-back",
  "about-title", "about-en", "about-fr",
  "add-caption", "sync-caption",
].map((id) => [id.replaceAll("-", "_"), byId(id)]));

const opening = parseConfigFragment(window.location.hash);
const copy = copyFor(opening.language);
const catalog = createCatalogClient();
const closeSession = createCloseSession();
let state = initialConfigState(opening);
let places = [];
let services = [];
let selectedPlace = null;
let selectedService = null;
let serviceController = null;
let searchGeneration = 0;
let idSequence = 0;
let keyRevealed = false;

let aboutReturnFocus = elements.about_open;
function setText(element, value) {
  if (element.textContent !== value) element.textContent = value;
}

const NEUTRAL_LINE_BACKGROUND = "#52616f";
const NEUTRAL_LINE_TEXT = "#ffffff";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const ICON_MOVE_UP = "M6 14l6-6 6 6";
const ICON_MOVE_DOWN = "M6 10l6 6 6-6";
const ICON_REMOVE = "M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M10 11v6M14 11v6";

function fallbackLineBadge(service) {
  const namespace = SVG_NAMESPACE;
  const width = Math.max(40, 18 + (Array.from(service.lineLabel).length * 12));
  const backgroundColor = service.lineColor ?? NEUTRAL_LINE_BACKGROUND;
  const textColor = service.lineTextColor ?? NEUTRAL_LINE_TEXT;
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} 40`);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", service.lineLabel);
  svg.setAttribute("focusable", "false");
  const title = document.createElementNS(namespace, "title");
  title.textContent = service.lineLabel;
  const background = document.createElementNS(namespace, "rect");
  background.setAttribute("width", String(width));
  background.setAttribute("height", "40");
  background.setAttribute("rx", "6");
  background.setAttribute("fill", backgroundColor);
  const label = document.createElementNS(namespace, "text");
  label.setAttribute("x", String(width / 2));
  label.setAttribute("y", "21");
  label.setAttribute("text-anchor", "middle");
  label.setAttribute("dominant-baseline", "middle");
  label.setAttribute("fill", textColor);
  label.setAttribute("font-family", "system-ui, sans-serif");
  label.setAttribute("font-size", "18");
  label.setAttribute("font-weight", "800");
  label.textContent = service.lineLabel;
  svg.append(title, background, label);
  return svg;
}

function renderLineBadge(container, service) {
  container.className = "line-badge";
  const assetUrl = service.lineMode === undefined
    ? undefined
    : lineBadgeAssetUrl(service.lineMode, service.lineLabel);
  if (assetUrl === undefined) {
    container.replaceChildren(fallbackLineBadge(service));
    return;
  }
  const image = document.createElement("img");
  image.alt = service.lineLabel;
  image.src = assetUrl;
  image.addEventListener("error", () => {
    if (image.parentNode === container) container.replaceChildren(fallbackLineBadge(service));
  }, { once: true });
  container.replaceChildren(image);
}

function dispatch(action) {
  state = reduceConfigState(state, action);
  renderKey();
  renderFavorites();
}

function applyCopy() {
  document.title = copy.pageTitle;
  document.documentElement.lang = opening.locale;
  for (const [key, element] of [
    ["pageHeading", elements.page_title], ["intro", elements.intro], ["keyTitle", elements.key_title],
    ["keyExplanation", elements.key_explanation], ["keyLink", elements.key_link],
    ["keyDocsLink", elements.key_docs_link], ["keyRequirement", elements.key_required],
    ["keyRequiredHint", elements.key_required_hint],
    ["keyLabel", elements.key_label], ["favoritesTitle", elements.favorites_title],
    ["favoritesEmpty", elements.favorites_empty], ["favoriteAddTitle", elements.add_title],
    ["favoriteAddCaption", elements.add_caption],
    ["searchLabel", elements.search_label], ["searchHint", elements.search_hint],
    ["servicesLabel", elements.services_label], ["previewTitle", elements.preview_title],
    ["favoriteNameLabel", elements.favorite_name_label], ["favoriteAdd", elements.favorite_add],
    ["save", elements.save], ["aboutOpen", elements.about_open], ["aboutBack", elements.about_back],
    ["aboutTitle", elements.about_title],
    ["syncTitle", elements.sync_title], ["syncHint", elements.sync_hint],
    ["syncCaption", elements.sync_caption],
    ["forceSyncLabel", elements.force_sync_label],
  ]) setText(element, copy[key]);
  elements.key_input.placeholder = copy.keyPlaceholder;
  elements.place_search.placeholder = copy.searchPlaceholder;
  elements.favorite_name.placeholder = copy.favoriteNamePlaceholder;
  elements.about_en.hidden = opening.locale !== "en";
  elements.about_fr.hidden = opening.locale !== "fr";
}

function renderKey() {
  setText(elements.key_status, state.hasKey ? copy.keyStatusConfigured : copy.keyStatusMissing);
  elements.key_required.hidden = state.hasKey;
  elements.key_required_hint.hidden = state.hasKey;
  const removing = state.keyDraft.removeRequested;
  const replacing = state.keyDraft.value.length > 0;
  elements.key_pending.hidden = !removing && !replacing;
  if (removing) setText(elements.key_pending, copy.keyRemovePending);
  else if (replacing) setText(elements.key_pending, copy.keyReplacementPending);
  elements.key_remove.hidden = !state.hasKey;
  setText(elements.key_remove, removing ? copy.keyUndoRemove : copy.keyRemove);
  setText(elements.key_toggle, keyRevealed ? copy.keyHide : copy.keyShow);
}

function actionButton(label, disabled, action, className = "quiet") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", action);
  return button;
}

function iconButton(label, disabled, pathDefinition, action, extraClass = "") {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `icon-button quiet${extraClass.length > 0 ? ` ${extraClass}` : ""}`;
  button.disabled = disabled;
  button.setAttribute("aria-label", label);
  const icon = document.createElementNS(SVG_NAMESPACE, "svg");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const glyph = document.createElementNS(SVG_NAMESPACE, "path");
  glyph.setAttribute("d", pathDefinition);
  glyph.setAttribute("fill", "none");
  glyph.setAttribute("stroke", "currentColor");
  glyph.setAttribute("stroke-width", "2");
  glyph.setAttribute("stroke-linecap", "round");
  glyph.setAttribute("stroke-linejoin", "round");
  icon.append(glyph);
  button.append(icon);
  button.addEventListener("click", action);
  return button;
}

// A collapsed section must never swallow a validation error: opening the
// section before writing the message or moving focus keeps the failure
// visible instead of targeting a display:none element.
function revealSection(section) {
  if (section instanceof HTMLDetailsElement) section.open = true;
}

// Keyboard move/remove rebuilds the whole list; the activation request lets
// renderFavorites put focus back on the affected favorite's same control
// instead of dropping it to <body>.
let pendingFavoriteFocus = null;

function favoriteFocusTarget(request) {
  if (state.favorites.length === 0) {
    // The natural next step after the last removal is searching for a new
    // favorite; the Add section may be collapsed, so reveal it first.
    revealSection(elements.add_section);
    return elements.place_search;
  }
  let index = state.favorites.findIndex((favorite) => favorite.id === request.id);
  if (index < 0) index = Math.min(request.index, state.favorites.length - 1);
  if (index < 0) return null;
  const row = elements.favorites_list.children[index];
  if (row === undefined) return null;
  const control = row.querySelector(`[data-favorite-action="${request.action}"]`);
  if (control !== null && !control.disabled) return control;
  return row.querySelector("input");
}

function renderFavorites() {
  elements.favorites_list.replaceChildren();
  elements.favorites_empty.hidden = state.favorites.length > 0;
  const atLimit = state.favorites.length >= LIMITS.favorites;
  elements.add_section.hidden = atLimit;
  elements.favorites_status.hidden = !atLimit;
  if (atLimit) setText(elements.favorites_status, copy.favoriteLimit);
  const used = state.favorites.length;
  const available = LIMITS.favorites - used;
  setText(elements.favorites_count,
    `${used} ${used === 1 ? copy.favoriteUsed : copy.favoritesUsed} · ${available} ${available === 1 ? copy.favoriteAvailable : copy.favoritesAvailable}`);

  state.favorites.forEach((favorite, index) => {
    const item = document.createElement("li");
    item.className = "favorite";
    const route = document.createElement("span");
    renderLineBadge(route, favorite);
    const labels = document.createElement("div");
    labels.className = "favorite-labels";
    const journey = document.createElement("div");
    journey.className = "route-journey";
    const stop = document.createElement("strong");
    stop.className = "route-stop";
    stop.textContent = favorite.stopLabel;
    const destination = document.createElement("span");
    destination.className = "route-destination";
    destination.textContent = favorite.destinationLabel;
    journey.append(stop, destination);
    labels.append(journey);
    if (!Object.hasOwn(favorite, "routing")) {
      const unresolved = document.createElement("span");
      unresolved.className = "unresolved";
      unresolved.textContent = copy.favoriteUnresolved;
      labels.append(unresolved);
    }
    const routeRow = document.createElement("div");
    routeRow.className = "favorite-route";
    routeRow.append(route, labels);

    const renameLabel = document.createElement("label");
    renameLabel.className = "visually-hidden";
    const renameId = `favorite-name-${index}`;
    renameLabel.htmlFor = renameId;
    renameLabel.textContent = copy.favoriteRename;
    const rename = document.createElement("input");
    rename.id = renameId;
    rename.className = "favorite-name";
    rename.type = "text";
    rename.autocomplete = "off";
    rename.maxLength = LIMITS.labelUtf8Bytes;
    rename.value = favorite.displayName ?? "";
    rename.placeholder = copy.favoriteNamePlaceholder;
    rename.addEventListener("change", () => {
      if (utf8Bytes(rename.value.trim()) <= LIMITS.labelUtf8Bytes) {
        // A rename changes no row besides the one being edited, so commit
        // into state without the rebuild: rebuilding here would drop
        // keyboard focus to body after the change and replace the icon
        // button under a just-pressed pointer.
        state = reduceConfigState(state, { type: "favorite-rename", id: favorite.id, displayName: rename.value });
      }
      // Reconcile the field with committed state rather than the
      // render-time capture: valid edits trim (and renames make the capture
      // stale), while oversized or control-bearing values are rejected by
      // the reducer and must revert to what is actually stored.
      const current = state.favorites.find((entry) => entry.id === favorite.id);
      rename.value = current?.displayName ?? "";
    });

    // Compact editing strip: reorder and remove sit beside the name field as
    // icon buttons; the localized action names double as accessible names.
    // Each control is tagged so focus can follow the affected row after the
    // rebuild that a move or removal triggers.
    const actions = document.createElement("div");
    actions.className = "favorite-actions";
    const moveUpControl = iconButton(copy.favoriteMoveUp, index === 0, ICON_MOVE_UP,
      () => {
        pendingFavoriteFocus = { id: favorite.id, index, action: "move-up" };
        dispatch({ type: "favorite-move", id: favorite.id, delta: -1 });
      });
    const moveDownControl = iconButton(copy.favoriteMoveDown, index === state.favorites.length - 1, ICON_MOVE_DOWN,
      () => {
        pendingFavoriteFocus = { id: favorite.id, index, action: "move-down" };
        dispatch({ type: "favorite-move", id: favorite.id, delta: 1 });
      });
    const removeControl = iconButton(copy.favoriteRemove, false, ICON_REMOVE,
      () => {
        pendingFavoriteFocus = { id: favorite.id, index, action: "remove" };
        dispatch({ type: "favorite-remove", id: favorite.id });
      }, "danger");
    moveUpControl.dataset.favoriteAction = "move-up";
    moveDownControl.dataset.favoriteAction = "move-down";
    removeControl.dataset.favoriteAction = "remove";
    actions.append(moveUpControl, moveDownControl, removeControl);
    const edit = document.createElement("div");
    edit.className = "favorite-edit";
    edit.append(renameLabel, rename, actions);
    item.append(routeRow, edit);
    elements.favorites_list.append(item);
  });

  if (pendingFavoriteFocus !== null) {
    const request = pendingFavoriteFocus;
    pendingFavoriteFocus = null;
    const target = favoriteFocusTarget(request);
    if (target !== null) target.focus();
  }
}

function clearServiceSelection() {
  if (serviceController !== null) serviceController.abort();
  serviceController = null;
  services = [];
  selectedPlace = null;
  selectedService = null;
  elements.service_step.hidden = true;
  elements.preview.hidden = true;
  elements.service_select.replaceChildren();
}

function renderPlaces() {
  elements.place_results.replaceChildren();
  for (const place of places) {
    const item = document.createElement("li");
    const button = actionButton("", false, () => selectPlace(place), "choice");
    const labels = document.createElement("span");
    labels.className = "choice-labels";
    const stop = document.createElement("strong");
    stop.textContent = place.stopLabel;
    const context = document.createElement("span");
    context.className = "choice-context";
    context.textContent = place.localityLabel ? `${place.localityLabel} · ${place.mode}` : place.mode;
    const lines = document.createElement("span");
    lines.className = "choice-lines";
    for (const line of place.lines) {
      // Search rows reuse the exact favorite/preview badge renderers: the
      // enclosing place mode selects the official pictogram, and lines
      // without one (BUS and unlisted labels) fall back to official colors.
      const badge = document.createElement("span");
      renderLineBadge(badge, { ...line, lineMode: place.mode });
      lines.append(badge);
    }
    labels.append(stop, context, lines);
    button.append(labels);
    item.append(button);
    elements.place_results.append(item);
  }
}

async function selectPlace(place) {
  clearServiceSelection();
  selectedPlace = place;
  serviceController = new AbortController();
  const controller = serviceController;
  setText(elements.catalog_status, copy.servicesLoading);
  try {
    services = await catalog.listServices(place.placeId, controller.signal);
    if (controller.signal.aborted) return;
    serviceController = null;
    if (services.length === 0) {
      revealSection(elements.add_section);
      setText(elements.catalog_status, copy.servicesEmpty);
      return;
    }
    elements.service_select.replaceChildren();
    const prompt = document.createElement("option");
    prompt.value = "";
    prompt.textContent = copy.servicesLabel;
    elements.service_select.append(prompt);
    services.forEach((service, index) => {
      const option = document.createElement("option");
      option.value = String(index);
      option.textContent = `${service.lineLabel} · ${service.destinationLabel}`;
      elements.service_select.append(option);
    });
    elements.service_step.hidden = false;
    revealSection(elements.add_section);
    setText(elements.catalog_status, "");
    elements.service_select.focus();
  } catch (error) {
    if (controller.signal.aborted) return;
    serviceController = null;
    revealSection(elements.add_section);
    setText(elements.catalog_status, error instanceof CatalogClientError && error.code === "INVALID_SERVICE"
      ? copy.invalidService
      : copy.backendUnavailable);
  }
}

function renderPreview() {
  elements.preview.hidden = selectedService === null;
  if (selectedService === null) return;
  renderLineBadge(elements.preview_line, selectedService);
  setText(elements.preview_stop, selectedService.stopLabel);
  setText(elements.preview_destination, selectedService.destinationLabel);
  setText(
    elements.preview_departures,
    `${copy.previewRecorded}: ${RECORDED_PREVIEW.map((entry) => `${entry.minutes} ${copy.minutesShort}`).join(" · ")}`,
  );
}

function nextFavoriteId() {
  let candidate;
  do {
    idSequence += 1;
    candidate = `cfg-${Date.now().toString(36)}-${idSequence.toString(36)}`;
  } while (state.favorites.some((favorite) => favorite.id === candidate));
  return candidate;
}

// Routing recovery: favorites stored without routing keep their place
// and labels; a known serviceId gains routing via an exact catalog lookup. An
// absent ID keeps the favorite untouched — the visible marker asks for an
// explicit re-selection, never an automatic delete.
const hydrationController = new AbortController();

async function hydrateUnresolvedFavorites() {
  const unresolved = state.favorites.filter((favorite) => !Object.hasOwn(favorite, "routing"));
  await Promise.all(unresolved.map(async (unresolvedFavorite) => {
    let service;
    try {
      service = await catalog.lookupService(unresolvedFavorite.serviceId, hydrationController.signal);
    } catch {
      return;
    }
    if (service === null) return;
    const current = state.favorites.find((favorite) => favorite.id === unresolvedFavorite.id);
    if (current === undefined || Object.hasOwn(current, "routing")) return;
    // Routing-only recovery: the stored favorite is kept verbatim — labels,
    // colors, service binding and the watch metadata hash — and only the
    // validated routing from the exact lookup is attached.
    if (!isServiceRouting(service.routing)) return;
    const hydrated = copyPhoneFavorite(current);
    hydrated.routing = { ...service.routing };
    dispatch({ type: "favorite-hydrate", id: current.id, favorite: hydrated });
  }));
}

elements.key_input.addEventListener("input", () => {
  elements.key_error.hidden = true;
  dispatch({ type: "key-draft", value: elements.key_input.value });
});

elements.key_toggle.addEventListener("click", () => {
  keyRevealed = !keyRevealed;
  elements.key_input.type = keyRevealed ? "text" : "password";
  elements.key_toggle.setAttribute("aria-pressed", String(keyRevealed));
  renderKey();
  elements.key_input.focus();
});

elements.key_remove.addEventListener("click", () => {
  elements.key_input.value = "";
  dispatch(state.keyDraft.removeRequested
    ? { type: "key-remove-cancelled" }
    : { type: "key-remove-requested" });
});

elements.place_search.addEventListener("input", async () => {
  const generation = ++searchGeneration;
  clearServiceSelection();
  places = [];
  renderPlaces();
  const query = elements.place_search.value.trim();
  const length = Array.from(query).length;
  if (length < LIMITS.catalogQueryMinCharacters) {
    catalog.cancelSearch();
    setText(elements.catalog_status, "");
    return;
  }
  setText(elements.catalog_status, copy.searchLoading);
  try {
    const result = await catalog.searchPlaces(query);
    if (generation !== searchGeneration) return;
    places = result;
    renderPlaces();
    if (places.length === 0) {
      revealSection(elements.add_section);
      setText(elements.catalog_status, copy.searchNoResults);
    } else {
      setText(elements.catalog_status, "");
    }
  } catch (error) {
    if (error?.name === "AbortError" || generation !== searchGeneration) return;
    revealSection(elements.add_section);
    setText(elements.catalog_status, error instanceof CatalogClientError && error.code === "INVALID_QUERY"
      ? copy.searchHint
      : copy.backendUnavailable);
  }
});

elements.service_select.addEventListener("change", () => {
  const index = Number(elements.service_select.value);
  selectedService = Number.isInteger(index) && index >= 0 ? services[index] ?? null : null;
  renderPreview();
});

elements.favorite_add.addEventListener("click", () => {
  if (selectedPlace === null || selectedService === null || !services.includes(selectedService)) {
    setText(elements.catalog_status, copy.invalidService);
    return;
  }
  const name = elements.favorite_name.value.trim();
  if (name.length > 0 && utf8Bytes(name) > LIMITS.labelUtf8Bytes) {
    setText(elements.catalog_status, copy.invalidService);
    return;
  }
  const favorite = favoriteFromService(nextFavoriteId(), selectedService, state.favorites.length, name || undefined);
  if (favorite === null) {
    setText(elements.catalog_status, copy.invalidService);
    return;
  }
  dispatch({ type: "favorite-add", favorite });
  elements.favorite_name.value = "";
  elements.place_search.value = "";
  places = [];
  renderPlaces();
  clearServiceSelection();
  setText(elements.catalog_status, "");
});

elements.about_open.addEventListener("click", () => {
  aboutReturnFocus = document.activeElement instanceof HTMLElement
    ? document.activeElement
    : elements.about_open;
  elements.config_view.hidden = true;
  elements.config_footer.hidden = true;
  elements.about_view.hidden = false;
  elements.about_back.focus();
});

elements.about_back.addEventListener("click", () => {
  elements.about_view.hidden = true;
  elements.config_view.hidden = false;
  elements.config_footer.hidden = false;
  aboutReturnFocus.focus();
});

elements.force_sync.addEventListener("change", () => {
  dispatch({ type: "force-full-sync", value: elements.force_sync.checked });
});

elements.save.addEventListener("click", () => {
  const keyError = apiKeyError(state.keyDraft.value);
  if (keyError !== null) {
    revealSection(elements.prim_section);
    setText(elements.key_error, copy[keyError]);
    elements.key_error.hidden = false;
    elements.key_input.focus();
    return;
  }
  const outcome = planConfigResult(state);
  if (!outcome.ok) {
    // At the favorite limit the add section carries the hidden attribute,
    // so save failures surface in the favorites list section instead: it is
    // visible in exactly the states where these failures occur.
    revealSection(elements.favorites_section);
    elements.favorites_status.hidden = false;
    setText(elements.favorites_status, copy[outcome.error]);
    elements.favorites_status.scrollIntoView({ block: "nearest" });
    return;
  }
  if (!closePayloadFits(outcome.payload)) {
    revealSection(elements.favorites_section);
    elements.favorites_status.hidden = false;
    setText(elements.favorites_status, copy.saveTooLarge);
    elements.favorites_status.scrollIntoView({ block: "nearest" });
    return;
  }
  const closeUrl = closeSession.close(outcome.payload);
  if (closeUrl === null) return;
  elements.save.disabled = true;
  window.location.assign(closeUrl);
});

// Section open/closed state is the only local persistence on this page:
// four booleans under one namespaced key, keyed by the stable section IDs.
// The key draft, favorites, and catalog data never reach storage, and
// unavailable or corrupt storage (private mode, blocked cookies, cleared
// origins) leaves the markup defaults in place and the page functional.
const SECTION_STORAGE_KEY = "lapin-fute:config-sections:v1";
const sectionElements = [
  elements.prim_section,
  elements.favorites_section,
  elements.add_section,
  elements.sync_section,
];

function readStoredSectionStates() {
  try {
    const raw = window.localStorage.getItem(SECTION_STORAGE_KEY);
    if (raw === null) return null;
    const saved = JSON.parse(raw);
    if (saved === null || typeof saved !== "object") return null;
    return sectionElements
      .filter((section) => typeof saved[section.id] === "boolean")
      .map((section) => [section, saved[section.id]]);
  } catch {
    return null;
  }
}

function persistSectionStates() {
  try {
    const states = {};
    for (const section of sectionElements) states[section.id] = section.open;
    window.localStorage.setItem(SECTION_STORAGE_KEY, JSON.stringify(states));
  } catch {
    // Persistence is a convenience; toggling must keep working without it.
  }
}

// Restore all sections before registering listeners so queued toggle events
// persist the complete restored state.
const storedSectionStates = readStoredSectionStates();
if (storedSectionStates !== null) {
  for (const [section, open] of storedSectionStates) section.open = open;
}
for (const section of sectionElements) {
  section.addEventListener("toggle", persistSectionStates);
}
// The details toggle event is queued with rendering steps and can be lost
// to an immediate close, so navigating away flushes the live DOM state.
window.addEventListener("pagehide", persistSectionStates);

applyCopy();
renderKey();
renderFavorites();
setText(elements.catalog_status, "");
document.documentElement.classList.add("ready");
hydrateUnresolvedFavorites();
