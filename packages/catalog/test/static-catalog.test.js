import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, opendirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LIMITS, TRANSPORT_MODE, isPlaceSearchItem } from "../../contracts/src/index.ts";
import { buildCatalogCandidateFromRecords, createPlaceIdentity, createServiceIdentity } from "../src/catalog-import.ts";
import { SqliteCatalogReader } from "../src/catalog.ts";
import { publishStaticCatalog } from "../src/static-catalog.ts";
import journeyPatterns from "../../companion/src/journey-patterns.js";
import { createCatalogClient } from "../../config-page/src/catalog-client.js";
import { catalogSearchBucket, normalizeCatalogSearchText } from "../../config-page/src/search-text.js";

const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/catalog/idfm-v1.json", import.meta.url), "utf8"));

// Journey overlay rows merge into the base record sources; overlay stopTimes
// replace the base rows of the same trip while additional trips can add services.
function fixtureSources(sourceRevision) {
  const overlay = fixture.journeySources ?? {};
  const selected = (rows) => rows
    .filter((row) => !Array.isArray(row.revisions) || row.revisions.includes(sourceRevision))
    .map(({ revisions, ...row }) => row);
  return Object.fromEntries(Object.entries(fixture.sources).map(([key, rows]) => {
    const extra = selected(overlay[key] ?? []);
    if (key === "stopTimes") {
      const replaced = new Set(extra.map((row) => row.trip_id));
      return [key, [...selected(rows).filter((row) => !replaced.has(row.trip_id)), ...extra]];
    }
    return [key, [...selected(rows), ...extra]];
  }));
}

async function catalogFixture(t, sourceRevision = "fixture-2026-08-a") {
  const directory = mkdtempSync(join(tmpdir(), "lapin-fute-static-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const catalogPath = join(directory, "catalog.sqlite");
  const outputDirectory = join(directory, "static");
  await buildCatalogCandidateFromRecords({
    candidatePath: catalogPath,
    sourceRevision,
    createdAt: "2026-09-05T00:00:00.000Z",
    sources: fixtureSources(sourceRevision),
  });
  return { catalogPath, outputDirectory, attribution: fixture.attribution };
}

function opaqueId(prefix, tuple) {
  return prefix + createHash("sha256").update(tuple, "utf8").digest("base64url");
}

// Builds one minimal valid group (one place, one terminal, one two-stop pattern)
// with the importer's identity scheme and attaches the given services to it.
function journeyGroupFixture({ mode, lineRef, name, stopRef, terminalStopRef, serviceIds, nullTerminalPlaceIds = [] }) {
  const placeId = opaqueId("plc_", JSON.stringify(["journey-stop", [mode, lineRef, name]]));
  const terminalId = opaqueId("term_", JSON.stringify([mode, `${lineRef}-${name}-terminal`]));
  const stops = [
    { stopRef, placeId, pickupType: 0, dropOffType: 0 },
    { stopRef: terminalStopRef, placeId, pickupType: 0, dropOffType: 0 },
  ];
  const patternId = opaqueId("pat_", JSON.stringify([mode, lineRef, terminalId,
    stops.map((stop) => [stop.stopRef, stop.placeId, stop.pickupType, stop.dropOffType])]));
  return {
    mode,
    lineRef,
    groupId: opaqueId("grp_", JSON.stringify([mode, lineRef])),
    rows: [
      { kind: "place", placeId, label: `${name} départ` },
      { kind: "terminal", terminalId, terminalPlaceId: placeId, refs: [terminalStopRef], labels: [`${name} terminus`] },
      { kind: "pattern", patternId, terminalId, stops },
    ],
    annexes: [
      ...serviceIds.map((serviceId) => [serviceId, placeId]),
      ...nullTerminalPlaceIds.map((serviceId) => [serviceId, null]),
    ],
  };
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

function pageClient(directory, requests = []) {
  return createCatalogClient({
    setTimer(callback) { queueMicrotask(callback); return 1; },
    clearTimer() {},
    async fetchImpl(url, options) {
      requests.push(url);
      assert.equal(options.credentials, "omit");
      assert.equal(new Headers(options.headers).has("Authorization"), false);
      const path = join(directory, url.slice("catalog/".length));
      return existsSync(path)
        ? new Response(readFileSync(path), { headers: { "content-type": "application/json" } })
        : new Response(null, { status: 404 });
    },
  });
}

function* files(directory) {
  const entries = opendirSync(directory);
  try {
    for (let entry = entries.readSync(); entry !== null; entry = entries.readSync()) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) yield* files(path);
      else yield path;
    }
  } finally {
    entries.closeSync();
  }
}

test("validated catalog publication preserves all modes, stable service identity and exact legacy lookup", async (t) => {
  const options = await catalogFixture(t);
  const publication = publishStaticCatalog(options);
  const client = pageClient(options.outputDirectory);
  const reader = SqliteCatalogReader.open(options.catalogPath);
  const selections = ["gare du nord", "chatelet", "porte de versailles", "chatelet les halles", "saint lazare"];
  const modes = new Set();
  for (const query of selections) {
    for (const place of await client.searchPlaces(query)) {
      modes.add(place.mode);
      assert.equal(isPlaceSearchItem(place), true);
      assert.deepEqual(place, reader.searchPlaces(query).find((entry) => entry.placeId === place.placeId));
      const services = await client.listServices(place.placeId);
      assert.deepEqual(
        [...services].sort((left, right) => left.serviceId.localeCompare(right.serviceId)),
        reader.listServices(place.placeId).sort((left, right) => left.serviceId.localeCompare(right.serviceId)),
      );
      const nativeLines = new Map(services.map((service) => [service.routing.lineRef, {
        lineLabel: service.lineLabel, lineColor: service.lineColor, lineTextColor: service.lineTextColor,
      }]));
      assert.equal(place.lines.length, nativeLines.size);
      for (const line of nativeLines.values()) assert.ok(place.lines.some((entry) =>
        entry.lineLabel === line.lineLabel && entry.lineColor === line.lineColor && entry.lineTextColor === line.lineTextColor));
      for (const service of services) {
        assert.equal(service.lineMode, place.mode);
        assert.deepEqual(await client.lookupService(service.serviceId), service);
      }
    }
  }
  assert.deepEqual([...modes].sort(), [...TRANSPORT_MODE].sort());
  assert.deepEqual(publication.manifest.attribution, fixture.attribution);
  assert.equal(publication.manifest.sourceRevision, "fixture-2026-08-a");
  assert.equal(publication.placeCount, 6);
  assert.ok(publication.journeyGroupCount > 0);
  assert.ok(publication.journeyPageCount >= publication.journeyGroupCount);
  const identity = createServiceIdentity({ mode: "METRO", lineId: "C200", monitoringRef: "STIF:StopPoint:Q:ART-METRO-EAST:", directionId: "0", destinationRef: "DEST:METRO-SOUTH" });
  const existing = await client.lookupService(identity.serviceId);
  assert.deepEqual(existing?.routing, {
    monitoringRef: "STIF:StopPoint:Q:ART-METRO-EAST:",
    lineRef: "STIF:Line::C200:",
    destinationRef: "STIF:StopPoint:Q:TERM-METRO-SOUTH:",
  });
  assert.equal(await client.lookupService(`svc_${"z".repeat(43)}`), null);
  const before = readFileSync(join(options.outputDirectory, "manifest.json"));
  const repeated = publishStaticCatalog(options);
  assert.equal(repeated.manifest.revision, publication.manifest.revision);
  assert.deepEqual(readFileSync(join(options.outputDirectory, "manifest.json")), before);
});

test("search publication keeps every native line in natural order and refreshes display metadata by revision", async (t) => {
  const options = await catalogFixture(t);
  const database = new DatabaseSync(options.catalogPath);
  const insertPlace = database.prepare("INSERT INTO places VALUES (?, ?, ?, ?, ?)");
  const insertSearch = database.prepare("INSERT INTO place_search(search_text, place_id) VALUES (?, ?)");
  const insertService = database.prepare("INSERT INTO services VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const busLines = [
    { lineId: "C-UNI10", lineLabel: "10", lineColor: "#333333" },
    { lineId: "C-UNI2-B", lineLabel: "2", lineColor: "#222222" },
    { lineId: "C-UNI2-C", lineLabel: "2", lineColor: "#111111" },
    { lineId: "C-UNI2-A", lineLabel: "2", lineColor: "#111111" },
  ];
  const journeys = new Map();
  try {
    database.exec("BEGIN");
    for (const [mode, lines] of [
      ["BUS", busLines],
      ["METRO", [{ lineId: "C-UNI13", lineLabel: "13", lineColor: "#82c8e6" }]],
    ]) {
      const place = createPlaceIdentity(mode, "STATIC-UNIVERSITY");
      insertPlace.run(place.placeId, "Saint-Denis Université", "Saint-Denis", mode, place.canonicalTuple);
      insertSearch.run(normalizeCatalogSearchText(`Saint-Denis Université ${mode}`), place.placeId);
      for (const line of lines) {
        for (const direction of ["0", "1"]) {
          const lineRef = `STIF:Line::${line.lineId}:`;
          const monitoringRef = `STIF:StopPoint:Q:UNI-${line.lineId}-${direction}:`;
          const destinationRef = `STIF:StopPoint:Q:UNI-TERM-${line.lineId}-${direction}:`;
          const service = createServiceIdentity({ mode, lineId: line.lineId, monitoringRef, directionId: direction, destinationRef });
          insertService.run(
            service.serviceId, place.placeId, "Saint-Denis Université", line.lineLabel, `Terminus ${direction}`,
            line.lineColor, "#ffffff", monitoringRef, lineRef, direction, destinationRef, service.canonicalTuple,
          );
          const key = `${mode}\u0000${lineRef}`;
          if (!journeys.has(key)) journeys.set(key, { mode, lineRef, name: `Université ${line.lineLabel}`, serviceIds: [] });
          journeys.get(key).serviceIds.push(service.serviceId);
        }
      }
    }
    for (const group of journeys.values()) {
      attachJourneyGroup(database, journeyGroupFixture({
        mode: group.mode,
        lineRef: group.lineRef,
        name: group.name,
        stopRef: `STIF:StopPoint:Q:UNI-STOP-${group.lineRef.slice(11, -1)}:`,
        terminalStopRef: `STIF:StopPoint:Q:UNI-END-${group.lineRef.slice(11, -1)}:`,
        serviceIds: group.serviceIds,
      }));
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }

  const first = publishStaticCatalog(options);
  const requests = [];
  const oldClient = pageClient(options.outputDirectory, requests);
  const places = await oldClient.searchPlaces("universite");
  assert.equal(places.length, 2);
  assert.equal(places.every(isPlaceSearchItem), true);
  assert.equal(requests.some((url) => /\/(?:places|services)\//u.test(url)), false);
  const expectedBus = [
    { lineLabel: "2", lineColor: "#111111", lineTextColor: "#ffffff" },
    { lineLabel: "2", lineColor: "#222222", lineTextColor: "#ffffff" },
    { lineLabel: "2", lineColor: "#111111", lineTextColor: "#ffffff" },
    { lineLabel: "10", lineColor: "#333333", lineTextColor: "#ffffff" },
  ];
  assert.deepEqual(places.find((place) => place.mode === "BUS").lines, expectedBus);
  assert.deepEqual(places.find((place) => place.mode === "METRO").lines, [
    { lineLabel: "13", lineColor: "#82c8e6", lineTextColor: "#ffffff" },
  ]);
  const live = SqliteCatalogReader.open(options.catalogPath).searchPlaces("universite");
  for (const place of places) assert.deepEqual(place, live.find((entry) => entry.placeId === place.placeId));

  const update = new DatabaseSync(options.catalogPath);
  try {
    update.prepare("UPDATE services SET line_label = ?, line_color = ?, line_text_color = ? WHERE line_ref = ?")
      .run("3", "#abcdef", "#000000", "STIF:Line::C-UNI2-B:");
  } finally {
    update.close();
  }
  const second = publishStaticCatalog(options);
  assert.equal(second.manifest.sourceRevision, first.manifest.sourceRevision);
  assert.notEqual(second.manifest.revision, first.manifest.revision);
  const refreshed = await pageClient(options.outputDirectory).searchPlaces("universite");
  assert.deepEqual(refreshed.find((place) => place.mode === "BUS").lines, [
    expectedBus[0], expectedBus[2],
    { lineLabel: "3", lineColor: "#abcdef", lineTextColor: "#000000" },
    expectedBus[3],
  ]);
  assert.deepEqual((await oldClient.searchPlaces("universite")).find((place) => place.mode === "BUS").lines, expectedBus);
});

test("new publication removes a stale service only for new sessions and keeps open sessions on their revision", async (t) => {
  const first = await catalogFixture(t);
  const oldPublication = publishStaticCatalog(first);
  const oldClient = pageClient(first.outputDirectory);
  const metro = (await oldClient.searchPlaces("chatelet")).find((place) => place.mode === "METRO");
  const removed = (await oldClient.listServices(metro.placeId)).find((service) => service.destinationLabel === "Porte de Clignancourt");
  assert.ok(removed);
  const second = await catalogFixture(t, "fixture-2026-08-b");
  const next = publishStaticCatalog({ ...second, outputDirectory: first.outputDirectory });
  assert.notEqual(next.manifest.revision, oldPublication.manifest.revision);
  assert.equal(JSON.parse(readFileSync(join(first.outputDirectory, "manifest.json"), "utf8")).revision, next.manifest.revision);
  assert.deepEqual(await oldClient.lookupService(removed.serviceId), removed);
  assert.equal(await pageClient(first.outputDirectory).lookupService(removed.serviceId), null);
});

test("publisher splits search and busy-place pages by decoded bytes without dropping bus rows or long routing", async (t) => {
  const options = await catalogFixture(t);
  const database = new DatabaseSync(options.catalogPath);
  const insertPlace = database.prepare("INSERT INTO places VALUES (?, ?, ?, ?, ?)");
  const insertSearch = database.prepare("INSERT INTO place_search(search_text, place_id) VALUES (?, ?)");
  const insertService = database.prepare("INSERT INTO services VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const busy = createPlaceIdentity("BUS", "STATIC-BUSY");
  // Journey annex documents bound every routing ref at 256 UTF-8 bytes, so the
  // longest publishable monitoring ref is used at full size; page splitting then
  // comes from service volume on the busy place.
  const longMonitoring = `STIF:StopPoint:Q:${"x".repeat(230)}:`;
  const journeys = new Map();
  const collectGroup = (mode, lineRef, name, serviceId) => {
    const key = `${mode}\u0000${lineRef}`;
    if (!journeys.has(key)) journeys.set(key, { mode, lineRef, name, serviceIds: [] });
    journeys.get(key).serviceIds.push(serviceId);
  };
  let longServiceId;
  const expectedBusyServices = new Map();
  try {
    database.exec("BEGIN");
    for (let index = 0; index < 800; index += 1) {
      const stopLabel = `Café ${String(index).padStart(4, "0")} ${"é".repeat(37)}`;
      const locality = `Saint ${"é".repeat(42)}`;
      const place = createPlaceIdentity("BUS", `STATIC-${index}`);
      const monitoringRef = `STIF:StopPoint:Q:PAGE-${String(index).padStart(4, "0")}:`;
      const destinationRef = `STIF:StopPoint:Q:PAGE-TERM-${String(index).padStart(4, "0")}:`;
      const service = createServiceIdentity({ mode: "BUS", lineId: "C-STATIC", monitoringRef, directionId: "0", destinationRef });
      insertPlace.run(place.placeId, stopLabel, locality, "BUS", place.canonicalTuple);
      insertSearch.run(normalizeCatalogSearchText(`${stopLabel} ${locality}`), place.placeId);
      insertService.run(service.serviceId, place.placeId, stopLabel, "99", "Fixture terminal", "#123456", "#ffffff", monitoringRef, "STIF:Line::C-STATIC:", "0", destinationRef, service.canonicalTuple);
      collectGroup("BUS", "STIF:Line::C-STATIC:", "Static 99", service.serviceId);
    }
    insertPlace.run(busy.placeId, "Busy fixture", null, "BUS", busy.canonicalTuple);
    insertSearch.run("busy fixture", busy.placeId);
    for (let index = 0; index < 800; index += 1) {
      const destinationRef = `STIF:StopPoint:Q:BUSY-TERM-${index}:`;
      const lineId = `C-BUSY-${index}`;
      const service = createServiceIdentity({ mode: "BUS", lineId, monitoringRef: longMonitoring, directionId: "0", destinationRef });
      longServiceId ??= service.serviceId;
      expectedBusyServices.set(service.serviceId, String(index).padStart(3, "0"));
      insertService.run(service.serviceId, busy.placeId, "Busy fixture", String(index).padStart(3, "0"), `Fixture terminal ${"y".repeat(60)}`, "#123456", "#ffffff", longMonitoring, `STIF:Line::${lineId}:`, "0", destinationRef, service.canonicalTuple);
      collectGroup("BUS", `STIF:Line::${lineId}:`, `Affluent ${String(index).padStart(3, "0")}`, service.serviceId);
    }
    for (const group of journeys.values()) {
      attachJourneyGroup(database, journeyGroupFixture({
        mode: group.mode,
        lineRef: group.lineRef,
        name: group.name,
        stopRef: `STIF:StopPoint:Q:PAGE-STOP-${group.lineRef.slice(11, -1)}:`,
        terminalStopRef: `STIF:StopPoint:Q:PAGE-END-${group.lineRef.slice(11, -1)}:`,
        serviceIds: group.serviceIds,
      }));
    }
    database.exec("COMMIT");
  } finally {
    database.close();
  }
  const publication = publishStaticCatalog(options);
  const revision = publication.manifest.revision;
  const firstSearch = JSON.parse(readFileSync(join(options.outputDirectory, revision, "search", "63_61", "0.json"), "utf8"));
  const firstPlace = JSON.parse(readFileSync(join(options.outputDirectory, revision, "places", busy.placeId, "0.json"), "utf8"));
  assert.equal(firstSearch.nextPage, 1);
  assert.equal(firstPlace.nextPage, 1);
  const requests = [];
  const client = pageClient(options.outputDirectory, requests);
  const matches = await client.searchPlaces("café");
  assert.deepEqual(matches.map((place) => place.stopLabel.slice(0, 9)), Array.from({ length: 20 }, (_, index) => `Café ${String(index).padStart(4, "0")}`));
  assert.equal(requests.some((url) => /\/(?:places|services)\//u.test(url)), false);
  for (const place of matches) assert.deepEqual(place.lines, [
    { lineLabel: "99", lineColor: "#123456", lineTextColor: "#ffffff" },
  ]);
  const busyMatches = await client.searchPlaces("busy");
  assert.deepEqual(busyMatches[0].lines, [...expectedBusyServices.values()].map((lineLabel) => ({
    lineLabel, lineColor: "#123456", lineTextColor: "#ffffff",
  })));
  const services = await client.listServices(busy.placeId);
  assert.equal(services.length, expectedBusyServices.size);
  assert.deepEqual(new Map(services.map((service) => [service.serviceId, service.lineLabel])), expectedBusyServices);
  assert.equal((await client.lookupService(longServiceId)).routing.monitoringRef, longMonitoring);
  assert.equal(requests.some((url) => url.includes("/search/63_61/1.json")), true);
  assert.equal(requests.some((url) => url.includes(`/places/${busy.placeId}/1.json`)), true);
  assert.deepEqual((await client.searchPlaces("C.")).map((place) => place.placeId), matches.map((place) => place.placeId));
  assert.equal(requests.some((url) => url.includes("/search/63/1.json")), true);
  const exportedPlaces = [];
  for (let page = 0; page !== null;) {
    const body = JSON.parse(readFileSync(join(options.outputDirectory, revision, "search", "63_61", `${page}.json`), "utf8"));
    exportedPlaces.push(...body.places.map((place) => place.placeId));
    page = body.nextPage;
  }
  assert.deepEqual(exportedPlaces.sort(), Array.from({ length: 800 }, (_, index) =>
    createPlaceIdentity("BUS", `STATIC-${index}`).placeId).sort());
  let fileCount = 0;
  let totalBytes = 0;
  let maximum = 0;
  for (const path of files(options.outputDirectory)) {
    const bytes = readFileSync(path);
    const decoded = JSON.parse(bytes.toString("utf8"));
    assert.equal(decoded.revision, revision);
    assert.ok(bytes.byteLength <= LIMITS.httpResponseBytes);
    fileCount += 1;
    totalBytes += bytes.byteLength;
    maximum = Math.max(maximum, bytes.byteLength);
  }
  assert.equal(publication.fileCount, fileCount);
  assert.equal(publication.totalBytes, totalBytes);
  assert.equal(publication.maximumFileBytes, maximum);
  assert.equal(publication.placeCount, 807);
});

test("failed oversized publication preserves the previous manifest and its immutable catalog", async (t) => {
  const options = await catalogFixture(t);
  const good = publishStaticCatalog(options);
  const before = readFileSync(join(options.outputDirectory, "manifest.json"));
  const database = new DatabaseSync(options.catalogPath);
  try {
    database.prepare("UPDATE services SET monitoring_ref = ? WHERE service_id = (SELECT min(service_id) FROM services)").run("x".repeat(LIMITS.httpResponseBytes));
  } finally {
    database.close();
  }
  // The oversized routing now trips the journey annex validation before any byte is written.
  assert.throws(() => publishStaticCatalog(options), { code: "CATALOG_VALIDATION_FAILED" });
  assert.deepEqual(readFileSync(join(options.outputDirectory, "manifest.json")), before);
  assert.deepEqual((await pageClient(options.outputDirectory).searchPlaces("saint lazare")).map((place) => place.mode), ["TRANSILIEN"]);
  assert.equal(existsSync(join(options.outputDirectory, good.manifest.revision)), true);
});

test("publication exposes only dataset attribution, never operator credentials or signed download URLs", async (t) => {
  const options = await catalogFixture(t);
  const sentinel = "operator-test-secret-not-for-static-output";
  const publication = publishStaticCatalog({
    ...options,
    datasetToken: sentinel,
    attribution: options.attribution.map((source) => ({ ...source, authorization: sentinel, apiKey: sentinel })),
  });
  for (const path of files(options.outputDirectory)) {
    assert.equal(readFileSync(path, "utf8").includes(sentinel), false);
  }
  const before = readFileSync(join(options.outputDirectory, "manifest.json"));
  assert.throws(() => publishStaticCatalog({
    ...options,
    attribution: [{ ...options.attribution[0], url: `${options.attribution[0].url}?apikey=${sentinel}` }],
  }), /public dataset metadata URL/u);
  assert.deepEqual(readFileSync(join(options.outputDirectory, "manifest.json")), before);
  assert.equal(publication.manifest.attribution.some((source) => Object.hasOwn(source, "authorization")), false);
});

test("search bucket addressing uses Unicode codepoints rather than UTF-16 units", () => {
  assert.equal(catalogSearchBucket(normalizeCatalogSearchText("École")), "65_63");
  assert.equal(catalogSearchBucket("a"), "61");
  assert.equal(catalogSearchBucket("𐐨lpha"), "10428_6c");
});

test("journey publication writes every annex and bounded paginated groups load from published bytes", async (t) => {
  const options = await catalogFixture(t);
  const database = new DatabaseSync(options.catalogPath);
  let bigGroupId;
  let bigServiceId;
  let extraServiceId;
  let groupTotal;
  try {
    const host = database.prepare("SELECT place_id AS placeId, stop_label AS stopLabel FROM places WHERE mode = 'BUS' LIMIT 1").get();
    const lineRef = "STIF:Line::C-BIG:";
    const monitoringRef = "STIF:StopPoint:Q:ART-BIG:";
    const destinationRef = "STIF:StopPoint:Q:TERM-BIG:";
    const service = createServiceIdentity({ mode: "BUS", lineId: "C-BIG", monitoringRef, directionId: "0", destinationRef });
    const extra = createServiceIdentity({ mode: "BUS", lineId: "C-BIG", monitoringRef: "STIF:StopPoint:Q:ART-BIG-2:", directionId: "0", destinationRef: "STIF:StopPoint:Q:TERM-BIG-2:" });
    bigServiceId = service.serviceId;
    extraServiceId = extra.serviceId;
    const placeId = opaqueId("plc_", JSON.stringify(["journey-stop", ["BUS", lineRef, "big"]]));
    const terminalId = opaqueId("term_", JSON.stringify(["BUS", `${lineRef}-big-terminal`]));
    const stops = (suffix) => Array.from({ length: journeyPatterns.JOURNEY_LIMITS.stops }, (_, index) => ({
      stopRef: `STIF:StopPoint:Q:${suffix}-${String(index).padStart(4, "0")}:`,
      placeId, pickupType: 0, dropOffType: 0,
    }));
    const pattern = (patternStops) => ({
      kind: "pattern",
      patternId: opaqueId("pat_", JSON.stringify(["BUS", lineRef, terminalId,
        patternStops.map((stop) => [stop.stopRef, stop.placeId, stop.pickupType, stop.dropOffType])])),
      terminalId,
      stops: patternStops,
    });
    bigGroupId = opaqueId("grp_", JSON.stringify(["BUS", lineRef]));
    database.exec("BEGIN");
    const insertService = database.prepare("INSERT INTO services VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    for (const [target, monitoring, destination] of [
      [service, monitoringRef, destinationRef],
      [extra, "STIF:StopPoint:Q:ART-BIG-2:", "STIF:StopPoint:Q:TERM-BIG-2:"],
    ]) {
      insertService.run(target.serviceId, host.placeId, host.stopLabel, "BIG", "Fixture terminal", "#123456", "#ffffff", monitoring, lineRef, "0", destination, target.canonicalTuple);
    }
    database.prepare("INSERT INTO journey_groups VALUES (?, ?, ?)").run(bigGroupId, "BUS", lineRef);
    const insertRow = database.prepare("INSERT INTO journey_rows VALUES (?, ?, ?, ?)");
    const place = { kind: "place", placeId, label: "Grand Boucle" };
    const terminal = { kind: "terminal", terminalId, terminalPlaceId: placeId, refs: ["STIF:StopPoint:Q:TERM-BIG:"], labels: ["Grand Boucle terminus"] };
    for (const row of [place, terminal, pattern(stops("LOOP")), pattern(stops("ROUND"))]) {
      const rowId = row.kind === "place" ? row.placeId : row.kind === "terminal" ? row.terminalId : row.patternId;
      insertRow.run(bigGroupId, row.kind, rowId, JSON.stringify(row));
    }
    const insertAnnex = database.prepare("INSERT INTO service_journeys VALUES (?, ?, ?)");
    insertAnnex.run(service.serviceId, bigGroupId, placeId);
    insertAnnex.run(extra.serviceId, bigGroupId, null);
    groupTotal = database.prepare("SELECT COUNT(*) AS count FROM journey_groups").get().count;
    database.exec("COMMIT");
  } finally {
    database.close();
  }

  const publication = publishStaticCatalog(options);
  const revision = publication.manifest.revision;
  const root = join(options.outputDirectory, revision);
  assert.deepEqual(Object.keys(publication.manifest).sort(), ["attribution", "createdAt", "revision", "schemaVersion", "sourceRevision"]);
  assert.equal(groupTotal, publication.journeyGroupCount);

  // One valid annex per published service, consistent with its service document.
  const annexGroups = new Set();
  let annexCount = 0;
  for (const path of files(join(root, "services"))) {
    const document = JSON.parse(readFileSync(path, "utf8"));
    const annex = JSON.parse(readFileSync(join(root, "journeys", "services", `${document.service.serviceId}.json`), "utf8"));
    assert.equal(journeyPatterns.isServiceJourneyDocument(annex), true);
    assert.equal(annex.serviceId, document.service.serviceId);
    assert.deepEqual(annex.routing, document.service.routing);
    assert.equal(annex.lineMode, document.service.lineMode);
    assert.equal(annex.revision, revision);
    annexGroups.add(annex.groupId);
    annexCount += 1;
    if (document.service.serviceId === extraServiceId) assert.equal(annex.terminalPlaceId, null);
  }
  assert.equal(annexCount, publication.serviceCount);
  assert.equal(annexGroups.size, publication.journeyGroupCount);

  // Groups load page by page from the published bytes: order, counts and budgets hold.
  let pageCount = 0;
  let bigPages;
  for (const groupId of annexGroups) {
    const directory = join(root, "journeys", "groups", groupId);
    const index = JSON.parse(readFileSync(join(directory, "index.json"), "utf8"));
    assert.equal(journeyPatterns.isJourneyGroupIndex(index), true);
    assert.equal(index.revision, revision);
    assert.equal(index.groupId, groupId);
    const pages = [];
    let rows = 0;
    let patterns = 0;
    let groupBytes = 0;
    let phase = 0;
    let lastId = "";
    for (let pageNumber = 0; pageNumber < index.pageCount; pageNumber += 1) {
      const raw = readFileSync(join(directory, `${pageNumber}.json`));
      assert.ok(raw.byteLength <= journeyPatterns.JOURNEY_LIMITS.documentBytes);
      groupBytes += raw.byteLength;
      const document = JSON.parse(raw.toString("utf8"));
      assert.equal(journeyPatterns.isJourneyGroupPage(document), true);
      assert.equal(document.page, pageNumber);
      assert.equal(document.nextPage, pageNumber + 1 < index.pageCount ? pageNumber + 1 : null);
      for (const row of document.rows) {
        const rowPhase = row.kind === "place" ? 0 : row.kind === "terminal" ? 1 : 2;
        assert.ok(rowPhase >= phase);
        if (rowPhase !== phase) {
          phase = rowPhase;
          lastId = "";
        }
        const rowId = row.kind === "place" ? row.placeId : row.kind === "terminal" ? row.terminalId : row.patternId;
        assert.ok(lastId < rowId);
        lastId = rowId;
        rows += 1;
        if (row.kind === "pattern") patterns += 1;
      }
      pages.push(document);
      pageCount += 1;
    }
    assert.ok(groupBytes <= journeyPatterns.JOURNEY_LIMITS.groupBytes);
    assert.equal(rows, index.rowCount);
    assert.equal(patterns, index.patternCount);
    assert.notEqual(journeyPatterns.validateJourneyGroup(index, pages), null);
    if (groupId === bigGroupId) {
      bigPages = pages;
      assert.ok(index.pageCount >= 2);
      assert.equal(index.rowCount, 4);
      assert.equal(index.patternCount, 2);
    }
  }
  assert.equal(pageCount, publication.journeyPageCount);
  assert.ok(bigPages.length >= 2);
  // Pattern rows never split: the page holding the oversized pattern ends at its boundary.
  assert.equal(bigPages[0].rows[bigPages[0].rows.length - 1].kind, "pattern");
  assert.equal(bigPages.at(-1).nextPage, null);
  const bigAnnex = JSON.parse(readFileSync(join(root, "journeys", "services", `${bigServiceId}.json`), "utf8"));
  assert.equal(bigAnnex.groupId, bigGroupId);
  assert.equal(bigAnnex.terminalPlaceId, bigPages[0].rows[0].placeId);
});

test("journey-only order and restriction changes move the revision while service payloads stay unchanged", async (t) => {
  const options = await catalogFixture(t);
  const database = new DatabaseSync(options.catalogPath);
  let groupId;
  let originalRowId;
  let originalRowJson;
  let seed;
  try {
    const host = database.prepare("SELECT place_id AS placeId, stop_label AS stopLabel FROM places WHERE mode = 'BUS' LIMIT 1").get();
    const lineRef = "STIF:Line::C-DIGEST:";
    const monitoringRef = "STIF:StopPoint:Q:ART-DIGEST:";
    const service = createServiceIdentity({ mode: "BUS", lineId: "C-DIGEST", monitoringRef, directionId: "0", destinationRef: "STIF:StopPoint:Q:TERM-DIGEST:" });
    const placeIds = ["Amont", "Milieu", "Terminus"].map((suffix) => opaqueId("plc_", JSON.stringify(["journey-stop", ["BUS", lineRef, suffix]])));
    const terminalId = opaqueId("term_", JSON.stringify(["BUS", `${lineRef}-digest-terminal`]));
    const stops = placeIds.map((placeId, index) => ({
      stopRef: `STIF:StopPoint:Q:DIGEST-${index}:`, placeId, pickupType: 0, dropOffType: 0,
    }));
    seed = { lineRef, terminalId, stops };
    groupId = opaqueId("grp_", JSON.stringify(["BUS", lineRef]));
    database.exec("BEGIN");
    database.prepare("INSERT INTO services VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
      service.serviceId, host.placeId, host.stopLabel, "DIGEST", "Fixture terminal", "#123456", "#ffffff",
      monitoringRef, lineRef, "0", "STIF:StopPoint:Q:TERM-DIGEST:", service.canonicalTuple);
    database.prepare("INSERT INTO journey_groups VALUES (?, ?, ?)").run(groupId, "BUS", lineRef);
    const insertRow = database.prepare("INSERT INTO journey_rows VALUES (?, ?, ?, ?)");
    const labels = ["Digest Amont", "Digest Milieu", "Digest Terminus"];
    for (const [index, placeId] of placeIds.entries()) {
      insertRow.run(groupId, "place", placeId, JSON.stringify({ kind: "place", placeId, label: labels[index] }));
    }
    insertRow.run(groupId, "terminal", terminalId, JSON.stringify({
      kind: "terminal", terminalId, terminalPlaceId: placeIds[2],
      refs: ["STIF:StopPoint:Q:DIGEST-2:"], labels: ["Digest Terminus terminus"],
    }));
    originalRowId = opaqueId("pat_", JSON.stringify(["BUS", lineRef, terminalId,
      stops.map((stop) => [stop.stopRef, stop.placeId, stop.pickupType, stop.dropOffType])]));
    originalRowJson = JSON.stringify({ kind: "pattern", patternId: originalRowId, terminalId, stops });
    insertRow.run(groupId, "pattern", originalRowId, originalRowJson);
    database.prepare("INSERT INTO service_journeys VALUES (?, ?, ?)").run(service.serviceId, groupId, placeIds[2]);
    database.exec("COMMIT");
  } finally {
    database.close();
  }

  const mutatedRowJson = (change) => {
    const stops = seed.stops.map((stop) => ({ ...stop }));
    change(stops);
    return JSON.stringify({
      kind: "pattern",
      patternId: opaqueId("pat_", JSON.stringify(["BUS", seed.lineRef, seed.terminalId,
        stops.map((stop) => [stop.stopRef, stop.placeId, stop.pickupType, stop.dropOffType])])),
      terminalId: seed.terminalId,
      stops,
    });
  };
  const replacePattern = (rowJson) => {
    const writer = new DatabaseSync(options.catalogPath);
    try {
      writer.exec("BEGIN");
      writer.prepare("DELETE FROM journey_rows WHERE group_id = ? AND row_kind = 'pattern'").run(groupId);
      writer.prepare("INSERT INTO journey_rows VALUES (?, ?, ?, ?)").run(groupId, "pattern", JSON.parse(rowJson).patternId, rowJson);
      writer.exec("COMMIT");
    } finally {
      writer.close();
    }
  };

  const first = publishStaticCatalog(options);
  replacePattern(mutatedRowJson((stops) => { stops[1].dropOffType = 1; }));
  const restricted = publishStaticCatalog(options);
  assert.notEqual(restricted.manifest.revision, first.manifest.revision);
  assert.equal(restricted.placeCount, first.placeCount);
  assert.equal(restricted.serviceCount, first.serviceCount);
  const firstRoot = join(options.outputDirectory, first.manifest.revision);
  const restrictedRoot = join(options.outputDirectory, restricted.manifest.revision);
  let journeyDifference = 0;
  for (const path of files(firstRoot)) {
    const relative = path.slice(firstRoot.length + 1);
    const nextPath = join(restrictedRoot, relative);
    const { revision: originalRevision, ...originalPayload } = JSON.parse(readFileSync(path, "utf8"));
    const { revision: nextRevision, ...nextPayload } = JSON.parse(readFileSync(nextPath, "utf8"));
    assert.equal(originalRevision, first.manifest.revision);
    assert.equal(nextRevision, restricted.manifest.revision);
    if (relative.startsWith("journeys/")) {
      if (JSON.stringify(nextPayload) !== JSON.stringify(originalPayload)) journeyDifference += 1;
      continue;
    }
    assert.deepEqual(nextPayload, originalPayload);
  }
  assert.ok(journeyDifference > 0);

  replacePattern(originalRowJson);
  const restored = publishStaticCatalog(options);
  assert.equal(restored.manifest.revision, first.manifest.revision);

  replacePattern(mutatedRowJson((stops) => { [stops[0], stops[1]] = [stops[1], stops[0]]; }));
  const reordered = publishStaticCatalog(options);
  assert.notEqual(reordered.manifest.revision, first.manifest.revision);
  assert.notEqual(reordered.manifest.revision, restricted.manifest.revision);

  // The published revision is immutable byte for byte, journeys included.
  const tampered = join(options.outputDirectory, reordered.manifest.revision, "journeys", "groups", groupId, "0.json");
  writeFileSync(tampered, "{}");
  const before = readFileSync(join(options.outputDirectory, "manifest.json"));
  assert.throws(() => publishStaticCatalog(options), /immutable revision differs/u);
  assert.deepEqual(readFileSync(join(options.outputDirectory, "manifest.json")), before);
});

test("invalid journey content fails validation and preserves the previous manifest and revision", async (t) => {
  const patternRow = "SELECT row_id AS rowId, row_json AS rowJson FROM journey_rows WHERE row_kind = 'pattern' LIMIT 1";
  const cases = [
    { name: "broken row JSON", mutate: (database) => {
      const row = database.prepare(patternRow).get();
      database.prepare("UPDATE journey_rows SET row_json = '{' WHERE row_kind = 'pattern' AND row_id = ?").run(row.rowId);
    } },
    { name: "row identity mismatch", mutate: (database) => {
      const row = database.prepare(patternRow).get();
      const place = database.prepare("SELECT row_json AS rowJson FROM journey_rows WHERE row_kind = 'place' LIMIT 1").get();
      database.prepare("UPDATE journey_rows SET row_json = ? WHERE row_kind = 'pattern' AND row_id = ?").run(place.rowJson, row.rowId);
    } },
    { name: "oversized journey row", mutate: (database) => {
      const row = database.prepare(patternRow).get();
      database.prepare("UPDATE journey_rows SET row_json = ? WHERE row_kind = 'pattern' AND row_id = ?")
        .run(row.rowJson + " ".repeat(journeyPatterns.JOURNEY_LIMITS.documentBytes + 1), row.rowId);
    } },
    { name: "missing annex coverage", mutate: (database) => {
      database.prepare("DELETE FROM service_journeys WHERE service_id = (SELECT min(service_id) FROM service_journeys)").run();
    } },
    { name: "journey row without group", code: "CATALOG_FOREIGN_KEY", mutate: (database) => {
      database.prepare("INSERT INTO journey_rows VALUES (?, ?, ?, ?)").run(`grp_${"z".repeat(43)}`, "place", `plc_${"z".repeat(43)}`,
        JSON.stringify({ kind: "place", placeId: `plc_${"z".repeat(43)}`, label: "Orphelin" }));
    } },
    { name: "group without service", mutate: (database) => {
      database.prepare("INSERT INTO journey_groups VALUES (?, ?, ?)").run(`grp_${"y".repeat(43)}`, "BUS", "STIF:Line::C-ORPHAN:");
    } },
  ];
  for (const { name, mutate, code = "CATALOG_VALIDATION_FAILED" } of cases) {
    const options = await catalogFixture(t);
    const good = publishStaticCatalog(options);
    const before = readFileSync(join(options.outputDirectory, "manifest.json"));
    const database = new DatabaseSync(options.catalogPath);
    try {
      // Model a corrupt external candidate, not a write through the importer.
      database.exec("PRAGMA foreign_keys = OFF");
      database.exec("BEGIN");
      mutate(database);
      database.exec("COMMIT");
    } finally {
      database.close();
    }
    assert.throws(() => publishStaticCatalog(options), { code }, name);
    assert.deepEqual(readFileSync(join(options.outputDirectory, "manifest.json")), before, name);
    assert.equal(existsSync(join(options.outputDirectory, good.manifest.revision)), true, name);
    assert.equal((await pageClient(options.outputDirectory).searchPlaces("saint lazare")).length > 0, true, name);
  }
});
