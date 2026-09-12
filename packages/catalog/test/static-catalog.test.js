import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, opendirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LIMITS, TRANSPORT_MODE } from "../../contracts/src/index.ts";
import { buildCatalogCandidateFromRecords, createPlaceIdentity, createServiceIdentity } from "../src/catalog-import.ts";
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
  const selections = ["gare du nord", "chatelet", "porte de versailles", "chatelet les halles", "saint lazare"];
  const modes = new Set();
  for (const query of selections) {
    for (const place of await client.searchPlaces(query)) {
      modes.add(place.mode);
      for (const service of await client.listServices(place.placeId)) {
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
      const service = createServiceIdentity({ mode: "BUS", lineId: "C-BUSY", monitoringRef: longMonitoring, directionId: "0", destinationRef });
      longServiceId ??= service.serviceId;
      insertService.run(service.serviceId, busy.placeId, "Busy fixture", String(index).padStart(2, "0"), "Fixture terminal", "#123456", "#ffffff", longMonitoring, "IDFM:C-BUSY", "0", destinationRef, service.canonicalTuple);
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
  const services = await client.listServices(busy.placeId);
  assert.deepEqual(services.map((service) => service.lineLabel), Array.from({ length: 12 }, (_, index) => String(index).padStart(2, "0")));
  assert.equal((await client.lookupService(longServiceId)).routing.monitoringRef, longMonitoring);
  assert.equal(requests.some((url) => url.includes("/search/63_61/1.json")), true);
  assert.equal(requests.some((url) => url.includes(`/places/${busy.placeId}/1.json`)), true);
  assert.deepEqual((await client.searchPlaces("C.")).map((place) => place.placeId), matches.map((place) => place.placeId));
  assert.equal(requests.some((url) => url.includes("/search/63/1.json")), true);
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
