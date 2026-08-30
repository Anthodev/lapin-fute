import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DOWNLOAD_TIMEOUT_MS,
  IDFM_CATALOG_SOURCE_URL,
  activateCatalogCandidate,
  buildCatalogCandidate,
  downloadCatalogSource,
  resolveIdfmGtfsDownload,
  validateCatalogCandidate,
} from "../packages/backend/src/catalog-import.ts";
import { redactSecrets } from "../packages/backend/src/index.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ACTIVE_PATH = join(PROJECT_ROOT, "var/catalog/catalog.sqlite");
const ACTIVE_PATH = resolve(process.env.CATALOG_PATH ?? DEFAULT_ACTIVE_PATH);
const EVIDENCE_PATH = join(PROJECT_ROOT, "var/catalog/evidence/refresh-catalog.json");
const METADATA_BODY_LIMIT = 1024 * 1024;
const DATA_ORIGIN = new URL(IDFM_CATALOG_SOURCE_URL.gtfsRecord).origin;

const GTFS_SOURCE = {
  key: "gtfs",
  dataset: "offre-horaires-tc-gtfs-idfm",
  restricted: true,
  requiredFields: ["filename", "url"],
};

const CSV_SOURCES = [
  {
    key: "perimeter",
    dataset: "perimetre-des-donnees-tr-disponibles-plateforme-idfm",
    url: IDFM_CATALOG_SOURCE_URL.perimeter,
    restricted: true,
    requiredFields: ["line", "name_line", "ns2_stoppointref", "ns2_stopname", "operatorname"],
  },
  {
    key: "arrets",
    dataset: "arrets",
    url: IDFM_CATALOG_SOURCE_URL.arrets,
    restricted: false,
    requiredFields: ["arrid", "zdaid"],
  },
  {
    key: "zones",
    dataset: "zones-d-arrets",
    url: IDFM_CATALOG_SOURCE_URL.zones,
    restricted: false,
    requiredFields: ["zdaid", "zdaname", "zdatown"],
  },
  {
    key: "relations",
    dataset: "relations",
    url: IDFM_CATALOG_SOURCE_URL.relations,
    restricted: false,
    requiredFields: ["zdaid", "arrid", "artid"],
  },
  {
    key: "lines",
    dataset: "referentiel-des-lignes",
    url: IDFM_CATALOG_SOURCE_URL.lines,
    restricted: false,
    requiredFields: ["id_line", "name_line", "shortname_line", "transportmode", "transportsubmode", "status"],
  },
  {
    key: "arretsLignes",
    dataset: "arrets-lignes",
    url: IDFM_CATALOG_SOURCE_URL.arretsLignes,
    restricted: false,
    requiredFields: ["id", "stop_id"],
  },
];

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`Invalid ${field} in IDFM dataset metadata`);
  }
  return value;
}

async function boundedJson(response, dataset) {
  if (response.body === null) throw new Error(`IDFM metadata for ${dataset} returned no body`);
  const chunks = [];
  let byteLength = 0;
  for await (const chunkValue of response.body) {
    const chunk = chunkValue instanceof Uint8Array
      ? chunkValue
      : new Uint8Array(chunkValue);
    byteLength += chunk.byteLength;
    if (byteLength > METADATA_BODY_LIMIT) {
      throw new Error(`IDFM metadata for ${dataset} exceeds 1 MiB`);
    }
    chunks.push(chunk);
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
    return JSON.parse(text);
  } catch {
    throw new Error(`IDFM metadata for ${dataset} is not valid UTF-8 JSON`);
  }
}

async function fetchDatasetMetadata(source, datasetToken) {
  const target = new URL(
    `/api/explore/v2.1/catalog/datasets/${encodeURIComponent(source.dataset)}`,
    DATA_ORIGIN,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new Error("IDFM metadata request timed out")),
    DOWNLOAD_TIMEOUT_MS,
  );

  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: "manual",
      credentials: "omit",
      cache: "no-store",
      headers: source.restricted
        ? { Authorization: `apikey ${datasetToken}` }
        : {},
      signal: controller.signal,
    });
    if (response.status !== 200) {
      throw new Error(`IDFM metadata for ${source.dataset} returned HTTP ${response.status}`);
    }
    const mediaType = (response.headers.get("content-type") ?? "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (mediaType !== "application/json") {
      throw new Error(`IDFM metadata for ${source.dataset} is not JSON`);
    }

    const value = record(await boundedJson(response, source.dataset));
    const metas = record(value?.metas);
    const defaults = record(metas?.default);
    if (value?.dataset_id !== source.dataset || value?.has_records !== true) {
      throw new Error(`IDFM metadata identity for ${source.dataset} is invalid`);
    }
    if (value.data_visible !== !source.restricted) {
      throw new Error(`IDFM metadata visibility for ${source.dataset} changed`);
    }

    const fields = Array.isArray(value.fields) ? value.fields : [];
    const fieldNames = new Set(fields.map((field) => record(field)?.name));
    for (const requiredField of source.requiredFields) {
      if (!fieldNames.has(requiredField)) {
        throw new Error(`IDFM metadata for ${source.dataset} lacks ${requiredField}`);
      }
    }

    const recordsCount = defaults?.records_count;
    if (!Number.isSafeInteger(recordsCount) || recordsCount < 1) {
      throw new Error(`IDFM metadata record count for ${source.dataset} is invalid`);
    }
    const modified = requiredText(defaults?.modified, `${source.dataset}.modified`);
    if (!Number.isFinite(Date.parse(modified))) {
      throw new Error(`IDFM metadata timestamp for ${source.dataset} is invalid`);
    }

    return {
      dataset: source.dataset,
      datasetUid: requiredText(value.dataset_uid, `${source.dataset}.dataset_uid`),
      title: requiredText(defaults?.title, `${source.dataset}.title`),
      license: requiredText(defaults?.license, `${source.dataset}.license`),
      modified,
      recordsCount,
      restricted: source.restricted,
      retrievedAt: new Date().toISOString(),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function sourceAttribution(metadata, url) {
  return {
    dataset: metadata.dataset,
    url,
    retrievedAt: metadata.retrievedAt,
    license: metadata.license,
    restricted: metadata.restricted,
  };
}

function revisionFor(downloads) {
  const sourceState = downloads.map(({ metadata, download }) => ({
    dataset: metadata.dataset,
    modified: metadata.modified,
    recordsCount: metadata.recordsCount,
    sha256: download.sha256,
  }));
  const digest = createHash("sha256")
    .update(JSON.stringify(sourceState), "utf8")
    .digest("hex");
  return `idfm-v1-${digest}`;
}

function assertSameResult(expected, actual, phase) {
  const sameCounts = expected.placeCount === actual.placeCount
    && expected.serviceCount === actual.serviceCount
    && Object.keys(expected.countsByMode).every(
      (mode) => expected.countsByMode[mode] === actual.countsByMode[mode],
    );
  if (expected.sourceRevision !== actual.sourceRevision || !sameCounts) {
    throw new Error(`Catalog ${phase} result changed after validation`);
  }
}

function evidenceSource({ metadata, download, filename }) {
  return {
    dataset: metadata.dataset,
    datasetUid: metadata.datasetUid,
    title: metadata.title,
    license: metadata.license,
    restricted: metadata.restricted,
    modified: metadata.modified,
    retrievedAt: metadata.retrievedAt,
    recordsCount: metadata.recordsCount,
    bytes: download.bytes,
    sha256: download.sha256,
    ...(filename === undefined ? {} : { filename }),
  };
}

function writeEvidence(report, secrets) {
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  const temporaryPath = `${EVIDENCE_PATH}.${process.pid}.tmp`;
  const serialized = `${redactSecrets(JSON.stringify(report, null, 2), secrets)}\n`;
  try {
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, EVIDENCE_PATH);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  process.stdout.write(serialized);
}

// Closes the snapshot/download window: re-fetches each dataset's metadata after
// all downloads complete and aborts the refresh when any revision moved, so the
// built candidate can never mix content from two source revisions.
async function verifySnapshotsUnchanged(downloads, datasetToken) {
  for (const entry of downloads) {
    if (entry.filename !== undefined) {
      const resolved = await resolveIdfmGtfsDownload(datasetToken);
      if (resolved.filename !== entry.filename) {
        throw new Error(`IDFM GTFS record changed during refresh (${entry.filename} -> ${resolved.filename})`);
      }
    }
    const source = entry.key === GTFS_SOURCE.key
      ? GTFS_SOURCE
      : CSV_SOURCES.find((candidate) => candidate.key === entry.key);
    if (source === undefined) {
      throw new Error(`IDFM source ${entry.key} is missing from the refresh snapshot`);
    }
    const fresh = await fetchDatasetMetadata(source, source.restricted ? datasetToken : undefined);
    if (fresh.modified !== entry.metadata.modified) {
      throw new Error(`IDFM dataset ${entry.metadata.dataset} changed during refresh (modified ${entry.metadata.modified} -> ${fresh.modified})`);
    }
  }
}

async function refreshCatalog(datasetToken, state) {
  mkdirSync(dirname(ACTIVE_PATH), { recursive: true });
  const workspace = mkdtempSync(join(dirname(ACTIVE_PATH), ".refresh-"));

  let downloads;
  let activated;
  try {
    const gtfsMetadata = await fetchDatasetMetadata(GTFS_SOURCE, datasetToken);
    const resolvedGtfs = await resolveIdfmGtfsDownload(datasetToken);
    if (new URL(resolvedGtfs.url).origin !== DATA_ORIGIN) {
      throw new Error("Resolved IDFM GTFS download left the trusted data origin");
    }
    const gtfsFilename = requiredText(resolvedGtfs.filename, "GTFS filename");
    if (Buffer.byteLength(gtfsFilename, "utf8") > 512) {
      throw new Error("Resolved IDFM GTFS filename exceeds 512 bytes");
    }
    const gtfsDownload = await downloadCatalogSource({
      source: sourceAttribution(gtfsMetadata, resolvedGtfs.url),
      destinationPath: join(workspace, "gtfs.zip"),
      expectedContentTypes: ["application/zip"],
      datasetToken,
    });
    downloads = [{
      key: GTFS_SOURCE.key,
      metadata: gtfsMetadata,
      download: gtfsDownload,
      filename: gtfsFilename,
    }];

    for (const source of CSV_SOURCES) {
      const metadata = await fetchDatasetMetadata(
        source,
        source.restricted ? datasetToken : undefined,
      );
      const download = await downloadCatalogSource({
        source: sourceAttribution(metadata, source.url),
        destinationPath: join(workspace, `${source.key}.csv`),
        expectedContentTypes: ["text/csv"],
        ...(source.restricted ? { datasetToken } : {}),
      });
      downloads.push({ key: source.key, metadata, download });
    }
    await verifySnapshotsUnchanged(downloads, datasetToken);
    state.metadataRechecked = true;

    const byKey = Object.fromEntries(downloads.map((entry) => [entry.key, entry]));
    const sourceRevision = revisionFor(downloads);
    const createdAt = new Date().toISOString();
    const candidatePath = join(workspace, "candidate.sqlite");
    const buildResult = await buildCatalogCandidate({
      candidatePath,
      sourceRevision,
      createdAt,
      sources: {
        gtfsZipPath: byKey.gtfs.download.path,
        perimeter: {
          path: byKey.perimeter.download.path,
          expectedRows: byKey.perimeter.metadata.recordsCount,
        },
        arrets: {
          path: byKey.arrets.download.path,
          expectedRows: byKey.arrets.metadata.recordsCount,
        },
        zones: {
          path: byKey.zones.download.path,
          expectedRows: byKey.zones.metadata.recordsCount,
        },
        relations: {
          path: byKey.relations.download.path,
          expectedRows: byKey.relations.metadata.recordsCount,
        },
        lines: {
          path: byKey.lines.download.path,
          expectedRows: byKey.lines.metadata.recordsCount,
        },
        arretsLignes: {
          path: byKey.arretsLignes.download.path,
          expectedRows: byKey.arretsLignes.metadata.recordsCount,
        },
      },
    });
    const validated = validateCatalogCandidate(candidatePath);
    assertSameResult(buildResult, validated, "candidate");
    activated = activateCatalogCandidate(candidatePath, ACTIVE_PATH);
    state.atomicActivation = true;
    assertSameResult(validated, activated, "activation");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    state.temporaryInputsRemoved = true;
  }

  return {
    command: "catalog:refresh",
    status: "ok",
    completedAt: new Date().toISOString(),
    sourceRevision: activated.sourceRevision,
    sources: downloads.map(evidenceSource),
    catalog: {
      createdAt: activated.createdAt,
      placeCount: activated.placeCount,
      serviceCount: activated.serviceCount,
      countsByMode: activated.countsByMode,
      placeResolution: buildResult.placeResolution ?? null,
    },
    validation: {
      sqliteIntegrity: "ok",
      foreignKeys: "ok",
      schemaAndCatalogVersions: "ok",
      allModesCovered: true,
      everyServiceResolvable: true,
      metadataRechecked: state.metadataRechecked === true,
    },
    activation: {
      atomic: state.atomicActivation,
      temporaryInputsRemoved: state.temporaryInputsRemoved,
      ...(activated.revalidatedAfterRenameFailure === true
        ? { revalidatedAfterRenameFailure: true }
        : {}),
    },
    maxRSSKiB: process.resourceUsage().maxRSS,
  };
}

const startedAt = new Date().toISOString();
const state = {
  atomicActivation: false,
  temporaryInputsRemoved: false,
  metadataRechecked: false,
};
const datasetToken = process.env.IDFM_DATASET_TOKEN;

if (typeof datasetToken !== "string" || datasetToken.length === 0) {
  process.stderr.write("catalog:refresh requires IDFM_DATASET_TOKEN\n");
  process.exitCode = 1;
} else {
  try {
    const report = await refreshCatalog(datasetToken, state);
    writeEvidence({ ...report, startedAt }, [datasetToken]);
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error && error.message ? error.message : "Catalog refresh failed",
      [datasetToken],
    );
    const report = {
      command: "catalog:refresh",
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      activation: {
        atomic: state.atomicActivation,
        temporaryInputsRemoved: state.temporaryInputsRemoved,
      },
      maxRSSKiB: process.resourceUsage().maxRSS,
      error: message,
    };
    try {
      writeEvidence(report, [datasetToken]);
    } catch {
      // The primary refresh failure remains authoritative if evidence persistence also fails.
    }
    process.stderr.write(`catalog:refresh failed: ${message}\n`);
    process.exitCode = 1;
  }
}
