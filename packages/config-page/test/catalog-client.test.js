import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CatalogClientError, SEARCH_DEBOUNCE_MS, createCatalogClient } from "../src/catalog-client.js";
import { LIMITS } from "../../contracts/src/index.ts";
import { normalizeCatalogSearchText } from "../src/search-text.js";
import { JOURNEY_LIMITS } from "../src/generated/journey-patterns.js";
import {
  buildCatalogCandidateFromRecords,
  createPlaceIdentity,
  createServiceIdentity,
} from "../../catalog/src/catalog-import.ts";
import { publishStaticCatalog } from "../../catalog/src/static-catalog.ts";

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

// --- lookupJourney: real publication -> client regressions --------------------

const catalogFixtureSource = JSON.parse(
  readFileSync(new URL("../../../fixtures/catalog/idfm-v1.json", import.meta.url), "utf8"),
);

function opaqueId(prefix, tuple) {
  return prefix + createHash("sha256").update(tuple, "utf8").digest("base64url");
}

function catalogSources(sourceRevision) {
  const overlay = catalogFixtureSource.journeySources ?? {};
  const selected = (rows) => rows
    .filter((row) => !Array.isArray(row.revisions) || row.revisions.includes(sourceRevision))
    .map(({ revisions, ...row }) => row);
  return Object.fromEntries(Object.entries(catalogFixtureSource.sources).map(([key, rows]) => {
    const extra = selected(overlay[key] ?? []);
    if (key === "stopTimes") {
      const replaced = new Set(extra.map((row) => row.trip_id));
      return [key, [...selected(rows).filter((row) => !replaced.has(row.trip_id)), ...extra]];
    }
    return [key, [...selected(rows), ...extra]];
  }));
}

function attachJourneyGroup(database, group) {
  database.prepare("INSERT INTO journey_groups VALUES (?, ?, ?)").run(group.groupId, group.mode, group.lineRef);
  const insertRow = database.prepare("INSERT INTO journey_rows VALUES (?, ?, ?, ?)");
  for (const row of group.rows) {
    const rowId = row.kind === "place" ? row.placeId : row.kind === "terminal" ? row.terminalId : row.patternId;
    insertRow.run(group.groupId, row.kind, rowId, JSON.stringify(row));
  }
  const insertAnnex = database.prepare("INSERT INTO service_journeys VALUES (?, ?, ?)");
  for (const [serviceId, terminalPlaceId] of group.annexes) {
    insertAnnex.run(serviceId, group.groupId, terminalPlaceId);
  }
}

// Two 1024-stop patterns of one line: their rows exceed one document budget,
// so the publisher really splits the group over multiple pages.
function multiPageJourneyGroup(serviceIds) {
  const mode = "BUS";
  const lineRef = "STIF:Line::C-JOURNEY:";
  const places = [];
  const terminals = [];
  const patterns = [];
  let terminalPlaceId = null;
  for (const suffix of ["A", "B"]) {
    const originPlaceId = opaqueId("plc_", JSON.stringify(["journey-stop", [mode, lineRef, suffix]]));
    const endPlaceId = opaqueId("plc_", JSON.stringify(["journey-stop", [mode, lineRef, `${suffix}-end`]]));
    const terminalId = opaqueId("term_", JSON.stringify([mode, `${lineRef}-${suffix}`]));
    const stops = Array.from({ length: 1024 }, (_, index) => ({
      stopRef: `STIF:StopPoint:Q:JOURNEY-${suffix}-${index}:`,
      placeId: index % 2 === 0 ? originPlaceId : endPlaceId,
      pickupType: 0,
      dropOffType: 0,
    }));
    const patternId = opaqueId("pat_", JSON.stringify([mode, lineRef, terminalId,
      stops.map((stop) => [stop.stopRef, stop.placeId, stop.pickupType, stop.dropOffType])]));
    places.push({ kind: "place", placeId: originPlaceId, label: `Marché ${suffix}` });
    places.push({ kind: "place", placeId: endPlaceId, label: `Terminus ${suffix}` });
    terminals.push({
      kind: "terminal", terminalId, terminalPlaceId: endPlaceId,
      refs: [`STIF:StopPoint:Q:JOURNEY-${suffix}-1023:`], labels: [`Terminus ${suffix}`],
    });
    patterns.push({ kind: "pattern", patternId, terminalId, stops });
    if (suffix === "A") terminalPlaceId = endPlaceId;
  }
  return {
    mode,
    lineRef,
    groupId: opaqueId("grp_", JSON.stringify([mode, lineRef])),
    terminalPlaceId,
    rows: [...places, ...terminals, ...patterns],
    annexes: serviceIds.map((serviceId) => [serviceId, terminalPlaceId]),
  };
}

function singlePageJourneyGroup(serviceId) {
  const mode = "BUS";
  const lineRef = "STIF:Line::C-OTHER:";
  const placeId = opaqueId("plc_", JSON.stringify(["journey-stop", [mode, lineRef, "other"]]));
  const terminalId = opaqueId("term_", JSON.stringify([mode, `${lineRef}-terminal`]));
  const stops = [
    { stopRef: "STIF:StopPoint:Q:JOURNEY-OTHER:", placeId, pickupType: 0, dropOffType: 0 },
    { stopRef: "STIF:StopPoint:Q:JOURNEY-OTHER-END:", placeId, pickupType: 0, dropOffType: 0 },
  ];
  const patternId = opaqueId("pat_", JSON.stringify([mode, lineRef, terminalId,
    stops.map((stop) => [stop.stopRef, stop.placeId, stop.pickupType, stop.dropOffType])]));
  return {
    mode,
    lineRef,
    groupId: opaqueId("grp_", JSON.stringify([mode, lineRef])),
    terminalPlaceId: placeId,
    rows: [
      { kind: "place", placeId, label: "Marché Autre" },
      { kind: "terminal", terminalId, terminalPlaceId: placeId, refs: ["STIF:StopPoint:Q:JOURNEY-OTHER-END:"], labels: ["Terminus Autre"] },
      { kind: "pattern", patternId, terminalId, stops },
    ],
    annexes: [[serviceId, placeId]],
  };
}

function journeyService(lineId, monitoringSuffix, destinationSuffix) {
  const monitoringRef = `STIF:StopPoint:Q:${monitoringSuffix}:`;
  const destinationRef = `STIF:StopPoint:Q:${destinationSuffix}:`;
  return {
    routing: { monitoringRef, lineRef: `STIF:Line::${lineId}:`, destinationRef },
    identity: createServiceIdentity({
      mode: "BUS", lineId, monitoringRef, directionId: "0", destinationRef,
    }),
  };
}

async function journeyFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "lapin-fute-journey-client-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const catalogPath = join(directory, "catalog.sqlite");
  await buildCatalogCandidateFromRecords({
    candidatePath: catalogPath,
    sourceRevision: "fixture-2026-08-a",
    createdAt: "2026-09-05T00:00:00.000Z",
    sources: catalogSources("fixture-2026-08-a"),
  });
  const place = createPlaceIdentity("BUS", "STATIC-JOURNEY");
  const full = journeyService("C-JOURNEY", "JOURNEY-FULL", "JOURNEY-END-A");
  const short = journeyService("C-JOURNEY", "JOURNEY-SHORT", "JOURNEY-END-A");
  const other = journeyService("C-OTHER", "JOURNEY-OTHER", "JOURNEY-OTHER-END");
  const bigGroup = multiPageJourneyGroup([full.identity.serviceId, short.identity.serviceId]);
  const smallGroup = singlePageJourneyGroup(other.identity.serviceId);
  const database = new DatabaseSync(catalogPath);
  try {
    database.exec("BEGIN");
    const insertPlace = database.prepare("INSERT INTO places VALUES (?, ?, ?, ?, ?)");
    const insertSearch = database.prepare("INSERT INTO place_search(search_text, place_id) VALUES (?, ?)");
    const insertService = database.prepare("INSERT INTO services VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    insertPlace.run(place.placeId, "Marché A", "Saint-Denis", "BUS", place.canonicalTuple);
    insertSearch.run(normalizeCatalogSearchText("Marché A Saint-Denis"), place.placeId);
    for (const entry of [full, short, other]) {
      insertService.run(
        entry.identity.serviceId, place.placeId, "Marché A", "J255", "Terminus",
        "#e86a10", "#ffffff", entry.routing.monitoringRef, entry.routing.lineRef, "0",
        entry.routing.destinationRef, entry.identity.canonicalTuple,
      );
    }
    attachJourneyGroup(database, bigGroup);
    attachJourneyGroup(database, smallGroup);
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  const outputDirectory = join(directory, "static");
  const publication = publishStaticCatalog({
    catalogPath, outputDirectory, attribution: catalogFixtureSource.attribution,
  });
  return { outputDirectory, publication, full, short, other, bigGroup, smallGroup };
}

// Serves the exact bytes published on disk; hide fakes missing files, mutate
// fakes a compromised host, gates hold a response until released.
function journeyClient(directory, requests, { hide = [], mutate = null, gates = [] } = {}) {
  return createCatalogClient({
    setTimer(callback) { queueMicrotask(callback); return 1; },
    clearTimer() {},
    fetchImpl(url, options) {
      requests.push(url);
      assert.equal(options.credentials, "omit");
      assert.equal(new Headers(options.headers).has("Authorization"), false);
      assert.equal(options.redirect, "error");
      const suffix = url.slice("catalog/".length);
      if (hide.some((fragment) => suffix.includes(fragment))) {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      const respond = () => {
        const path = join(directory, suffix);
        if (!existsSync(path)) return new Response(null, { status: 404 });
        let bytes = readFileSync(path);
        if (mutate !== null) bytes = mutate(suffix, bytes) ?? bytes;
        return new Response(bytes, { headers: { "content-type": "application/json" } });
      };
      const gate = gates.find((entry) => suffix.includes(entry.key));
      if (gate === undefined) return Promise.resolve(respond());
      return new Promise((resolve, reject) => {
        if (options.signal?.aborted) {
          reject(new DOMException("Superseded", "AbortError"));
          return;
        }
        gate.waiters.push({ suffix, signal: options.signal, resolve: () => resolve(respond()) });
        if (!gate.ignoreAbort) {
          options.signal?.addEventListener("abort", () => reject(new DOMException("Superseded", "AbortError")), { once: true });
        }
      });
    },
  });
}

function releaseGate(gate) {
  for (const waiter of gate.waiters.splice(0)) waiter.resolve();
}

async function until(condition) {
  for (let attempt = 0; attempt < 10000 && !condition(); attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.ok(condition(), "condition not reached");
}

function assertRetainedService(result, env) {
  assert.equal(result === null, false);
  assert.equal(result.group, null);
  assert.equal(result.service.serviceId, env.full.identity.serviceId);
  assert.equal(result.service.revision, env.publication.manifest.revision);
  assert.equal(result.service.groupId, env.bigGroup.groupId);
  assert.equal(result.service.terminalPlaceId, env.bigGroup.terminalPlaceId);
  assert.deepEqual(result.service.routing, env.full.routing);
}

test("lookupJourney assembles a real multi-page group on one pinned revision", async (t) => {
  const env = await journeyFixture(t);
  const requests = [];
  const client = journeyClient(env.outputDirectory, requests);
  const rev = env.publication.manifest.revision;
  const base = `catalog/${rev}/journeys/groups/${env.bigGroup.groupId}`;
  const result = await client.lookupJourney(env.full.identity.serviceId, env.full.routing);
  assert.equal(result === null, false);
  assert.equal(result.service.serviceId, env.full.identity.serviceId);
  assert.equal(result.service.revision, rev);
  assert.equal(result.service.groupId, env.bigGroup.groupId);
  assert.equal(result.service.terminalPlaceId, env.bigGroup.terminalPlaceId);
  assert.deepEqual(result.service.routing, env.full.routing);
  assert.equal(result.group.revision, rev);
  assert.equal(result.group.groupId, env.bigGroup.groupId);
  assert.equal(result.group.patterns.length, 2);
  assert.equal(result.group.places.length, 4);
  assert.equal(result.group.terminals.length, 2);
  assert.deepEqual(requests, [
    "catalog/manifest.json",
    `catalog/${rev}/journeys/services/${env.full.identity.serviceId}.json`,
    `${base}/index.json`,
    `${base}/0.json`,
    `${base}/1.json`,
  ]);
  const index = JSON.parse(readFileSync(
    join(env.outputDirectory, rev, "journeys", "groups", env.bigGroup.groupId, "index.json"), "utf8",
  ));
  assert.equal(index.pageCount, 2);
  // No group is retained between lookups: the second one transfers everything again.
  const repeated = await client.lookupJourney(env.full.identity.serviceId, env.full.routing);
  assert.equal(repeated.group.patterns.length, 2);
  assert.equal(requests.filter((url) => url === `${base}/index.json`).length, 2);
});

test("concurrent services of one group share one flight and one assembled group", async (t) => {
  const env = await journeyFixture(t);
  const requests = [];
  const gate = { key: `${env.bigGroup.groupId}/index.json`, waiters: [] };
  const client = journeyClient(env.outputDirectory, requests, { gates: [gate] });
  const rev = env.publication.manifest.revision;
  const base = `catalog/${rev}/journeys/groups/${env.bigGroup.groupId}`;
  const first = client.lookupJourney(env.full.identity.serviceId, env.full.routing);
  const second = client.lookupJourney(env.short.identity.serviceId, env.short.routing);
  await until(() => requests.filter((url) => url.includes("journeys/services/")).length === 2
    && requests.includes(`${base}/index.json`));
  releaseGate(gate);
  const [left, right] = await Promise.all([first, second]);
  assert.equal(left.group, right.group);
  assert.equal(left.group.patterns.length, 2);
  assert.deepEqual(right.service.routing, env.short.routing);
  assert.equal(requests.filter((url) => url.endsWith("/index.json")).length, 1);
  assert.equal(requests.filter((url) => url === `${base}/0.json`).length, 1);
  assert.equal(requests.filter((url) => url === `${base}/1.json`).length, 1);
});

test("lookups for different groups run separate flights", async (t) => {
  const env = await journeyFixture(t);
  const requests = [];
  const gate = { key: `${env.bigGroup.groupId}/index.json`, waiters: [] };
  const client = journeyClient(env.outputDirectory, requests, { gates: [gate] });
  const rev = env.publication.manifest.revision;
  const big = client.lookupJourney(env.full.identity.serviceId, env.full.routing);
  const small = client.lookupJourney(env.other.identity.serviceId, env.other.routing);
  await until(() => requests.includes(`catalog/${rev}/journeys/groups/${env.smallGroup.groupId}/index.json`));
  assert.equal(requests.filter((url) => url.endsWith("/index.json")).length, 2);
  releaseGate(gate);
  const [left, right] = await Promise.all([big, small]);
  assert.equal(left.group.patterns.length, 2);
  assert.equal(right.group.patterns.length, 1);
  assert.notEqual(left.group.groupId, right.group.groupId);
});

test("aborting one subscriber leaves the shared group load intact", async (t) => {
  const env = await journeyFixture(t);
  const requests = [];
  const gate = { key: `${env.bigGroup.groupId}/index.json`, waiters: [] };
  const client = journeyClient(env.outputDirectory, requests, { gates: [gate] });
  const rev = env.publication.manifest.revision;
  const base = `catalog/${rev}/journeys/groups/${env.bigGroup.groupId}`;
  const controller = new AbortController();
  const first = client.lookupJourney(env.full.identity.serviceId, env.full.routing, controller.signal);
  const second = client.lookupJourney(env.short.identity.serviceId, env.short.routing);
  await until(() => requests.filter((url) => url.includes("journeys/services/")).length === 2
    && requests.includes(`${base}/index.json`));
  controller.abort();
  await assert.rejects(first, (error) => error.name === "AbortError");
  releaseGate(gate);
  const kept = await second;
  assert.equal(kept.group.groupId, env.bigGroup.groupId);
  assert.equal(kept.group.patterns.length, 2);
  assert.equal(requests.filter((url) => url === `${base}/index.json`).length, 1);
  assert.equal(requests.filter((url) => url === `${base}/0.json`).length, 1);
  assert.equal(requests.filter((url) => url === `${base}/1.json`).length, 1);
});

test("aborting the last subscriber cancels the load and a later lookup starts fresh", async (t) => {
  const env = await journeyFixture(t);
  const requests = [];
  const gate = { key: `${env.bigGroup.groupId}/index.json`, waiters: [], ignoreAbort: true };
  const client = journeyClient(env.outputDirectory, requests, { gates: [gate] });
  const rev = env.publication.manifest.revision;
  const base = `catalog/${rev}/journeys/groups/${env.bigGroup.groupId}`;
  const controller = new AbortController();
  const pending = client.lookupJourney(env.full.identity.serviceId, env.full.routing, controller.signal);
  const secondController = new AbortController();
  const second = client.lookupJourney(env.short.identity.serviceId, env.short.routing, secondController.signal);
  await until(() => requests.includes(`${base}/index.json`));
  controller.abort();
  await assert.rejects(pending, (error) => error.name === "AbortError");
  assert.equal(gate.waiters[0].signal.aborted, false);
  secondController.abort();
  const fresh = client.lookupJourney(env.full.identity.serviceId, env.full.routing);
  await assert.rejects(second, (error) => error.name === "AbortError");
  assert.equal(gate.waiters[0].signal.aborted, true);
  assert.equal(requests.some((url) => url === `${base}/0.json`), false);
  // Keep the canceled transport unresolved until its replacement is fetching.
  // Releasing before that point would leave the replacement behind a new gate.
  await until(() => gate.waiters.length === 2);
  releaseGate(gate);
  assert.equal((await fresh).group.patterns.length, 2);
  assert.equal(requests.filter((url) => url === `${base}/index.json`).length, 2);
});

test("group admission failures keep the service and never yield a partial group", async (t) => {
  const env = await journeyFixture(t);
  const rev = env.publication.manifest.revision;
  const serviceId = env.full.identity.serviceId;
  const groupBase = `${rev}/journeys/groups/${env.bigGroup.groupId}`;
  let result = await journeyClient(env.outputDirectory, [],
    { hide: [`${env.bigGroup.groupId}/index.json`] }).lookupJourney(serviceId, env.full.routing);
  assertRetainedService(result, env);
  result = await journeyClient(env.outputDirectory, [],
    { hide: [`${env.bigGroup.groupId}/1.json`] }).lookupJourney(serviceId, env.full.routing);
  assertRetainedService(result, env);
  result = await journeyClient(env.outputDirectory, [], {
    mutate: (suffix, bytes) => suffix === `${groupBase}/index.json`
      ? Buffer.concat([bytes, Buffer.from(" broken")]) : null,
  }).lookupJourney(serviceId, env.full.routing);
  assertRetainedService(result, env);
  result = await journeyClient(env.outputDirectory, [], {
    mutate: (suffix, bytes) => suffix === `${groupBase}/index.json`
      ? Buffer.from(JSON.stringify({ ...JSON.parse(bytes), rowCount: 999 })) : null,
  }).lookupJourney(serviceId, env.full.routing);
  assertRetainedService(result, env);
  result = await journeyClient(env.outputDirectory, [], {
    mutate: (suffix, bytes) => suffix === `${groupBase}/1.json`
      ? Buffer.from(JSON.stringify({
        ...JSON.parse(bytes),
        rows: [...JSON.parse(bytes).rows, { kind: "place", placeId: `plc_${"z".repeat(43)}` }],
      })) : null,
  }).lookupJourney(serviceId, env.full.routing);
  assertRetainedService(result, env);
});

test("group line and mode must match the service annex even when group identities match", async (t) => {
  const env = await journeyFixture(t);
  const rev = env.publication.manifest.revision;
  const groupBase = `${rev}/journeys/groups/${env.bigGroup.groupId}`;
  for (const mismatch of [{ lineRef: env.other.routing.lineRef }, { lineMode: "TRAM" }]) {
    const requests = [];
    const client = journeyClient(env.outputDirectory, requests, {
      mutate: (suffix, bytes) => suffix === `${groupBase}/index.json`
        ? Buffer.from(JSON.stringify({ ...JSON.parse(bytes), ...mismatch })) : null,
    });
    const result = await client.lookupJourney(env.full.identity.serviceId, env.full.routing);
    assertRetainedService(result, env);
    assert.equal(requests.includes(`catalog/${groupBase}/1.json`), true);
  }
});

test("annex failures return null without any group transfer", async (t) => {
  const env = await journeyFixture(t);
  const rev = env.publication.manifest.revision;
  const serviceId = env.full.identity.serviceId;
  const annexPath = `${rev}/journeys/services/${serviceId}.json`;
  const requests = [];
  const client = journeyClient(env.outputDirectory, requests);
  assert.equal(await client.lookupJourney(`svc_${"z".repeat(43)}`, env.full.routing), null);
  assert.equal(requests.filter((url) => url.includes("journeys/groups/")).length, 0);
  const afterUnknown = requests.length;
  await assert.rejects(client.lookupJourney("not-a-service", env.full.routing),
    (error) => error instanceof CatalogClientError && error.code === "INVALID_SERVICE");
  await assert.rejects(client.lookupJourney(serviceId, null),
    (error) => error instanceof CatalogClientError && error.code === "INVALID_SERVICE");
  await assert.rejects(client.lookupJourney(serviceId, { monitoringRef: "x" }),
    (error) => error instanceof CatalogClientError && error.code === "INVALID_SERVICE");
  assert.equal(requests.length, afterUnknown);
  const broken = journeyClient(env.outputDirectory, requests, {
    mutate: (suffix, bytes) => suffix === annexPath ? Buffer.concat([bytes, Buffer.from(" broken")]) : null,
  });
  assert.equal(await broken.lookupJourney(serviceId, env.full.routing), null);
  assert.equal(requests.filter((url) => url.includes("journeys/groups/")).length, 0);
  const foreign = journeyClient(env.outputDirectory, requests, {
    mutate: (suffix, bytes) => suffix === annexPath
      ? Buffer.from(JSON.stringify({ ...JSON.parse(bytes), revision: "f".repeat(64) })) : null,
  });
  assert.equal(await foreign.lookupJourney(serviceId, env.full.routing), null);
  const oversized = journeyClient(env.outputDirectory, requests, {
    mutate: (suffix, bytes) => suffix === annexPath ? Buffer.concat([bytes, Buffer.alloc(300000, 0x20)]) : null,
  });
  assert.equal(await oversized.lookupJourney(serviceId, env.full.routing), null);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    journeyClient(env.outputDirectory, requests)
      .lookupJourney(serviceId, env.full.routing, controller.signal),
    (error) => error.name === "AbortError",
  );
  assert.equal(requests.filter((url) => url.includes("journeys/groups/")).length, 0);
});

test("annex routing must exactly match every requested routing field", async (t) => {
  const env = await journeyFixture(t);
  for (const field of ["monitoringRef", "lineRef", "destinationRef"]) {
    const requests = [];
    const client = journeyClient(env.outputDirectory, requests);
    const routing = { ...env.full.routing, [field]: env.other.routing[field] };
    assert.equal(await client.lookupJourney(env.full.identity.serviceId, routing), null, field);
    assert.equal(requests.some((url) => url.includes("journeys/groups/")), false, field);
  }
});

test("raw group budget includes whitespace in the index as well as pages", async () => {
  const option = journeyService("C-OTHER", "JOURNEY-OTHER", "JOURNEY-OTHER-END");
  const group = singlePageJourneyGroup(option.identity.serviceId);
  const pageCount = JOURNEY_LIMITS.pages;
  const index = {
    schemaVersion: 1, revision, groupId: group.groupId, lineMode: group.mode,
    lineRef: group.lineRef, pageCount, rowCount: pageCount + 2, patternCount: pageCount,
  };
  const indexText = JSON.stringify(index);
  const annex = {
    schemaVersion: 1, revision, serviceId: option.identity.serviceId, groupId: group.groupId,
    lineMode: group.mode, routing: option.routing, terminalPlaceId: group.terminalPlaceId,
  };
  const pages = Array.from({ length: pageCount }, (_, page) => {
    const pattern = { ...group.rows[2], patternId: opaqueId("pat_", `budget-${page}`) };
    const text = JSON.stringify({
      schemaVersion: 1, revision, groupId: group.groupId, page,
      nextPage: page + 1 < pageCount ? page + 1 : null,
      rows: page === 0 ? [...group.rows.slice(0, 2), pattern] : [pattern],
    });
    const bytes = page + 1 < pageCount ? JOURNEY_LIMITS.documentBytes
      : JOURNEY_LIMITS.groupBytes - (pageCount - 1) * JOURNEY_LIMITS.documentBytes
        - Buffer.byteLength(indexText);
    return text + " ".repeat(bytes - Buffer.byteLength(text));
  });
  const load = (indexWhitespace) => fixtureClient((url) => {
    if (url === "catalog/manifest.json") return response(manifest);
    if (url.includes("journeys/services/")) return response(annex);
    if (url.endsWith("/index.json")) return new Response(indexText + indexWhitespace);
    return new Response(pages[Number(url.split("/").at(-1).slice(0, -5))]);
  }).client.lookupJourney(option.identity.serviceId, option.routing);
  // Exactly the original-byte budget is admitted. One extra index byte is not.
  assert.equal((await load("")).group.patterns.length, pageCount);
  const exceeded = await load(" ");
  assert.deepEqual(exceeded, { service: annex, group: null });
});
