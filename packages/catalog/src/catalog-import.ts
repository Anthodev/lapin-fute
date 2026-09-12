import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { open as openFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { Readable, Transform } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import { parse } from "csv-parse";
import yauzl from "yauzl";
import {
  LIMITS,
  SCHEMA_VERSION,
  TRANSPORT_MODE,
} from "../../contracts/src/index.ts";
import type { TransportMode } from "../../contracts/src/index.ts";
import { normalizeCatalogSearchText } from "../../config-page/src/search-text.js";

export const CATALOG_VERSION = 3 as const;
export const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1_000;
export const MAX_COMPRESSED_DOWNLOAD_BYTES = 2 * 1024 ** 3;
export const MAX_SELECTED_ENTRY_BYTES = 8 * 1024 ** 3;
export const MAX_SELECTED_ARCHIVE_BYTES = 16 * 1024 ** 3;
export const MAX_CSV_RECORD_BYTES = 1024 * 1024;
export const IMPORT_TRANSACTION_ROWS = 10_000;
export const IDFM_CATALOG_SOURCE_URL = {
  gtfsRecord: "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/offre-horaires-tc-gtfs-idfm/records?limit=1",
  perimeter: "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/perimetre-des-donnees-tr-disponibles-plateforme-idfm/exports/csv?limit=-1",
  arrets: "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/arrets/exports/csv?limit=-1",
  zones: "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/zones-d-arrets/exports/csv?limit=-1",
  relations: "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/relations/exports/csv?limit=-1",
  lines: "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/referentiel-des-lignes/exports/csv?limit=-1",
  arretsLignes: "https://data.iledefrance-mobilites.fr/api/explore/v2.1/catalog/datasets/arrets-lignes/exports/csv?limit=-1",
} as const;

const SUPPORTED_MODE: Readonly<Record<TransportMode, true>> = {
  BUS: true,
  METRO: true,
  TRAM: true,
  RER: true,
  TRANSILIEN: true,
};
const REQUIRED_GTFS_ENTRIES = [
  "routes.txt",
  "trips.txt",
  "stop_times.txt",
  "stops.txt",
  "agency.txt",
] as const;
const CODE_ENTRY_NAME: Readonly<Record<string, true>> = {
  "object_codes_extension.txt": true,
  "objects_codes_extension.txt": true,
};

export class CatalogImportError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "CatalogImportError";
    this.code = code;
  }
}

export type CsvValue = string | number | boolean | null | undefined;
export type CsvRecord = Readonly<Record<string, CsvValue>>;

export interface CatalogRecordSourceSet {
  readonly routes: readonly CsvRecord[];
  readonly trips: readonly CsvRecord[];
  readonly stopTimes: readonly CsvRecord[];
  readonly stops: readonly CsvRecord[];
  readonly agency: readonly CsvRecord[];
  readonly objectCodes: readonly CsvRecord[];
  readonly perimeter: readonly CsvRecord[];
  readonly arrets: readonly CsvRecord[];
  readonly zones: readonly CsvRecord[];
  readonly relations: readonly CsvRecord[];
  readonly lines: readonly CsvRecord[];
  readonly arretsLignes: readonly CsvRecord[];
}

export interface CsvFileSource {
  readonly path: string;
  readonly delimiter?: "," | ";";
  readonly expectedRows?: number;
}

export interface CatalogFileSourceSet {
  readonly gtfsZipPath: string;
  readonly perimeter: CsvFileSource;
  readonly arrets: CsvFileSource;
  readonly zones: CsvFileSource;
  readonly relations: CsvFileSource;
  readonly lines: CsvFileSource;
  readonly arretsLignes: CsvFileSource;
}

export interface CatalogSourceAttribution {
  readonly dataset: string;
  readonly url: string;
  readonly retrievedAt: string;
  readonly license: string;
  readonly restricted?: boolean;
}

export interface DownloadCatalogSourceOptions {
  readonly source: CatalogSourceAttribution;
  readonly destinationPath: string;
  readonly expectedContentTypes: readonly string[];
  readonly datasetToken?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface DownloadedCatalogSource {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly source: CatalogSourceAttribution;
}
export interface ResolvedGtfsDownload {
  readonly filename: string;
  readonly url: string;
}

export interface BuildCatalogOptions {
  readonly candidatePath: string;
  readonly sourceRevision: string;
  readonly createdAt?: string;
  readonly sources: CatalogFileSourceSet;
}

export interface BuildCatalogFromRecordsOptions {
  readonly candidatePath: string;
  readonly sourceRevision: string;
  readonly createdAt?: string;
  readonly sources: CatalogRecordSourceSet;
}

export interface PlaceResolutionCounts {
  readonly arrets: number;
  readonly relations: number;
  readonly direct: number;
}

export interface CatalogBuildResult {
  readonly candidatePath: string;
  readonly sourceRevision: string;
  readonly createdAt: string;
  readonly placeCount: number;
  readonly serviceCount: number;
  readonly countsByMode: Readonly<Record<TransportMode, number>>;
  readonly excludedAmbiguousServicesByMode: Readonly<Record<TransportMode, number>>;
  readonly placeResolution?: PlaceResolutionCounts;
  readonly revalidatedAfterRenameFailure?: true;
}

interface CsvSpec {
  readonly required: readonly string[];
  readonly insert: (row: Readonly<Record<string, string>>) => void;
}

interface ZipEntryLike {
  readonly fileName: string;
  readonly uncompressedSize: number;
  readonly generalPurposeBitFlag: number;
}

interface ZipFileLike {
  readEntry(): void;
  close(): void;
  once(event: "entry", listener: (entry: ZipEntryLike) => void): this;
  once(event: "end" | "error", listener: (...args: unknown[]) => void): this;
  removeListener(event: string, listener: (...args: never[]) => void): this;
  openReadStream(
    entry: ZipEntryLike,
    callback: (error: Error | null, stream?: Readable) => void,
  ): void;
}

interface QueryRow {
  readonly [key: string]: unknown;
}

function fail(code: string, message: string, cause?: unknown): never {
  throw new CatalogImportError(code, message, cause === undefined ? undefined : { cause });
}

function nonEmpty(value: unknown, field: string): string {
  const text = String(value ?? "").trim();
  if (text.length === 0 || text.includes("\0")) fail("INVALID_SOURCE", `${field} must be non-empty`);
  return text;
}

function optionalText(value: unknown): string {
  const text = String(value ?? "").trim();
  if (text.includes("\0")) fail("INVALID_SOURCE", "source text contains NUL");
  return text;
}

function integer(value: unknown, field: string): number {
  const text = nonEmpty(value, field);
  if (!/^-?\d+$/u.test(text)) fail("INVALID_SOURCE", `${field} must be an integer`);
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed)) fail("INVALID_SOURCE", `${field} exceeds safe integer range`);
  return parsed;
}

function transportMode(value: unknown): TransportMode {
  const mode = nonEmpty(value, "mode");
  if (!Object.hasOwn(SUPPORTED_MODE, mode)) fail("INVALID_MODE", `unsupported transport mode ${mode}`);
  return mode as TransportMode;
}

function canonicalLineId(value: unknown, field: string): string {
  const text = nonEmpty(value, field);
  if (/^STIF:Line::[^:]+:$/.test(text)) return text.slice("STIF:Line::".length, -1);
  return text.startsWith("IDFM:") ? text.slice("IDFM:".length) : text;
}

function normalizeLineColor(value: unknown, field: string): string {
  const text = nonEmpty(value, field);
  if (!/^#?[0-9a-f]{6}$/iu.test(text)) fail("INVALID_SOURCE", `${field} must be a six-digit hexadecimal color`);
  return `#${text.replace(/^#/u, "").toLowerCase()}`;
}

function isoTimestamp(value: string, field: string): string {
  if (value.length === 0 || !Number.isFinite(Date.parse(value))) {
    fail("INVALID_METADATA", `${field} must be an ISO timestamp`);
  }
  return value;
}

function assertSourceAttribution(source: CatalogSourceAttribution): void {
  nonEmpty(source.dataset, "source.dataset");
  nonEmpty(source.license, "source.license");
  isoTimestamp(source.retrievedAt, "source.retrievedAt");
  let url: URL;
  try {
    url = new URL(source.url);
  } catch (error) {
    fail("INVALID_SOURCE_URL", "source URL is invalid", error);
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
    fail("INVALID_SOURCE_URL", "source URL must be credential-free HTTPS");
  }
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
  }
}

function removeCandidateFiles(path: string): void {
  safeUnlink(path);
  safeUnlink(`${path}-journal`);
  safeUnlink(`${path}-wal`);
  safeUnlink(`${path}-shm`);
}

function fsyncFile(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function canonicalTuple(namespace: "place" | "service", fields: readonly string[]): string {
  let tuple = `lapin-fute:${namespace}:v1`;
  for (const field of fields) tuple += `|${Buffer.byteLength(field, "utf8")}:${field}`;
  return tuple;
}

function opaqueId(prefix: "plc_" | "svc_", tuple: string): string {
  return prefix + createHash("sha256").update(tuple, "utf8").digest("base64url");
}

export function createPlaceIdentity(mode: TransportMode, zdaId: string): {
  readonly placeId: string;
  readonly canonicalTuple: string;
} {
  const tuple = canonicalTuple("place", [transportMode(mode), nonEmpty(zdaId, "zdaId")]);
  return { placeId: opaqueId("plc_", tuple), canonicalTuple: tuple };
}

export interface ServiceIdentityInput {
  readonly mode: TransportMode;
  readonly lineId: string;
  readonly monitoringRef: string;
  readonly directionId: string;
  readonly destinationRef: string;
}

export function createServiceIdentity(input: ServiceIdentityInput): {
  readonly serviceId: string;
  readonly canonicalTuple: string;
} {
  const tuple = canonicalTuple("service", [
    transportMode(input.mode),
    nonEmpty(input.lineId, "lineId"),
    nonEmpty(input.monitoringRef, "monitoringRef"),
    nonEmpty(input.directionId, "directionId"),
    nonEmpty(input.destinationRef, "destinationRef"),
  ]);
  return { serviceId: opaqueId("svc_", tuple), canonicalTuple: tuple };
}

export async function resolveIdfmGtfsDownload(
  datasetToken: string,
  fetchSource: typeof globalThis.fetch = globalThis.fetch,
): Promise<ResolvedGtfsDownload> {
  const token = nonEmpty(datasetToken, "datasetToken");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("GTFS metadata request timed out")), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetchSource(IDFM_CATALOG_SOURCE_URL.gtfsRecord, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      headers: { Authorization: `apikey ${token}` },
      signal: controller.signal,
    });
    if (response.status !== 200) fail("SOURCE_HTTP_STATUS", `GTFS metadata returned HTTP ${response.status}`);
    const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    if (mediaType !== "application/json") fail("SOURCE_CONTENT_TYPE", "GTFS metadata is not JSON");
    if (response.body === null) fail("SOURCE_EMPTY_BODY", "GTFS metadata returned no body");

    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 262_144) fail("SOURCE_METADATA_TOO_LARGE", "GTFS metadata exceeds 256 KiB");
      chunks.push(chunk);
    }
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch (error) {
      fail("INVALID_SOURCE_METADATA", "GTFS metadata is not valid UTF-8 JSON", error);
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      fail("INVALID_SOURCE_METADATA", "GTFS metadata root is invalid");
    }
    const results = (value as Record<string, unknown>).results;
    if (!Array.isArray(results) || results.length !== 1 || typeof results[0] !== "object" || results[0] === null) {
      fail("INVALID_SOURCE_METADATA", "GTFS metadata must resolve exactly one file");
    }
    const record = results[0] as Record<string, unknown>;
    const filename = nonEmpty(record.filename, "GTFS metadata filename");
    const urlValue = record.url;
    const url = typeof urlValue === "string"
      ? urlValue
      : typeof urlValue === "object" && urlValue !== null
        ? String((urlValue as Record<string, unknown>).url ?? "")
        : "";
    let resolvedUrl: URL;
    try {
      resolvedUrl = new URL(nonEmpty(url, "GTFS metadata URL"));
    } catch (error) {
      fail("INVALID_SOURCE_URL", "GTFS metadata URL is invalid", error);
    }
    if (resolvedUrl.protocol !== "https:" || resolvedUrl.username !== "" || resolvedUrl.password !== ""
      || resolvedUrl.href.includes(token) || resolvedUrl.href.includes(encodeURIComponent(token))) {
      fail("INVALID_SOURCE_URL", "GTFS metadata URL must be credential-free HTTPS");
    }
    return { filename, url: resolvedUrl.href };
  } catch (error) {
    if (error instanceof CatalogImportError) throw error;
    fail("SOURCE_METADATA_FAILED", "GTFS metadata request failed", error);
  } finally {
    clearTimeout(timeout);
  }
}

export async function downloadCatalogSource(
  options: DownloadCatalogSourceOptions,
): Promise<DownloadedCatalogSource> {
  assertSourceAttribution(options.source);
  if (existsSync(options.destinationPath)) fail("DESTINATION_EXISTS", "download destination already exists");

  const token = options.datasetToken;
  if (options.source.restricted && !token) fail("DATASET_TOKEN_REQUIRED", "restricted source needs IDFM_DATASET_TOKEN");
  if (!options.source.restricted && token !== undefined) {
    fail("UNEXPECTED_DATASET_TOKEN", "credentials are forbidden for public catalog sources");
  }
  if (token !== undefined) {
    nonEmpty(token, "datasetToken");
    const encoded = encodeURIComponent(token);
    if (options.source.url.includes(token) || options.source.url.includes(encoded)) {
      fail("CREDENTIAL_IN_URL", "dataset token must not appear in a URL");
    }
  }

  mkdirSync(dirname(options.destinationPath), { recursive: true });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("catalog download timed out")), DOWNLOAD_TIMEOUT_MS);
  let handle: FileHandle | undefined;
  try {
    const fetchSource = options.fetch ?? globalThis.fetch;
    const response = await fetchSource(options.source.url, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      headers: token === undefined ? {} : { Authorization: `apikey ${token}` },
      signal: controller.signal,
    });
    if (response.status !== 200) fail("SOURCE_HTTP_STATUS", `catalog source returned HTTP ${response.status}`);
    const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase();
    const accepted = options.expectedContentTypes.map((value) => value.toLowerCase());
    if (!accepted.includes(mediaType)) fail("SOURCE_CONTENT_TYPE", `unexpected catalog content type ${mediaType || "<missing>"}`);
    if (response.body === null) fail("SOURCE_EMPTY_BODY", "catalog source returned no body");

    handle = await openFile(options.destinationPath, "wx", 0o600);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunkValue of response.body) {
      const chunk = chunkValue instanceof Uint8Array ? chunkValue : new Uint8Array(chunkValue as ArrayBuffer);
      bytes += chunk.byteLength;
      if (bytes > MAX_COMPRESSED_DOWNLOAD_BYTES) {
        controller.abort(new Error("catalog download exceeded byte limit"));
        fail("SOURCE_TOO_LARGE", "catalog source exceeds the 2 GiB download limit");
      }
      hash.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await handle.write(chunk, offset, chunk.byteLength - offset);
        offset += result.bytesWritten;
      }
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    return {
      path: options.destinationPath,
      bytes,
      sha256: hash.digest("hex"),
      source: options.source,
    };
  } catch (error) {
    try {
      await handle?.close();
    } finally {
      safeUnlink(options.destinationPath);
    }
    if (error instanceof CatalogImportError) throw error;
    fail("SOURCE_DOWNLOAD_FAILED", "catalog source download failed", error);
  } finally {
    clearTimeout(timeout);
  }
}

function createSchema(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = DELETE;
    PRAGMA synchronous = FULL;
    PRAGMA temp_store = FILE;

    CREATE TABLE metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE places (
      place_id TEXT PRIMARY KEY,
      stop_label TEXT NOT NULL,
      locality_label TEXT,
      mode TEXT NOT NULL,
      canonical_tuple TEXT NOT NULL UNIQUE
    ) STRICT;
    CREATE TABLE services (
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
    ) STRICT;
    CREATE VIRTUAL TABLE place_search USING fts5(
      search_text,
      place_id UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 2'
    );

    CREATE TABLE stage_routes (
      route_id TEXT PRIMARY KEY,
      route_short_name TEXT NOT NULL,
      route_long_name TEXT NOT NULL
    ) STRICT;
    CREATE TABLE stage_trips (
      trip_id TEXT PRIMARY KEY,
      route_id TEXT NOT NULL,
      trip_headsign TEXT NOT NULL,
      direction_id TEXT NOT NULL
    ) STRICT;
    CREATE TABLE stage_stop_times (
      trip_id TEXT NOT NULL,
      stop_id TEXT NOT NULL,
      stop_sequence INTEGER NOT NULL,
      pickup_type INTEGER NOT NULL,
      PRIMARY KEY (trip_id, stop_sequence)
    ) STRICT;
    CREATE TABLE stage_stops (
      stop_id TEXT PRIMARY KEY,
      stop_name TEXT NOT NULL,
      parent_station TEXT NOT NULL
    ) STRICT;
    CREATE TABLE stage_agency (
      agency_name TEXT PRIMARY KEY
    ) STRICT;
    CREATE TABLE stage_codes (
      object_type TEXT NOT NULL,
      object_id TEXT NOT NULL,
      object_system TEXT NOT NULL,
      object_code TEXT NOT NULL,
      PRIMARY KEY (object_type, object_id, object_system, object_code)
    ) STRICT;
    CREATE TABLE stage_perimeter (
      line TEXT NOT NULL,
      id_line TEXT NOT NULL,
      monitoring_ref TEXT NOT NULL,
      PRIMARY KEY (line, monitoring_ref)
    ) STRICT;
    CREATE TABLE stage_arrets (
      arrid TEXT PRIMARY KEY,
      zdaid TEXT NOT NULL
    ) STRICT;
    CREATE TABLE stage_zones (
      zdaid TEXT PRIMARY KEY,
      zdaname TEXT NOT NULL,
      zdatown TEXT NOT NULL
    ) STRICT;
    CREATE TABLE stage_relations (
      zdaid TEXT NOT NULL,
      arrid TEXT NOT NULL,
      artid TEXT
    ) STRICT;
    CREATE TABLE stage_lines (
      id_line TEXT PRIMARY KEY,
      name_line TEXT NOT NULL,
      shortname_line TEXT NOT NULL,
      transport_mode TEXT NOT NULL,
      transport_submode TEXT NOT NULL,
      status TEXT NOT NULL,
      line_color TEXT NOT NULL,
      line_text_color TEXT NOT NULL
    ) STRICT;
    CREATE TABLE stage_arrets_lignes (
      route_id TEXT NOT NULL,
      stop_id TEXT NOT NULL,
      PRIMARY KEY (route_id, stop_id)
    ) STRICT;
  `);
}

function prepareSpecs(database: DatabaseSync): Readonly<Record<keyof CatalogRecordSourceSet, CsvSpec>> {
  const route = database.prepare("INSERT INTO stage_routes VALUES (?, ?, ?)");
  const trip = database.prepare("INSERT INTO stage_trips VALUES (?, ?, ?, ?)");
  const stopTime = database.prepare("INSERT INTO stage_stop_times VALUES (?, ?, ?, ?)");
  const stop = database.prepare("INSERT INTO stage_stops VALUES (?, ?, ?)");
  const agency = database.prepare("INSERT OR IGNORE INTO stage_agency VALUES (?)");
  const code = database.prepare("INSERT OR IGNORE INTO stage_codes VALUES (?, ?, ?, ?)");
  const perimeter = database.prepare("INSERT OR IGNORE INTO stage_perimeter VALUES (?, ?, ?)");
  const arret = database.prepare("INSERT INTO stage_arrets VALUES (?, ?)");
  const zone = database.prepare("INSERT INTO stage_zones VALUES (?, ?, ?)");
  const relation = database.prepare("INSERT INTO stage_relations VALUES (?, ?, ?)");
  const line = database.prepare("INSERT INTO stage_lines VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
  const arretLigne = database.prepare("INSERT OR IGNORE INTO stage_arrets_lignes VALUES (?, ?)");

  return {
    routes: {
      required: ["route_id", "route_short_name", "route_long_name"],
      insert: (row) => route.run(canonicalLineId(row.route_id, "routes.route_id"), optionalText(row.route_short_name), optionalText(row.route_long_name)),
    },
    trips: {
      required: ["route_id", "trip_id", "trip_headsign", "direction_id"],
      insert: (row) => trip.run(nonEmpty(row.trip_id, "trips.trip_id"), nonEmpty(row.route_id, "trips.route_id"), optionalText(row.trip_headsign), nonEmpty(row.direction_id, "trips.direction_id")),
    },
    stopTimes: {
      required: ["trip_id", "stop_id", "stop_sequence", "pickup_type"],
      insert: (row) => {
        const pickupType = row.pickup_type === "" ? 0 : integer(row.pickup_type, "stop_times.pickup_type");
        if (pickupType < 0 || pickupType > 3) fail("INVALID_SOURCE", "stop_times.pickup_type is outside GTFS range");
        stopTime.run(nonEmpty(row.trip_id, "stop_times.trip_id"), nonEmpty(row.stop_id, "stop_times.stop_id"), integer(row.stop_sequence, "stop_times.stop_sequence"), pickupType);
      },
    },
    stops: {
      required: ["stop_id", "stop_name", "parent_station"],
      insert: (row) => stop.run(nonEmpty(row.stop_id, "stops.stop_id"), nonEmpty(row.stop_name, "stops.stop_name"), optionalText(row.parent_station)),
    },
    agency: {
      required: ["agency_name", "agency_url", "agency_timezone"],
      insert: (row) => {
        nonEmpty(row.agency_url, "agency.agency_url");
        nonEmpty(row.agency_timezone, "agency.agency_timezone");
        agency.run(nonEmpty(row.agency_name, "agency.agency_name"));
      },
    },
    objectCodes: {
      required: ["object_type", "object_id", "object_system", "object_code"],
      insert: (row) => code.run(nonEmpty(row.object_type, "codes.object_type"), nonEmpty(row.object_id, "codes.object_id"), nonEmpty(row.object_system, "codes.object_system"), nonEmpty(row.object_code, "codes.object_code")),
    },
    perimeter: {
      // Nullable descriptions are not routing inputs; display labels come from the referentials.
      required: ["line", "ns2_stoppointref"],
      insert: (row) => perimeter.run(nonEmpty(row.line, "perimeter.line"), canonicalLineId(row.line, "perimeter.line"), nonEmpty(row.ns2_stoppointref, "perimeter.ns2_stoppointref")),
    },
    arrets: {
      required: ["arrid", "zdaid"],
      insert: (row) => arret.run(nonEmpty(row.arrid, "arrets.arrid"), nonEmpty(row.zdaid, "arrets.zdaid")),
    },
    zones: {
      required: ["zdaid", "zdaname", "zdatown"],
      insert: (row) => zone.run(nonEmpty(row.zdaid, "zones.zdaid"), nonEmpty(row.zdaname, "zones.zdaname"), optionalText(row.zdatown)),
    },
    relations: {
      required: ["zdaid", "arrid", "artid"],
      insert: (row) => relation.run(nonEmpty(row.zdaid, "relations.zdaid"), nonEmpty(row.arrid, "relations.arrid"), optionalText(row.artid) || null),
    },
    lines: {
      required: ["id_line", "name_line", "shortname_line", "transportmode", "transportsubmode", "status", "colourweb_hexa", "textcolourweb_hexa"],
      insert: (row) => line.run(canonicalLineId(row.id_line, "lines.id_line"), nonEmpty(row.name_line, "lines.name_line"), optionalText(row.shortname_line), nonEmpty(row.transportmode, "lines.transportmode"), optionalText(row.transportsubmode), nonEmpty(row.status, "lines.status"), normalizeLineColor(row.colourweb_hexa, "lines.colourweb_hexa"), normalizeLineColor(row.textcolourweb_hexa, "lines.textcolourweb_hexa")),
    },
    arretsLignes: {
      required: ["id", "stop_id"],
      insert: (row) => arretLigne.run(canonicalLineId(row.id, "arrets_lignes.id"), nonEmpty(row.stop_id, "arrets_lignes.stop_id")),
    },
  };
}

function runBatched(database: DatabaseSync, rows: Iterable<Readonly<Record<string, string>>>, spec: CsvSpec): void {
  let pending = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      spec.insert(row);
      pending += 1;
      if (pending === IMPORT_TRANSACTION_ROWS) {
        database.exec("COMMIT; BEGIN IMMEDIATE");
        pending = 0;
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function stringRecord(record: CsvRecord, required: readonly string[]): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const key of required) {
    if (!Object.hasOwn(record, key)) fail("MISSING_COLUMN", `record is missing ${key}`);
    result[key] = String(record[key] ?? "");
  }
  return result;
}

function loadRecordSources(database: DatabaseSync, sources: CatalogRecordSourceSet): void {
  const specs = prepareSpecs(database);
  for (const key of Object.keys(specs) as (keyof CatalogRecordSourceSet)[]) {
    const spec = specs[key];
    const rows = sources[key].map((row) => stringRecord(row, spec.required));
    runBatched(database, rows, spec);
  }
}

class Utf8Decoder extends Transform {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    try {
      this.push(this.#decoder.decode(chunk, { stream: true }));
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }

  override _flush(callback: (error?: Error | null) => void): void {
    try {
      this.push(this.#decoder.decode());
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

class ByteLimit extends Transform {
  #bytes = 0;
  readonly #limit: number;
  readonly #onBytes: (bytes: number) => void;

  constructor(limit: number, onBytes: (bytes: number) => void) {
    super();
    this.#limit = limit;
    this.#onBytes = onBytes;
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.#bytes += chunk.byteLength;
    if (this.#bytes > this.#limit) {
      callback(new CatalogImportError("ZIP_ENTRY_TOO_LARGE", "selected GTFS entry exceeds the 8 GiB limit"));
      return;
    }
    try {
      this.#onBytes(chunk.byteLength);
      this.push(chunk);
      callback();
    } catch (error) {
      callback(error as Error);
    }
  }
}

async function loadCsvStream(
  database: DatabaseSync,
  input: Readable,
  delimiter: "," | ";",
  spec: CsvSpec,
): Promise<number> {
  const decoder = new Utf8Decoder();
  const parser = parse({
    bom: true,
    columns: false,
    delimiter,
    max_record_size: MAX_CSV_RECORD_BYTES,
    relax_column_count: false,
    relax_quotes: false,
    skip_empty_lines: true,
  });
  const destroyParser = (error: Error): void => parser.destroy(error);
  input.once("error", destroyParser);
  decoder.once("error", destroyParser);
  input.pipe(decoder).pipe(parser);

  let indexes: Readonly<Record<string, number>> | undefined;
  let pending = 0;
  let rows = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    for await (const value of parser) {
      if (!Array.isArray(value) || !value.every((field) => typeof field === "string")) {
        fail("INVALID_CSV", "CSV parser returned a non-string record");
      }
      const fields = value as string[];
      if (indexes === undefined) {
        const header = fields.map((field) => field.trim());
        if (header.length === 0 || header.some((field) => field.length === 0)) fail("INVALID_HEADER", "CSV header is empty");
        if (new Set(header).size !== header.length) fail("DUPLICATE_HEADER", "CSV contains duplicate columns");
        const mapped: Record<string, number> = {};
        for (const required of spec.required) {
          const index = header.indexOf(required);
          if (index === -1) fail("MISSING_COLUMN", `CSV is missing required column ${required}`);
          mapped[required] = index;
        }
        indexes = mapped;
        continue;
      }
      const row: Record<string, string> = {};
      for (const [key, index] of Object.entries(indexes)) row[key] = fields[index] ?? "";
      spec.insert(row);
      rows += 1;
      pending += 1;
      if (pending === IMPORT_TRANSACTION_ROWS) {
        database.exec("COMMIT; BEGIN IMMEDIATE");
        pending = 0;
      }
    }
    if (indexes === undefined) fail("INVALID_HEADER", "CSV source is empty");
    database.exec("COMMIT");
    return rows;
  } catch (error) {
    input.destroy();
    database.exec("ROLLBACK");
    if (error instanceof CatalogImportError) throw error;
    fail("CSV_PARSE_FAILED", "CSV source could not be parsed", error);
  }
}

function assertSourceFile(path: string): void {
  const size = statSync(path).size;
  if (size > MAX_COMPRESSED_DOWNLOAD_BYTES) fail("SOURCE_TOO_LARGE", `${basename(path)} exceeds the 2 GiB source limit`);
}

function openZip(path: string): Promise<ZipFileLike> {
  const { promise, resolve: resolveZip, reject } = Promise.withResolvers<ZipFileLike>();
  yauzl.open(path, {
    autoClose: false,
    decodeStrings: true,
    lazyEntries: true,
    strictFileNames: true,
    validateEntrySizes: true,
  }, (error: Error | null, zipFile?: ZipFileLike) => {
    if (error || zipFile === undefined) reject(error ?? new Error("ZIP did not open"));
    else resolveZip(zipFile);
  });
  return promise;
}

function nextZipEntry(zip: ZipFileLike): Promise<ZipEntryLike | undefined> {
  const { promise, resolve: resolveEntry, reject } = Promise.withResolvers<ZipEntryLike | undefined>();
  const cleanup = (): void => {
    zip.removeListener("entry", onEntry as (...args: never[]) => void);
    zip.removeListener("end", onEnd as (...args: never[]) => void);
    zip.removeListener("error", onError as (...args: never[]) => void);
  };
  const onEntry = (entry: ZipEntryLike): void => {
    cleanup();
    resolveEntry(entry);
  };
  const onEnd = (): void => {
    cleanup();
    resolveEntry(undefined);
  };
  const onError = (error: unknown): void => {
    cleanup();
    reject(error);
  };
  zip.once("entry", onEntry);
  zip.once("end", onEnd);
  zip.once("error", onError);
  zip.readEntry();
  return promise;
}

function openZipEntry(zip: ZipFileLike, entry: ZipEntryLike): Promise<Readable> {
  const { promise, resolve: resolveStream, reject } = Promise.withResolvers<Readable>();
  zip.openReadStream(entry, (error, stream) => {
    if (error || stream === undefined) reject(error ?? new Error("ZIP entry did not open"));
    else resolveStream(stream);
  });
  return promise;
}

function gtfsKey(name: string): keyof CatalogRecordSourceSet | undefined {
  switch (name) {
    case "routes.txt": return "routes";
    case "trips.txt": return "trips";
    case "stop_times.txt": return "stopTimes";
    case "stops.txt": return "stops";
    case "agency.txt": return "agency";
    case "object_codes_extension.txt":
    case "objects_codes_extension.txt": return "objectCodes";
    default: return undefined;
  }
}

async function loadGtfsZip(database: DatabaseSync, path: string, specs: Readonly<Record<keyof CatalogRecordSourceSet, CsvSpec>>): Promise<void> {
  assertSourceFile(path);
  let zip: ZipFileLike | undefined;
  const seen = new Set<string>();
  let selectedBytes = 0;
  try {
    zip = await openZip(path);
    while (true) {
      const entry = await nextZipEntry(zip);
      if (entry === undefined) break;
      const normalizedName = entry.fileName.replaceAll("\\", "/").split("/").at(-1)!.toLowerCase();
      const key = gtfsKey(normalizedName);
      if (key === undefined) continue;
      if ((entry.generalPurposeBitFlag & 1) !== 0) fail("ENCRYPTED_ZIP_ENTRY", `selected GTFS entry ${normalizedName} is encrypted`);
      const conceptualName = Object.hasOwn(CODE_ENTRY_NAME, normalizedName) ? "codes-extension" : normalizedName;
      if (seen.has(conceptualName)) fail("DUPLICATE_ZIP_ENTRY", `GTFS contains duplicate required entry ${normalizedName}`);
      seen.add(conceptualName);
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 || entry.uncompressedSize > MAX_SELECTED_ENTRY_BYTES) {
        fail("ZIP_ENTRY_TOO_LARGE", `selected GTFS entry ${normalizedName} exceeds its byte limit`);
      }
      const stream = await openZipEntry(zip, entry);
      const limiter = new ByteLimit(MAX_SELECTED_ENTRY_BYTES, (bytes) => {
        selectedBytes += bytes;
        if (selectedBytes > MAX_SELECTED_ARCHIVE_BYTES) {
          fail("ZIP_AGGREGATE_TOO_LARGE", "selected GTFS entries exceed the 16 GiB aggregate limit");
        }
      });
      stream.once("error", (error) => limiter.destroy(error));
      await loadCsvStream(database, stream.pipe(limiter), ",", specs[key]);
    }
    for (const name of REQUIRED_GTFS_ENTRIES) {
      if (!seen.has(name)) fail("MISSING_ZIP_ENTRY", `GTFS is missing required entry ${name}`);
    }
    if (!seen.has("codes-extension")) fail("MISSING_ZIP_ENTRY", "GTFS is missing its codes-extension entry");
  } catch (error) {
    if (error instanceof CatalogImportError) throw error;
    fail("GTFS_ZIP_FAILED", "GTFS ZIP could not be imported", error);
  } finally {
    zip?.close();
  }
}

async function loadFileSources(database: DatabaseSync, sources: CatalogFileSourceSet): Promise<void> {
  const specs = prepareSpecs(database);
  await loadGtfsZip(database, sources.gtfsZipPath, specs);
  const csvSources: readonly [keyof CatalogRecordSourceSet, CsvFileSource][] = [
    ["perimeter", sources.perimeter],
    ["arrets", sources.arrets],
    ["zones", sources.zones],
    ["relations", sources.relations],
    ["lines", sources.lines],
    ["arretsLignes", sources.arretsLignes],
  ];
  for (const [key, source] of csvSources) {
    assertSourceFile(source.path);
    const rows = await loadCsvStream(database, createReadStream(source.path), source.delimiter ?? ";", specs[key]);
    if (source.expectedRows !== undefined && rows !== source.expectedRows) {
      fail("SOURCE_ROW_COUNT", `${key} row count ${rows} does not match metadata count ${source.expectedRows}`);
    }
  }
}

function createIndexes(database: DatabaseSync): void {
  database.exec(`
    CREATE INDEX stage_trips_route ON stage_trips(route_id);
    CREATE INDEX stage_stop_times_trip ON stage_stop_times(trip_id, stop_sequence);
    CREATE INDEX stage_stop_times_stop ON stage_stop_times(stop_id);
    CREATE INDEX stage_codes_object ON stage_codes(object_id, object_code);
    CREATE INDEX stage_codes_code ON stage_codes(object_code, object_id);
    CREATE INDEX stage_perimeter_line ON stage_perimeter(id_line, monitoring_ref);
    CREATE INDEX stage_arrets_zda ON stage_arrets(zdaid);
    CREATE INDEX stage_relations_art ON stage_relations(artid, zdaid) WHERE artid IS NOT NULL;
    CREATE INDEX stage_arrets_lignes_stop ON stage_arrets_lignes(stop_id, route_id);
  `);
}

function deriveCandidates(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE stage_line_modes (
      id_line TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      line_label TEXT NOT NULL,
      line_color TEXT NOT NULL,
      line_text_color TEXT NOT NULL
    ) STRICT;

    INSERT INTO stage_line_modes
    SELECT id_line,
      CASE
        WHEN lower(trim(transport_mode)) = 'bus' THEN 'BUS'
        WHEN lower(trim(transport_mode)) = 'metro' THEN 'METRO'
        WHEN lower(trim(transport_mode)) = 'tram' THEN 'TRAM'
        WHEN lower(trim(transport_mode)) = 'rail' AND lower(trim(transport_submode)) = 'local' THEN 'RER'
        WHEN lower(trim(transport_mode)) = 'rail' AND lower(trim(transport_submode)) = 'suburbanrailway' THEN 'TRANSILIEN'
      END,
      coalesce(nullif(trim(shortname_line), ''), trim(name_line)),
      line_color,
      line_text_color
    FROM stage_lines
    WHERE lower(trim(status)) = 'active'
      AND (
        lower(trim(transport_mode)) IN ('bus', 'metro', 'tram')
        OR (lower(trim(transport_mode)) = 'rail' AND lower(trim(transport_submode)) IN ('local', 'suburbanrailway'))
      );

    CREATE TABLE stage_stop_zda (
      stop_id TEXT PRIMARY KEY,
      zdaid TEXT,
      rail_zdaid TEXT NOT NULL,
      resolution TEXT NOT NULL
    ) STRICT;

    INSERT INTO stage_stop_zda (stop_id, zdaid, rail_zdaid, resolution)
    SELECT
      stop.stop_id,
      coalesce(current_area.zdaid, area.zdaid, relation.zdaid),
      CASE
        WHEN stop.stop_id LIKE 'IDFM:monomodalStopPlace:%'
          THEN substr(stop.stop_id, length('IDFM:monomodalStopPlace:') + 1)
        WHEN coalesce(nullif(stop.parent_station, ''), stop.stop_id) LIKE 'IDFM:monomodalStopPlace:%'
          THEN substr(coalesce(nullif(stop.parent_station, ''), stop.stop_id), length('IDFM:monomodalStopPlace:') + 1)
        WHEN coalesce(nullif(stop.parent_station, ''), stop.stop_id) LIKE 'IDFM:%'
          THEN substr(coalesce(nullif(stop.parent_station, ''), stop.stop_id), 6)
        ELSE coalesce(nullif(stop.parent_station, ''), stop.stop_id)
      END,
      CASE WHEN coalesce(current_area.arrid, area.arrid) IS NULL THEN 'relations' ELSE 'arrets' END
    FROM stage_stops AS stop
    LEFT JOIN stage_arrets AS current_area
      ON current_area.arrid = CASE
        WHEN stop.stop_id LIKE 'IDFM:%' THEN substr(stop.stop_id, 6)
        ELSE stop.stop_id
      END
    LEFT JOIN stage_arrets AS area
      ON area.arrid = CASE
        WHEN coalesce(nullif(stop.parent_station, ''), stop.stop_id) LIKE 'IDFM:%'
          THEN substr(coalesce(nullif(stop.parent_station, ''), stop.stop_id), 6)
        ELSE coalesce(nullif(stop.parent_station, ''), stop.stop_id)
      END
    LEFT JOIN (
      SELECT artid, min(zdaid) AS zdaid
      FROM stage_relations
      WHERE artid IS NOT NULL
      GROUP BY artid
    ) AS relation
      ON relation.artid = CASE
        WHEN stop.stop_id LIKE 'IDFM:%' THEN substr(stop.stop_id, 6)
        ELSE stop.stop_id
      END;

    CREATE TABLE stage_terminals AS
    SELECT stop_time.trip_id, stop_time.stop_id, stop.stop_name
    FROM stage_stop_times AS stop_time
    JOIN stage_stops AS stop ON stop.stop_id = stop_time.stop_id
    JOIN (
      SELECT trip_id, max(stop_sequence) AS stop_sequence
      FROM stage_stop_times
      GROUP BY trip_id
    ) AS terminal
      ON terminal.trip_id = stop_time.trip_id
      AND terminal.stop_sequence = stop_time.stop_sequence;
    CREATE UNIQUE INDEX stage_terminals_trip ON stage_terminals(trip_id);

    CREATE TABLE stage_gtfs_services AS
    SELECT DISTINCT trip.route_id, trip.trip_headsign, trip.direction_id,
      current_stop_time.stop_id, terminal.stop_id AS terminal_stop_id,
      terminal.stop_name AS terminal_stop_name
    FROM stage_stop_times AS current_stop_time
    JOIN stage_trips AS trip ON trip.trip_id = current_stop_time.trip_id
    JOIN stage_terminals AS terminal ON terminal.trip_id = current_stop_time.trip_id
    WHERE current_stop_time.pickup_type <> 1
      AND trim(trip.direction_id) <> ''
      AND EXISTS (
        SELECT 1 FROM stage_stop_times AS later
        WHERE later.trip_id = current_stop_time.trip_id
          AND later.stop_sequence > current_stop_time.stop_sequence
      );

    CREATE TABLE stage_routing_candidates AS
    SELECT DISTINCT
      line_mode.mode AS mode,
      CASE WHEN line_mode.mode IN ('RER', 'TRANSILIEN') THEN stop_zda.rail_zdaid ELSE stop_zda.zdaid END AS zdaid,
      zone.zdaname AS stop_label, zone.zdatown AS locality_label,
      line_mode.id_line AS id_line, line_mode.line_label AS line_label,
      line_mode.line_color AS line_color, line_mode.line_text_color AS line_text_color,
      CASE WHEN line_mode.mode IN ('RER', 'TRANSILIEN') THEN trip.terminal_stop_name
        ELSE coalesce(nullif(trim(trip.trip_headsign), ''), trip.terminal_stop_name)
      END AS destination_label,
      CASE WHEN line_mode.mode IN ('RER', 'TRANSILIEN')
        THEN 'STIF:StopArea:SP:' || stop_zda.rail_zdaid || ':'
        ELSE 'STIF:StopPoint:Q:' || substr(trip.stop_id, 6) || ':'
      END AS monitoring_ref,
      trip.direction_id AS direction_id,
      CASE WHEN line_mode.mode IN ('RER', 'TRANSILIEN')
        THEN 'STIF:StopArea:SP:' || substr(trip.terminal_stop_id, length('IDFM:monomodalStopPlace:') + 1) || ':'
        ELSE 'STIF:StopPoint:Q:' || substr(trip.terminal_stop_id, 6) || ':'
      END AS destination_ref,
      destination_code.object_code AS source_terminal_code,
      trip.terminal_stop_id AS terminal_stop_id,
      current_stop.stop_id AS stop_id, current_stop.parent_station AS parent_station,
      stop_zda.resolution AS resolution
    FROM stage_gtfs_services AS trip
    JOIN stage_routes AS route ON route.route_id = CASE WHEN trip.route_id LIKE 'IDFM:%' THEN substr(trip.route_id, 6) ELSE trip.route_id END
    JOIN stage_line_modes AS line_mode ON line_mode.id_line = route.route_id
    JOIN stage_stops AS current_stop ON current_stop.stop_id = trip.stop_id
    JOIN stage_stop_zda AS stop_zda ON stop_zda.stop_id = current_stop.stop_id
    JOIN stage_codes AS destination_code
      ON destination_code.object_id = trip.terminal_stop_id
      AND lower(trim(destination_code.object_system)) = 'source'
    JOIN stage_zones AS zone
      ON zone.zdaid = CASE WHEN line_mode.mode IN ('RER', 'TRANSILIEN') THEN stop_zda.rail_zdaid ELSE stop_zda.zdaid END
    WHERE trim(destination_code.object_code) <> ''
      AND (
        (line_mode.mode IN ('RER', 'TRANSILIEN')
          AND trip.stop_id LIKE 'IDFM:monomodalStopPlace:%'
          AND trip.terminal_stop_id LIKE 'IDFM:monomodalStopPlace:%')
        OR (line_mode.mode NOT IN ('RER', 'TRANSILIEN')
          AND trip.stop_id LIKE 'IDFM:%' AND trip.stop_id NOT LIKE 'IDFM:monomodalStopPlace:%'
          AND trip.terminal_stop_id LIKE 'IDFM:%' AND trip.terminal_stop_id NOT LIKE 'IDFM:monomodalStopPlace:%')
      );

    -- Detect conflicts before perimeter or attachment exclusions can hide one side.
    CREATE TABLE stage_routing_collisions AS
    SELECT monitoring_ref, id_line, destination_ref
    FROM stage_routing_candidates
    GROUP BY monitoring_ref, id_line, destination_ref
    HAVING count(DISTINCT direction_id) > 1 OR count(DISTINCT terminal_stop_id) > 1
      OR count(DISTINCT source_terminal_code) > 1;
    CREATE UNIQUE INDEX stage_routing_collision_key
      ON stage_routing_collisions(monitoring_ref, id_line, destination_ref);

    CREATE TABLE stage_routing_exclusions AS
    SELECT mode, count(*) AS service_count
    FROM (
      SELECT DISTINCT candidate.mode, candidate.id_line, candidate.monitoring_ref,
        candidate.direction_id, candidate.source_terminal_code
      FROM stage_routing_candidates AS candidate
      JOIN stage_routing_collisions AS collision
        USING (monitoring_ref, id_line, destination_ref)
    )
    GROUP BY mode;

    CREATE TABLE stage_candidates AS
    SELECT candidate.mode, candidate.zdaid,
      min(candidate.stop_label) AS stop_label, min(candidate.locality_label) AS locality_label,
      candidate.id_line, min(candidate.line_label) AS line_label,
      min(candidate.line_color) AS line_color, min(candidate.line_text_color) AS line_text_color,
      min(candidate.destination_label) AS destination_label,
      candidate.monitoring_ref, perimeter.line AS line_ref,
      candidate.direction_id, candidate.destination_ref, candidate.source_terminal_code,
      max(CASE WHEN candidate.resolution = 'arrets' THEN 1 ELSE 0 END) AS via_arrets
    FROM stage_routing_candidates AS candidate
    JOIN stage_arrets_lignes AS attached
      ON attached.route_id = candidate.id_line
      AND attached.stop_id IN (candidate.stop_id, candidate.parent_station)
    JOIN stage_perimeter AS perimeter
      ON perimeter.id_line = candidate.id_line
      AND (
        perimeter.monitoring_ref = candidate.monitoring_ref
        OR (candidate.mode IN ('RER', 'TRANSILIEN') AND EXISTS (
          SELECT 1 FROM stage_arrets AS child
          WHERE child.zdaid = candidate.zdaid
            AND perimeter.monitoring_ref = 'STIF:StopPoint:Q:' || child.arrid || ':'
        ))
      )
    WHERE NOT EXISTS (
      SELECT 1 FROM stage_routing_collisions AS collision
      WHERE collision.monitoring_ref = candidate.monitoring_ref
        AND collision.id_line = candidate.id_line
        AND collision.destination_ref = candidate.destination_ref
    )
    GROUP BY candidate.mode, candidate.zdaid, candidate.monitoring_ref, candidate.id_line,
      perimeter.line, candidate.direction_id, candidate.destination_ref, candidate.source_terminal_code;
  `);
}

function insertFinalCatalog(database: DatabaseSync, sourceRevision: string, createdAt: string): PlaceResolutionCounts {
  const metadata = database.prepare("INSERT INTO metadata VALUES (?, ?)");
  metadata.run("schema_version", String(SCHEMA_VERSION));
  metadata.run("catalog_version", String(CATALOG_VERSION));
  metadata.run("source_revision", sourceRevision);
  metadata.run("created_at", createdAt);
  const exclusions = Object.fromEntries(TRANSPORT_MODE.map((mode) => [mode, 0])) as Record<TransportMode, number>;
  for (const row of database.prepare("SELECT mode, service_count FROM stage_routing_exclusions").iterate() as Iterable<QueryRow>) {
    exclusions[transportMode(row.mode)] = Number(row.service_count);
  }
  metadata.run("excluded_ambiguous_services_by_mode", JSON.stringify(exclusions));

  const insertPlace = database.prepare("INSERT INTO places VALUES (?, ?, ?, ?, ?)");
  const insertSearch = database.prepare("INSERT INTO place_search(search_text, place_id) VALUES (?, ?)");
  const insertService = database.prepare("INSERT INTO services VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
  const selectPlace = database.prepare("SELECT canonical_tuple FROM places WHERE place_id = ?");
  const selectService = database.prepare("SELECT place_id, canonical_tuple FROM services WHERE service_id = ?");

  const places = database.prepare(`
    SELECT mode, zdaid, min(stop_label) AS stop_label, min(locality_label) AS locality_label,
      max(via_arrets) AS via_arrets
    FROM stage_candidates
    GROUP BY mode, zdaid
    ORDER BY mode, zdaid
  `).iterate() as Iterable<QueryRow>;

  const placeResolution: PlaceResolutionCounts = { arrets: 0, relations: 0, direct: 0 };

  database.exec("BEGIN IMMEDIATE");
  try {
    for (const row of places) {
      const mode = transportMode(row.mode);
      const zdaId = nonEmpty(row.zdaid, "candidate.zdaid");
      const stopLabel = nonEmpty(row.stop_label, "candidate.stop_label");
      const localityLabel = optionalText(row.locality_label);
      const identity = createPlaceIdentity(mode, zdaId);
      const collision = selectPlace.get(identity.placeId) as QueryRow | undefined;
      if (collision !== undefined && collision.canonical_tuple !== identity.canonicalTuple) {
        fail("HASH_COLLISION", "place ID collision detected");
      }
      if (collision === undefined) {
        const searchText = normalizeCatalogSearchText(`${stopLabel} ${localityLabel}`);
        if (searchText.length === 0) fail("CATALOG_SEARCH", "place label produces empty search text");
        insertPlace.run(identity.placeId, stopLabel, localityLabel || null, mode, identity.canonicalTuple);
        insertSearch.run(searchText, identity.placeId);
      }
      if (mode === "RER" || mode === "TRANSILIEN") placeResolution.direct += 1;
      else if (Number(row.via_arrets) === 1) placeResolution.arrets += 1;
      else placeResolution.relations += 1;
    }

    const candidates = database.prepare(`
      SELECT mode, zdaid, stop_label, line_label, destination_label,
        line_color, line_text_color, id_line, monitoring_ref, line_ref, direction_id, destination_ref, source_terminal_code
      FROM stage_candidates
      ORDER BY mode, zdaid, id_line, monitoring_ref, direction_id, destination_ref
    `).iterate() as Iterable<QueryRow>;
    for (const row of candidates) {
      const mode = transportMode(row.mode);
      const place = createPlaceIdentity(mode, nonEmpty(row.zdaid, "candidate.zdaid"));
      const service = createServiceIdentity({
        mode,
        lineId: nonEmpty(row.id_line, "candidate.id_line"),
        monitoringRef: nonEmpty(row.monitoring_ref, "candidate.monitoring_ref"),
        directionId: nonEmpty(row.direction_id, "candidate.direction_id"),
        destinationRef: nonEmpty(row.source_terminal_code, "candidate.source_terminal_code"),
      });
      const collision = selectService.get(service.serviceId) as QueryRow | undefined;
      if (collision !== undefined && collision.canonical_tuple !== service.canonicalTuple) {
        fail("HASH_COLLISION", "service ID collision detected");
      }
      if (collision !== undefined && collision.place_id !== place.placeId) {
        fail("INVALID_SERVICE_PLACE", "one semantic service resolved to multiple places");
      }
      if (collision === undefined) {
        insertService.run(
          service.serviceId,
          place.placeId,
          nonEmpty(row.stop_label, "candidate.stop_label"),
          nonEmpty(row.line_label, "candidate.line_label"),
          nonEmpty(row.destination_label, "candidate.destination_label"),
          normalizeLineColor(row.line_color, "candidate.line_color"),
          normalizeLineColor(row.line_text_color, "candidate.line_text_color"),
          nonEmpty(row.monitoring_ref, "candidate.monitoring_ref"),
          nonEmpty(row.line_ref, "candidate.line_ref"),
          nonEmpty(row.direction_id, "candidate.direction_id"),
          nonEmpty(row.destination_ref, "candidate.destination_ref"),
          service.canonicalTuple,
        );
      }
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return placeResolution;
}

function validateByteBounds(database: DatabaseSync): void {
  const invalidPlace = database.prepare(`
    SELECT place_id FROM places
    WHERE length(CAST(place_id AS BLOB)) > ?
      OR length(CAST(stop_label AS BLOB)) > ?
      OR (locality_label IS NOT NULL AND length(CAST(locality_label AS BLOB)) > ?)
    LIMIT 1
  `).get(LIMITS.idUtf8Bytes, LIMITS.labelUtf8Bytes, LIMITS.labelUtf8Bytes);
  if (invalidPlace !== undefined) fail("CATALOG_LIMIT", "place exceeds a shared UTF-8 byte limit");

  const invalidService = database.prepare(`
    SELECT service_id FROM services
    WHERE length(CAST(service_id AS BLOB)) > ?
      OR length(CAST(stop_label AS BLOB)) > ?
      OR length(CAST(line_label AS BLOB)) > ?
      OR length(CAST(destination_label AS BLOB)) > ?
      OR length(CAST(line_color AS BLOB)) <> 7
      OR length(CAST(line_text_color AS BLOB)) <> 7
    LIMIT 1
  `).get(LIMITS.idUtf8Bytes, LIMITS.labelUtf8Bytes, LIMITS.labelUtf8Bytes, LIMITS.labelUtf8Bytes);
  if (invalidService !== undefined) fail("CATALOG_LIMIT", "service exceeds a shared UTF-8 byte limit");
}

function exactColumns(database: DatabaseSync, table: string, expected: readonly string[]): void {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as QueryRow[];
  const actual = rows.map((row) => String(row.name));
  if (actual.length !== expected.length || actual.some((name, index) => name !== expected[index])) {
    fail("CATALOG_SCHEMA", `${table} has an unexpected column contract`);
  }
}

function metadataValue(database: DatabaseSync, key: string): string | undefined {
  const row = database.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as QueryRow | undefined;
  return row === undefined ? undefined : String(row.value);
}

function validateOpenCatalog(database: DatabaseSync): CatalogBuildResult {
  database.exec("PRAGMA foreign_keys = ON");
  exactColumns(database, "metadata", ["key", "value"]);
  exactColumns(database, "places", ["place_id", "stop_label", "locality_label", "mode", "canonical_tuple"]);
  exactColumns(database, "services", ["service_id", "place_id", "stop_label", "line_label", "destination_label", "line_color", "line_text_color", "monitoring_ref", "line_ref", "direction_id", "destination_ref", "canonical_tuple"]);
  exactColumns(database, "place_search", ["search_text", "place_id"]);

  const sourceRevision = metadataValue(database, "source_revision");
  const createdAt = metadataValue(database, "created_at");
  if (metadataValue(database, "schema_version") !== String(SCHEMA_VERSION)
    || metadataValue(database, "catalog_version") !== String(CATALOG_VERSION)
    || sourceRevision === undefined || sourceRevision.trim() === ""
    || createdAt === undefined) {
    fail("CATALOG_METADATA", "catalog metadata is incomplete or incompatible");
  }
  isoTimestamp(createdAt, "metadata.created_at");

  const integrity = database.prepare("PRAGMA integrity_check").all() as QueryRow[];
  if (integrity.length !== 1 || String(integrity[0]?.integrity_check) !== "ok") fail("CATALOG_INTEGRITY", "SQLite integrity_check failed");
  if ((database.prepare("PRAGMA foreign_key_check").all() as QueryRow[]).length !== 0) fail("CATALOG_FOREIGN_KEY", "SQLite foreign_key_check failed");
  validateByteBounds(database);

  const missingSearch = database.prepare(`
    SELECT 1 FROM places AS place
    LEFT JOIN place_search AS search ON search.place_id = place.place_id
    WHERE search.place_id IS NULL
    LIMIT 1
  `).get();
  const extraSearch = database.prepare(`
    SELECT 1 FROM place_search AS search
    LEFT JOIN places AS place ON place.place_id = search.place_id
    WHERE place.place_id IS NULL
    LIMIT 1
  `).get();
  if (missingSearch !== undefined || extraSearch !== undefined) fail("CATALOG_SEARCH", "FTS place index does not match places");
  const invalidPlaceService = database.prepare(`
    SELECT 1
    FROM places AS place
    LEFT JOIN services AS service ON service.place_id = place.place_id
    WHERE service.service_id IS NULL OR service.stop_label <> place.stop_label
    LIMIT 1
  `).get();
  if (invalidPlaceService !== undefined) {
    fail("CATALOG_PLACE_SERVICE", "catalog place is empty or has inconsistent service labels");
  }
  if (database.prepare("SELECT 1 FROM place_search WHERE trim(search_text) = '' LIMIT 1").get() !== undefined) {
    fail("CATALOG_SEARCH", "FTS place index contains empty search text");
  }

  const unresolved = database.prepare(`
    SELECT 1 FROM services
    WHERE trim(monitoring_ref) = '' OR trim(line_ref) = '' OR trim(direction_id) = '' OR trim(destination_ref) = ''
      OR line_color NOT GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      OR line_text_color NOT GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
    LIMIT 1
  `).get();
  if (unresolved !== undefined) fail("CATALOG_UNRESOLVED", "catalog contains an unresolvable or malformed offered service");
  if (database.prepare(`
    SELECT 1 FROM services
    GROUP BY monitoring_ref, line_ref, destination_ref
    HAVING count(*) <> 1
    LIMIT 1
  `).get() !== undefined) fail("AMBIGUOUS_SERVICE", "multiple services share the same phone routing selector");

  for (const row of database.prepare("SELECT place_id, canonical_tuple FROM places").iterate() as Iterable<QueryRow>) {
    if (opaqueId("plc_", String(row.canonical_tuple)) !== row.place_id) fail("HASH_COLLISION", "place ID does not match its canonical tuple");
  }
  for (const row of database.prepare("SELECT service_id, canonical_tuple FROM services").iterate() as Iterable<QueryRow>) {
    if (opaqueId("svc_", String(row.canonical_tuple)) !== row.service_id) fail("HASH_COLLISION", "service ID does not match its canonical tuple");
  }

  const counts = Object.fromEntries(TRANSPORT_MODE.map((mode) => [mode, 0])) as Record<TransportMode, number>;
  for (const row of database.prepare(`
    SELECT place.mode AS mode, count(service.service_id) AS service_count
    FROM places AS place
    JOIN services AS service ON service.place_id = place.place_id
    GROUP BY place.mode
  `).all() as QueryRow[]) {
    const mode = transportMode(row.mode);
    counts[mode] = Number(row.service_count);
  }
  for (const mode of TRANSPORT_MODE) {
    if (counts[mode] < 1) fail("MODE_COVERAGE", `catalog has no resolvable ${mode} service`);
  }
  const excludedAmbiguousServicesByMode = JSON.parse(nonEmpty(metadataValue(database, "excluded_ambiguous_services_by_mode"), "excluded_ambiguous_services_by_mode")) as Record<TransportMode, number>;
  if (excludedAmbiguousServicesByMode === null || Array.isArray(excludedAmbiguousServicesByMode)
    || typeof excludedAmbiguousServicesByMode !== "object"
    || Object.keys(excludedAmbiguousServicesByMode).length !== TRANSPORT_MODE.length
    || TRANSPORT_MODE.some((mode) => !Number.isSafeInteger(excludedAmbiguousServicesByMode[mode]) || excludedAmbiguousServicesByMode[mode] < 0)) {
    fail("CATALOG_METADATA", "ambiguous service exclusion counts are invalid");
  }

  const placeCount = Number((database.prepare("SELECT count(*) AS count FROM places").get() as QueryRow).count);
  const serviceCount = Number((database.prepare("SELECT count(*) AS count FROM services").get() as QueryRow).count);
  return { candidatePath: "", sourceRevision, createdAt, placeCount, serviceCount, countsByMode: counts, excludedAmbiguousServicesByMode };
}

function validateStagedPerimeter(database: DatabaseSync): void {
  const missing = database.prepare(`
    SELECT 1 FROM stage_candidates AS candidate
    WHERE NOT EXISTS (
      SELECT 1 FROM stage_perimeter AS perimeter
      WHERE perimeter.line = candidate.line_ref
        AND (
          perimeter.monitoring_ref = candidate.monitoring_ref
          OR (candidate.mode IN ('RER', 'TRANSILIEN')
            AND candidate.monitoring_ref = 'STIF:StopArea:SP:' || candidate.zdaid || ':'
            AND EXISTS (
              SELECT 1 FROM stage_arrets AS child
              WHERE child.zdaid = candidate.zdaid
                AND perimeter.monitoring_ref = 'STIF:StopPoint:Q:' || child.arrid || ':'
            ))
        )
    )
    LIMIT 1
  `).get();
  if (missing !== undefined) fail("PERIMETER_MISMATCH", "offered service lacks its exact perimeter pair or documented rail child provenance");
}

function validateCandidateSemanticTuples(database: DatabaseSync): void {
  const ambiguous = database.prepare(`
    SELECT 1
    FROM stage_candidates
    GROUP BY mode, id_line, monitoring_ref, direction_id, source_terminal_code
    HAVING count(*) <> 1 OR count(DISTINCT zdaid) <> 1
    LIMIT 1
  `).get();
  if (ambiguous !== undefined) {
    fail("AMBIGUOUS_SERVICE", "a semantic service tuple resolves to multiple candidate rows or places");
  }
  if (database.prepare(`
    SELECT 1 FROM stage_candidates
    GROUP BY monitoring_ref, line_ref, destination_ref
    HAVING count(*) <> 1
    LIMIT 1
  `).get() !== undefined) fail("AMBIGUOUS_SERVICE", "multiple services share the same phone routing selector");
}

function dropStaging(database: DatabaseSync): void {
  database.exec(`
    DROP TABLE stage_candidates;
    DROP TABLE stage_routing_exclusions;
    DROP TABLE stage_routing_collisions;
    DROP TABLE stage_routing_candidates;
    DROP TABLE stage_gtfs_services;
    DROP TABLE stage_terminals;
    DROP TABLE stage_stop_zda;
    DROP TABLE stage_line_modes;
    DROP TABLE stage_arrets_lignes;
    DROP TABLE stage_lines;
    DROP TABLE stage_relations;
    DROP TABLE stage_zones;
    DROP TABLE stage_arrets;
    DROP TABLE stage_perimeter;
    DROP TABLE stage_codes;
    DROP TABLE stage_agency;
    DROP TABLE stage_stops;
    DROP TABLE stage_stop_times;
    DROP TABLE stage_trips;
    DROP TABLE stage_routes;
    PRAGMA optimize;
  `);
}

async function build(
  candidatePath: string,
  sourceRevisionValue: string,
  createdAtValue: string | undefined,
  load: (database: DatabaseSync) => void | Promise<void>,
): Promise<CatalogBuildResult> {
  const candidate = resolve(candidatePath);
  const sourceRevision = nonEmpty(sourceRevisionValue, "sourceRevision");
  const createdAt = isoTimestamp(createdAtValue ?? new Date().toISOString(), "createdAt");
  if (existsSync(candidate)) fail("CANDIDATE_EXISTS", "catalog candidate path already exists");
  mkdirSync(dirname(candidate), { recursive: true });

  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(candidate);
    createSchema(database);
    await load(database);
    createIndexes(database);
    deriveCandidates(database);
    validateStagedPerimeter(database);
    validateCandidateSemanticTuples(database);
    const placeResolution = insertFinalCatalog(database, sourceRevision, createdAt);
    dropStaging(database);
    const result = validateOpenCatalog(database);
    database.close();
    database = undefined;
    fsyncFile(candidate);
    return { ...result, candidatePath: candidate, placeResolution };
  } catch (error) {
    try {
      database?.close();
    } finally {
      removeCandidateFiles(candidate);
    }
    if (error instanceof CatalogImportError) throw error;
    fail("CATALOG_BUILD_FAILED", "catalog candidate build failed", error);
  }
}

export function buildCatalogCandidate(options: BuildCatalogOptions): Promise<CatalogBuildResult> {
  return build(options.candidatePath, options.sourceRevision, options.createdAt, (database) => loadFileSources(database, options.sources));
}

export function buildCatalogCandidateFromRecords(options: BuildCatalogFromRecordsOptions): Promise<CatalogBuildResult> {
  return build(options.candidatePath, options.sourceRevision, options.createdAt, (database) => loadRecordSources(database, options.sources));
}

export function validateCatalogCandidate(path: string): CatalogBuildResult {
  const candidate = resolve(path);
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(candidate, { readOnly: true });
    const result = validateOpenCatalog(database);
    return { ...result, candidatePath: candidate };
  } catch (error) {
    if (error instanceof CatalogImportError) throw error;
    fail("CATALOG_VALIDATION_FAILED", "catalog candidate validation failed", error);
  } finally {
    database?.close();
  }
}

export function activateCatalogCandidate(candidatePath: string, activePath: string): CatalogBuildResult {
  const candidate = resolve(candidatePath);
  const active = resolve(activePath);
  if (candidate === active) fail("INVALID_ACTIVATION", "candidate and active paths must differ");
  mkdirSync(dirname(active), { recursive: true });
  let result: CatalogBuildResult;
  try {
    result = validateCatalogCandidate(candidate);
    if (statSync(candidate).dev !== statSync(dirname(active)).dev) {
      fail("CROSS_DEVICE_ACTIVATION", "catalog candidate and active directory must share a filesystem");
    }
    fsyncFile(candidate);
  } catch (error) {
    removeCandidateFiles(candidate);
    throw error;
  }
  try {
    renameSync(candidate, active);
  } catch (error) {
    removeCandidateFiles(candidate);
    throw error;
  }
  try {
    fsyncDirectory(dirname(active));
  } catch {
    // The rename already replaced the active path; never unlink either file.
    // Revalidate what is actually active and report the applied activation.
    const reapplied = validateCatalogCandidate(active);
    return { ...reapplied, candidatePath: active, revalidatedAfterRenameFailure: true };
  }
  return { ...result, candidatePath: active };
}

export async function refreshCatalog(options: BuildCatalogOptions & { readonly activePath: string }): Promise<CatalogBuildResult> {
  await buildCatalogCandidate(options);
  return activateCatalogCandidate(options.candidatePath, options.activePath);
}

export async function refreshCatalogFromRecords(
  options: BuildCatalogFromRecordsOptions & { readonly activePath: string },
): Promise<CatalogBuildResult> {
  await buildCatalogCandidateFromRecords(options);
  return activateCatalogCandidate(options.candidatePath, options.activePath);
}
