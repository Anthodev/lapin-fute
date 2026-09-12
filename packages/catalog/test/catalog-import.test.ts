import test from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRANSPORT_MODE } from "../../contracts/src/index.ts";
import type { TransportMode } from "../../contracts/src/index.ts";
import { CatalogManager } from "../src/catalog.ts";
import {
  activateCatalogCandidate,
  buildCatalogCandidateFromRecords,
  createPlaceIdentity,
  createServiceIdentity,
  downloadCatalogSource,
  refreshCatalogFromRecords,
} from "../src/catalog-import.ts";
import type {
  CatalogRecordSourceSet,
  CsvRecord,
} from "../src/catalog-import.ts";

interface Fixture {
  readonly schemaVersion: number;
  readonly fixtureVersion: string;
  readonly dataClassification: string;
  readonly attribution: readonly { readonly dataset: string; readonly url: string; readonly retrievedAt: string; readonly license: string }[];
  readonly sources: Readonly<Record<keyof CatalogRecordSourceSet, readonly Record<string, unknown>[]>>;
}

const fixtureUrl = new URL("../../../fixtures/catalog/idfm-v1.json", import.meta.url);
const fixtureText = readFileSync(fixtureUrl, "utf8");
const fixture = JSON.parse(fixtureText) as Fixture;

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
    arrets: [...sources.arrets, { arrid: "ARR-RER-CHILD", zdaid: "ZDA-RER" }],
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

test("parent-only relations retain valid routes without inventing an ART association", async (t) => {
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

  const noArtPath = join(directory, "no-invented-art.sqlite");
  const noArt = await buildCatalogCandidateFromRecords({
    candidatePath: noArtPath,
    sourceRevision: "fixture-no-invented-art",
    sources: {
      ...withParentOnly,
      relations: [
        ...withParentOnly.relations.filter((row) => row.artid !== "ART-BUS-1"),
        // A coincident ARR/ZDC value is not permission to manufacture a missing ART edge.
        { zdaid: "ZDA-BUS-1", arrid: "ART-BUS-1", artid: null, zdcid: "ART-BUS-1" },
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
  for (const requiredField of ["arrid", "zdaid"]) {
    await assert.rejects(buildCatalogCandidateFromRecords({
      candidatePath: join(directory, `invalid-parent-${requiredField}.sqlite`),
      sourceRevision: `fixture-invalid-parent-${requiredField}`,
      sources: {
        ...withParentOnly,
        relations: [{ ...parentOnly, [requiredField]: null }],
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
