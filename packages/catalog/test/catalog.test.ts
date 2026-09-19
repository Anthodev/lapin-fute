import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LIMITS, isPlaceSearchItem, type TransportMode } from "../../contracts/src/index.ts";
import { CatalogManager, SqliteCatalogReader } from "../src/catalog.ts";

interface PlaceSeed {
  readonly key: string;
  readonly mode: TransportMode;
  readonly sourceCode: string;
  readonly stopLabel: string;
  readonly localityLabel?: string;
}

interface ServiceSeed {
  readonly key: string;
  readonly placeKey: string;
  readonly mode: TransportMode;
  readonly stopLabel: string;
  readonly lineLabel: string;
  readonly destinationLabel: string;
  readonly lineColor?: string;
  readonly lineTextColor?: string;
  readonly monitoringRef: string;
  readonly lineRef: string;
  readonly directionId: string;
  readonly destinationRef: string;
}

interface CatalogSeed {
  readonly revision?: string;
  readonly places?: readonly PlaceSeed[];
  readonly services?: readonly ServiceSeed[];
  readonly omitServiceKeys?: readonly string[];
  readonly catalogVersion?: string;
  readonly omitSearchFor?: string;
}

interface BuiltCatalog {
  readonly path: string;
  readonly placeIds: Readonly<Record<string, string>>;
  readonly serviceIds: Readonly<Record<string, string>>;
}

const temporaryDirectories: string[] = [];

const BASE_PLACES: readonly PlaceSeed[] = [
  {
    key: "bus",
    mode: "BUS",
    sourceCode: "zda-bus-republique",
    stopLabel: "République",
    localityLabel: "Paris",
  },
  {
    key: "metro",
    mode: "METRO",
    sourceCode: "zda-metro-chatelet",
    stopLabel: "Châtelet",
    localityLabel: "Paris",
  },
  {
    key: "tram",
    mode: "TRAM",
    sourceCode: "zda-tram-versailles",
    stopLabel: "Porte de Versailles",
    localityLabel: "Paris",
  },
  {
    key: "rer",
    mode: "RER",
    sourceCode: "zda-rer-chatelet-halles",
    stopLabel: "Châtelet – Les Halles",
    localityLabel: "Paris",
  },
  {
    key: "transilien",
    mode: "TRANSILIEN",
    sourceCode: "zda-train-saint-lazare",
    stopLabel: "Saint-Lazare",
    localityLabel: "Paris",
  },
];

const BASE_SERVICES: readonly ServiceSeed[] = [
  {
    key: "bus-east",
    placeKey: "bus",
    mode: "BUS",
    stopLabel: "République",
    lineLabel: "96",
    destinationLabel: "Porte des Lilas",
    monitoringRef: "STIF:StopPoint:Q:raw-monitoring-bus-east:",
    lineRef: "STIF:Line::raw-line-bus-96:",
    directionId: "east",
    destinationRef: "STIF:StopPoint:Q:terminal-bus-east:",
  },
  {
    key: "metro-south",
    placeKey: "metro",
    mode: "METRO",
    stopLabel: "Châtelet",
    lineLabel: "4",
    destinationLabel: "Bagneux – Lucie Aubrac",
    monitoringRef: "STIF:StopPoint:Q:raw-monitoring-metro-south:",
    lineRef: "STIF:Line::raw-line-metro-4:",
    directionId: "south",
    destinationRef: "STIF:StopPoint:Q:terminal-metro-south:",
  },
  {
    key: "tram-west",
    placeKey: "tram",
    mode: "TRAM",
    stopLabel: "Porte de Versailles",
    lineLabel: "T2",
    destinationLabel: "Porte de Versailles",
    monitoringRef: "STIF:StopPoint:Q:raw-monitoring-tram-west:",
    lineRef: "STIF:Line::raw-line-tram-t2:",
    directionId: "west",
    destinationRef: "STIF:StopPoint:Q:terminal-tram-west:",
  },
  {
    key: "rer-north",
    placeKey: "rer",
    mode: "RER",
    stopLabel: "Châtelet – Les Halles",
    lineLabel: "B",
    destinationLabel: "Aéroport Charles de Gaulle 2",
    monitoringRef: "STIF:StopArea:SP:raw-shared-rer-station:",
    lineRef: "STIF:Line::raw-line-rer-b:",
    directionId: "north",
    destinationRef: "STIF:StopArea:SP:terminal-rer-north:",
  },
  {
    key: "train-west",
    placeKey: "transilien",
    mode: "TRANSILIEN",
    stopLabel: "Saint-Lazare",
    lineLabel: "L",
    destinationLabel: "Versailles Rive Droite",
    monitoringRef: "STIF:StopArea:SP:raw-monitoring-train-west:",
    lineRef: "STIF:Line::raw-line-train-l:",
    directionId: "west",
    destinationRef: "STIF:StopArea:SP:terminal-train-west:",
  },
];

function canonicalTuple(namespace: string, values: readonly string[]): string {
  const framed = values.map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`).join("|");
  return `${namespace}:v1|${framed}`;
}

function opaqueId(prefix: "plc_" | "svc_", canonical: string): string {
  return prefix + createHash("sha256").update(canonical).digest("base64url");
}

function placeIdentity(place: PlaceSeed): { id: string; canonical: string } {
  const canonical = canonicalTuple("place", [place.mode, place.sourceCode]);
  return { id: opaqueId("plc_", canonical), canonical };
}

function serviceIdentity(service: ServiceSeed): { id: string; canonical: string } {
  const canonical = canonicalTuple("service", [
    service.mode,
    service.lineRef,
    service.monitoringRef,
    service.directionId,
    service.destinationRef,
  ]);
  return { id: opaqueId("svc_", canonical), canonical };
}

function searchText(place: PlaceSeed): string {
  return [place.stopLabel, place.localityLabel, place.mode]
    .filter((value): value is string => value !== undefined)
    .join(" ")
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function buildCatalog(seed: CatalogSeed = {}): BuiltCatalog {
  const directory = mkdtempSync(join(tmpdir(), "lapin-catalog-runtime-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "catalog.sqlite");
  const database = new DatabaseSync(path);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE metadata(
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE places(
      place_id TEXT PRIMARY KEY,
      stop_label TEXT NOT NULL,
      locality_label TEXT,
      mode TEXT NOT NULL,
      canonical_tuple TEXT NOT NULL UNIQUE
    );
    CREATE TABLE services(
      service_id TEXT PRIMARY KEY,
      place_id TEXT NOT NULL REFERENCES places(place_id),
      stop_label TEXT NOT NULL,
      line_label TEXT NOT NULL,
      destination_label TEXT NOT NULL,
      line_color TEXT NOT NULL,
      line_text_color TEXT NOT NULL,
      monitoring_ref TEXT NOT NULL,
      line_ref TEXT NOT NULL,
      direction_id TEXT NOT NULL,
      destination_ref TEXT NOT NULL,
      canonical_tuple TEXT NOT NULL UNIQUE
    );
    CREATE TABLE journey_groups(group_id TEXT PRIMARY KEY, line_mode TEXT NOT NULL, line_ref TEXT NOT NULL,
      UNIQUE(line_mode,line_ref)) STRICT;
    CREATE TABLE journey_rows(group_id TEXT NOT NULL REFERENCES journey_groups(group_id),
      row_kind TEXT NOT NULL CHECK(row_kind IN ('place','terminal','pattern')), row_id TEXT NOT NULL, row_json TEXT NOT NULL,
      PRIMARY KEY(group_id,row_kind,row_id)) STRICT;
    CREATE TABLE service_journeys(service_id TEXT PRIMARY KEY REFERENCES services(service_id),
      group_id TEXT NOT NULL REFERENCES journey_groups(group_id), terminal_place_id TEXT) STRICT;
    CREATE VIRTUAL TABLE place_search USING fts5(search_text, place_id UNINDEXED);
  `);

  const metadata = database.prepare("INSERT INTO metadata(key, value) VALUES (?, ?)");
  metadata.run("schema_version", "1");
  metadata.run("catalog_version", seed.catalogVersion ?? "4");
  metadata.run("source_revision", seed.revision ?? "fixture-revision-a");
  metadata.run("created_at", "2026-08-30T12:00:00.000Z");

  const places = [...BASE_PLACES, ...(seed.places ?? [])];
  const omittedServiceKeys = new Set(seed.omitServiceKeys ?? []);
  const services = [
    ...BASE_SERVICES.filter((service) => !omittedServiceKeys.has(service.key)),
    ...(seed.services ?? []),
  ];
  const placeIds: Record<string, string> = {};
  const serviceIds: Record<string, string> = {};
  const insertPlace = database.prepare(`
    INSERT INTO places(place_id, stop_label, locality_label, mode, canonical_tuple)
    VALUES (?, ?, ?, ?, ?)
  `);
  const insertSearch = database.prepare(
    "INSERT INTO place_search(search_text, place_id) VALUES (?, ?)",
  );
  for (const place of places) {
    const identity = placeIdentity(place);
    placeIds[place.key] = identity.id;
    insertPlace.run(
      identity.id,
      place.stopLabel,
      place.localityLabel ?? null,
      place.mode,
      identity.canonical,
    );
    if (place.key !== seed.omitSearchFor) insertSearch.run(searchText(place), identity.id);
  }

  const insertService = database.prepare(`
    INSERT INTO services(
      service_id,
      place_id,
      stop_label,
      line_label,
      destination_label,
      line_color,
      line_text_color,
      monitoring_ref,
      line_ref,
      direction_id,
      destination_ref,
      canonical_tuple
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const service of services) {
    const identity = serviceIdentity(service);
    serviceIds[service.key] = identity.id;
    insertService.run(
      identity.id,
      placeIds[service.placeKey],
      service.stopLabel,
      service.lineLabel,
      service.destinationLabel,
      service.lineColor ?? "#123456",
      service.lineTextColor ?? "#ffffff",
      service.monitoringRef,
      service.lineRef,
      service.directionId,
      service.destinationRef,
      identity.canonical,
    );
    const groupId = "grp_" + createHash("sha256").update(JSON.stringify([service.mode, service.lineRef])).digest("base64url");
    const terminalId = "term_" + createHash("sha256").update(service.destinationRef).digest("base64url");
    const terminalPlaceId = "plc_" + createHash("sha256").update(service.destinationRef).digest("base64url");
    const patternId = "pat_" + createHash("sha256").update(identity.id).digest("base64url");
    database.prepare("INSERT OR IGNORE INTO journey_groups VALUES (?, ?, ?)").run(groupId, service.mode, service.lineRef);
    for (const [kind, id, value] of [
      ["place", placeIds[service.placeKey], { kind: "place", placeId: placeIds[service.placeKey], label: service.stopLabel }],
      ["place", terminalPlaceId, { kind: "place", placeId: terminalPlaceId, label: service.destinationLabel }],
      ["terminal", terminalId, { kind: "terminal", terminalId, terminalPlaceId, refs: [service.destinationRef], labels: [service.destinationLabel] }],
      ["pattern", patternId, { kind: "pattern", patternId, terminalId, stops: [
        { stopRef: service.monitoringRef, placeId: placeIds[service.placeKey], pickupType: 0, dropOffType: 0 },
        { stopRef: service.destinationRef, placeId: terminalPlaceId, pickupType: 1, dropOffType: 0 },
      ] }],
    ] as const) {
      database.prepare("INSERT OR IGNORE INTO journey_rows VALUES (?, ?, ?, ?)").run(groupId, kind, id!, JSON.stringify(value));
    }
    database.prepare("INSERT INTO service_journeys VALUES (?, ?, ?)").run(identity.id, groupId, terminalPlaceId);
  }
  database.close();
  return { path, placeIds, serviceIds };
}

test.afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
});

test("search is accent tolerant, punctuation safe, and bounded by Unicode code points", () => {
  const catalog = buildCatalog();
  const reader = SqliteCatalogReader.open(catalog.path);

  assert.deepEqual(
    reader.searchPlaces("chatelet").map((place) => place.placeId),
    [catalog.placeIds.metro, catalog.placeIds.rer],
  );
  assert.deepEqual(
    reader.searchPlaces("  ChÂtElEt---LES...HALLES  ").map((place) => place.placeId),
    [catalog.placeIds.rer],
  );
  assert.throws(() => reader.searchPlaces("a"), RangeError);
  assert.throws(() => reader.searchPlaces("a".repeat(101)), RangeError);
  assert.throws(() => reader.searchPlaces("--"), RangeError);
  assert.deepEqual(reader.searchPlaces("😀a"), []);
  assert.deepEqual(reader.searchPlaces("z".repeat(100)), []);
});

test("search preserves homonyms and applies deterministic ranking before the 20-row bound", () => {
  const homonyms: PlaceSeed[] = [
    {
      key: "homonym-b",
      mode: "BUS",
      sourceCode: "zda-homonym-b",
      stopLabel: "Place Centrale",
      localityLabel: "Saint-Denis",
    },
    {
      key: "homonym-a",
      mode: "BUS",
      sourceCode: "zda-homonym-a",
      stopLabel: "Place Centrale",
      localityLabel: "Saint-Denis",
    },
  ];
  const rankedPlaces: PlaceSeed[] = Array.from({ length: 25 }, (_, index) => ({
    key: `rank-${index}`,
    mode: "BUS" as const,
    sourceCode: `zda-rank-${index}`,
    stopLabel: `Alpha ${String(index).padStart(2, "0")}`,
    localityLabel: "Paris",
  }));
  const services: ServiceSeed[] = [...homonyms, ...rankedPlaces].map((place, index) => ({
    key: `extra-service-${index}`,
    placeKey: place.key,
    mode: place.mode,
    stopLabel: place.stopLabel,
    lineLabel: `X${index}`,
    destinationLabel: "Terminus",
    monitoringRef: `STIF:StopPoint:Q:raw-monitoring-extra-${index}:`,
    lineRef: `STIF:Line::raw-line-extra-${index}:`,
    directionId: "outbound",
    destinationRef: `STIF:StopPoint:Q:terminal-extra-${index}:`,
  }));
  const catalog = buildCatalog({ places: [...homonyms, ...rankedPlaces], services });
  const reader = SqliteCatalogReader.open(catalog.path);

  const homonymResults = reader.searchPlaces("place centrale");
  assert.equal(homonymResults.length, 2);
  assert.deepEqual(
    homonymResults.map((place) => place.placeId),
    [catalog.placeIds["homonym-a"], catalog.placeIds["homonym-b"]].sort(),
  );

  const ranked = reader.searchPlaces("alpha");
  assert.equal(ranked.length, LIMITS.catalogSearchResults);
  assert.deepEqual(
    ranked.map((place) => place.stopLabel),
    Array.from({ length: 20 }, (_, index) => `Alpha ${String(index).padStart(2, "0")}`),
  );
});

test("search deduplicates destinations by native line and keeps equal labels and homonymous modes", () => {
  const places: PlaceSeed[] = (["BUS", "METRO"] as const).map((mode) => ({
    key: `university-${mode}`,
    mode,
    sourceCode: "zda-university",
    stopLabel: "Saint-Denis Université",
    localityLabel: "Saint-Denis",
  }));
  const busLines = [
    { lineRef: "STIF:Line::native-10:", lineLabel: "10", lineColor: "#333333" },
    { lineRef: "STIF:Line::native-2-b:", lineLabel: "2", lineColor: "#222222" },
    { lineRef: "STIF:Line::native-2-c:", lineLabel: "2", lineColor: "#111111" },
    { lineRef: "STIF:Line::native-2-a:", lineLabel: "2", lineColor: "#111111" },
  ];
  const services: ServiceSeed[] = busLines.flatMap((line, index) => [0, 1].map((direction) => ({
    ...line,
    key: `university-bus-${index}-${direction}`,
    placeKey: "university-BUS",
    mode: "BUS" as const,
    stopLabel: "Saint-Denis Université",
    lineTextColor: "#ffffff",
    destinationLabel: `Terminus ${direction}`,
    monitoringRef: `STIF:StopPoint:Q:university-bus-${direction}:`,
    directionId: String(direction),
    destinationRef: `STIF:StopPoint:Q:university-terminal-${direction}:`,
  })));
  services.push({
    key: "university-metro",
    placeKey: "university-METRO",
    mode: "METRO",
    stopLabel: "Saint-Denis Université",
    lineLabel: "13",
    lineColor: "#82c8e6",
    lineTextColor: "#000000",
    destinationLabel: "Châtillon Montrouge",
    monitoringRef: "STIF:StopPoint:Q:university-metro:",
    lineRef: "STIF:Line::native-metro-13:",
    directionId: "0",
    destinationRef: "STIF:StopPoint:Q:metro-terminal:",
  });
  const catalog = buildCatalog({ places, services });
  const matches = SqliteCatalogReader.open(catalog.path).searchPlaces("universite");
  assert.equal(matches.length, 2);
  assert.equal(matches.every(isPlaceSearchItem), true);
  assert.deepEqual(matches.find((place) => place.mode === "BUS")?.lines, [
    { lineLabel: "2", lineColor: "#111111", lineTextColor: "#ffffff" },
    { lineLabel: "2", lineColor: "#222222", lineTextColor: "#ffffff" },
    { lineLabel: "2", lineColor: "#111111", lineTextColor: "#ffffff" },
    { lineLabel: "10", lineColor: "#333333", lineTextColor: "#ffffff" },
  ]);
  assert.deepEqual(matches.find((place) => place.mode === "METRO")?.lines, [
    { lineLabel: "13", lineColor: "#82c8e6", lineTextColor: "#000000" },
  ]);
});

test("search rejects conflicting display metadata for one native line", () => {
  const catalog = buildCatalog({
    services: [{
      ...BASE_SERVICES[0]!,
      key: "bus-other-destination",
      destinationLabel: "Other terminus",
      destinationRef: "STIF:StopPoint:Q:terminal-bus-other:",
      lineColor: "#654321",
    }],
  });
  assert.throws(() => SqliteCatalogReader.open(catalog.path).searchPlaces("republique"), /inconsistent line metadata/u);
});

test("service options return every valid direction without applying the place-search bound", () => {
  const extraServices: ServiceSeed[] = Array.from({ length: 65 }, (_, index) => ({
    key: `bus-option-${index}`,
    placeKey: "bus",
    mode: "BUS",
    stopLabel: "République",
    lineLabel: `X${String(index).padStart(2, "0")}`,
    destinationLabel: `Terminus ${index}`,
    monitoringRef: `STIF:StopPoint:Q:raw-monitoring-bus-option-${index}:`,
    lineRef: `STIF:Line::raw-line-bus-option-${index}:`,
    directionId: `direction-${index}`,
    destinationRef: `STIF:StopPoint:Q:terminal-bus-option-${index}:`,
  }));
  const catalog = buildCatalog({ services: extraServices });
  const reader = SqliteCatalogReader.open(catalog.path);

  const options = reader.listServices(catalog.placeIds.bus);
  assert.equal(options?.length, extraServices.length + 1);
  const place = reader.searchPlaces("republique").find((entry) => entry.placeId === catalog.placeIds.bus);
  assert.equal(isPlaceSearchItem(place), true);
  assert.deepEqual(place?.lines.map((line) => line.lineLabel), ["96", ...extraServices.map((service) => service.lineLabel)]);
});

test("reload preserves stable IDs, distinguishes directions, rejects invalid candidates, and removes stale services", () => {
  const southbound: ServiceSeed = {
    key: "rer-south",
    placeKey: "rer",
    mode: "RER",
    stopLabel: "Châtelet – Les Halles",
    lineLabel: "B",
    destinationLabel: "Saint-Rémy-lès-Chevreuse",
    monitoringRef: "STIF:StopArea:SP:raw-shared-rer-station:",
    lineRef: "STIF:Line::raw-line-rer-b:",
    directionId: "south",
    destinationRef: "STIF:StopArea:SP:terminal-rer-south:",
  };
  const first = buildCatalog({ services: [southbound] });
  const manager = new CatalogManager();
  manager.reload(first.path);

  const northId = first.serviceIds["rer-north"];
  const southId = first.serviceIds["rer-south"];
  assert.equal(Buffer.byteLength(northId, "utf8"), 47);
  assert.ok(Buffer.byteLength(northId, "utf8") <= LIMITS.idUtf8Bytes);
  assert.notEqual(northId, southId);
  assert.deepEqual(manager.resolveService(northId), {
    status: "RESOLVED",
    monitoringRef: "STIF:StopArea:SP:raw-shared-rer-station:",
    lineRef: "STIF:Line::raw-line-rer-b:",
    destinationRef: "STIF:StopArea:SP:terminal-rer-north:",
    destinationLabel: "Aéroport Charles de Gaulle 2",
  });
  assert.deepEqual(manager.resolveService(southId), {
    status: "RESOLVED",
    monitoringRef: "STIF:StopArea:SP:raw-shared-rer-station:",
    lineRef: "STIF:Line::raw-line-rer-b:",
    destinationRef: "STIF:StopArea:SP:terminal-rer-south:",
    destinationLabel: "Saint-Rémy-lès-Chevreuse",
  });

  const invalid = buildCatalog({ catalogVersion: "1" });
  assert.throws(() => manager.reload(invalid.path), /Invalid catalog candidate/u);
  assert.equal(manager.resolveService(southId).status, "RESOLVED");

  const renamedNorth: ServiceSeed = {
    ...BASE_SERVICES.find((service) => service.key === "rer-north")!,
    destinationLabel: "Aéroport CDG 2",
  };
  const replacement = buildCatalog({
    revision: "fixture-revision-b",
    omitServiceKeys: ["rer-north"],
    services: [renamedNorth],
  });
  manager.reload(replacement.path);

  assert.equal(replacement.serviceIds["rer-north"], northId);
  assert.deepEqual(manager.resolveService(northId), {
    status: "RESOLVED",
    monitoringRef: "STIF:StopArea:SP:raw-shared-rer-station:",
    lineRef: "STIF:Line::raw-line-rer-b:",
    destinationRef: "STIF:StopArea:SP:terminal-rer-north:",
    destinationLabel: "Aéroport CDG 2",
  });
  assert.deepEqual(
    manager.resolveService(southId),
    { status: "UNRESOLVED", code: "INVALID_SERVICE" },
  );
  assert.equal(manager.listServices("plc_missing"), undefined);
  assert.deepEqual(manager.listServices(replacement.placeIds.metro)![0], {
    serviceId: replacement.serviceIds["metro-south"],
    stopLabel: "Châtelet",
    lineLabel: "4",
    destinationLabel: "Bagneux – Lucie Aubrac",
    lineMode: "METRO",
    lineColor: "#123456",
    lineTextColor: "#ffffff",
    routing: {
      monitoringRef: "STIF:StopPoint:Q:raw-monitoring-metro-south:",
      lineRef: "STIF:Line::raw-line-metro-4:",
      destinationRef: "STIF:StopPoint:Q:terminal-metro-south:",
    },
  });
});

test("candidate validation rejects incomplete FTS coverage", () => {
  const invalid = buildCatalog({ omitSearchFor: "metro" });
  assert.throws(() => SqliteCatalogReader.open(invalid.path), /search consistency/u);
});

test("candidate validation rejects non-normalized presentation colors", () => {
  const invalid = buildCatalog({
    omitServiceKeys: ["metro-south"],
    services: [{ ...BASE_SERVICES.find((service) => service.key === "metro-south")!, lineColor: "#ABCDEF" }],
  });
  assert.throws(() => SqliteCatalogReader.open(invalid.path), /service data/u);
});

test("reader rejects incomplete journey bindings and malformed linked pattern rows", () => {
  for (const mutation of [
    "DELETE FROM service_journeys WHERE service_id = (SELECT service_id FROM service_journeys LIMIT 1)",
    "UPDATE service_journeys SET terminal_place_id = 'plc_' || replace(hex(zeroblob(22)), '0', 'x')",
    "UPDATE journey_rows SET row_json = json_set(row_json, '$.stops[0].dropOffType', 4) WHERE row_kind = 'pattern'",
    "UPDATE journey_rows SET row_json = json_set(row_json, '$.stops[0].placeId', 'plc_' || substr(hex(zeroblob(22)), 1, 43)) WHERE row_kind = 'pattern'",
    "UPDATE journey_rows SET row_json = json_set(row_json, '$.unexpected', 1) WHERE row_kind = 'terminal'",
    "DELETE FROM journey_rows WHERE row_kind = 'terminal'",
  ]) {
    const catalog = buildCatalog();
    const database = new DatabaseSync(catalog.path);
    database.exec(mutation);
    database.close();
    assert.throws(() => SqliteCatalogReader.open(catalog.path), /Invalid catalog candidate/u);
  }
});
