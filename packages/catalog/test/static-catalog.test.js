import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, opendirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LIMITS, TRANSPORT_MODE, isPlaceSearchItem } from "../../contracts/src/index.ts";
import { buildCatalogCandidateFromRecords, createPlaceIdentity, createServiceIdentity } from "../src/catalog-import.ts";
import { SqliteCatalogReader } from "../src/catalog.ts";
import { publishStaticCatalog } from "../src/static-catalog.ts";
import { createCatalogClient } from "../../config-page/src/catalog-client.js";
import { catalogSearchBucket, normalizeCatalogSearchText } from "../../config-page/src/search-text.js";

const fixture = JSON.parse(readFileSync(new URL("../../../fixtures/catalog/idfm-v1.json", import.meta.url), "utf8"));

async function catalogFixture(t, sourceRevision = "fixture-2026-08-a") {
  const directory = mkdtempSync(join(tmpdir(), "lapin-fute-static-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const catalogPath = join(directory, "catalog.sqlite");
  const outputDirectory = join(directory, "static");
  const sources = Object.fromEntries(Object.entries(fixture.sources).map(([key, rows]) => [key,
    rows.filter((row) => !Array.isArray(row.revisions) || row.revisions.includes(sourceRevision))
      .map(({ revisions, ...row }) => row),
  ]));
  await buildCatalogCandidateFromRecords({ candidatePath: catalogPath, sourceRevision, createdAt: "2026-09-05T00:00:00.000Z", sources });
  return { catalogPath, outputDirectory, attribution: fixture.attribution };
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
  assert.equal(publication.serviceCount, 8);
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
          const monitoringRef = `fixture:university:${mode}:${direction}`;
          const destinationRef = `fixture:university:terminal:${direction}`;
          const service = createServiceIdentity({ mode, lineId: line.lineId, monitoringRef, directionId: direction, destinationRef });
          insertService.run(
            service.serviceId, place.placeId, "Saint-Denis Université", line.lineLabel, `Terminus ${direction}`,
            line.lineColor, "#ffffff", monitoringRef, `IDFM:${line.lineId}`, direction, destinationRef, service.canonicalTuple,
          );
        }
      }
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
      .run("3", "#abcdef", "#000000", "IDFM:C-UNI2-B");
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
  const longMonitoring = `fixture:${"x".repeat(80_000)}`;
  let longServiceId;
  try {
    database.exec("BEGIN");
    for (let index = 0; index < 800; index += 1) {
      const stopLabel = `Café ${String(index).padStart(4, "0")} ${"é".repeat(37)}`;
      const locality = `Saint ${"é".repeat(42)}`;
      const place = createPlaceIdentity("BUS", `STATIC-${index}`);
      const monitoringRef = `fixture:monitoring:${index}`;
      const destinationRef = `fixture:terminal:${index}`;
      const service = createServiceIdentity({ mode: "BUS", lineId: "C-STATIC", monitoringRef, directionId: "0", destinationRef });
      insertPlace.run(place.placeId, stopLabel, locality, "BUS", place.canonicalTuple);
      insertSearch.run(normalizeCatalogSearchText(`${stopLabel} ${locality}`), place.placeId);
      insertService.run(service.serviceId, place.placeId, stopLabel, "99", "Fixture terminal", "#123456", "#ffffff", monitoringRef, "IDFM:C-STATIC", "0", destinationRef, service.canonicalTuple);
    }
    insertPlace.run(busy.placeId, "Busy fixture", null, "BUS", busy.canonicalTuple);
    insertSearch.run("busy fixture", busy.placeId);
    for (let index = 0; index < 12; index += 1) {
      const destinationRef = `fixture:busy:${index}`;
      const lineId = `C-BUSY-${index}`;
      const service = createServiceIdentity({ mode: "BUS", lineId, monitoringRef: longMonitoring, directionId: "0", destinationRef });
      longServiceId ??= service.serviceId;
      insertService.run(service.serviceId, busy.placeId, "Busy fixture", String(index).padStart(2, "0"), "Fixture terminal", "#123456", "#ffffff", longMonitoring, `IDFM:${lineId}`, "0", destinationRef, service.canonicalTuple);
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
  assert.deepEqual(busyMatches[0].lines, Array.from({ length: 12 }, (_, index) => ({
    lineLabel: String(index).padStart(2, "0"), lineColor: "#123456", lineTextColor: "#ffffff",
  })));
  const services = await client.listServices(busy.placeId);
  assert.deepEqual(services.map((service) => service.lineLabel), Array.from({ length: 12 }, (_, index) => String(index).padStart(2, "0")));
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
  assert.equal(publication.serviceCount, 820);
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
  assert.throws(() => publishStaticCatalog(options), /byte limit/u);
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
