import { DatabaseSync, type StatementSync } from "node:sqlite";
import {
  LIMITS,
  TRANSPORT_MODE,
  isPlaceLine,
  type PlaceLine,
  type PlaceSearchItem,
  type ServiceOption,
  type TransportMode,
} from "../../contracts/src/index.ts";

import { normalizeCatalogSearchText } from "../../config-page/src/search-text.js";

export type CatalogServiceResolution =
  | {
    readonly status: "RESOLVED";
    readonly monitoringRef: string;
    readonly lineRef: string;
    readonly destinationRef: string;
    readonly destinationLabel: string;
  }
  | { readonly status: "UNRESOLVED"; readonly code: "INVALID_SERVICE" };

export interface CatalogReader {
  searchPlaces(query: string): PlaceSearchItem[];
  listServices(placeId: string): ServiceOption[] | undefined;
  resolveService(serviceId: string): CatalogServiceResolution;
}

interface PlaceRow {
  readonly placeId: string;
  readonly stopLabel: string;
  readonly localityLabel: string | null;
  readonly mode: TransportMode;
  readonly lines: string;
}

interface ServiceRow {
  readonly serviceId: string;
  readonly stopLabel: string;
  readonly lineLabel: string;
  readonly destinationLabel: string;
  readonly lineMode: TransportMode;
  readonly lineColor: string;
  readonly lineTextColor: string;
  readonly monitoringRef: string;
  readonly lineRef: string;
  readonly destinationRef: string;
}

interface ResolutionRow {
  readonly monitoringRef: string;
  readonly lineRef: string;
  readonly destinationRef: string;
  readonly destinationLabel: string;
}

interface MetadataRow {
  readonly key: string;
  readonly value: string;
}

interface SchemaRow {
  readonly name: string;
  readonly sql: string | null;
}

interface ColumnRow {
  readonly cid: number;
  readonly name: string;
  readonly type: string;
  readonly notNull: number;
  readonly primaryKey: number;
}

interface ExpectedColumn {
  readonly name: string;
  readonly type: string;
  readonly notNull?: boolean;
  readonly primaryKey?: number;
}


const CLOSE_READER = Symbol("closeCatalogReader");
const OPAQUE_ID_BYTES = 47;
const CATALOG_SCHEMA_VERSION = "1";
const CATALOG_FORMAT_VERSION = "3";
const REQUIRED_METADATA = [
  "schema_version",
  "catalog_version",
  "source_revision",
  "created_at",
] as const;
const EXPECTED_TABLES: Readonly<Record<string, true>> = {
  metadata: true,
  places: true,
  services: true,
  place_search: true,
  place_search_data: true,
  place_search_idx: true,
  place_search_content: true,
  place_search_docsize: true,
  place_search_config: true,
};
const TABLE_COLUMNS: Readonly<Record<string, readonly ExpectedColumn[]>> = {
  metadata: [
    { name: "key", type: "TEXT", primaryKey: 1 },
    { name: "value", type: "TEXT", notNull: true },
  ],
  places: [
    { name: "place_id", type: "TEXT", primaryKey: 1 },
    { name: "stop_label", type: "TEXT", notNull: true },
    { name: "locality_label", type: "TEXT" },
    { name: "mode", type: "TEXT", notNull: true },
    { name: "canonical_tuple", type: "TEXT", notNull: true },
  ],
  services: [
    { name: "service_id", type: "TEXT", primaryKey: 1 },
    { name: "place_id", type: "TEXT", notNull: true },
    { name: "stop_label", type: "TEXT", notNull: true },
    { name: "line_label", type: "TEXT", notNull: true },
    { name: "destination_label", type: "TEXT", notNull: true },
    { name: "line_color", type: "TEXT", notNull: true },
    { name: "line_text_color", type: "TEXT", notNull: true },
    { name: "monitoring_ref", type: "TEXT", notNull: true },
    { name: "line_ref", type: "TEXT", notNull: true },
    { name: "direction_id", type: "TEXT", notNull: true },
    { name: "destination_ref", type: "TEXT", notNull: true },
    { name: "canonical_tuple", type: "TEXT", notNull: true },
  ],
  place_search: [
    { name: "search_text", type: "" },
    { name: "place_id", type: "" },
  ],
};

class CatalogUnavailableError extends Error {
  constructor() {
    super("No complete catalog is active");
    this.name = "CatalogUnavailableError";
  }
}

class InvalidCatalogQueryError extends RangeError {
  constructor() {
    super("Catalog query is outside the supported bounds");
    this.name = "InvalidCatalogQueryError";
  }
}

function invalidCandidate(reason: string): never {
  throw new Error(`Invalid catalog candidate: ${reason}`);
}

function rows<T>(statement: StatementSync, ...parameters: (string | number)[]): T[] {
  return statement.all(...parameters) as unknown as T[];
}

function row<T>(statement: StatementSync, ...parameters: (string | number)[]): T | undefined {
  return statement.get(...parameters) as unknown as T | undefined;
}

function validateColumns(database: DatabaseSync): void {
  const statement = database.prepare(`
    SELECT
      cid,
      name,
      type,
      "notnull" AS "notNull",
      pk AS "primaryKey"
    FROM pragma_table_info(?)
    ORDER BY cid
  `);

  for (const [table, expected] of Object.entries(TABLE_COLUMNS)) {
    const actual = rows<ColumnRow>(statement, table);
    if (actual.length !== expected.length) invalidCandidate(`${table} columns`);

    for (let index = 0; index < expected.length; index += 1) {
      const actualColumn = actual[index];
      const expectedColumn = expected[index];
      if (
        actualColumn === undefined
        || expectedColumn === undefined
        || actualColumn.cid !== index
        || actualColumn.name !== expectedColumn.name
        || actualColumn.type.toUpperCase() !== expectedColumn.type
        || (expectedColumn.notNull === true && actualColumn.notNull !== 1)
        || (expectedColumn.primaryKey !== undefined
          && actualColumn.primaryKey !== expectedColumn.primaryKey)
      ) {
        invalidCandidate(`${table} columns`);
      }
    }
  }
}

function validateSchema(database: DatabaseSync): void {
  const schema = rows<SchemaRow>(database.prepare(`
    SELECT name, sql
    FROM sqlite_schema
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `));
  const names = new Set(schema.map((entry) => entry.name));

  if (schema.some((entry) => EXPECTED_TABLES[entry.name] !== true)) {
    invalidCandidate("unexpected table");
  }
  for (const name of Object.keys(EXPECTED_TABLES)) {
    if (!names.has(name)) invalidCandidate(`missing ${name}`);
  }

  const searchSql = schema.find((entry) => entry.name === "place_search")?.sql;
  if (
    typeof searchSql !== "string"
    || !/\bUSING\s+fts5\s*\(/iu.test(searchSql)
    || !/\bplace_id\s+UNINDEXED\b/iu.test(searchSql)
  ) {
    invalidCandidate("place_search definition");
  }

  validateColumns(database);

  const uniqueIndex = database.prepare(`
    SELECT indexes.name
    FROM pragma_index_list(?) AS indexes
    JOIN pragma_index_info(indexes.name) AS columns
    WHERE indexes."unique" = 1
    GROUP BY indexes.name
    HAVING COUNT(*) = 1 AND MAX(columns.name) = ?
    LIMIT 1
  `);
  if (row(uniqueIndex, "places", "canonical_tuple") === undefined) {
    invalidCandidate("places canonical uniqueness");
  }
  if (row(uniqueIndex, "services", "canonical_tuple") === undefined) {
    invalidCandidate("services canonical uniqueness");
  }

  const foreignKeys = rows<{ targetTable: string; sourceColumn: string; targetColumn: string }>(
    database.prepare(`
      SELECT
        "table" AS targetTable,
        "from" AS sourceColumn,
        "to" AS targetColumn
      FROM pragma_foreign_key_list('services')
    `),
  );
  if (
    foreignKeys.length !== 1
    || foreignKeys[0]?.targetTable !== "places"
    || foreignKeys[0].sourceColumn !== "place_id"
    || foreignKeys[0].targetColumn !== "place_id"
  ) {
    invalidCandidate("services foreign key");
  }
}

function validateMetadata(database: DatabaseSync): void {
  const statement = database.prepare(`
    SELECT key, value
    FROM metadata
    WHERE key IN (?, ?, ?, ?)
  `);
  const metadata = new Map(
    rows<MetadataRow>(statement, ...REQUIRED_METADATA).map((entry) => [entry.key, entry.value]),
  );

  if (metadata.size !== REQUIRED_METADATA.length) invalidCandidate("required metadata");
  if (metadata.get("schema_version") !== CATALOG_SCHEMA_VERSION) {
    invalidCandidate("schema version");
  }
  if (metadata.get("catalog_version") !== CATALOG_FORMAT_VERSION) {
    invalidCandidate("catalog version");
  }
  if (metadata.get("source_revision")?.trim() === "") {
    invalidCandidate("source revision");
  }
  if (metadata.get("created_at")?.trim() === "") invalidCandidate("creation time");
}

function validateIntegrity(database: DatabaseSync): void {
  const integrity = row<{ integrityCheck: string }>(database.prepare(`
    SELECT integrity_check AS integrityCheck
    FROM pragma_integrity_check
  `));
  if (integrity?.integrityCheck !== "ok") invalidCandidate("integrity check");
  if (database.prepare("PRAGMA foreign_key_check").get() !== undefined) {
    invalidCandidate("foreign key check");
  }
}

function validateData(database: DatabaseSync): void {
  const invalidPlace = database.prepare(`
    SELECT 1
    FROM places
    WHERE
      typeof(place_id) <> 'text'
      OR length(CAST(place_id AS BLOB)) <> ${OPAQUE_ID_BYTES}
      OR substr(place_id, 1, 4) <> 'plc_'
      OR substr(place_id, 5) GLOB '*[^A-Za-z0-9_-]*'
      OR length(CAST(stop_label AS BLOB)) NOT BETWEEN 1 AND ${LIMITS.labelUtf8Bytes}
      OR (locality_label IS NOT NULL
        AND length(CAST(locality_label AS BLOB)) NOT BETWEEN 1 AND ${LIMITS.labelUtf8Bytes})
      OR mode NOT IN ('BUS', 'METRO', 'TRAM', 'RER', 'TRANSILIEN')
      OR length(CAST(canonical_tuple AS BLOB)) < 1
    LIMIT 1
  `).get();
  if (invalidPlace !== undefined) invalidCandidate("place data");

  const invalidService = database.prepare(`
    SELECT 1
    FROM services
    WHERE
      typeof(service_id) <> 'text'
      OR length(CAST(service_id AS BLOB)) <> ${OPAQUE_ID_BYTES}
      OR substr(service_id, 1, 4) <> 'svc_'
      OR substr(service_id, 5) GLOB '*[^A-Za-z0-9_-]*'
      OR length(CAST(place_id AS BLOB)) <> ${OPAQUE_ID_BYTES}
      OR length(CAST(stop_label AS BLOB)) NOT BETWEEN 1 AND ${LIMITS.labelUtf8Bytes}
      OR length(CAST(line_label AS BLOB)) NOT BETWEEN 1 AND ${LIMITS.labelUtf8Bytes}
      OR length(CAST(destination_label AS BLOB)) NOT BETWEEN 1 AND ${LIMITS.labelUtf8Bytes}
      OR length(CAST(line_color AS BLOB)) <> 7
      OR line_color NOT GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      OR length(CAST(line_text_color AS BLOB)) <> 7
      OR line_text_color NOT GLOB '#[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]'
      OR length(CAST(monitoring_ref AS BLOB)) < 1
      OR length(CAST(line_ref AS BLOB)) < 1
      OR length(CAST(direction_id AS BLOB)) < 1
      OR length(CAST(destination_ref AS BLOB)) < 1
      OR length(CAST(canonical_tuple AS BLOB)) < 1
    LIMIT 1
  `).get();
  if (invalidService !== undefined) invalidCandidate("service data");

  if (database.prepare(`
    SELECT 1 FROM services
    GROUP BY monitoring_ref, line_ref, destination_ref
    HAVING count(*) <> 1
    LIMIT 1
  `).get() !== undefined) invalidCandidate("ambiguous routing selector");

  if (database.prepare(`
    SELECT 1
    FROM places
    WHERE NOT EXISTS (
      SELECT 1 FROM services WHERE services.place_id = places.place_id
    )
    LIMIT 1
  `).get() !== undefined) {
    invalidCandidate("place without service");
  }

  if (database.prepare(`
    SELECT 1
    FROM services
    JOIN places ON places.place_id = services.place_id
    WHERE services.stop_label <> places.stop_label
    LIMIT 1
  `).get() !== undefined) {
    invalidCandidate("inconsistent stop label");
  }


  if (database.prepare(`
    SELECT 1
    FROM places
    GROUP BY canonical_tuple
    HAVING COUNT(*) <> 1
    LIMIT 1
  `).get() !== undefined || database.prepare(`
    SELECT 1
    FROM services
    GROUP BY canonical_tuple
    HAVING COUNT(*) <> 1
    LIMIT 1
  `).get() !== undefined) {
    invalidCandidate("canonical collision");
  }

  if (database.prepare(`
    SELECT 1
    FROM place_search
    WHERE
      length(CAST(search_text AS BLOB)) < 1
      OR length(CAST(place_id AS BLOB)) <> ${OPAQUE_ID_BYTES}
    LIMIT 1
  `).get() !== undefined) {
    invalidCandidate("search data");
  }

  if (database.prepare(`
    SELECT 1
    FROM place_search
    GROUP BY place_id
    HAVING COUNT(*) <> 1
    LIMIT 1
  `).get() !== undefined || database.prepare(`
    SELECT 1
    FROM places
    LEFT JOIN place_search ON place_search.place_id = places.place_id
    WHERE place_search.place_id IS NULL
    LIMIT 1
  `).get() !== undefined || database.prepare(`
    SELECT 1
    FROM place_search
    LEFT JOIN places ON places.place_id = place_search.place_id
    WHERE places.place_id IS NULL
    LIMIT 1
  `).get() !== undefined) {
    invalidCandidate("search consistency");
  }

  const coverage = new Set(rows<{ mode: TransportMode }>(database.prepare(`
    SELECT places.mode AS mode
    FROM places
    JOIN services ON services.place_id = places.place_id
    GROUP BY places.mode
  `)).map((entry) => entry.mode));
  if (TRANSPORT_MODE.some((mode) => !coverage.has(mode))) {
    invalidCandidate("transport mode coverage");
  }
}

function validateCandidate(database: DatabaseSync): void {
  validateIntegrity(database);
  validateSchema(database);
  validateMetadata(database);
  validateData(database);
}

function normalizedMatchQuery(query: string): string {
  const trimmed = query.trim();
  const codePoints = [...trimmed].length;
  if (
    codePoints < LIMITS.catalogQueryMinCharacters
    || codePoints > LIMITS.catalogQueryMaxCharacters
  ) {
    throw new InvalidCatalogQueryError();
  }

  const normalized = normalizeCatalogSearchText(trimmed);
  if (normalized === "") throw new InvalidCatalogQueryError();

  return normalized
    .split(" ")
    .map((token) => `"${token.replaceAll('"', '""')}"*`)
    .join(" AND ");
}

// Keep native identity until display ordering and duplicate checks are complete.
export const PLACE_LINES_SQL = `json_group_array(DISTINCT json_object(
  'lineRef', services.line_ref,
  'lineLabel', services.line_label,
  'lineColor', services.line_color,
  'lineTextColor', services.line_text_color
))`;
const lineLabelOrder = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

export function placeLinesFromJson(serialized: string): PlaceLine[] {
  const entries = JSON.parse(serialized) as (PlaceLine & { readonly lineRef: string })[];
  entries.sort((left, right) => lineLabelOrder.compare(left.lineLabel, right.lineLabel)
    || (left.lineRef < right.lineRef ? -1 : left.lineRef > right.lineRef ? 1 : 0));
  const identities = new Set<string>();
  return entries.map((entry) => {
    // DISTINCT removed destination copies. A remaining duplicate ref is conflicting metadata.
    if (identities.has(entry.lineRef)) invalidCandidate("inconsistent line metadata");
    identities.add(entry.lineRef);
    const line = {
      lineLabel: entry.lineLabel,
      lineColor: entry.lineColor,
      lineTextColor: entry.lineTextColor,
    };
    if (!isPlaceLine(line)) invalidCandidate("line metadata");
    return line;
  });
}

function placeItem(entry: PlaceRow): PlaceSearchItem {
  const item: PlaceSearchItem = {
    placeId: entry.placeId,
    stopLabel: entry.stopLabel,
    mode: entry.mode,
    lines: placeLinesFromJson(entry.lines),
  };
  if (entry.localityLabel !== null) item.localityLabel = entry.localityLabel;
  return item;
}

export class SqliteCatalogReader implements CatalogReader {
  readonly #database: DatabaseSync;
  readonly #searchPlacesStatement: StatementSync;
  readonly #placeExistsStatement: StatementSync;
  readonly #listServicesStatement: StatementSync;
  readonly #resolveServiceStatement: StatementSync;
  #closed = false;

  private constructor(database: DatabaseSync) {
    this.#database = database;
    this.#searchPlacesStatement = database.prepare(`
      WITH matches AS MATERIALIZED (
        SELECT places.place_id, places.stop_label, places.locality_label, places.mode,
          bm25(place_search) AS search_rank
        FROM place_search
        JOIN places ON places.place_id = place_search.place_id
        WHERE place_search MATCH ?
        ORDER BY search_rank, places.stop_label COLLATE NOCASE, places.place_id
        LIMIT ?
      )
      SELECT
        matches.place_id AS placeId,
        matches.stop_label AS stopLabel,
        matches.locality_label AS localityLabel,
        matches.mode AS mode,
        ${PLACE_LINES_SQL} AS lines
      FROM matches
      JOIN services ON services.place_id = matches.place_id
      GROUP BY matches.place_id
      ORDER BY matches.search_rank, matches.stop_label COLLATE NOCASE, matches.place_id
    `);
    this.#placeExistsStatement = database.prepare(`
      SELECT 1
      FROM places
      WHERE place_id = ?
      LIMIT 1
    `);
    this.#listServicesStatement = database.prepare(`
      SELECT
        services.service_id AS serviceId,
        services.stop_label AS stopLabel,
        services.line_label AS lineLabel,
        services.destination_label AS destinationLabel,
        places.mode AS lineMode,
        services.line_color AS lineColor,
        services.line_text_color AS lineTextColor,
        services.monitoring_ref AS monitoringRef,
        services.line_ref AS lineRef,
        services.destination_ref AS destinationRef
      FROM services
      JOIN places ON places.place_id = services.place_id
      WHERE services.place_id = ?
      ORDER BY
        line_label COLLATE NOCASE,
        destination_label COLLATE NOCASE,
        service_id
    `);
    this.#resolveServiceStatement = database.prepare(`
      SELECT
        monitoring_ref AS monitoringRef,
        line_ref AS lineRef,
        destination_ref AS destinationRef,
        destination_label AS destinationLabel
      FROM services
      WHERE service_id = ?
      LIMIT 1
    `);
  }

  static open(path: string): SqliteCatalogReader {
    const database = new DatabaseSync(path, {
      readOnly: true,
      enableForeignKeyConstraints: true,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      defensive: true,
    });

    try {
      validateCandidate(database);
      return new SqliteCatalogReader(database);
    } catch (error) {
      try {
        database.close();
      } catch {
        // Preserve the candidate validation/open error.
      }
      throw error;
    }
  }

  searchPlaces(query: string): PlaceSearchItem[] {
    const matchQuery = normalizedMatchQuery(query);
    return rows<PlaceRow>(
      this.#searchPlacesStatement,
      matchQuery,
      LIMITS.catalogSearchResults,
    ).map(placeItem);
  }

  listServices(placeId: string): ServiceOption[] | undefined {
    if (row(this.#placeExistsStatement, placeId) === undefined) return undefined;
    return rows<ServiceRow>(this.#listServicesStatement, placeId).map((entry) => ({
      serviceId: entry.serviceId,
      stopLabel: entry.stopLabel,
      lineLabel: entry.lineLabel,
      destinationLabel: entry.destinationLabel,
      lineMode: entry.lineMode,
      lineColor: entry.lineColor,
      lineTextColor: entry.lineTextColor,
      routing: {
        monitoringRef: entry.monitoringRef,
        lineRef: entry.lineRef,
        destinationRef: entry.destinationRef,
      },
    }));
  }

  resolveService(serviceId: string): CatalogServiceResolution {
    const resolution = row<ResolutionRow>(this.#resolveServiceStatement, serviceId);
    if (resolution === undefined) return { status: "UNRESOLVED", code: "INVALID_SERVICE" };
    return { status: "RESOLVED", ...resolution };
  }

  [CLOSE_READER](): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }
}

export class CatalogManager implements CatalogReader {
  #reader: SqliteCatalogReader | undefined;

  reload(path: string): void {
    const candidate = SqliteCatalogReader.open(path);
    const previous = this.#reader;
    this.#reader = candidate;
    if (previous !== undefined) {
      try {
        previous[CLOSE_READER]();
      } catch {
        // The validated replacement is already active; an old close failure cannot roll it back.
      }
    }
  }

  searchPlaces(query: string): PlaceSearchItem[] {
    return this.#activeReader().searchPlaces(query);
  }

  listServices(placeId: string): ServiceOption[] | undefined {
    return this.#activeReader().listServices(placeId);
  }

  resolveService(serviceId: string): CatalogServiceResolution {
    return this.#activeReader().resolveService(serviceId);
  }

  #activeReader(): SqliteCatalogReader {
    if (this.#reader === undefined) throw new CatalogUnavailableError();
    return this.#reader;
  }
}

