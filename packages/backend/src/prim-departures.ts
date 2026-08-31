import {
  LIMITS,
  PRIM_ORIGIN,
  SCHEMA_VERSION,
  type Departure,
  type DepartureStatus,
  type Freshness,
} from "../../contracts/src/index.ts";

export interface PrimServiceResolution {
  readonly monitoringRef: string;
  readonly lineRef: string;
  readonly directionId: string;
  readonly destinationRef: string;
}

export interface PrimNormalizedDepartureData {
  readonly schemaVersion: typeof SCHEMA_VERSION;
  readonly fetchedAt: number;
  readonly sourceUpdatedAt?: number;
  readonly freshness: Freshness;
  readonly departures: readonly Departure[];
}

export class PrimNormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrimNormalizationError";
  }
}

interface PrimVisit {
  readonly expectedAt: number;
  readonly aimedAt?: number;
  readonly hasExpected: boolean;
  readonly status: DepartureStatus;
  readonly recordedAt: number;
}

const STATUS_BY_SOURCE_VALUE: Readonly<Record<string, DepartureStatus>> = {
  cancelled: "CANCELLED",
  delayed: "DELAYED",
  ontime: "ON_TIME",
};

const RFC3339_EXPLICIT_OFFSET =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(Z|([+-])([0-9]{2}):([0-9]{2}))$/u;

const RETRY_AFTER_DELTA = /^[0-9]+$/u;
const RETRY_AFTER_MAX_SECONDS = 86_400;

function fail(reason: string): never {
  throw new PrimNormalizationError(`Invalid PRIM stop-monitoring response: ${reason}`);
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function optionalRef(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return requireRef(value, name);
  if (record(value)) return requireRef(value.value, `${name}.value`);
  return fail(`${name} must be a string or reference object`);
}

function requiredRef(value: unknown, name: string): string {
  return optionalRef(value, name) ?? fail(`${name} is required`);
}


function requireRef(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${name} must be a non-empty string`);
  return value;
}

function epochSeconds(value: unknown, name: string): number {
  if (typeof value !== "string") fail(`${name} must be an ISO timestamp string`);
  const match = RFC3339_EXPLICIT_OFFSET.exec(value);
  if (match === null || match[0].length !== value.length) {
    fail(`${name} is not a valid contract timestamp`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[9] === undefined ? 0 : Number(match[9]);
  const offsetMinute = match[10] === undefined ? 0 : Number(match[10]);
  const maximumDay = month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
    : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
  if (
    year < 1969
    || year > 2106
    || month < 1
    || month > 12
    || day < 1
    || day > maximumDay
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
  ) {
    fail(`${name} is not a valid contract timestamp`);
  }

  const offsetDirection = match[8] === "-" ? -1 : 1;
  const offsetSeconds = offsetDirection * (offsetHour * 60 + offsetMinute) * 60;
  const seconds = Date.UTC(year, month - 1, day, hour, minute, second) / 1_000
    - offsetSeconds;
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 0xffff_ffff) {
    fail(`${name} is not a valid contract timestamp`);
  }
  return seconds;
}

function optionalEpochSeconds(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : epochSeconds(value, name);
}

function sourceStatus(value: unknown): DepartureStatus {
  if (typeof value !== "string") return "UNKNOWN";
  const status: DepartureStatus | undefined = STATUS_BY_SOURCE_VALUE[value.toLowerCase()];
  return status ?? "UNKNOWN";
}

function matchedJourney(
  visit: Record<string, unknown>,
  resolution: PrimServiceResolution,
): Record<string, unknown> | undefined {
  epochSeconds(visit.RecordedAtTime, "MonitoredStopVisit.RecordedAtTime");
  const monitoringRef = requiredRef(visit.MonitoringRef, "MonitoredStopVisit.MonitoringRef");
  const journey = visit.MonitoredVehicleJourney;
  if (!record(journey)) fail("MonitoredStopVisit.MonitoredVehicleJourney must be an object");
  const lineRef = requiredRef(journey.LineRef, "MonitoredVehicleJourney.LineRef");
  if (!record(journey.MonitoredCall)) fail("MonitoredVehicleJourney.MonitoredCall must be an object");
  if (monitoringRef !== resolution.monitoringRef || lineRef !== resolution.lineRef) return undefined;
  const directionRef = optionalRef(journey.DirectionRef, "MonitoredVehicleJourney.DirectionRef");
  if (directionRef !== undefined && directionRef !== resolution.directionId) return undefined;
  const destinationRef = optionalRef(journey.DestinationRef, "MonitoredVehicleJourney.DestinationRef");
  if (destinationRef !== undefined && destinationRef !== resolution.destinationRef) return undefined;
  return journey;
}

function parseMatchedVisit(journey: Record<string, unknown>, recordedAt: number): PrimVisit {
  const call = record(journey.MonitoredCall) ? journey.MonitoredCall : fail("MonitoredVehicleJourney.MonitoredCall must be an object");
  const expected = optionalEpochSeconds(call.ExpectedDepartureTime, "MonitoredCall.ExpectedDepartureTime");
  const aimed = optionalEpochSeconds(call.AimedDepartureTime, "MonitoredCall.AimedDepartureTime");
  const expectedAt = expected ?? aimed;
  if (expectedAt === undefined) fail("MonitoredCall requires ExpectedDepartureTime or AimedDepartureTime");
  return {
    expectedAt,
    ...(aimed === undefined ? {} : { aimedAt: aimed }),
    hasExpected: expected !== undefined,
    status: sourceStatus(call.DepartureStatus),
    recordedAt,
  };
}

export function normalizePrimDepartureResponse(
  value: unknown,
  resolution: PrimServiceResolution,
  fetchedAt: number,
): PrimNormalizedDepartureData {
  requireRef(resolution.monitoringRef, "monitoringRef");
  requireRef(resolution.lineRef, "lineRef");
  requireRef(resolution.directionId, "directionId");
  requireRef(resolution.destinationRef, "destinationRef");
  if (!Number.isInteger(fetchedAt) || fetchedAt < 0 || fetchedAt > 0xffff_ffff) {
    fail("fetchedAt must be a contract epoch-seconds integer");
  }

  const envelope = record(value) ? value : fail("response must be a JSON object");
  const siri = record(envelope.Siri) ? envelope.Siri : fail("Siri must be an object");
  const serviceDelivery = record(siri.ServiceDelivery) ? siri.ServiceDelivery : fail("Siri.ServiceDelivery must be an object");
  const serviceTimestamp = optionalEpochSeconds(
    serviceDelivery.ResponseTimestamp,
    "ServiceDelivery.ResponseTimestamp",
  );
  const deliveries = serviceDelivery.StopMonitoringDelivery;
  if (!Array.isArray(deliveries)) fail("ServiceDelivery.StopMonitoringDelivery must be an array");

  const matched: PrimVisit[] = [];
  let sourceUpdatedAt: number | undefined = serviceTimestamp;
  for (const entry of deliveries) {
    const stopDelivery = record(entry) ? entry : fail("StopMonitoringDelivery entry must be an object");
    const responseTimestamp = optionalEpochSeconds(stopDelivery.ResponseTimestamp, "ResponseTimestamp");
    if (responseTimestamp !== undefined && (sourceUpdatedAt === undefined || responseTimestamp > sourceUpdatedAt)) {
      sourceUpdatedAt = responseTimestamp;
    }
    const visits = stopDelivery.MonitoredStopVisit;
    if (visits === undefined) continue;
    if (!Array.isArray(visits)) fail("StopMonitoringDelivery.MonitoredStopVisit must be an array");
    for (const candidate of visits) {
      const visit = record(candidate) ? candidate : fail("MonitoredStopVisit entry must be an object");
      const journey = matchedJourney(visit, resolution);
      if (journey === undefined) continue;
      const recordedAt = epochSeconds(visit.RecordedAtTime, "MonitoredStopVisit.RecordedAtTime");
      if (sourceUpdatedAt === undefined || recordedAt > sourceUpdatedAt) sourceUpdatedAt = recordedAt;
      matched.push(parseMatchedVisit(journey, recordedAt));
    }
  }
  if (matched.length === 0) fail("no MonitoredStopVisit matches the resolved service");

  matched.sort((left, right) => left.expectedAt - right.expectedAt);
  const bounded = matched.slice(0, LIMITS.departures);
  const realtimeCount = bounded.filter((visit) => visit.hasExpected).length;
  const freshness: Freshness = realtimeCount === bounded.length ? "REALTIME" : realtimeCount === 0 ? "SCHEDULED" : "MIXED";

  const departures: Departure[] = bounded.map((visit) => {
    const departure: Departure = {
      expectedAt: visit.expectedAt,
      minutes: Math.max(0, Math.ceil((visit.expectedAt - fetchedAt) / 60)),
      status: visit.status,
    };
    if (visit.aimedAt !== undefined) departure.aimedAt = visit.aimedAt;
    return departure;
  });
  for (const [index, visit] of bounded.entries()) {
    if (visit.status === "CANCELLED") continue;
    const next = bounded.slice(index + 1).find((candidate) => candidate.status !== "CANCELLED");
    if (next === undefined) break;
    const interval = Math.round((next.expectedAt - visit.expectedAt) / 60);
    if (interval > 0) departures[index].nextIntervalMinutes = interval;
  }
  for (const departure of departures) Object.freeze(departure);

  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    fetchedAt,
    ...(sourceUpdatedAt === undefined ? {} : { sourceUpdatedAt }),
    freshness,
    departures: Object.freeze(departures),
  });
}

export function buildPrimStopMonitoringUrl(resolution: PrimServiceResolution): URL {
  requireRef(resolution.monitoringRef, "monitoringRef");
  requireRef(resolution.lineRef, "lineRef");
  requireRef(resolution.directionId, "directionId");
  requireRef(resolution.destinationRef, "destinationRef");
  const url = new URL("/marketplace/stop-monitoring", PRIM_ORIGIN);
  url.searchParams.set("MonitoringRef", resolution.monitoringRef);
  url.searchParams.set("LineRef", resolution.lineRef);
  return url;
}

export function parseRetryAfterSeconds(value: unknown): number | undefined {
  if (typeof value === "string") {
    if (!RETRY_AFTER_DELTA.test(value)) return undefined;
    value = Number(value);
  }
  if (typeof value !== "number" || !Number.isInteger(value)) return undefined;
  return value >= 0 && value <= RETRY_AFTER_MAX_SECONDS ? value : undefined;
}
