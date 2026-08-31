import {
  LIMITS,
  isPlaceSearchResult,
  isServiceOptionsResult,
} from "./config-core.js";

export const SEARCH_DEBOUNCE_MS = 300;

export class CatalogClientError extends Error {
  constructor(code) {
    super(code);
    this.name = "CatalogClientError";
    this.code = code;
  }
}

function abortError() {
  return new DOMException("Superseded", "AbortError");
}

async function responseJson(response) {
  if (!response.ok) {
    throw new CatalogClientError(response.status === 404 ? "INVALID_SERVICE" : "BACKEND_UNAVAILABLE");
  }
  try {
    return await response.json();
  } catch {
    throw new CatalogClientError("BACKEND_UNAVAILABLE");
  }
}

export function createCatalogClient({
  fetchImpl = globalThis.fetch,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  let timer = null;
  let searchController = null;

  function cancelSearch() {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (searchController !== null) {
      searchController.abort();
      searchController = null;
    }
  }

  function searchPlaces(query) {
    cancelSearch();
    const normalized = typeof query === "string" ? query.trim() : "";
    if (Array.from(normalized).length < LIMITS.catalogQueryMinCharacters) {
      return Promise.resolve([]);
    }
    if (Array.from(normalized).length > LIMITS.catalogQueryMaxCharacters) {
      return Promise.reject(new CatalogClientError("INVALID_QUERY"));
    }

    const controller = new AbortController();
    searchController = controller;
    return new Promise((resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(abortError()), { once: true });
      timer = setTimer(async () => {
        timer = null;
        if (controller.signal.aborted) return;
        try {
          const response = await fetchImpl(
            `/api/catalog/places?q=${encodeURIComponent(normalized)}`,
            { signal: controller.signal, credentials: "omit", headers: { accept: "application/json" } },
          );
          const body = await responseJson(response);
          if (!isPlaceSearchResult(body)) throw new CatalogClientError("BACKEND_UNAVAILABLE");
          if (!controller.signal.aborted) resolve(body.places);
        } catch (error) {
          if (!controller.signal.aborted) reject(error instanceof CatalogClientError
            ? error
            : new CatalogClientError("BACKEND_UNAVAILABLE"));
        } finally {
          if (searchController === controller) searchController = null;
        }
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  async function listServices(placeId, signal) {
    const response = await fetchImpl(
      `/api/catalog/places/${encodeURIComponent(placeId)}/services`,
      { signal, credentials: "omit", headers: { accept: "application/json" } },
    );
    const body = await responseJson(response);
    if (!isServiceOptionsResult(body, placeId)) throw new CatalogClientError("INVALID_SERVICE");
    return body.services;
  }

  return { cancelSearch, searchPlaces, listServices };
}
