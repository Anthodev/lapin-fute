import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CATALOG_ROUTE,
  LIMITS,
  SCHEMA_VERSION,
  isCatalogErrorResult,
  isPlaceSearchResult,
  isServiceOptionsResult,
  type TransportMode,
} from "../../contracts/src/index.ts";
import { CatalogManager, handleCatalogRequest } from "../src/catalog.ts";

interface FixturePlace {
  readonly id: string;
  readonly label: string;
  readonly locality: string;
  readonly mode: TransportMode;
  readonly serviceId: string;
  readonly line: string;
  readonly destination: string;
  readonly monitoringRef: string;
  readonly lineRef: string;
}

const PLACE_ID = `plc_${"a".repeat(43)}`;
const SERVICE_ID = `svc_${"f".repeat(43)}`;
const PERSONAL_KEY = "test-only-personal-credential";
const temporaryDirectories: string[] = [];

const FIXTURE: readonly FixturePlace[] = [
  { id: PLACE_ID, label: "Châtelet", locality: "Paris", mode: "METRO", serviceId: SERVICE_ID, line: "4", destination: "Bagneux – Lucie Aubrac", monitoringRef: "raw-monitoring-metro-chatelet", lineRef: "raw-line-metro-4" },
  { id: `plc_${"b".repeat(43)}`, label: "République", locality: "Paris", mode: "BUS", serviceId: `svc_${"g".repeat(43)}`, line: "96", destination: "Porte des Lilas", monitoringRef: "raw-monitoring-bus-republique", lineRef: "raw-line-bus-96" },
  { id: `plc_${"c".repeat(43)}`, label: "Porte de Versailles", locality: "Paris", mode: "TRAM", serviceId: `svc_${"h".repeat(43)}`, line: "T2", destination: "Pont de Bezons", monitoringRef: "raw-monitoring-tram-versailles", lineRef: "raw-line-tram-t2" },
  { id: `plc_${"d".repeat(43)}`, label: "Châtelet – Les Halles", locality: "Paris", mode: "RER", serviceId: `svc_${"i".repeat(43)}`, line: "B", destination: "Aéroport Charles de Gaulle 2", monitoringRef: "raw-monitoring-rer-chatelet", lineRef: "raw-line-rer-b" },
  { id: `plc_${"e".repeat(43)}`, label: "Saint-Lazare", locality: "Paris", mode: "TRANSILIEN", serviceId: `svc_${"j".repeat(43)}`, line: "L", destination: "Versailles Rive Droite", monitoringRef: "raw-monitoring-train-saint-lazare", lineRef: "raw-line-train-l" },
];

function normalizedSearchText(place: FixturePlace): string {
  return `${place.label} ${place.locality} ${place.mode}`.normalize("NFKD")
    .replace(/\p{M}+/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim().replace(/\s+/gu, " ");
}

function fixtureManager(): CatalogManager {
  const directory = mkdtempSync(join(tmpdir(), "lapin-catalog-http-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "catalog.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE places(place_id TEXT PRIMARY KEY, stop_label TEXT NOT NULL, locality_label TEXT, mode TEXT NOT NULL, canonical_tuple TEXT NOT NULL UNIQUE);
    CREATE TABLE services(service_id TEXT PRIMARY KEY, place_id TEXT NOT NULL REFERENCES places(place_id), stop_label TEXT NOT NULL, line_label TEXT NOT NULL, destination_label TEXT NOT NULL, monitoring_ref TEXT NOT NULL, line_ref TEXT NOT NULL, direction_id TEXT NOT NULL, destination_ref TEXT NOT NULL, canonical_tuple TEXT NOT NULL UNIQUE);
    CREATE VIRTUAL TABLE place_search USING fts5(search_text, place_id UNINDEXED);
  `);
  const metadata = database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)");
  metadata.run("schema_version", "1"); metadata.run("catalog_version", "1");
  metadata.run("source_revision", "http-fixture-revision");
  metadata.run("created_at", "2026-08-30T12:00:00.000Z");
  const place = database.prepare("INSERT INTO places VALUES (?, ?, ?, ?, ?)");
  const search = database.prepare("INSERT INTO place_search(search_text, place_id) VALUES (?, ?)");
  const service = database.prepare("INSERT INTO services VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  FIXTURE.forEach((entry, index) => {
    place.run(entry.id, entry.label, entry.locality, entry.mode, `place:v1|${index}:${entry.id}`);
    search.run(normalizedSearchText(entry), entry.id);
    service.run(entry.serviceId, entry.id, entry.label, entry.line, entry.destination, entry.monitoringRef, entry.lineRef, `direction-${index}`, `raw-terminal-${index}`, `service:v1|${index}:${entry.serviceId}`);
  });
  database.close();
  const manager = new CatalogManager();
  manager.reload(path);
  return manager;
}

function request(catalog: CatalogManager, method: string, url: string) {
  return handleCatalogRequest({ method, url }, { catalog });
}

test.afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

test("GET routes return exact public response bodies without source identifiers or credentials", () => {
  const catalog = fixtureManager();
  const places = request(catalog, "GET", `${CATALOG_ROUTE.places}?q=chatelet`);
  assert.equal(places.status, 200);
  assert.ok(isPlaceSearchResult(places.body));
  assert.deepEqual(places.body, { schemaVersion: SCHEMA_VERSION, places: [
    { placeId: PLACE_ID, stopLabel: "Châtelet", localityLabel: "Paris", mode: "METRO" },
    { placeId: FIXTURE[3]!.id, stopLabel: "Châtelet – Les Halles", localityLabel: "Paris", mode: "RER" },
  ] });
  const services = request(catalog, "GET", CATALOG_ROUTE.placeServices.replace(":placeId", PLACE_ID));
  assert.equal(services.status, 200);
  assert.ok(isServiceOptionsResult(services.body));
  assert.deepEqual(services.body, { schemaVersion: SCHEMA_VERSION, placeId: PLACE_ID, services: [
    { serviceId: SERVICE_ID, stopLabel: "Châtelet", lineLabel: "4", destinationLabel: "Bagneux – Lucie Aubrac" },
  ] });
  const publicJson = JSON.stringify([places.body, services.body]);
  for (const forbidden of [PERSONAL_KEY, "raw-monitoring-metro-chatelet", "raw-line-metro-4", "raw-terminal-0", "direction-0"]) {
    assert.equal(publicJson.includes(forbidden), false);
  }
});

test("search rejects malformed parameters and accepts exact code-point boundaries", () => {
  const catalog = fixtureManager();
  for (const url of [CATALOG_ROUTE.places, `${CATALOG_ROUTE.places}?q=`, `${CATALOG_ROUTE.places}?q=a`, `${CATALOG_ROUTE.places}?q=${"a".repeat(101)}`, `${CATALOG_ROUTE.places}?q=--`, `${CATALOG_ROUTE.places}?q=ch&q=metro`, `${CATALOG_ROUTE.places}?q=ch&mode=METRO`]) {
    const result = request(catalog, "GET", url);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { schemaVersion: SCHEMA_VERSION, code: "INVALID_QUERY" });
    assert.ok(isCatalogErrorResult(result.body));
  }
  assert.equal(request(catalog, "GET", `${CATALOG_ROUTE.places}?q=ch`).status, 200);
  assert.equal(request(catalog, "GET", `${CATALOG_ROUTE.places}?q=${"z".repeat(100)}`).status, 200);
  const route = CATALOG_ROUTE.placeServices.replace(":placeId", PLACE_ID);
  assert.deepEqual(request(catalog, "GET", `${route}?raw=forbidden`), {
    status: 400, body: { schemaVersion: SCHEMA_VERSION, code: "INVALID_QUERY" },
  });
});

test("handler distinguishes method, place, route, and unavailable failures", () => {
  const catalog = fixtureManager();
  const route = CATALOG_ROUTE.placeServices.replace(":placeId", PLACE_ID);
  assert.deepEqual(request(catalog, "POST", CATALOG_ROUTE.places), { status: 405, body: { schemaVersion: SCHEMA_VERSION, code: "METHOD_NOT_ALLOWED" } });
  assert.deepEqual(request(catalog, "DELETE", route), { status: 405, body: { schemaVersion: SCHEMA_VERSION, code: "METHOD_NOT_ALLOWED" } });
  assert.deepEqual(request(catalog, "GET", CATALOG_ROUTE.placeServices.replace(":placeId", "plc_unknown")), { status: 404, body: { schemaVersion: SCHEMA_VERSION, code: "PLACE_NOT_FOUND" } });
  assert.deepEqual(request(catalog, "GET", "/api/catalog/unknown"), { status: 404, body: { schemaVersion: SCHEMA_VERSION, code: "PLACE_NOT_FOUND" } });
  const unavailable = new CatalogManager();
  assert.deepEqual(request(unavailable, "GET", `${CATALOG_ROUTE.places}?q=ch`), { status: 503, body: { schemaVersion: SCHEMA_VERSION, code: "CATALOG_UNAVAILABLE" } });
  assert.deepEqual(request(unavailable, "GET", route), { status: 503, body: { schemaVersion: SCHEMA_VERSION, code: "CATALOG_UNAVAILABLE" } });
});

test("catalog browsing never invokes fetch or a PRIM source", { concurrency: false }, () => {
  const catalog = fixtureManager();
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (() => { fetchCalls += 1; throw new Error("network request"); }) as typeof fetch;
  try {
    assert.equal(request(catalog, "GET", `${CATALOG_ROUTE.places}?q=chatelet`).status, 200);
    assert.equal(request(catalog, "GET", CATALOG_ROUTE.placeServices.replace(":placeId", PLACE_ID)).status, 200);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("success collections remain within the shared result bound", () => {
  const result = request(fixtureManager(), "GET", `${CATALOG_ROUTE.places}?q=ch`);
  assert.equal(result.status, 200);
  if (!isPlaceSearchResult(result.body)) assert.fail("expected place search result");
  assert.ok(result.body.places.length <= LIMITS.catalogSearchResults);
});
