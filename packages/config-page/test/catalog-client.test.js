import test from "node:test";
import assert from "node:assert/strict";
import { CatalogClientError, SEARCH_DEBOUNCE_MS, createCatalogClient } from "../src/catalog-client.js";
import { LIMITS } from "../../contracts/src/index.ts";
import { normalizeCatalogSearchText } from "../src/search-text.js";

const revision = "a".repeat(64);
const otherRevision = "b".repeat(64);
const manifest = {
  schemaVersion: 1, revision, sourceRevision: "fixture-source", createdAt: "2026-09-05T00:00:00.000Z",
  attribution: [{ dataset: "arrets", url: "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/arrets", retrievedAt: "2026-09-05T00:00:00.000Z", license: "Licence Ouverte 2.0" }],
};

function place(index, stopLabel = "Châtelet", localityLabel = "Paris") {
  return {
    placeId: `plc_${String(index).padStart(43, "0")}`, stopLabel, localityLabel, mode: "BUS",
    lines: [{ lineLabel: "21", lineColor: "#0064b0", lineTextColor: "#ffffff" }],
    searchText: normalizeCatalogSearchText(`${stopLabel} ${localityLabel}`),
  };
}

function service(index, routing = {}) {
  return {
    serviceId: `svc_${String(index).padStart(43, "0")}`, stopLabel: "Châtelet", lineLabel: "42",
    destinationLabel: "Gare du Nord", lineMode: "BUS", lineColor: "#e86a10", lineTextColor: "#ffffff",
    routing: { monitoringRef: "fixture-monitoring", lineRef: "fixture-line", destinationRef: "fixture-terminal", ...routing },
  };
}

function response(body, status = 200) {
  return new Response(body === null ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function fixtureClient(resolve) {
  const requests = [];
  const client = createCatalogClient({
    setTimer(callback) { queueMicrotask(callback); return 1; },
    clearTimer() {},
    async fetchImpl(url, options) {
      requests.push(url);
      assert.equal(options.credentials, "omit");
      assert.equal(new Headers(options.headers).has("Authorization"), false);
      assert.equal(options.redirect, "error");
      return resolve(url, options);
    },
  });
  return { client, requests };
}

function unavailable(error) {
  return error instanceof CatalogClientError && error.code === "BACKEND_UNAVAILABLE";
}

test("static search scans every page, keeps the best twenty and preserves homonyms", async () => {
  const first = Array.from({ length: 24 }, (_, index) => place(index, `Châtelet station ${String(index).padStart(2, "0")}`));
  const exactParis = place(101);
  const exactOther = place(102, "Châtelet", "Saint-Denis");
  const { client, requests } = fixtureClient((url) => {
    if (url === "catalog/manifest.json") return response(manifest);
    if (url.endsWith("/0.json")) return response({ schemaVersion: 1, revision, page: 0, nextPage: 1, places: first });
    return response({ schemaVersion: 1, revision, page: 1, nextPage: null, places: [exactOther, first[0], exactParis, exactParis] });
  });
  const results = await client.searchPlaces("  ChÂtElEt  ");
  assert.equal(results.length, 20);
  assert.deepEqual(results.slice(0, 2).map((entry) => entry.placeId), [exactParis.placeId, exactOther.placeId]);
  assert.equal(new Set(results.map((entry) => entry.placeId)).size, 20);
  assert.equal(results.some((entry) => Object.hasOwn(entry, "searchText")), false);
  assert.deepEqual(requests, ["catalog/manifest.json", `catalog/${revision}/search/63_68/0.json`, `catalog/${revision}/search/63_68/1.json`]);
});

test("search rows carry precomputed lines without extra requests and reject malformed metadata", async () => {
  const enriched = place(1, "Saint-Denis - Université");
  enriched.lines = [
    { lineLabel: "1611", lineColor: "#009645", lineTextColor: "#ffffff" },
    { lineLabel: "253", lineColor: "#6f4fa0", lineTextColor: "#ffffff" },
  ];
  const { client, requests } = fixtureClient((url) => url === "catalog/manifest.json" ? response(manifest)
    : response({ schemaVersion: 1, revision, page: 0, nextPage: null, places: [enriched] }));
  const results = await client.searchPlaces("universite");
  // searchText is stripped; every validated field, the lines included, survives.
  assert.deepEqual(results, [{
    placeId: enriched.placeId, stopLabel: "Saint-Denis - Université", localityLabel: "Paris", mode: "BUS",
    lines: enriched.lines,
  }]);
  // Exactly the manifest and the one search page: no per-result service fetches.
  assert.equal(requests.length, 2);
  assert.match(requests[1], /\/search\/[^/]+\/0\.json$/u);

  const { lines: _omitted, ...withoutLines } = enriched;
  const sparse = { ...enriched, lines: [enriched.lines[0]] };
  sparse.lines.length = 2;
  const malformed = [
    withoutLines,
    { ...enriched, lines: [] },
    { ...enriched, lines: "21" },
    sparse,
    { ...enriched, lines: [{ ...enriched.lines[0], lineRef: "STIF:Line::C01611:" }] },
    { ...enriched, lines: [{ lineLabel: "253", lineColor: "#6f4fa0" }] },
    { ...enriched, lines: [{ ...enriched.lines[0], lineColor: "#6F4FA0" }] },
    { ...enriched, lines: [{ ...enriched.lines[0], lineTextColor: "#fff" }] },
    { ...enriched, lines: [{ ...enriched.lines[0], lineLabel: "" }] },
    { ...enriched, lines: [{ ...enriched.lines[0], lineLabel: "é".repeat(49) }] },
    { ...enriched, lines: [{ ...enriched.lines[0], lineLabel: "1611\n" }] },
  ];
  for (const entry of malformed) {
    const failing = fixtureClient((url) => url === "catalog/manifest.json" ? response(manifest)
      : response({ schemaVersion: 1, revision, page: 0, nextPage: null, places: [entry] }));
    await assert.rejects(failing.client.searchPlaces("universite"), unavailable);
  }
});

test("equally relevant stops put rail modes before tram and bus", async () => {
  const modes = ["BUS", "TRAM", "TRANSILIEN", "RER", "METRO"];
  const entries = modes.map((mode, index) => ({
    ...place(index, "Saint-Denis - Université", "Saint-Denis"),
    mode,
  }));
  const { client } = fixtureClient((url) => url === "catalog/manifest.json" ? response(manifest)
    : response({ schemaVersion: 1, revision, page: 0, nextPage: null, places: entries }));

  const results = await client.searchPlaces("universite saint denis");

  assert.deepEqual(results.map((entry) => entry.mode), ["METRO", "RER", "TRANSILIEN", "TRAM", "BUS"]);
});

test("static search uses AND token prefixes, Unicode normalization and one-codepoint buckets", async () => {
  const match = place(1, "Rue Saint-Denis Châtelet");
  const noChatelet = place(2, "Saint-Denis");
  const { client, requests } = fixtureClient((url) => url === "catalog/manifest.json" ? response(manifest)
    : response({ schemaVersion: 1, revision, page: 0, nextPage: null, places: [match, noChatelet] }));
  assert.deepEqual((await client.searchPlaces("sÂint---CHÂT")).map((entry) => entry.placeId), [match.placeId]);
  assert.equal(requests[1], `catalog/${revision}/search/73_61/0.json`);
  const one = fixtureClient((url) => url === "catalog/manifest.json" ? response(manifest)
    : response({ schemaVersion: 1, revision, page: 0, nextPage: null, places: [place(3, "𐐨lpha")] }));
  assert.deepEqual((await one.client.searchPlaces("𐐨.")).map((entry) => entry.stopLabel), ["𐐨lpha"]);
  assert.equal(one.requests[1], `catalog/${revision}/search/10428/0.json`);
  await assert.rejects(client.searchPlaces("--"), (error) => error.code === "INVALID_QUERY");
});

test("search ignores French join words absent from an official stop label", async () => {
  const mairie = place(1, "Mairie / Pelletier", "Stains");
  mairie.lines = [
    { lineLabel: "252", lineColor: "#ff0000", lineTextColor: "#000000" },
    { lineLabel: "253", lineColor: "#ffbe00", lineTextColor: "#000000" },
    { lineLabel: "255", lineColor: "#6e6e00", lineTextColor: "#ffffff" },
    { lineLabel: "N43", lineColor: "#ff5a00", lineTextColor: "#ffffff" },
  ];
  const { client, requests } = fixtureClient((url) => url === "catalog/manifest.json" ? response(manifest)
    : response({ schemaVersion: 1, revision, page: 0, nextPage: null, places: [mairie] }));

  const results = await client.searchPlaces("Mairie de Stains");

  assert.deepEqual(results.map((entry) => entry.placeId), [mairie.placeId]);
  assert.equal(requests[1], `catalog/${revision}/search/6d_61/0.json`);
  await assert.rejects(client.searchPlaces("de la"), (error) => error.code === "INVALID_QUERY");
});

test("missing initial search bucket is empty but a missing continuation is unavailable", async () => {
  const missing = fixtureClient((url) => url === "catalog/manifest.json" ? response(manifest) : response(null, 404));
  assert.deepEqual(await missing.client.searchPlaces("absent"), []);
  const continuation = fixtureClient((url) => {
    if (url === "catalog/manifest.json") return response(manifest);
    if (url.endsWith("/0.json")) return response({ schemaVersion: 1, revision, page: 0, nextPage: 1, places: [place(1)] });
    return response(null, 404);
  });
  await assert.rejects(continuation.client.searchPlaces("chatelet"), unavailable);
  const noManifest = fixtureClient(() => response(null, 404));
  await assert.rejects(noManifest.client.searchPlaces("chatelet"), unavailable);
});

test("search refuses revision changes and noncontiguous continuations", async () => {
  const mixed = fixtureClient((url) => url === "catalog/manifest.json" ? response(manifest)
    : response({ schemaVersion: 1, revision: otherRevision, page: 0, nextPage: null, places: [place(1)] }));
  await assert.rejects(mixed.client.searchPlaces("chatelet"), unavailable);
  const loop = fixtureClient((url) => url === "catalog/manifest.json" ? response(manifest)
    : response({ schemaVersion: 1, revision, page: 0, nextPage: 0, places: [place(1)] }));
  await assert.rejects(loop.client.searchPlaces("chatelet"), unavailable);
  assert.equal(loop.requests.length, 2);
});

test("service pages and exact service lookups keep unbounded authoritative routing on one revision", async () => {
  const first = service(1, { monitoringRef: `fixture:${"x".repeat(80_000)}` });
  const second = service(2);
  const placeId = place(1).placeId;
  let manifestRequests = 0;
  const { client, requests } = fixtureClient((url) => {
    if (url === "catalog/manifest.json") {
      manifestRequests += 1;
      return response(manifestRequests === 1 ? manifest : { ...manifest, revision: otherRevision });
    }
    if (url === `catalog/${revision}/places/${placeId}/0.json`) return response({ schemaVersion: 1, revision, placeId, page: 0, nextPage: 1, services: [first] });
    if (url === `catalog/${revision}/places/${placeId}/1.json`) return response({ schemaVersion: 1, revision, placeId, page: 1, nextPage: null, services: [second] });
    if (url === `catalog/${revision}/services/${first.serviceId}.json`) return response({ schemaVersion: 1, revision, service: first });
    return response(null, 404);
  });
  assert.deepEqual(await client.listServices(placeId), [first, second]);
  assert.deepEqual(await client.lookupService(first.serviceId), first);
  assert.equal(await client.lookupService(service(9).serviceId), null);
  assert.equal(manifestRequests, 1);
  assert.equal(requests.some((url) => url.includes(otherRevision)), false);
});

test("service lookup rejects unsafe paths, wrong identities and credential-shaped routing", async () => {
  const unsafe = fixtureClient(() => { throw new Error("unsafe ID reached HTTP"); });
  await assert.rejects(unsafe.client.lookupService("../../secret"), (error) => error.code === "INVALID_SERVICE");
  await assert.rejects(unsafe.client.listServices("plc_not-a-digest"), (error) => error.code === "INVALID_SERVICE");
  assert.deepEqual(unsafe.requests, []);
  const wrong = fixtureClient((url) => url === "catalog/manifest.json" ? response(manifest)
    : response({ schemaVersion: 1, revision, service: service(2) }));
  await assert.rejects(wrong.client.lookupService(service(1).serviceId), (error) => error.code === "INVALID_SERVICE");
  const secret = fixtureClient((url) => url === "catalog/manifest.json" ? response(manifest)
    : response({ schemaVersion: 1, revision, service: service(1, { apiKey: "not-a-routing-field" }) }));
  await assert.rejects(secret.client.lookupService(service(1).serviceId), (error) => error.code === "INVALID_SERVICE");
});

test("service pages reject missing continuations and cross-place content", async () => {
  const placeId = place(1).placeId;
  const missing = fixtureClient((url) => {
    if (url === "catalog/manifest.json") return response(manifest);
    return url.endsWith("/0.json")
      ? response({ schemaVersion: 1, revision, placeId, page: 0, nextPage: 1, services: [service(1)] })
      : response(null, 404);
  });
  await assert.rejects(missing.client.listServices(placeId), unavailable);
  const wrong = fixtureClient((url) => url === "catalog/manifest.json" ? response(manifest)
    : response({ schemaVersion: 1, revision, placeId: place(2).placeId, page: 0, nextPage: null, services: [service(1)] }));
  await assert.rejects(wrong.client.listServices(placeId), unavailable);
});

test("debouncing cancels superseded requests before they reach the static host", async () => {
  const timers = new Map();
  const delays = [];
  const requests = [];
  let timerId = 0;
  const client = createCatalogClient({
    setTimer(callback, delay) { timerId += 1; timers.set(timerId, callback); delays.push(delay); return timerId; },
    clearTimer(id) { timers.delete(id); },
    async fetchImpl(url) {
      requests.push(url);
      return url === "catalog/manifest.json" ? response(manifest) : response(null, 404);
    },
  });
  const old = client.searchPlaces("ch");
  const latest = client.searchPlaces("cha");
  await assert.rejects(old, { name: "AbortError" });
  assert.deepEqual(delays, [SEARCH_DEBOUNCE_MS, SEARCH_DEBOUNCE_MS]);
  assert.equal(timers.size, 1);
  [...timers.values()][0]();
  assert.deepEqual(await latest, []);
  assert.deepEqual(requests, ["catalog/manifest.json", `catalog/${revision}/search/63_68/0.json`]);
});

test("canceling an active search aborts its fetch and prevents later pages even if fetch ignores abort", async () => {
  let release;
  let started;
  let signal;
  const reachedContinuation = new Promise((resolve) => { started = resolve; });
  const { client, requests } = fixtureClient((url, options) => {
    if (url === "catalog/manifest.json") return response(manifest);
    if (url.endsWith("/0.json")) return response({ schemaVersion: 1, revision, page: 0, nextPage: 1, places: [place(1)] });
    signal = options.signal;
    started();
    return new Promise((resolve) => { release = resolve; });
  });
  const pending = client.searchPlaces("chatelet");
  await reachedContinuation;
  client.cancelSearch();
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(signal.aborted, true);
  release(response({ schemaVersion: 1, revision, page: 1, nextPage: 2, places: [place(2)] }));
  await new Promise(setImmediate);
  assert.equal(requests.some((url) => url.endsWith("/2.json")), false);
});

test("decoded response bounds stop a stream instead of buffering the remainder", async () => {
  let canceled = false;
  const { client } = fixtureClient((url) => {
    if (url === "catalog/manifest.json") return response(manifest);
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(LIMITS.httpResponseBytes + 1)); },
      cancel() { canceled = true; },
    }));
  });
  await assert.rejects(client.searchPlaces("chatelet"), unavailable);
  assert.equal(canceled, true);
});
