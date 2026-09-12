import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  LIMITS,
  SCHEMA_VERSION,
  isPlaceSearchItem,
  isServiceOption,
  type PlaceSearchItem,
  type ServiceOption,
} from "../../contracts/src/index.ts";
import {
  validateCatalogCandidate,
  type CatalogSourceAttribution,
} from "./catalog-import.ts";
import { PLACE_LINES_SQL, placeLinesFromJson } from "./catalog.ts";
import { catalogSearchBucket, normalizeCatalogSearchText } from "../../config-page/src/search-text.js";

const PLACE_ID = /^plc_[A-Za-z0-9_-]{43}$/u;
const SERVICE_ID = /^svc_[A-Za-z0-9_-]{43}$/u;
const EXPORT_FORMAT = "lapin-fute-static-catalog-v1";
const DATA_ORIGIN = "https://data.iledefrance-mobilites.fr";

export interface StaticCatalogManifest {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly revision: string;
  readonly sourceRevision: string;
  readonly createdAt: string;
  readonly attribution: readonly CatalogSourceAttribution[];
}

export interface PublishStaticCatalogOptions {
  readonly catalogPath: string;
  readonly outputDirectory: string;
  readonly attribution: readonly CatalogSourceAttribution[];
}

export interface StaticCatalogPublication {
  readonly manifest: StaticCatalogManifest;
  readonly outputDirectory: string;
  readonly placeCount: number;
  readonly serviceCount: number;
  readonly searchPageCount: number;
  readonly placePageCount: number;
  readonly fileCount: number;
  readonly totalBytes: number;
  readonly maximumFileBytes: number;
}

type SearchRow = PlaceSearchItem & { readonly searchText: string };
type SqlRow = Record<string, string | null>;

interface PageWriter {
  add(item: string): void;
  finish(): void;
}

const PLACE_QUERY = `
  SELECT places.place_id AS placeId, places.stop_label AS stopLabel,
    places.locality_label AS localityLabel, places.mode AS mode,
    place_search.search_text AS searchText, ${PLACE_LINES_SQL} AS lines
  FROM places
  JOIN place_search ON place_search.place_id = places.place_id
  JOIN services ON services.place_id = places.place_id
  GROUP BY places.place_id
  ORDER BY places.place_id
`;
const SERVICE_QUERY = `
  SELECT services.place_id AS placeId, services.service_id AS serviceId,
    services.stop_label AS stopLabel, services.line_label AS lineLabel,
    services.destination_label AS destinationLabel, places.mode AS lineMode,
    services.line_color AS lineColor, services.line_text_color AS lineTextColor,
    services.monitoring_ref AS monitoringRef, services.line_ref AS lineRef,
    services.destination_ref AS destinationRef
  FROM services JOIN places ON places.place_id = services.place_id
  ORDER BY services.place_id, services.line_label COLLATE NOCASE,
    services.destination_label COLLATE NOCASE, services.service_id
`;

function fail(message: string): never {
  throw new Error(`Static catalog: ${message}`);
}

function publicAttribution(sources: readonly CatalogSourceAttribution[]): CatalogSourceAttribution[] {
  if (!Array.isArray(sources) || sources.length === 0) fail("source attribution is required");
  return sources.map((source) => {
    if (!/^[a-z0-9-]+$/u.test(source.dataset)
      || typeof source.license !== "string" || source.license.trim() === ""
      || typeof source.retrievedAt !== "string" || !Number.isFinite(Date.parse(source.retrievedAt))
      || (source.restricted !== undefined && typeof source.restricted !== "boolean")) {
      fail("invalid source attribution");
    }
    // Attribute the dataset, never its signed download URL or request headers.
    const url = `${DATA_ORIGIN}/api/explore/v2.1/catalog/datasets/${source.dataset}`;
    if (source.url !== url) fail("attribution must use the public dataset metadata URL");
    return {
      dataset: source.dataset,
      url,
      retrievedAt: source.retrievedAt,
      license: source.license,
      ...(source.restricted === undefined ? {} : { restricted: source.restricted }),
    };
  });
}

function searchRow(row: SqlRow): SearchRow {
  if (typeof row.lines !== "string") fail("invalid search row");
  const place = {
    placeId: row.placeId,
    stopLabel: row.stopLabel,
    ...(row.localityLabel === null ? {} : { localityLabel: row.localityLabel }),
    mode: row.mode,
    lines: placeLinesFromJson(row.lines),
  };
  if (!isPlaceSearchItem(place) || !PLACE_ID.test(place.placeId)
    || typeof row.searchText !== "string" || row.searchText === ""
    || normalizeCatalogSearchText(row.searchText) !== row.searchText) fail("invalid search row");
  return { ...place, searchText: row.searchText };
}

function serviceRow(row: SqlRow): ServiceOption {
  const service = {
    serviceId: row.serviceId,
    stopLabel: row.stopLabel,
    lineLabel: row.lineLabel,
    destinationLabel: row.destinationLabel,
    lineMode: row.lineMode,
    lineColor: row.lineColor,
    lineTextColor: row.lineTextColor,
    routing: {
      monitoringRef: row.monitoringRef,
      lineRef: row.lineRef,
      destinationRef: row.destinationRef,
    },
  };
  if (!isServiceOption(service) || !SERVICE_ID.test(service.serviceId)) fail("invalid service row");
  return service;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

// Used only when publishing the exact same revision again. Never rewrite it.
function sameRevision(expected: string, existing: string): boolean {
  const directory = opendirSync(expected);
  let entries = 0;
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      entries += 1;
      const left = join(expected, entry.name);
      const right = join(existing, entry.name);
      if (!existsSync(right)) return false;
      if (entry.isDirectory()) {
        if (!statSync(right).isDirectory() || !sameRevision(left, right)) return false;
      } else {
        const length = statSync(left).size;
        if (!statSync(right).isFile() || statSync(right).size !== length
          || length > LIMITS.httpResponseBytes || !readFileSync(left).equals(readFileSync(right))) return false;
      }
    }
  } finally {
    directory.closeSync();
  }
  const other = opendirSync(existing);
  try {
    for (let entry = other.readSync(); entry !== null; entry = other.readSync()) entries -= 1;
  } finally {
    other.closeSync();
  }
  return entries === 0;
}

export function publishStaticCatalog(options: PublishStaticCatalogOptions): StaticCatalogPublication {
  const attribution = publicAttribution(options.attribution);
  const validated = validateCatalogCandidate(options.catalogPath);
  const outputDirectory = resolve(options.outputDirectory);
  mkdirSync(outputDirectory, { recursive: true });
  const staging = mkdtempSync(join(outputDirectory, ".publish-"));
  const manifestTemporary = `${staging}.manifest`;
  const database = new DatabaseSync(options.catalogPath, { readOnly: true });
  let fileCount = 0;
  let totalBytes = 0;
  let maximumFileBytes = 0;
  let searchPageCount = 0;
  let placePageCount = 0;
  try {
    database.exec("PRAGMA temp_store = FILE; PRAGMA cache_size = -2048; BEGIN");
    const metadata: Record<string, string> = {};
    for (const row of database.prepare("SELECT key, value FROM metadata").iterate()) {
      metadata[String(row.key)] = String(row.value);
    }
    if (metadata.source_revision !== validated.sourceRevision || metadata.created_at !== validated.createdAt) {
      fail("catalog changed after validation");
    }
    // Hash the same pinned SQLite snapshot that will be exported, in bounded rows.
    const digest = createHash("sha256").update(EXPORT_FORMAT).update(JSON.stringify({ metadata, attribution }));
    for (const row of database.prepare(PLACE_QUERY).iterate() as Iterable<SqlRow>) {
      digest.update(JSON.stringify(searchRow(row))).update("\n");
    }
    for (const row of database.prepare(SERVICE_QUERY).iterate()) digest.update(JSON.stringify(row)).update("\n");
    const revision = digest.digest("hex");
    const manifest: StaticCatalogManifest = {
      schemaVersion: SCHEMA_VERSION,
      revision,
      sourceRevision: validated.sourceRevision,
      createdAt: validated.createdAt,
      attribution,
    };

    function writeJson(path: string, body: string): void {
      const bytes = Buffer.byteLength(body, "utf8");
      if (bytes > LIMITS.httpResponseBytes) fail("one row or envelope exceeds the response byte limit");
      writeFileSync(path, body, { encoding: "utf8", flag: "wx", flush: true });
      fileCount += 1;
      totalBytes += bytes;
      maximumFileBytes = Math.max(maximumFileBytes, bytes);
    }

    function pages(directory: string, field: "places" | "services", placeId?: string): PageWriter {
      mkdirSync(directory, { recursive: true });
      let page = 0;
      let items: string[] = [];
      let bytes = 0;
      function envelope(nextPage: number | null): string {
        return JSON.stringify({
          schemaVersion: SCHEMA_VERSION, revision,
          ...(placeId === undefined ? {} : { placeId }),
          page, nextPage, [field]: [],
        });
      }
      function flush(nextPage: number | null): void {
        const empty = envelope(nextPage);
        writeJson(join(directory, `${page}.json`), `${empty.slice(0, -2)}${items.join(",")}]}`);
        if (field === "places") searchPageCount += 1;
        else placePageCount += 1;
        items = [];
        bytes = 0;
        page += 1;
      }
      return {
        add(item: string): void {
          const length = Buffer.byteLength(item, "utf8");
          const overhead = () => Math.max(Buffer.byteLength(envelope(null)), Buffer.byteLength(envelope(page + 1)));
          if (items.length > 0 && overhead() + bytes + length + items.length > LIMITS.httpResponseBytes) flush(page + 1);
          if (overhead() + length > LIMITS.httpResponseBytes) fail("one row exceeds the response byte limit");
          items.push(item);
          bytes += length;
        },
        finish(): void {
          if (items.length > 0) flush(null);
          syncDirectory(directory);
        },
      };
    }

    database.exec(`CREATE TEMP TABLE static_search (
      bucket TEXT NOT NULL, place_id TEXT NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (bucket, place_id)
    ) WITHOUT ROWID; PRAGMA temp.cache_size = -2048`);
    const insertSearch = database.prepare("INSERT OR IGNORE INTO static_search VALUES (?, ?, ?)");
    let placeCount = 0;
    for (const row of database.prepare(PLACE_QUERY).iterate() as Iterable<SqlRow>) {
      const place = searchRow(row);
      const serialized = JSON.stringify(place);
      if (Buffer.byteLength(serialized) > LIMITS.httpResponseBytes) fail("one search row exceeds the response byte limit");
      const buckets = new Set<string>();
      for (const token of place.searchText.split(" ")) {
        buckets.add(catalogSearchBucket(Array.from(token)[0]!));
        buckets.add(catalogSearchBucket(token));
      }
      for (const bucket of buckets) insertSearch.run(bucket, place.placeId, serialized);
      placeCount += 1;
    }
    mkdirSync(join(staging, "search"));
    let bucket: string | undefined;
    let searchPages: PageWriter | undefined;
    for (const row of database.prepare("SELECT bucket, body FROM static_search ORDER BY bucket, place_id").iterate()) {
      if (row.bucket !== bucket) {
        searchPages?.finish();
        bucket = String(row.bucket);
        searchPages = pages(join(staging, "search", bucket), "places");
      }
      searchPages!.add(String(row.body));
    }
    searchPages?.finish();
    syncDirectory(join(staging, "search"));

    mkdirSync(join(staging, "places"));
    mkdirSync(join(staging, "services"));
    let placeId: string | undefined;
    let servicePages: PageWriter | undefined;
    let serviceCount = 0;
    for (const row of database.prepare(SERVICE_QUERY).iterate() as Iterable<SqlRow>) {
      if (typeof row.placeId !== "string" || !PLACE_ID.test(row.placeId)) fail("invalid service place ID");
      if (row.placeId !== placeId) {
        servicePages?.finish();
        placeId = row.placeId;
        servicePages = pages(join(staging, "places", placeId), "services", placeId);
      }
      const service = serviceRow(row);
      writeJson(join(staging, "services", `${service.serviceId}.json`), JSON.stringify({ schemaVersion: SCHEMA_VERSION, revision, service }));
      servicePages!.add(JSON.stringify(service));
      serviceCount += 1;
    }
    servicePages?.finish();
    if (placeCount !== validated.placeCount || serviceCount !== validated.serviceCount) fail("catalog counts changed after validation");
    syncDirectory(join(staging, "places"));
    syncDirectory(join(staging, "services"));
    syncDirectory(staging);

    // A failed export never moves the public pointer. Keep older revisions for open pages.
    writeJson(manifestTemporary, JSON.stringify(manifest));
    const destination = join(outputDirectory, revision);
    if (existsSync(destination)) {
      if (!sameRevision(staging, destination)) fail("an existing immutable revision differs");
    } else {
      chmodSync(staging, 0o755);
      renameSync(staging, destination);
      syncDirectory(outputDirectory);
    }
    renameSync(manifestTemporary, join(outputDirectory, "manifest.json"));
    syncDirectory(outputDirectory);
    return { manifest, outputDirectory, placeCount, serviceCount, searchPageCount, placePageCount, fileCount, totalBytes, maximumFileBytes };
  } finally {
    database.close();
    rmSync(staging, { recursive: true, force: true });
    rmSync(manifestTemporary, { force: true });
  }
}
