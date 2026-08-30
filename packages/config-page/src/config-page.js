// DOM wiring for the Lapin Futé configuration page. All state transitions and
// serialization live in config-core.js; this layer only renders and dispatches.
//
// Secret boundary: the personal PRIM key exists only in the masked input's
// value. The page holds no storage of any kind, performs no network requests,
// and never logs; its single navigation is the one-time close fragment, which
// the mobile app intercepts before any HTTP request could exist.
//
// The opening fragment carries only non-secret fields: hasKey, the watch
// language, and the current favorites list. The stored key itself is never
// present in the fragment, the DOM, or this source.

import {
  copyFor,
  createCloseSession,
  initialConfigState,
  parseConfigFragment,
  planConfigResult,
  reduceConfigState,
} from "./config-core.js";

function byId(id) {
  return document.getElementById(id);
}

const elements = {
  pageTitle: byId("page-title"),
  keyTitle: byId("key-title"),
  keyStatus: byId("key-status"),
  keyLabel: byId("key-label"),
  keyInput: byId("key-input"),
  keyToggle: byId("key-toggle"),
  keyError: byId("key-error"),
  keyPending: byId("key-pending"),
  keyRemove: byId("key-remove"),
  favoritesTitle: byId("favorites-title"),
  favoritesEmpty: byId("favorites-empty"),
  favoritesList: byId("favorites-list"),
  save: byId("save"),
};

const query = parseConfigFragment(window.location.hash);
const copy = copyFor(query.language);
let state = initialConfigState(query);
let revealed = false;
const session = createCloseSession();

function setText(element, text) {
  if (element.textContent !== text) {
    element.textContent = text;
  }
}

function dispatch(action) {
  const next = reduceConfigState(state, action);
  if (next !== state) {
    state = next;
  }
  render();
}

function applyStaticCopy() {
  document.title = copy.pageTitle;
  document.documentElement.lang = query.locale;
  setText(elements.pageTitle, copy.pageTitle);
  setText(elements.keyTitle, copy.keyTitle);
  setText(elements.keyLabel, copy.keyLabel);
  elements.keyInput.placeholder = copy.keyPlaceholder;
  setText(elements.keyToggle, copy.keyShow);
  setText(elements.favoritesTitle, copy.favoritesTitle);
  setText(elements.favoritesEmpty, copy.favoritesEmpty);
  setText(elements.save, copy.save);
}

function render() {
  renderKeySection();
  renderFavorites();
}

function renderKeySection() {
  setText(elements.keyStatus, state.hasKey ? copy.keyStatusConfigured : copy.keyStatusMissing);
  const pending = state.keyDraft.removeRequested;
  elements.keyPending.hidden = !pending;
  if (pending) {
    setText(elements.keyPending, copy.keyRemovePending);
  }
  elements.keyRemove.hidden = !state.hasKey;
  setText(elements.keyRemove, pending ? copy.keyUndoRemove : copy.keyRemove);
}

function renderFavorites() {
  elements.favoritesList.replaceChildren();
  elements.favoritesEmpty.hidden = state.favorites.length > 0;
  state.favorites.forEach((favorite, index) => {
    elements.favoritesList.append(favoriteItem(favorite, index));
  });
}

function favoriteItem(favorite, index) {
  const item = document.createElement("li");
  item.className = "favorite";

  const heading = document.createElement("p");
  heading.className = "labels";
  heading.textContent = favorite.displayName ?? favorite.stopLabel;

  const detail = document.createElement("p");
  detail.className = "sub";
  // Authored and transport labels cross every locale verbatim.
  detail.textContent = [favorite.stopLabel, favorite.lineLabel, favorite.destinationLabel].join(" · ");

  const actions = document.createElement("div");
  actions.className = "favorite-actions";
  actions.append(
    listButton(copy.favoriteMoveUp, index === 0, () =>
      dispatch({ type: "favorite-move", id: favorite.id, delta: -1 }),
    ),
    listButton(copy.favoriteMoveDown, index === state.favorites.length - 1, () =>
      dispatch({ type: "favorite-move", id: favorite.id, delta: 1 }),
    ),
    listButton(copy.favoriteRemove, false, () =>
      dispatch({ type: "favorite-remove", id: favorite.id }),
    ),
  );

  item.append(heading, detail, actions);
  return item;
}

function listButton(label, disabled, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  button.addEventListener("click", onClick);
  return button;
}

elements.keyInput.addEventListener("input", () => {
  elements.keyError.hidden = true;
  dispatch({ type: "key-draft", value: elements.keyInput.value });
});

elements.keyToggle.addEventListener("click", () => {
  revealed = !revealed;
  elements.keyInput.type = revealed ? "text" : "password";
  setText(elements.keyToggle, revealed ? copy.keyHide : copy.keyShow);
  elements.keyToggle.setAttribute("aria-pressed", String(revealed));
  elements.keyInput.focus();
});

elements.keyRemove.addEventListener("click", () => {
  dispatch(
    state.keyDraft.removeRequested
      ? { type: "key-remove-cancelled" }
      : { type: "key-remove-requested" },
  );
});

elements.save.addEventListener("click", () => {
  const outcome = planConfigResult(state);
  if (!outcome.ok) {
    elements.keyError.textContent = copy[outcome.error];
    elements.keyError.hidden = false;
    elements.keyInput.focus();
    return;
  }
  const fragment = session.close(outcome.payload);
  if (fragment === null) {
    return;
  }
  elements.save.disabled = true;
  window.location.assign(fragment);
});

applyStaticCopy();
render();
