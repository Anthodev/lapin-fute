import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { crc32 } from "node:zlib";
import journeyPatterns from "../../companion/src/journey-patterns.js";
import { TRANSPORT_MODE } from "../../contracts/src/index.ts";
import type { TransportMode } from "../../contracts/src/index.ts";
import { CatalogManager } from "../src/catalog.ts";
import {
  activateCatalogCandidate,
  buildCatalogCandidate,
  buildCatalogCandidateFromRecords,
  createPlaceIdentity,
  createServiceIdentity,
  downloadCatalogSource,
  refreshCatalogFromRecords,
} from "../src/catalog-import.ts";
import type {
  CatalogRecordSourceSet,
  CatalogFileSourceSet,
  CsvRecord,
} from "../src/catalog-import.ts";

interface Fixture {
  readonly schemaVersion: number;
  readonly fixtureVersion: string;
  readonly dataClassification: string;
  readonly attribution: readonly { readonly dataset: string; readonly url: string; readonly retrievedAt: string; readonly license: string }[];
  readonly sources: Readonly<Record<keyof CatalogRecordSourceSet, readonly Record<string, unknown>[]>>;
  readonly journeySources: Partial<Record<keyof CatalogRecordSourceSet, readonly CsvRecord[]>>;
}

const fixtureUrl = new URL("../../../fixtures/catalog/idfm-v1.json", import.meta.url);
const fixtureText = readFileSync(fixtureUrl, "utf8");
const fixture = JSON.parse(fixtureText) as Fixture;

// IDFM relations published on 2026-09-19 with no reference/operator stop children.
const hierarchyOnlyRelations: readonly CsvRecord[] = [
  { zdcid: "72421", zdaid: "473350", arrid: null, artid: null },
  { zdcid: "497419", zdaid: null, arrid: null, artid: null },
  { zdcid: "61340", zdaid: "497052", arrid: null, artid: null },
];

function sourcesFor(revisionId: string): CatalogRecordSourceSet {
  return Object.fromEntries(Object.entries(fixture.sources).map(([name, records]) => [
    name,
    records.filter((record) => !Array.isArray(record.revisions) || record.revisions.includes(revisionId)).map((record) => {
      const { revisions: _revisions, ...sourceRecord } = record;
      return sourceRecord as CsvRecord;
    }),
  ])) as unknown as CatalogRecordSourceSet;
}

function workspace(t: TestContext): string {
  const directory = mkdtempSync(join(tmpdir(), "lapin-fute-catalog-import-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function place(manager: CatalogManager, query: string, mode: TransportMode, locality?: string) {
  const found = manager.searchPlaces(query).find((entry) => entry.mode === mode && (locality === undefined || entry.localityLabel === locality));
  assert.ok(found, `expected ${mode} place for ${query}`);
  return found;
}

function service(manager: CatalogManager, placeId: string, destination: string) {
  const found = manager.listServices(placeId)?.find((entry) => entry.destinationLabel === destination);
  assert.ok(found, `expected service to ${destination}`);
  return found;
}

test("fixture is attributed and contains neither credentials nor personal responses", () => {
  assert.equal(fixture.schemaVersion, 1);
  assert.equal(fixture.fixtureVersion, "idfm-catalog-v1");
  assert.match(fixture.dataClassification, /fixture-only/u);
  assert.equal(fixture.attribution.length, 7);
  for (const source of fixture.attribution) {
    assert.equal(new URL(source.url).hostname, "data.iledefrance-mobilites.fr");
    assert.ok(Number.isFinite(Date.parse(source.retrievedAt)));
    assert.ok(source.license.length > 0);
  }
  assert.doesNotMatch(fixtureText, /IDFM_DATASET_TOKEN|PRIM_API_KEY|"apikey"|StopMonitoringDelivery|MonitoredStopVisit/iu);
});

test("opaque IDs use stable full SHA-256 identities and distinguish opposite directions", () => {
  const firstPlace = createPlaceIdentity("METRO", "ZDA-METRO");
  assert.deepEqual(firstPlace, createPlaceIdentity("METRO", "ZDA-METRO"));
  assert.match(firstPlace.placeId, /^plc_[A-Za-z0-9_-]{43}$/u);
  const east = createServiceIdentity({ mode: "METRO", lineId: "C200", monitoringRef: "STIF:StopPoint:Q:METRO-EAST:", directionId: "0", destinationRef: "DEST:METRO-SOUTH" });
  const west = createServiceIdentity({ mode: "METRO", lineId: "C200", monitoringRef: "STIF:StopPoint:Q:METRO-WEST:", directionId: "1", destinationRef: "DEST:METRO-NORTH" });
  assert.match(east.serviceId, /^svc_[A-Za-z0-9_-]{43}$/u);
  assert.notEqual(east.serviceId, west.serviceId);
  assert.match(east.canonicalTuple, /^lapin-fute:service:v1\|/u);
});

test("import covers five modes, gates perimeter and unsupported modes, preserves homonyms, and uses rail terminals", async (t) => {
  const directory = workspace(t);
  const candidate = join(directory, "candidate.sqlite");
  const active = join(directory, "catalog.sqlite");
  const result = await buildCatalogCandidateFromRecords({ candidatePath: candidate, sourceRevision: "fixture-2026-08-a", createdAt: "2026-08-30T00:00:00.000Z", sources: sourcesFor("fixture-2026-08-a") });
  assert.equal(result.placeCount, 6);
  assert.equal(result.serviceCount, 8);
  assert.deepEqual(result.countsByMode, { BUS: 2, METRO: 2, TRAM: 1, RER: 2, TRANSILIEN: 1 });
  for (const mode of TRANSPORT_MODE) assert.ok(result.countsByMode[mode] > 0);

  activateCatalogCandidate(candidate, active);
  const manager = new CatalogManager();
  manager.reload(active);
  const homonyms = manager.searchPlaces("gare du nord").filter((entry) => entry.mode === "BUS");
  assert.equal(homonyms.length, 2);
  assert.notEqual(homonyms[0]?.placeId, homonyms[1]?.placeId);
  assert.deepEqual(new Set(homonyms.map((entry) => entry.localityLabel)), new Set(["Paris", "Saint-Denis"]));

  const metro = place(manager, "chatelet", "METRO");
  const metroServices = manager.listServices(metro.placeId) ?? [];
  assert.equal(metroServices.length, 2);
  assert.notEqual(metroServices[0]?.serviceId, metroServices[1]?.serviceId);
  assert.deepEqual(
    metroServices.map(({ lineMode, lineColor, lineTextColor }) => ({ lineMode, lineColor, lineTextColor })),
    [
      { lineMode: "METRO", lineColor: "#be418d", lineTextColor: "#ffffff" },
      { lineMode: "METRO", lineColor: "#be418d", lineTextColor: "#ffffff" },
    ],
  );
  const rer = place(manager, "chatelet les halles", "RER");
  const east = service(manager, rer.placeId, "Marne-la-Vallée Chessy");
  const west = service(manager, rer.placeId, "Saint-Germain-en-Laye");
  const eastResolution = manager.resolveService(east.serviceId);
  const westResolution = manager.resolveService(west.serviceId);
  assert.equal(eastResolution.status, "RESOLVED");
  assert.equal(westResolution.status, "RESOLVED");
  if (eastResolution.status === "RESOLVED" && westResolution.status === "RESOLVED") {
    assert.equal(eastResolution.monitoringRef, westResolution.monitoringRef);
    assert.notEqual(eastResolution.destinationRef, westResolution.destinationRef);
    assert.notEqual(eastResolution.destinationLabel, "NORA");
    assert.notEqual(westResolution.destinationLabel, "ZEBU");
  }
  assert.equal(manager.searchPlaces("montmartre").length, 0);
  const bus = place(manager, "gare du nord", "BUS", "Paris");
  const busServices = manager.listServices(bus.placeId) ?? [];
  assert.deepEqual(busServices.map((entry) => entry.destinationLabel), ["Hôpital Européen"]);
  assert.equal(busServices.some((entry) => entry.destinationLabel === "Wrong perimeter destination"), false);
});

test("bus services use their actual terminal to distinguish partial trips with the same headsign", async (t) => {
  const directory = workspace(t);
  const candidate = join(directory, "candidate.sqlite");
  const sources = sourcesFor("fixture-2026-08-a");
  await buildCatalogCandidateFromRecords({
    candidatePath: candidate,
    sourceRevision: "fixture-bus-partial-trip",
    sources: {
      ...sources,
      stops: [
        ...sources.stops,
        { stop_id: "IDFM:TERM-BUS-PARTIAL", stop_name: "Porte de Paris", parent_station: "" },
      ],
      trips: [
        ...sources.trips,
        {
          route_id: "IDFM:C100",
          trip_id: "trip-bus-partial",
          trip_headsign: "Hôpital Européen",
          direction_id: "0",
        },
      ],
      stopTimes: [
        ...sources.stopTimes,
        { trip_id: "trip-bus-partial", stop_id: "IDFM:ART-BUS-1", stop_sequence: "1", pickup_type: "0" },
        { trip_id: "trip-bus-partial", stop_id: "IDFM:TERM-BUS-PARTIAL", stop_sequence: "2", pickup_type: "1" },
      ],
      objectCodes: [
        ...sources.objectCodes,
        {
          object_type: "StopPoint",
          object_id: "IDFM:TERM-BUS-PARTIAL",
          object_system: "source",
          object_code: "DEST:BUS-PARTIAL",
        },
      ],
    },
  });

  const manager = new CatalogManager();
  manager.reload(candidate);
  const bus = place(manager, "gare du nord", "BUS", "Paris");
  const services = manager.listServices(bus.placeId) ?? [];
  assert.deepEqual(
    services.map((entry) => entry.destinationLabel).sort(),
    ["Hôpital Européen", "Porte de Paris"],
  );
  assert.notEqual(services[0]?.serviceId, services[1]?.serviceId);
  assert.deepEqual(
    new Set(services.map((entry) => manager.resolveService(entry.serviceId))
      .filter((entry) => entry.status === "RESOLVED")
      .map((entry) => entry.destinationRef)),
    new Set(["STIF:StopPoint:Q:TERM-BUS-1:", "STIF:StopPoint:Q:TERM-BUS-PARTIAL:"]),
  );
});

test("GTFS quay and monomodal stops join SIRI perimeter namespaces without rewriting routing references", async (t) => {
  const directory = workspace(t);
  const sources = sourcesFor("fixture-2026-08-a");
  const stopId = (value: unknown): unknown => value === "IDFM:ART-BUS-1" ? "IDFM:22528" : value;
  const candidatePath = join(directory, "source-namespaces.sqlite");
  const result = await buildCatalogCandidateFromRecords({
    candidatePath,
    sourceRevision: "fixture-source-namespaces",
    sources: {
      ...sources,
      perimeter: sources.perimeter.map((row) => ({
        ...row,
        ns2_stoppointref: row.ns2_stoppointref === "STIF:StopPoint:Q:ART-BUS-1:"
          ? "STIF:StopPoint:Q:22528:"
          : row.ns2_stoppointref === "STIF:StopPoint:Q:BUS-OTHER:"
            ? "STIF:StopPoint:Q:28306:" : row.ns2_stoppointref,
      })),
      stops: sources.stops.map((row) => ({
        ...row,
        stop_id: stopId(row.stop_id) as string,
        parent_station: row.stop_id === "IDFM:ART-BUS-1" || row.stop_id === "IDFM:monomodalStopPlace:ZDA-RER"
          ? "IDFM:65549" : row.parent_station,
      })),
      stopTimes: sources.stopTimes.map((row) => ({ ...row, stop_id: stopId(row.stop_id) as string })),
      arretsLignes: sources.arretsLignes.map((row) => ({ ...row, stop_id: stopId(row.stop_id) as string })),
      arrets: sources.arrets.map((row) => ({ ...row, arrid: row.arrid === "ARR-BUS-1" ? "22528" : row.arrid })),
      objectCodes: [...sources.objectCodes.map((row) => ({
        ...row,
        object_id: stopId(row.object_id) as string,
        ...(row.object_id === "IDFM:ART-BUS-1"
          ? { object_system: "netex_zder_quay", object_code: "22528" } : {}),
      })), {
        // A quay's exported code list can also contain the opposing platform.
        object_type: "StopPoint", object_id: "IDFM:22528",
        object_system: "netex_zder_quay", object_code: "28306",
      }],
    },
  });
  assert.deepEqual(result.countsByMode, { BUS: 2, METRO: 2, TRAM: 1, RER: 2, TRANSILIEN: 1 });
  const manager = new CatalogManager();
  manager.reload(candidatePath);
  const bus = service(manager, place(manager, "gare du nord", "BUS", "Paris").placeId, "Hôpital Européen");
  const routing = manager.resolveService(bus.serviceId);
  assert.equal(routing.status, "RESOLVED");
  if (routing.status === "RESOLVED") {
    assert.equal(routing.monitoringRef, "STIF:StopPoint:Q:22528:");
    assert.equal(routing.lineRef, "STIF:Line::C100:");
    assert.equal(routing.destinationRef, "STIF:StopPoint:Q:TERM-BUS-1:");
  }
  const rer = service(manager, place(manager, "chatelet les halles", "RER").placeId, "Marne-la-Vallée Chessy");
  assert.equal(manager.resolveService(rer.serviceId).status, "RESOLVED");
});

test("rail queries retain exact same-line child provenance without querying the child quay", async (t) => {
  const directory = workspace(t);
  const sources = sourcesFor("fixture-2026-08-a");
  const withChild: CatalogRecordSourceSet = {
    ...sources,
    arrets: [...sources.arrets, { arrid: "ARR-RER-CHILD", zdaid: "ZDA-RER", arrname: "Châtelet" }],
    perimeter: sources.perimeter.map((row) => row.line === "STIF:Line::C400:"
      ? { ...row, ns2_stoppointref: "STIF:StopPoint:Q:ARR-RER-CHILD:" } : row),
  };
  const candidatePath = join(directory, "rail-child-provenance.sqlite");
  await buildCatalogCandidateFromRecords({ candidatePath, sourceRevision: "fixture-rail-child", sources: withChild });
  const manager = new CatalogManager();
  manager.reload(candidatePath);
  const east = service(manager, place(manager, "chatelet les halles", "RER").placeId, "Marne-la-Vallée Chessy");
  assert.deepEqual(manager.resolveService(east.serviceId), {
    status: "RESOLVED",
    monitoringRef: "STIF:StopArea:SP:ZDA-RER:",
    lineRef: "STIF:Line::C400:",
    destinationRef: "STIF:StopArea:SP:TERM-RER-EAST:",
    destinationLabel: "Marne-la-Vallée Chessy",
  });
  await assert.rejects(buildCatalogCandidateFromRecords({
    candidatePath: join(directory, "wrong-rail-parent.sqlite"),
    sourceRevision: "fixture-wrong-rail-parent",
    sources: {
      ...withChild,
      arrets: withChild.arrets.map((row) => row.arrid === "ARR-RER-CHILD" ? { ...row, zdaid: "ZDA-TRANSILIEN" } : row),
    },
  }), { code: "MODE_COVERAGE" });
});

test("ambiguous final selectors exclude both GTFS directions without rebinding existing services", async (t) => {
  const directory = workspace(t);
  const sources = sourcesFor("fixture-2026-08-a");
  const referencePath = join(directory, "unambiguous.sqlite");
  await buildCatalogCandidateFromRecords({ candidatePath: referencePath, sourceRevision: "fixture-before-collision", sources });
  const manager = new CatalogManager();
  manager.reload(referencePath);
  const bus = service(manager, place(manager, "gare du nord", "BUS", "Paris").placeId, "Hôpital Européen");
  const rerPlace = place(manager, "chatelet les halles", "RER");
  const east = service(manager, rerPlace.placeId, "Marne-la-Vallée Chessy");
  const west = service(manager, rerPlace.placeId, "Saint-Germain-en-Laye");
  const duplicateTrips = sources.trips.filter((row) => row.trip_id === "trip-bus-preserved" || row.trip_id === "trip-rer-east");
  const conflictedPath = join(directory, "ambiguous.sqlite");
  const result = await buildCatalogCandidateFromRecords({
    candidatePath: conflictedPath,
    sourceRevision: "fixture-after-collision",
    sources: {
      ...sources,
      trips: [...sources.trips, ...duplicateTrips.map((row) => ({ ...row, trip_id: `${row.trip_id}-opposite`, direction_id: "1" }))],
      stopTimes: [...sources.stopTimes, ...sources.stopTimes
        .filter((row) => duplicateTrips.some((trip) => trip.trip_id === row.trip_id))
        .map((row) => ({ ...row, trip_id: `${row.trip_id}-opposite` }))],
    },
  });
  assert.deepEqual(result.excludedAmbiguousServicesByMode, { BUS: 2, METRO: 0, TRAM: 0, RER: 2, TRANSILIEN: 0 });
  assert.deepEqual(result.countsByMode, { BUS: 1, METRO: 2, TRAM: 1, RER: 1, TRANSILIEN: 1 });
  manager.reload(conflictedPath);
  assert.deepEqual(manager.resolveService(bus.serviceId), { status: "UNRESOLVED", code: "INVALID_SERVICE" });
  assert.deepEqual(manager.resolveService(east.serviceId), { status: "UNRESOLVED", code: "INVALID_SERVICE" });
  assert.equal(manager.resolveService(west.serviceId).status, "RESOLVED");
});

test("perimeter descriptions are optional without losing services or weakening exact routing", async (t) => {
  const directory = workspace(t);
  const sources = sourcesFor("fixture-2026-08-a");
  const referencePath = join(directory, "reference.sqlite");
  await buildCatalogCandidateFromRecords({
    candidatePath: referencePath, sourceRevision: "fixture-descriptions-reference", sources,
  });
  const manager = new CatalogManager();
  manager.reload(referencePath);
  const queries = ["gare du nord", "chatelet", "porte de versailles", "saint lazare"];
  const expected = queries.flatMap((query) => manager.searchPlaces(query).map((place) => ({
    place,
    services: manager.listServices(place.placeId),
  })));
  const sparseSources: CatalogRecordSourceSet = {
    ...sources,
    perimeter: sources.perimeter.map((row) => ({
      line: row.line,
      ns2_stoppointref: row.ns2_stoppointref,
      // This extra source field must not replace the existing exact pair.
      ns2_lines: JSON.stringify({ "ns2:LineRef": ["IDFM:UNRELATED-FIXTURE"] }),
    })),
  };
  const sparsePath = join(directory, "sparse.sqlite");
  const result = await buildCatalogCandidateFromRecords({
    candidatePath: sparsePath, sourceRevision: "fixture-descriptions-absent", sources: sparseSources,
  });
  assert.equal(result.placeCount, 6);
  assert.equal(result.serviceCount, 8);
  assert.deepEqual(result.countsByMode, { BUS: 2, METRO: 2, TRAM: 1, RER: 2, TRANSILIEN: 1 });
  manager.reload(sparsePath);
  assert.deepEqual(queries.flatMap((query) => manager.searchPlaces(query).map((place) => ({
    place,
    services: manager.listServices(place.placeId),
  }))), expected);
  for (const bindingField of ["line", "ns2_stoppointref"]) {
    await assert.rejects(buildCatalogCandidateFromRecords({
      candidatePath: join(directory, `missing-${bindingField}.sqlite`),
      sourceRevision: `fixture-missing-${bindingField}`,
      sources: {
        ...sparseSources,
        perimeter: sparseSources.perimeter.map((row, index) => index === 0
          ? { ...row, [bindingField]: null }
          : row),
      },
    }), { code: "INVALID_SOURCE" });
  }
});

test("parent-only relations retain valid routes without inventing stop associations", async (t) => {
  const directory = workspace(t);
  const sources = sourcesFor("fixture-2026-08-a");
  const parentOnly: CsvRecord = {
    zdaid: "ZDA-METRO", arrid: "ARR-METRO-EAST", artid: null, zdcid: "ZDC-METRO",
  };
  const withParentOnly: CatalogRecordSourceSet = {
    ...sources,
    // Force both bus stops to use real ART-to-ZDA relations rather than ARR lookup.
    arrets: sources.arrets.filter((row) => row.arrid !== "ARR-BUS-1" && row.arrid !== "ARR-BUS-2"),
    relations: [...sources.relations, parentOnly],
  };
  const referencePath = join(directory, "parent-only-reference.sqlite");
  const reference = await buildCatalogCandidateFromRecords({
    candidatePath: referencePath, sourceRevision: "fixture-parent-only", sources: withParentOnly,
  });
  assert.equal(reference.placeCount, 6);
  assert.equal(reference.serviceCount, 8);
  const manager = new CatalogManager();
  manager.reload(referencePath);
  const expectedBus = manager.listServices(place(manager, "gare du nord", "BUS", "Saint-Denis").placeId);
  const expectedMetro = manager.listServices(place(manager, "chatelet", "METRO").placeId);
  const queries = ["gare du nord", "chatelet", "porte de versailles", "saint lazare"];
  const expected = queries.flatMap((query) => manager.searchPlaces(query).map((place) => ({
    place,
    services: manager.listServices(place.placeId),
  })));
  const hierarchyPath = join(directory, "hierarchy-only.sqlite");
  const withHierarchyOnly: CatalogRecordSourceSet = {
    ...withParentOnly,
    relations: [...withParentOnly.relations, ...hierarchyOnlyRelations],
  };
  await buildCatalogCandidateFromRecords({
    candidatePath: hierarchyPath, sourceRevision: "fixture-hierarchy-only", sources: withHierarchyOnly,
  });
  manager.reload(hierarchyPath);
  assert.deepEqual(queries.flatMap((query) => manager.searchPlaces(query).map((place) => ({
    place,
    services: manager.listServices(place.placeId),
  }))), expected);

  const noArtPath = join(directory, "no-invented-art.sqlite");
  const noArt = await buildCatalogCandidateFromRecords({
    candidatePath: noArtPath,
    sourceRevision: "fixture-no-invented-art",
    sources: {
      ...withHierarchyOnly,
      relations: [
        ...withHierarchyOnly.relations.filter((row) => row.artid !== "ART-BUS-1"),
        // A coincident ARR/ZDC value is not permission to manufacture a missing ART edge.
        { zdaid: "ZDA-BUS-1", arrid: "ART-BUS-1", artid: null, zdcid: "ART-BUS-1" },
        { zdaid: "ZDA-BUS-1", arrid: null, artid: null, zdcid: "ART-BUS-1" },
      ],
    },
  });
  assert.equal(noArt.placeCount, 5);
  assert.equal(noArt.serviceCount, 7);
  assert.deepEqual(noArt.countsByMode, { BUS: 1, METRO: 2, TRAM: 1, RER: 2, TRANSILIEN: 1 });
  manager.reload(noArtPath);
  assert.equal(manager.searchPlaces("gare du nord").some((entry) => entry.localityLabel === "Paris"), false);
  assert.deepEqual(manager.listServices(place(manager, "gare du nord", "BUS", "Saint-Denis").placeId), expectedBus);
  assert.deepEqual(manager.listServices(place(manager, "chatelet", "METRO").placeId), expectedMetro);
  const malformedRelations: readonly CsvRecord[] = [
    { ...parentOnly, zdaid: null },
    { ...parentOnly, arrid: null, artid: "ART-METRO-EAST" },
    { zdcid: null, zdaid: null, arrid: null, artid: null },
    { zdcid: "\0", zdaid: null, arrid: null, artid: null },
  ];
  for (const [index, relation] of malformedRelations.entries()) {
    await assert.rejects(buildCatalogCandidateFromRecords({
      candidatePath: join(directory, `invalid-parent-${index}.sqlite`),
      sourceRevision: `fixture-invalid-parent-${index}`,
      sources: {
        ...withParentOnly,
        relations: [relation],
      },
    }), { code: "INVALID_SOURCE" });
  }
});

test("import normalizes valid colors and rejects invalid or missing authoritative colors", async (t) => {
  const directory = workspace(t);
  const validSources = sourcesFor("fixture-2026-08-a");
  const invalidSources: CatalogRecordSourceSet = {
    ...validSources,
    lines: validSources.lines.map((line, index) => index === 0
      ? { ...line, colourweb_hexa: "not-a-color" }
      : line),
  };
  const invalidCandidate = join(directory, "invalid-color.sqlite");
  await assert.rejects(
    buildCatalogCandidateFromRecords({
      candidatePath: invalidCandidate,
      sourceRevision: "fixture-invalid-color",
      sources: invalidSources,
    }),
    /six-digit hexadecimal color/u,
  );
  assert.equal(existsSync(invalidCandidate), false);

  const missingSources: CatalogRecordSourceSet = {
    ...validSources,
    lines: validSources.lines.map((line, index) => {
      if (index !== 0) return line;
      const { textcolourweb_hexa: _missing, ...withoutTextColor } = line;
      return withoutTextColor;
    }),
  };
  const missingCandidate = join(directory, "missing-color.sqlite");
  await assert.rejects(
    buildCatalogCandidateFromRecords({
      candidatePath: missingCandidate,
      sourceRevision: "fixture-missing-color",
      sources: missingSources,
    }),
    /missing textcolourweb_hexa/u,
  );
  assert.equal(existsSync(missingCandidate), false);
});

test("activation preserves stable services, removes stale IDs, and failed replacement leaves the active file untouched", async (t) => {
  const directory = workspace(t);
  const active = join(directory, "catalog.sqlite");
  const first = join(directory, "first.sqlite");
  await buildCatalogCandidateFromRecords({ candidatePath: first, sourceRevision: "fixture-2026-08-a", sources: sourcesFor("fixture-2026-08-a") });
  activateCatalogCandidate(first, active);
  const manager = new CatalogManager();
  manager.reload(active);
  const busId = service(manager, place(manager, "gare du nord", "BUS", "Paris").placeId, "Hôpital Européen").serviceId;
  const removedId = service(manager, place(manager, "chatelet", "METRO").placeId, "Porte de Clignancourt").serviceId;

  const second = join(directory, "second.sqlite");
  await buildCatalogCandidateFromRecords({ candidatePath: second, sourceRevision: "fixture-2026-08-b", sources: sourcesFor("fixture-2026-08-b") });
  activateCatalogCandidate(second, active);
  assert.equal(manager.resolveService(removedId).status, "RESOLVED");
  manager.reload(active);
  assert.equal(service(manager, place(manager, "gare du nord", "BUS", "Paris").placeId, "Hôpital Européen").serviceId, busId);
  assert.deepEqual(manager.resolveService(removedId), { status: "UNRESOLVED", code: "INVALID_SERVICE" });

  const before = createHash("sha256").update(readFileSync(active)).digest("hex");
  const invalid = join(directory, "invalid.sqlite");
  await assert.rejects(refreshCatalogFromRecords({ candidatePath: invalid, activePath: active, sourceRevision: "fixture-invalid-no-transilien", sources: sourcesFor("fixture-invalid-no-transilien") }), /no resolvable TRANSILIEN/u);
  assert.equal(existsSync(invalid), false);
  assert.equal(createHash("sha256").update(readFileSync(active)).digest("hex"), before);
  assert.equal(manager.resolveService(busId).status, "RESOLVED");
});

test("restricted source download streams bytes and puts its token only in Authorization", async (t) => {
  const directory = workspace(t);
  const destination = join(directory, "source.csv");
  const bytes = new TextEncoder().encode("id;name\n1;Châtelet\n");
  let requested = "";
  let authorization: string | null = null;
  let redirect: RequestRedirect | undefined;
  const fetchSource = (async (input: string | URL | Request, init?: RequestInit) => {
    requested = String(input);
    authorization = new Headers(init?.headers).get("Authorization");
    redirect = init?.redirect;
    return new Response(bytes, { status: 200, headers: { "content-type": "text/csv; charset=utf-8" } });
  }) as typeof globalThis.fetch;
  const result = await downloadCatalogSource({
    source: { dataset: "restricted-fixture", url: "https://data.iledefrance-mobilites.fr/source.csv", retrievedAt: "2026-08-30T00:00:00.000Z", license: "Licence Mobilité", restricted: true },
    destinationPath: destination,
    expectedContentTypes: ["text/csv"],
    datasetToken: "operator-test-value",
    fetch: fetchSource,
  });
  assert.equal(requested.includes("operator-test-value"), false);
  assert.equal(authorization, "apikey operator-test-value");
  assert.equal(redirect, "manual");
  assert.equal(result.bytes, bytes.byteLength);
  assert.equal(result.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(readFileSync(destination), Buffer.from(bytes));
});

test("ordered journey groups preserve variants, restrictions, exact terminals and proven aliases without changing old services", async (t) => {
  const directory = workspace(t);
  const baselinePath = join(directory, "baseline.sqlite");
  const richPath = join(directory, "journeys.sqlite");
  const base = sourcesFor("fixture-2026-08-a");
  await buildCatalogCandidateFromRecords({ candidatePath: baselinePath, sourceRevision: "baseline", sources: base });
  const replacedTrips = new Set(fixture.journeySources.stopTimes!.map((entry) => entry.trip_id));
  const rich = Object.fromEntries(Object.entries(base).map(([key, values]) => [key, [
    ...[...values].filter((entry) => key !== "stopTimes" || !replacedTrips.has(entry.trip_id)),
    ...(fixture.journeySources[key as keyof CatalogRecordSourceSet] ?? []),
  ]])) as unknown as CatalogRecordSourceSet;
  await buildCatalogCandidateFromRecords({ candidatePath: richPath, sourceRevision: "rich", sources: {
    ...rich,
    trips: [...rich.trips, { route_id: "IDFM:C100", trip_id: "trip-express-copy", trip_headsign: "Another headsign", direction_id: "0" }],
    stopTimes: [...rich.stopTimes, ...fixture.journeySources.stopTimes!.filter((entry) => entry.trip_id === "trip-bus-express")
      .map((entry) => ({ ...entry, trip_id: "trip-express-copy" }))],
  } });
  const baseline = new DatabaseSync(baselinePath, { readOnly: true });
  const database = new DatabaseSync(richPath, { readOnly: true });
  t.after(() => { baseline.close(); database.close(); });
  for (const old of baseline.prepare("SELECT * FROM services").all()) {
    assert.deepEqual(database.prepare("SELECT * FROM services WHERE service_id = ?").get(old.service_id!), old);
  }
  const loadGroup = (lineRef: string) => {
    const stored = database.prepare("SELECT * FROM journey_groups WHERE line_ref = ?").get(lineRef)!;
    const values = database.prepare("SELECT row_json FROM journey_rows WHERE group_id = ? ORDER BY row_kind, row_id")
      .all(stored.group_id!).map((entry) => JSON.parse(String(entry.row_json)));
    const revision = "a".repeat(64);
    const index = { schemaVersion: 1, revision, groupId: stored.group_id, lineMode: stored.line_mode,
      lineRef, pageCount: 1, rowCount: values.length, patternCount: values.filter((value) => value.kind === "pattern").length };
    const group = journeyPatterns.validateJourneyGroup(index, [
      { schemaVersion: 1, revision, groupId: stored.group_id, page: 0, nextPage: null, rows: values },
    ]);
    assert.ok(group);
    return group;
  };
  const bus = loadGroup("STIF:Line::C100:");
  assert.equal(bus.patterns.length, 8, "identical trips merge, but express/loop/restriction variants do not");
  const partial = bus.terminals.find((terminal) => terminal.labels.includes("Porte de Paris"))!;
  assert.equal(partial.terminalPlaceId, createPlaceIdentity("BUS", "44016").placeId);
  assert.deepEqual(partial.refs, ["STIF:StopPoint:Q:7969:", "STIF:StopPoint:Q:TERM-BUS-PARTIAL:"]);
  assert.deepEqual(partial.labels, ["Mairie", "Mairie de Stains", "Porte de Paris"]);
  const originRef = "STIF:StopPoint:Q:ART-BUS-1:";
  const reachable = journeyPatterns.reachableArrivals(bus, originRef);
  assert.ok(reachable.some((place) => place.label === "Arrêt intermédiaire"));
  assert.ok(reachable.some((place) => place.placeId === partial.terminalPlaceId));
  const unbound = bus.places.find((place) => place.label === "Arrêt sans rattachement")!;
  assert.match(unbound.placeId, /^plc_[A-Za-z0-9_-]{43}$/u);
  assert.ok(!reachable.some((place) => place.placeId === unbound.placeId), "restricted alighting is not offered");
  const restricted = bus.patterns.find((pattern) => pattern.stops[0].pickupType === 2)!;
  assert.deepEqual(restricted.stops.map((stop) => [stop.pickupType, stop.dropOffType]), [[2, 0], [3, 2], [1, 3]]);
  assert.equal(restricted.stops[1].stopRef, null, "a non-IDFM stop has no fabricated SIRI reference");
  assert.equal(restricted.stops[1].placeId, unbound.placeId);
  assert.ok(bus.patterns.some((pattern) => pattern.stops.every((stop) => stop.pickupType === 1)));
  assert.ok(bus.patterns.some((pattern) => pattern.stops.filter((stop) => stop.stopRef === originRef).length === 2));
  const full = bus.terminals.find((terminal) => terminal.labels.includes("Hôpital Européen"))!;
  assert.ok(bus.patterns.some((pattern) => pattern.terminalId === full.terminalId && pattern.stops.length === 2));
  assert.ok(bus.patterns.some((pattern) => pattern.terminalId === full.terminalId && pattern.stops.length === 4));
  assert.equal(database.prepare("SELECT count(*) AS n FROM journey_groups WHERE line_ref = 'STIF:Line::C100:'").get()!.n, 1);
  const annex = database.prepare(`
    SELECT annex.terminal_place_id FROM service_journeys AS annex JOIN services USING(service_id)
    WHERE services.monitoring_ref = ? AND services.destination_label = ?
  `);
  assert.equal(annex.get(originRef, "Porte de Paris")!.terminal_place_id, partial.terminalPlaceId);
  assert.equal(annex.get(originRef, "Hôpital Européen")!.terminal_place_id, full.terminalPlaceId);
  const rer = loadGroup("STIF:Line::C400:");
  assert.equal(rer.patterns.length, 2);
  assert.equal(new Set(rer.patterns.map((pattern) => pattern.stops[0].stopRef)).size, 1);
  assert.equal(new Set(rer.patterns.map((pattern) => pattern.terminalId)).size, 2);
  assert.ok(rer.terminals.every((terminal) => terminal.refs.every((ref) => ref.startsWith("STIF:StopArea:SP:"))));
});

test("drop_off_type admits absent and empty values but rejects non-GTFS restriction codes", async (t) => {
  const directory = workspace(t);
  const base = sourcesFor("fixture-2026-08-a");
  const path = join(directory, "empty-dropoff.sqlite");
  await buildCatalogCandidateFromRecords({ candidatePath: path, sourceRevision: "empty-dropoff", sources: {
    ...base, stopTimes: [...base.stopTimes].map((entry) => ({ ...entry, drop_off_type: "" })),
  } });
  const database = new DatabaseSync(path, { readOnly: true });
  t.after(() => database.close());
  const patterns = database.prepare("SELECT row_json FROM journey_rows WHERE row_kind = 'pattern'").all();
  assert.ok(patterns.every((entry) => JSON.parse(String(entry.row_json)).stops.every((stop) => stop.dropOffType === 0)));
  for (const value of ["4", "-1", "1.5", "not-a-code"]) {
    await assert.rejects(buildCatalogCandidateFromRecords({
      candidatePath: join(directory, `bad-${value}.sqlite`), sourceRevision: "invalid-dropoff",
      sources: { ...base, stopTimes: [...base.stopTimes].map((entry) => ({ ...entry, drop_off_type: value })) },
    }));
  }
});

test("streaming CSV admits optional fields while enforcing complete source row counts", async (t) => {
  const directory = workspace(t);
  const base = sourcesFor("fixture-2026-08-a");
  const gtfsNames: Partial<Record<keyof CatalogRecordSourceSet, string>> = {
    agency: "agency.txt", routes: "routes.txt", trips: "trips.txt", stops: "stops.txt",
    stopTimes: "stop_times.txt", objectCodes: "object_codes_extension.txt",
  };
  const writeSources = (name: string, stopTimes: readonly CsvRecord[], relations: readonly CsvRecord[] = base.relations): CatalogFileSourceSet => {
    const localEntries: Buffer[] = [];
    const centralEntries: Buffer[] = [];
    const external: Record<string, { path: string; delimiter: ","; expectedRows: number }> = {};
    let offset = 0;
    for (const [key, records] of Object.entries({ ...base, stopTimes, relations })) {
      const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
      const csv = columns.join(",") + "\n" + records.map((record) =>
        columns.map((column) => `"${String(record[column] ?? "").replaceAll('"', '""')}"`).join(",")).join("\n") + "\n";
      const entryName = gtfsNames[key as keyof CatalogRecordSourceSet];
      if (entryName === undefined) {
        const path = join(directory, `${name}-${key}.csv`);
        writeFileSync(path, csv);
        external[key] = { path, delimiter: ",", expectedRows: records.length };
        continue;
      }
      // Minimal uncompressed ZIP records keep this streaming fixture dependency-free.
      const filename = Buffer.from(entryName);
      const data = Buffer.from(csv);
      const checksum = crc32(data);
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0);
      local.writeUInt16LE(20, 4);
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(data.length, 18);
      local.writeUInt32LE(data.length, 22);
      local.writeUInt16LE(filename.length, 26);
      const central = Buffer.alloc(46);
      central.writeUInt32LE(0x02014b50, 0);
      central.writeUInt16LE(20, 4);
      central.writeUInt16LE(20, 6);
      central.writeUInt32LE(checksum, 16);
      central.writeUInt32LE(data.length, 20);
      central.writeUInt32LE(data.length, 24);
      central.writeUInt16LE(filename.length, 28);
      central.writeUInt32LE(offset, 42);
      localEntries.push(Buffer.concat([local, filename, data]));
      centralEntries.push(Buffer.concat([central, filename]));
      offset += local.length + filename.length + data.length;
    }
    const central = Buffer.concat(centralEntries);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(centralEntries.length, 8);
    end.writeUInt16LE(centralEntries.length, 10);
    end.writeUInt32LE(central.length, 12);
    end.writeUInt32LE(offset, 16);
    const gtfsZipPath = join(directory, `${name}-gtfs.zip`);
    writeFileSync(gtfsZipPath, Buffer.concat([...localEntries, central, end]));
    return { ...external, gtfsZipPath } as unknown as CatalogFileSourceSet;
  };
  for (const variant of ["present", "absent", "empty"] as const) {
    const stopTimes = [...base.stopTimes].map((record, index) => variant === "absent" ? record
      : { ...record, drop_off_type: variant === "empty" ? "" : String(index % 3 + 1) });
    const candidatePath = join(directory, `${variant}.sqlite`);
    await buildCatalogCandidate({ candidatePath, sourceRevision: `csv-${variant}`, sources: writeSources(variant, stopTimes) });
    const database = new DatabaseSync(candidatePath, { readOnly: true });
    try {
      const patterns = database.prepare("SELECT row_json FROM journey_rows WHERE row_kind = 'pattern'").all()
        .map((row) => JSON.parse(String(row.row_json)));
      const actual = new Set(patterns.flatMap((pattern) => pattern.stops.map((stop) => stop.dropOffType)));
      assert.deepEqual(actual, new Set(variant === "present" ? [1, 2, 3] : [0]));
    } finally {
      database.close();
    }
  }
  await assert.rejects(buildCatalogCandidate({
    candidatePath: join(directory, "invalid.sqlite"), sourceRevision: "csv-invalid",
    sources: writeSources("invalid", [...base.stopTimes].map((record, index) => index === 0
      ? { ...record, drop_off_type: "4" } : { ...record, drop_off_type: "0" })),
  }), { code: "INVALID_SOURCE" });

  const manager = new CatalogManager();
  manager.reload(join(directory, "absent.sqlite"));
  const queries = ["gare du nord", "chatelet", "porte de versailles", "saint lazare"];
  const expected = queries.flatMap((query) => manager.searchPlaces(query).map((place) => ({
    place,
    services: manager.listServices(place.placeId),
  })));
  const hierarchySources = writeSources("hierarchy", base.stopTimes, [...base.relations, ...hierarchyOnlyRelations]);
  const hierarchyPath = join(directory, "hierarchy.sqlite");
  await buildCatalogCandidate({
    candidatePath: hierarchyPath, sourceRevision: "csv-hierarchy", sources: hierarchySources,
  });
  manager.reload(hierarchyPath);
  assert.deepEqual(queries.flatMap((query) => manager.searchPlaces(query).map((place) => ({
    place,
    services: manager.listServices(place.placeId),
  }))), expected);
  await assert.rejects(buildCatalogCandidate({
    candidatePath: join(directory, "missing-hierarchy-count.sqlite"),
    sourceRevision: "csv-missing-hierarchy-count",
    sources: {
      ...hierarchySources,
      relations: { ...hierarchySources.relations, expectedRows: base.relations.length },
    },
  }), { code: "SOURCE_ROW_COUNT" });
});
