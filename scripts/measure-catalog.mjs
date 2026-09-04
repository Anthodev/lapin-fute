import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "../packages/catalog/src/prim-probe.ts";
import { SqliteCatalogReader } from "../packages/catalog/src/catalog.ts";
import { normalizeCatalogSearchText } from "../packages/config-page/src/search-text.js";
import {
  LIMITS,
  TRANSPORT_MODE,
} from "../packages/contracts/src/index.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ACTIVE_PATH = join(PROJECT_ROOT, "var/catalog/catalog.sqlite");
const ACTIVE_PATH = resolve(process.env.CATALOG_PATH ?? DEFAULT_ACTIVE_PATH);
const EVIDENCE_PATH = join(PROJECT_ROOT, "var/catalog/evidence/measure-catalog.json");
const QUERY_COUNT = 1_000;
const MIN_QUERY_COUNT = 1_000;
let executedQueries = 0;

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function boundedPublicQuery(stopLabel, localityLabel) {
  const stop = typeof stopLabel === "string" ? stopLabel.trim() : "";
  let points = [...stop];
  if (points.length < LIMITS.catalogQueryMinCharacters) {
    const locality = typeof localityLabel === "string" ? localityLabel.trim() : "";
    points = [...`${stop} ${locality}`.trim()];
  }
  if (points.length < LIMITS.catalogQueryMinCharacters) return undefined;
  return points.slice(0, LIMITS.catalogQueryMaxCharacters).join("");
}

function selectRepresentativeQueries(database) {
  const statement = database.prepare(`
    SELECT stop_label AS stopLabel, locality_label AS localityLabel
    FROM places
    WHERE mode = ?
    ORDER BY stop_label COLLATE NOCASE, place_id
  `);
  const representatives = [];

  for (const mode of TRANSPORT_MODE) {
    let fallback;
    let accented;
    for (const rowValue of statement.iterate(mode)) {
      const row = record(rowValue);
      const query = boundedPublicQuery(row?.stopLabel, row?.localityLabel);
      if (query === undefined) continue;
      fallback ??= query;
      const withoutAccents = normalizeCatalogSearchText(query);
      if (withoutAccents !== "" && withoutAccents !== query) {
        accented = { mode, accented: query, unaccented: withoutAccents };
        break;
      }
    }

    const query = accented ?? (fallback === undefined
      ? undefined
      : { mode, accented: fallback, unaccented: normalizeCatalogSearchText(fallback) });
    if (query === undefined) {
      throw new Error(`Active catalog has no usable public ${mode} label`);
    }
    representatives.push(query);
  }

  if (!representatives.some((query) => query.accented !== query.unaccented)) {
    throw new Error("Active catalog has no accented public label for the measurement set");
  }
  return representatives;
}

function catalogFacts() {
  const database = new DatabaseSync(ACTIVE_PATH, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    defensive: true,
  });

  try {
    const metadataRows = database.prepare(`
      SELECT key, value
      FROM metadata
      WHERE key IN ('schema_version', 'catalog_version', 'source_revision', 'created_at')
    `).all();
    const metadata = Object.fromEntries(metadataRows.map((row) => [row.key, row.value]));
    for (const key of ["schema_version", "catalog_version", "source_revision", "created_at"]) {
      if (typeof metadata[key] !== "string" || metadata[key].trim() === "") {
        throw new Error(`Active catalog metadata is missing ${key}`);
      }
    }

    const placeCount = Number(database.prepare("SELECT count(*) AS count FROM places").get().count);
    const serviceCount = Number(database.prepare("SELECT count(*) AS count FROM services").get().count);
    if (!Number.isSafeInteger(placeCount) || placeCount < 1
      || !Number.isSafeInteger(serviceCount) || serviceCount < 1) {
      throw new Error("Active catalog counts are invalid");
    }

    const countsByMode = Object.fromEntries(TRANSPORT_MODE.map((mode) => [mode, 0]));
    for (const row of database.prepare(`
      SELECT places.mode AS mode, count(services.service_id) AS count
      FROM places
      JOIN services ON services.place_id = places.place_id
      GROUP BY places.mode
    `).all()) {
      if (Object.hasOwn(countsByMode, row.mode)) countsByMode[row.mode] = Number(row.count);
    }
    for (const mode of TRANSPORT_MODE) {
      if (!Number.isSafeInteger(countsByMode[mode]) || countsByMode[mode] < 1) {
        throw new Error(`Active catalog has no ${mode} services`);
      }
    }

    return {
      metadata,
      placeCount,
      serviceCount,
      countsByMode,
      representatives: selectRepresentativeQueries(database),
    };
  } finally {
    database.close();
  }
}

function percentile(sorted, percentage) {
  const index = Math.max(0, Math.ceil((percentage / 100) * sorted.length) - 1);
  return sorted[index];
}

function milliseconds(value) {
  return Math.round(value * 1_000) / 1_000;
}

function evidenceSecrets() {
  return [process.env.IDFM_DATASET_TOKEN, process.env.PRIM_API_KEY]
    .filter((value) => typeof value === "string" && value.length > 0);
}

function writeEvidence(report) {
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  const temporaryPath = `${EVIDENCE_PATH}.${process.pid}.tmp`;
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  try {
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, EVIDENCE_PATH);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  process.stdout.write(serialized);
}

function measure() {
  if (!existsSync(ACTIVE_PATH)) {
    throw new Error("Active catalog is missing; run npm run catalog:refresh first");
  }

  const facts = catalogFacts();
  const queries = facts.representatives.flatMap((entry) => [
    { mode: entry.mode, variant: "accented", value: entry.accented },
    { mode: entry.mode, variant: "unaccented", value: entry.unaccented },
  ]);
  const catalog = SqliteCatalogReader.open(ACTIVE_PATH);

  let warmMaxRows = 0;
  for (const query of queries) {
    const results = catalog.searchPlaces(query.value);
    executedQueries += 1;
    if (results.length === 0) {
      throw new Error(`Representative ${query.mode} ${query.variant} query returned no place`);
    }
    warmMaxRows = Math.max(warmMaxRows, results.length);
  }

  const latencies = new Array(QUERY_COUNT);
  let maxRows = warmMaxRows;
  for (let index = 0; index < QUERY_COUNT; index += 1) {
    const query = queries[index % queries.length];
    const started = performance.now();
    const results = catalog.searchPlaces(query.value);
    latencies[index] = performance.now() - started;
    executedQueries += 1;
    maxRows = Math.max(maxRows, results.length);
  }

  const sorted = [...latencies].sort((left, right) => left - right);
  const p50 = percentile(sorted, 50);
  const p95 = percentile(sorted, 95);
  const maximum = sorted[sorted.length - 1];
  const memory = process.memoryUsage();
  const pass = executedQueries >= MIN_QUERY_COUNT
    && p95 <= 200
    && maxRows <= LIMITS.catalogSearchResults;

  return {
    command: "measure:catalog",
    status: pass ? "ok" : "failed",
    measuredAt: new Date().toISOString(),
    catalog: {
      schemaVersion: facts.metadata.schema_version,
      catalogVersion: facts.metadata.catalog_version,
      sourceRevision: facts.metadata.source_revision,
      createdAt: facts.metadata.created_at,
      placeCount: facts.placeCount,
      serviceCount: facts.serviceCount,
      countsByMode: facts.countsByMode,
    },
    representativeQueries: facts.representatives,
    queryCount: executedQueries,
    p50Ms: milliseconds(p50),
    p95Ms: milliseconds(p95),
    maxMs: milliseconds(maximum),
    maxRows,
    maxRSSKiB: process.resourceUsage().maxRSS,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    gates: {
      queriesAtLeast: MIN_QUERY_COUNT,
      p95MsAtMost: 200,
      maxRowsAtMost: LIMITS.catalogSearchResults,
    },
    pass,
  };
}

try {
  const report = measure();
  writeEvidence(report);
  if (!report.pass) process.exitCode = 1;
} catch (error) {
  const message = redactSecrets(
    error instanceof Error && error.message ? error.message : "Catalog measurement failed",
    evidenceSecrets(),
  );
  process.stderr.write(`measure:catalog failed: ${message}\n`);
  try {
    writeEvidence({
      command: "measure:catalog",
      status: "failed",
      failedAt: new Date().toISOString(),
      activePath: ACTIVE_PATH,
      queryCount: executedQueries,
      error: message,
    });
  } catch {
    // Reporting evidence must not mask the primary failure.
  }
  process.exitCode = 1;
}
