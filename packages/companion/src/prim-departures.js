"use strict";

var contracts = require("./contracts");
var RFC3339_EXPLICIT_OFFSET = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(Z|([+-])([0-9]{2}):([0-9]{2}))$/;
var RETRY_AFTER_DELTA = /^[0-9]+$/;
var STOP_MONITORING_URL = "https://prim.iledefrance-mobilites.fr/marketplace/stop-monitoring";

function fail() {
  throw new Error("Invalid PRIM stop-monitoring response");
}

function requireRef(value) {
  if (typeof value !== "string" || value.length === 0) fail();
  return value;
}

function optionalRef(value) {
  if (typeof value === "undefined") return undefined;
  if (typeof value === "string") return requireRef(value);
  if (contracts.isObject(value)) return requireRef(value.value);
  return fail();
}

function requiredRef(value) {
  var ref = optionalRef(value);
  if (typeof ref === "undefined") fail();
  return ref;
}

function epochSeconds(value) {
  var match;
  var year;
  var month;
  var day;
  var hour;
  var minute;
  var second;
  var offsetHour;
  var offsetMinute;
  var maximumDay;
  var offsetSeconds;
  var seconds;
  if (typeof value !== "string") fail();
  match = RFC3339_EXPLICIT_OFFSET.exec(value);
  if (match === null || match[0].length !== value.length) fail();
  year = Number(match[1]);
  month = Number(match[2]);
  day = Number(match[3]);
  hour = Number(match[4]);
  minute = Number(match[5]);
  second = Number(match[6]);
  offsetHour = typeof match[9] === "undefined" ? 0 : Number(match[9]);
  offsetMinute = typeof match[10] === "undefined" ? 0 : Number(match[10]);
  maximumDay = month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
    : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
  if (year < 1969 || year > 2106 || month < 1 || month > 12 || day < 1 || day > maximumDay
      || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) fail();
  offsetSeconds = (match[8] === "-" ? -1 : 1) * (offsetHour * 60 + offsetMinute) * 60;
  seconds = Date.UTC(year, month - 1, day, hour, minute, second) / 1000 - offsetSeconds;
  if (!contracts.uint32(seconds)) fail();
  return seconds;
}

function optionalEpochSeconds(value) {
  return typeof value === "undefined" ? undefined : epochSeconds(value);
}

function sourceStatus(value) {
  if (typeof value !== "string") return "UNKNOWN";
  value = value.toLowerCase();
  if (value === "cancelled") return "CANCELLED";
  if (value === "delayed") return "DELAYED";
  if (value === "ontime") return "ON_TIME";
  return "UNKNOWN";
}

function matchedJourney(visit, routing) {
  var monitoringRef = requiredRef(visit.MonitoringRef);
  var journey = visit.MonitoredVehicleJourney;
  var lineRef;
  var destinationRef;
  if (!contracts.isObject(journey)) fail();
  lineRef = requiredRef(journey.LineRef);
  if (!contracts.isObject(journey.MonitoredCall)) fail();
  if (monitoringRef !== routing.monitoringRef || lineRef !== routing.lineRef) return undefined;
  // SIRI DirectionRef is an operator label, not the catalog's GTFS direction_id.
  // Only an exact terminal reference establishes the selected service.
  destinationRef = requiredRef(journey.DestinationRef);
  if (destinationRef !== routing.destinationRef) return undefined;
  return journey;
}

function parseMatchedVisit(journey) {
  var call = journey.MonitoredCall;
  var expected = optionalEpochSeconds(call.ExpectedDepartureTime);
  var aimed = optionalEpochSeconds(call.AimedDepartureTime);
  var expectedAt = typeof expected === "undefined" ? aimed : expected;
  if (typeof expectedAt === "undefined") fail();
  return {
    expectedAt: expectedAt,
    aimedAt: aimed,
    hasExpected: typeof expected !== "undefined",
    status: sourceStatus(call.DepartureStatus)
  };
}

// Validate every visit, but retain only the first four in chronological order.
// Equal timestamps keep source order without relying on an ES5 engine's sort stability.
function insertBounded(visits, visit) {
  var index = visits.length;
  while (index > 0 && visits[index - 1].expectedAt > visit.expectedAt) index -= 1;
  if (index >= contracts.LIMITS.departures) return;
  visits.splice(index, 0, visit);
  if (visits.length > contracts.LIMITS.departures) visits.pop();
}

function normalizePrimDepartureResponse(value, routing, fetchedAt) {
  var serviceDelivery;
  var deliveries;
  var sourceUpdatedAt;
  var stopDelivery;
  var responseTimestamp;
  var visits;
  var visit;
  var journey;
  var recordedAt;
  var matched = [];
  var departures = [];
  var realtimeCount = 0;
  var departure;
  var interval;
  var result;
  var index;
  var offset;
  var next;
  if (!contracts.isServiceRouting(routing) || !contracts.uint32(fetchedAt)) fail();
  if (!contracts.isObject(value) || !contracts.isObject(value.Siri)
      || !contracts.isObject(value.Siri.ServiceDelivery)) fail();
  serviceDelivery = value.Siri.ServiceDelivery;
  sourceUpdatedAt = optionalEpochSeconds(serviceDelivery.ResponseTimestamp);
  deliveries = serviceDelivery.StopMonitoringDelivery;
  if (!Array.isArray(deliveries)) fail();
  for (index = 0; index < deliveries.length; index += 1) {
    stopDelivery = deliveries[index];
    if (!contracts.isObject(stopDelivery)) fail();
    responseTimestamp = optionalEpochSeconds(stopDelivery.ResponseTimestamp);
    if (typeof responseTimestamp !== "undefined"
        && (typeof sourceUpdatedAt === "undefined" || responseTimestamp > sourceUpdatedAt)) {
      sourceUpdatedAt = responseTimestamp;
    }
    visits = stopDelivery.MonitoredStopVisit;
    if (typeof visits === "undefined") continue;
    if (!Array.isArray(visits)) fail();
    for (offset = 0; offset < visits.length; offset += 1) {
      visit = visits[offset];
      if (!contracts.isObject(visit)) fail();
      recordedAt = epochSeconds(visit.RecordedAtTime);
      journey = matchedJourney(visit, routing);
      if (typeof journey === "undefined") continue;
      if (typeof sourceUpdatedAt === "undefined" || recordedAt > sourceUpdatedAt) sourceUpdatedAt = recordedAt;
      insertBounded(matched, parseMatchedVisit(journey));
    }
  }
  if (matched.length === 0) fail();
  for (index = 0; index < matched.length; index += 1) {
    visit = matched[index];
    if (visit.hasExpected) realtimeCount += 1;
    departure = {
      expectedAt: visit.expectedAt,
      minutes: Math.max(0, Math.ceil((visit.expectedAt - fetchedAt) / 60)),
      status: visit.status
    };
    if (typeof visit.aimedAt !== "undefined") departure.aimedAt = visit.aimedAt;
    if (visit.status !== "CANCELLED") {
      for (next = index + 1; next < matched.length; next += 1) {
        if (matched[next].status !== "CANCELLED") {
          interval = Math.round((matched[next].expectedAt - visit.expectedAt) / 60);
          if (interval > 0) departure.nextIntervalMinutes = interval;
          break;
        }
      }
    }
    departures.push(Object.freeze(departure));
  }
  result = {
    fetchedAt: fetchedAt,
    freshness: realtimeCount === matched.length ? "REALTIME" : realtimeCount === 0 ? "SCHEDULED" : "MIXED",
    departures: Object.freeze(departures)
  };
  if (typeof sourceUpdatedAt !== "undefined") result.sourceUpdatedAt = sourceUpdatedAt;
  if (!contracts.isDepartureSnapshot(result)) fail();
  return Object.freeze(result);
}

function buildPrimStopMonitoringUrl(routing) {
  if (!contracts.isServiceRouting(routing)) fail();
  return STOP_MONITORING_URL + "?MonitoringRef=" + encodeURIComponent(routing.monitoringRef)
    + "&LineRef=" + encodeURIComponent(routing.lineRef);
}

function parseRetryAfterSeconds(value) {
  if (typeof value === "string") {
    if (!RETRY_AFTER_DELTA.test(value) || /\s/.test(value)) return undefined;
    value = Number(value);
  }
  if (typeof value !== "number" || !isFinite(value) || Math.floor(value) !== value) return undefined;
  return value >= 0 && value <= 86400 ? value : undefined;
}

module.exports = {
  normalizePrimDepartureResponse: normalizePrimDepartureResponse,
  buildPrimStopMonitoringUrl: buildPrimStopMonitoringUrl,
  parseRetryAfterSeconds: parseRetryAfterSeconds
};
