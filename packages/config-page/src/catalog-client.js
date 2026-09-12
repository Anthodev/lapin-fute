import {
  LIMITS,
  SCHEMA_VERSION,
  isPlaceSearchItem,
  isServiceOption,
} from "./config-core.js";
import { catalogSearchBucket, normalizeCatalogSearchText } from "./search-text.js";

export const SEARCH_DEBOUNCE_MS = 300;

const PLACE_ID = /^plc_[A-Za-z0-9_-]{43}$/u;
const SERVICE_ID = /^svc_[A-Za-z0-9_-]{43}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
const MANIFEST_FIELDS = ["schemaVersion", "revision", "sourceRevision", "createdAt", "attribution"];

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

function exactFields(value, fields) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function isManifest(value) {
  return exactFields(value, MANIFEST_FIELDS)
    && value.schemaVersion === SCHEMA_VERSION
    && typeof value.revision === "string" && REVISION.test(value.revision)
    && typeof value.sourceRevision === "string" && value.sourceRevision.trim() !== ""
    && typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
    && Array.isArray(value.attribution) && value.attribution.length > 0
    && value.attribution.every((source) => {
      const fields = ["dataset", "url", "retrievedAt", "license"];
      if (source?.restricted !== undefined) fields.push("restricted");
      return exactFields(source, fields)
        && typeof source.dataset === "string" && /^[a-z0-9-]+$/u.test(source.dataset)
        && source.url === `https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/${source.dataset}`
        && typeof source.license === "string" && source.license.trim() !== ""
        && typeof source.retrievedAt === "string" && Number.isFinite(Date.parse(source.retrievedAt))
        && (source.restricted === undefined || typeof source.restricted === "boolean");
    });
}

function isPage(value, revision, page, field, placeId) {
  const fields = ["schemaVersion", "revision", "page", "nextPage", field];
  if (placeId !== undefined) fields.push("placeId");
  return exactFields(value, fields)
    && value.schemaVersion === SCHEMA_VERSION && value.revision === revision
    && value.page === page && (placeId === undefined || value.placeId === placeId)
    && (value.nextPage === null || (Number.isSafeInteger(value.nextPage) && value.nextPage === page + 1))
    && Array.isArray(value[field]) && (value.nextPage === null || value[field].length > 0);
}

function compareMatches(left, right) {
  if (left.rank !== right.rank) return left.rank - right.rank;
  for (let index = 0; index < left.order.length; index += 1) {
    if (left.order[index] < right.order[index]) return -1;
    if (left.order[index] > right.order[index]) return 1;
  }
  return 0;
}

export function createCatalogClient({
  fetchImpl = globalThis.fetch,
  setTimer = globalThis.setTimeout,
  clearTimer = globalThis.clearTimeout,
} = {}) {
  let timer = null;
  let searchController = null;
  let manifest = null;

  async function json(path, signal, missingCode = "BACKEND_UNAVAILABLE", fresh = false) {
    if (signal?.aborted) throw abortError();
    try {
      const response = await fetchImpl(`catalog/${path}`, {
        signal, credentials: "omit", redirect: "error",
        cache: fresh ? "no-cache" : "force-cache",
        headers: { accept: "application/json" },
      });
      if (signal?.aborted) throw abortError();
      if (response.status === 404 && missingCode === null) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok || response.body === null) {
        await response.body?.cancel();
        throw new CatalogClientError(response.status === 404 ? missingCode : "BACKEND_UNAVAILABLE");
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const parts = [];
      let bytes = 0;
      let finished = false;
      try {
        while (true) {
          const next = await reader.read();
          if (signal?.aborted) throw abortError();
          if (next.done) {
            finished = true;
            break;
          }
          bytes += next.value.byteLength;
          if (bytes > LIMITS.httpResponseBytes) throw new CatalogClientError("BACKEND_UNAVAILABLE");
          parts.push(decoder.decode(next.value, { stream: true }));
        }
        parts.push(decoder.decode());
        return JSON.parse(parts.join(""));
      } finally {
        if (!finished) await reader.cancel();
        reader.releaseLock();
      }
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw abortError();
      throw error instanceof CatalogClientError ? error : new CatalogClientError("BACKEND_UNAVAILABLE");
    }
  }

  async function pinnedManifest(signal) {
    if (signal?.aborted) throw abortError();
    if (manifest !== null) return manifest;
    const body = await json("manifest.json", signal, "BACKEND_UNAVAILABLE", true);
    if (!isManifest(body)) throw new CatalogClientError("BACKEND_UNAVAILABLE");
    if (signal?.aborted) throw abortError();
    // Concurrent first operations use the first successfully loaded revision.
    manifest ??= body;
    return manifest;
  }

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

  async function search(normalized, signal) {
    const pinned = await pinnedManifest(signal);
    const tokens = normalized.split(" ");
    let longest = tokens[0];
    for (const token of tokens) {
      if (Array.from(token).length > Array.from(longest).length) longest = token;
    }
    const bucket = catalogSearchBucket(longest);
    const best = [];
    let page = 0;
    while (true) {
      const body = await json(`${pinned.revision}/search/${bucket}/${page}.json`, signal,
        page === 0 ? null : "BACKEND_UNAVAILABLE");
      if (body === null) return [];
      if (!isPage(body, pinned.revision, page, "places")) throw new CatalogClientError("BACKEND_UNAVAILABLE");
      for (const entry of body.places) {
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new CatalogClientError("BACKEND_UNAVAILABLE");
        const { searchText, ...place } = entry;
        if (!isPlaceSearchItem(place) || !PLACE_ID.test(place.placeId)
          || typeof searchText !== "string" || searchText === ""
          || normalizeCatalogSearchText(searchText) !== searchText) throw new CatalogClientError("BACKEND_UNAVAILABLE");
        const words = searchText.split(" ");
        if (!tokens.every((token) => words.some((word) => word.startsWith(token)))) continue;
        const stop = normalizeCatalogSearchText(place.stopLabel);
        const candidate = {
          place,
          rank: searchText === normalized || stop === normalized ? 0 : searchText.startsWith(normalized) ? 1 : 2,
          order: [stop, normalizeCatalogSearchText(place.localityLabel ?? ""), place.mode, place.placeId],
        };
        const duplicate = best.findIndex((match) => match.place.placeId === place.placeId);
        if (duplicate !== -1) {
          if (compareMatches(candidate, best[duplicate]) >= 0) continue;
          best.splice(duplicate, 1);
        }
        best.push(candidate);
        best.sort(compareMatches);
        if (best.length > LIMITS.catalogSearchResults) best.pop();
      }
      if (signal.aborted) throw abortError();
      if (body.nextPage === null) return best.map((match) => match.place);
      page = body.nextPage;
    }
  }

  function searchPlaces(query) {
    cancelSearch();
    const trimmed = typeof query === "string" ? query.trim() : "";
    const length = Array.from(trimmed).length;
    if (length < LIMITS.catalogQueryMinCharacters) return Promise.resolve([]);
    if (length > LIMITS.catalogQueryMaxCharacters) return Promise.reject(new CatalogClientError("INVALID_QUERY"));
    const normalized = normalizeCatalogSearchText(trimmed);
    if (normalized === "") return Promise.reject(new CatalogClientError("INVALID_QUERY"));
    const controller = new AbortController();
    searchController = controller;
    return new Promise((resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(abortError()), { once: true });
      timer = setTimer(async () => {
        timer = null;
        if (controller.signal.aborted) return;
        try {
          const places = await search(normalized, controller.signal);
          if (!controller.signal.aborted) resolve(places);
        } catch (error) {
          if (!controller.signal.aborted) reject(error);
        } finally {
          if (searchController === controller) searchController = null;
        }
      }, SEARCH_DEBOUNCE_MS);
    });
  }

  async function listServices(placeId, signal) {
    if (typeof placeId !== "string" || !PLACE_ID.test(placeId)) throw new CatalogClientError("INVALID_SERVICE");
    const pinned = await pinnedManifest(signal);
    const services = [];
    const seen = new Set();
    let page = 0;
    while (true) {
      const body = await json(`${pinned.revision}/places/${placeId}/${page}.json`, signal,
        page === 0 ? "INVALID_SERVICE" : "BACKEND_UNAVAILABLE");
      if (!isPage(body, pinned.revision, page, "services", placeId)) throw new CatalogClientError("BACKEND_UNAVAILABLE");
      for (const service of body.services) {
        if (!isServiceOption(service) || !SERVICE_ID.test(service.serviceId) || seen.has(service.serviceId)) {
          throw new CatalogClientError("INVALID_SERVICE");
        }
        seen.add(service.serviceId);
        services.push(service);
      }
      if (signal?.aborted) throw abortError();
      if (body.nextPage === null) return services;
      page = body.nextPage;
    }
  }

  async function lookupService(serviceId, signal) {
    if (typeof serviceId !== "string" || !SERVICE_ID.test(serviceId)) throw new CatalogClientError("INVALID_SERVICE");
    const pinned = await pinnedManifest(signal);
    const body = await json(`${pinned.revision}/services/${serviceId}.json`, signal, null);
    if (body === null) return null;
    if (!exactFields(body, ["schemaVersion", "revision", "service"])
      || body.schemaVersion !== SCHEMA_VERSION || body.revision !== pinned.revision
      || !isServiceOption(body.service) || body.service.serviceId !== serviceId) throw new CatalogClientError("INVALID_SERVICE");
    return body.service;
  }

  return { cancelSearch, searchPlaces, listServices, lookupService };
}
