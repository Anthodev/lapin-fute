import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  parseBearerAuthorization,
  redactSecrets,
  relayPrimRequest,
} from "../packages/catalog/src/prim-probe.ts";
import {
  PRIM_ORIGIN,
  TRANSPORT_MODE,
} from "../packages/contracts/src/index.ts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_ACTIVE_PATH = join(PROJECT_ROOT, "var/catalog/catalog.sqlite");
const ACTIVE_PATH = resolve(process.env.CATALOG_PATH ?? DEFAULT_ACTIVE_PATH);
const EVIDENCE_PATH = join(PROJECT_ROOT, "var/catalog/evidence/probe-catalog.json");
const STOP_MONITORING_PATH = "/marketplace/stop-monitoring";
const RETURNED_FIELD_NAME = /^(?:Direction|Destination)[A-Za-z0-9_]{0,48}$/u;
let callCount = 0;

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : undefined;
}

function requiredText(value, field) {
  if (typeof value !== "string" || value.trim() === "" || value.includes("\0")) {
    throw new Error(`Active catalog has an invalid ${field}`);
  }
  return value;
}

function siriText(value) {
  if (typeof value === "string") return value;
  const object = record(value);
  return typeof object?.value === "string" ? object.value : undefined;
}

function validateSiri(bytes, expectedLineRef) {
  let root;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    root = record(JSON.parse(text));
  } catch {
    return {
      siriValid: false,
      lineRefMatched: false,
      directionFields: [],
      destinationFields: [],
    };
  }

  const siri = record(root?.Siri) ?? root;
  const serviceDelivery = record(siri?.ServiceDelivery);
  const stopMonitoringDelivery = serviceDelivery?.StopMonitoringDelivery;
  if (serviceDelivery === undefined || !Array.isArray(stopMonitoringDelivery)) {
    return {
      siriValid: false,
      lineRefMatched: false,
      directionFields: [],
      destinationFields: [],
    };
  }

  let validDelivery = stopMonitoringDelivery.length > 0;
  let lineRefMatched = false;
  const directionFields = new Set();
  const destinationFields = new Set();

  for (const deliveryValue of stopMonitoringDelivery) {
    const delivery = record(deliveryValue);
    if (delivery === undefined) {
      validDelivery = false;
      continue;
    }
    const visitsValue = delivery.MonitoredStopVisit;
    if (visitsValue !== undefined && !Array.isArray(visitsValue)) {
      validDelivery = false;
      continue;
    }

    for (const visitValue of visitsValue ?? []) {
      const visit = record(visitValue);
      const journey = record(visit?.MonitoredVehicleJourney);
      if (journey === undefined) {
        validDelivery = false;
        continue;
      }
      if (siriText(journey.LineRef) !== expectedLineRef) continue;
      lineRefMatched = true;
      for (const field of Object.keys(journey)) {
        if (!RETURNED_FIELD_NAME.test(field)) continue;
        if (field.startsWith("Direction")) directionFields.add(field);
        if (field.startsWith("Destination")) destinationFields.add(field);
      }
    }
  }

  return {
    siriValid: validDelivery,
    lineRefMatched,
    directionFields: [...directionFields].sort(),
    destinationFields: [...destinationFields].sort(),
  };
}

function selectServices() {
  if (!existsSync(ACTIVE_PATH)) {
    throw new Error("Active catalog is missing; run npm run catalog:refresh first");
  }

  const database = new DatabaseSync(ACTIVE_PATH, {
    readOnly: true,
    enableForeignKeyConstraints: true,
    enableDoubleQuotedStringLiterals: false,
    allowExtension: false,
    defensive: true,
  });
  try {
    const select = database.prepare(`
      SELECT
        min(services.service_id) AS serviceId,
        services.monitoring_ref AS monitoringRef,
        services.line_ref AS lineRef
      FROM services
      JOIN places ON places.place_id = services.place_id
      WHERE places.mode = ?
      GROUP BY services.monitoring_ref, services.line_ref
      ORDER BY count(*) DESC, min(services.service_id)
      LIMIT 1
    `);

    return TRANSPORT_MODE.map((mode) => {
      const row = record(select.get(mode));
      if (row === undefined) throw new Error(`Active catalog has no resolved ${mode} service`);
      return {
        mode,
        serviceId: requiredText(row.serviceId, `${mode} serviceId`),
        monitoringRef: requiredText(row.monitoringRef, `${mode} monitoringRef`),
        lineRef: requiredText(row.lineRef, `${mode} lineRef`),
      };
    });
  } finally {
    database.close();
  }
}

function targetFor(monitoringRef) {
  const target = new URL(STOP_MONITORING_PATH, PRIM_ORIGIN);
  target.searchParams.set("MonitoringRef", monitoringRef);
  return target;
}

function writeEvidence(report, apiKey) {
  mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
  const temporaryPath = `${EVIDENCE_PATH}.${process.pid}.tmp`;
  const serialized = `${redactSecrets(JSON.stringify(report, null, 2), [apiKey])}\n`;
  try {
    writeFileSync(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    renameSync(temporaryPath, EVIDENCE_PATH);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  process.stdout.write(serialized);
}

async function probe(apiKey) {
  const services = selectServices();
  if (services.length !== TRANSPORT_MODE.length) {
    throw new Error("Active catalog did not resolve exactly one service per mode");
  }
  const requests = services.map((service) => ({
    ...service,
    target: targetFor(service.monitoringRef),
  }));

  const countedFetch = (target, init) => {
    callCount += 1;
    return globalThis.fetch(target, init);
  };
  const probes = [];

  for (const request of requests) {
    let status = null;
    let validation = {
      siriValid: false,
      lineRefMatched: false,
      directionFields: [],
      destinationFields: [],
    };
    try {
      const response = await relayPrimRequest(
        {
          target: request.target,
          authorization: `Bearer ${apiKey}`,
        },
        { fetch: countedFetch },
      );
      status = response.status;
      if (status === 200) validation = validateSiri(response.bytes, request.lineRef);
    } catch {
      // A failed call is recorded without response content; the probe still spends exactly one call per mode.
    }

    probes.push({
      mode: request.mode,
      status,
      siriValid: validation.siriValid,
      lineRefMatched: validation.lineRefMatched,
      directionFields: validation.directionFields,
      destinationFields: validation.destinationFields,
      acceptedStoredQuery: status === 200
        && validation.siriValid
        && validation.lineRefMatched,
    });
  }

  const pass = callCount === TRANSPORT_MODE.length
    && probes.every((result) => result.acceptedStoredQuery);
  return {
    command: "catalog:probe",
    status: pass ? "ok" : "failed",
    probedAt: new Date().toISOString(),
    requestStructure: {
      origin: PRIM_ORIGIN,
      path: STOP_MONITORING_PATH,
      queryParameters: ["MonitoringRef"],
      headers: ["apikey"],
    },
    callCount,
    probes,
    pass,
  };
}

const configuredKey = process.env.PRIM_API_KEY;
if (typeof configuredKey !== "string" || configuredKey.length === 0) {
  process.stderr.write("catalog:probe requires PRIM_API_KEY\n");
  process.exitCode = 1;
} else {
  let apiKey;
  try {
    apiKey = parseBearerAuthorization(`Bearer ${configuredKey}`);
    const report = await probe(apiKey);
    writeEvidence(report, apiKey);
    if (!report.pass) process.exitCode = 1;
  } catch (error) {
    const message = redactSecrets(
      error instanceof Error && error.message ? error.message : "Catalog probe failed",
      [configuredKey],
    );
    process.stderr.write(`catalog:probe failed: ${message}\n`);
    try {
      writeEvidence({
        command: "catalog:probe",
        status: "failed",
        failedAt: new Date().toISOString(),
        callCount,
        error: message,
      }, configuredKey);
    } catch {
      // Reporting evidence must not mask the primary failure.
    }
    process.exitCode = 1;
  }
}
