import {
  LIMITS,
  apiKeyError,
  copyFor,
  createCloseSession,
  favoriteFromService,
  initialConfigState,
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
  "page-title", "intro", "key-title", "key-status", "key-explanation", "key-link", "key-label",
  "key-input", "key-toggle", "key-error", "key-pending", "key-remove", "favorites-title",
  "favorites-empty", "favorites-list", "add-title", "search-label", "place-search", "search-hint",
  "catalog-status", "place-results", "service-step", "services-label", "service-select", "preview",
  "preview-title", "preview-line", "preview-stop", "preview-destination", "preview-departures",
  "favorite-name-label", "favorite-name", "favorite-add", "add-section", "save", "config-view",
  "config-footer", "about-open", "about-view", "about-back", "about-title", "about-en", "about-fr",
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

function fallbackLineBadge(service) {
  const namespace = "http://www.w3.org/2000/svg";
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
    ["pageTitle", elements.page_title], ["intro", elements.intro], ["keyTitle", elements.key_title],
    ["keyExplanation", elements.key_explanation], ["keyLink", elements.key_link],
    ["keyLabel", elements.key_label], ["favoritesTitle", elements.favorites_title],
    ["favoritesEmpty", elements.favorites_empty], ["favoriteAddTitle", elements.add_title],
    ["searchLabel", elements.search_label], ["searchHint", elements.search_hint],
    ["servicesLabel", elements.services_label], ["previewTitle", elements.preview_title],
    ["favoriteNameLabel", elements.favorite_name_label], ["favoriteAdd", elements.favorite_add],
    ["save", elements.save], ["aboutOpen", elements.about_open], ["aboutBack", elements.about_back],
    ["aboutTitle", elements.about_title],
  ]) setText(element, copy[key]);
  elements.key_input.placeholder = copy.keyPlaceholder;
  elements.place_search.placeholder = copy.searchPlaceholder;
  elements.favorite_name.placeholder = copy.favoriteNamePlaceholder;
  elements.about_en.hidden = opening.locale !== "en";
  elements.about_fr.hidden = opening.locale !== "fr";
}

function renderKey() {
  setText(elements.key_status, state.hasKey ? copy.keyStatusConfigured : copy.keyStatusMissing);
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

function renderFavorites() {
  elements.favorites_list.replaceChildren();
  elements.favorites_empty.hidden = state.favorites.length > 0;
  elements.add_section.hidden = state.favorites.length >= LIMITS.favorites;
  if (state.favorites.length >= LIMITS.favorites) setText(elements.catalog_status, copy.favoriteLimit);
  else if (elements.catalog_status.textContent === copy.favoriteLimit) setText(elements.catalog_status, "");

  state.favorites.forEach((favorite, index) => {
    const item = document.createElement("li");
    item.className = "favorite";
    const route = document.createElement("span");
    renderLineBadge(route, favorite);
    const labels = document.createElement("div");
    labels.className = "favorite-labels";
    const stop = document.createElement("strong");
    stop.textContent = favorite.stopLabel;
    const destination = document.createElement("span");
    destination.textContent = favorite.destinationLabel;
    labels.append(stop, destination);

    const renameLabel = document.createElement("label");
    renameLabel.className = "visually-hidden";
    const renameId = `favorite-name-${index}`;
    renameLabel.htmlFor = renameId;
    renameLabel.textContent = copy.favoriteRename;
    const rename = document.createElement("input");
    rename.id = renameId;
    rename.type = "text";
    rename.autocomplete = "off";
    rename.maxLength = LIMITS.labelUtf8Bytes;
    rename.value = favorite.displayName ?? "";
    rename.placeholder = copy.favoriteNamePlaceholder;
    rename.addEventListener("change", () => {
      if (utf8Bytes(rename.value.trim()) <= LIMITS.labelUtf8Bytes) {
        dispatch({ type: "favorite-rename", id: favorite.id, displayName: rename.value });
      } else {
        rename.value = favorite.displayName ?? "";
      }
    });


    const actions = document.createElement("div");
    actions.className = "favorite-actions";
    actions.append(
      actionButton(copy.favoriteMoveUp, index === 0, () => dispatch({ type: "favorite-move", id: favorite.id, delta: -1 })),
      actionButton(copy.favoriteMoveDown, index === state.favorites.length - 1, () => dispatch({ type: "favorite-move", id: favorite.id, delta: 1 })),
      actionButton(copy.favoriteRemove, false, () => dispatch({ type: "favorite-remove", id: favorite.id }), "quiet danger"),
    );
    item.append(route, labels, renameLabel, rename, actions);
    elements.favorites_list.append(item);
  });
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
    const label = place.localityLabel
      ? `${place.stopLabel} — ${place.localityLabel} · ${place.mode}`
      : `${place.stopLabel} · ${place.mode}`;
    item.append(actionButton(label, false, () => selectPlace(place), "choice"));
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
    setText(elements.catalog_status, "");
    elements.service_select.focus();
  } catch (error) {
    if (controller.signal.aborted) return;
    serviceController = null;
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
    setText(elements.catalog_status, places.length === 0 ? copy.searchNoResults : "");
  } catch (error) {
    if (error?.name === "AbortError" || generation !== searchGeneration) return;
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

elements.save.addEventListener("click", () => {
  const keyError = apiKeyError(state.keyDraft.value);
  if (keyError !== null) {
    setText(elements.key_error, copy[keyError]);
    elements.key_error.hidden = false;
    elements.key_input.focus();
    return;
  }
  const outcome = planConfigResult(state);
  if (!outcome.ok) return;
  const closeUrl = closeSession.close(outcome.payload);
  if (closeUrl === null) return;
  elements.save.disabled = true;
  window.location.assign(closeUrl);
});

applyCopy();
renderKey();
renderFavorites();
setText(elements.catalog_status, "");
document.documentElement.classList.add("ready");
