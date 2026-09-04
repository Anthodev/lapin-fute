"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var contracts = require("../src/contracts");
var departures = require("../src/prim-departures");
var traffic = require("../src/prim-traffic");
var parisTime = require("../src/compactparis-time");
var FETCHED_AT = Date.parse("2026-01-15T08:30:00Z") / 1000;
var TRAFFIC_MS = Date.parse("2026-01-15T09:00:00Z");
var KEY = "test-personal-key-a";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixture(name) {
  return clone(require("../../../fixtures/departures/prim/" + name + ".json"));
}

function routing(number) {
  return {
    monitoringRef: "IDFM:SP:" + number,
    lineRef: "IDFM:C" + number,
    destinationRef: "IDFM:" + number + "DST"
  };
}

function departure(time, minutes, status, aimed, interval) {
  var result = { expectedAt: Date.parse("2026-01-15T" + time + "Z") / 1000, minutes: minutes, status: status };
  if (aimed) result.aimedAt = Date.parse("2026-01-15T" + aimed + "Z") / 1000;
  if (interval) result.nextIntervalMinutes = interval;
  return result;
}

function snapshot(freshness, entries, sourceUpdatedAt) {
  return {
    fetchedAt: FETCHED_AT,
    sourceUpdatedAt: typeof sourceUpdatedAt === "undefined" ? FETCHED_AT : sourceUpdatedAt,
    freshness: freshness,
    departures: entries
  };
}

function visits(payload) {
  return payload.Siri.ServiceDelivery.StopMonitoringDelivery[0].MonitoredStopVisit;
}

function trafficFixture() {
  return clone(require("../../../fixtures/traffic/global.json"));
}

function trafficDetail(payload, lineRef, evaluatedAt, checkedAt, parser) {
  parser = parser || traffic;
  return parser.trafficForLine(parser.normalizePrimTrafficResponse(payload, KEY),
    parser.canonicalCatalogLineRef(lineRef), typeof evaluatedAt === "undefined" ? TRAFFIC_MS : evaluatedAt,
    typeof checkedAt === "undefined" ? TRAFFIC_MS : checkedAt);
}

function assertTrafficContract(result) {
  assert.equal(contracts.isTrafficDetailResult(Object.assign({}, result, {
    requestId: "request", favoriteId: "favorite"
  })), true);
  assert.doesNotMatch(JSON.stringify(result), /STIF:|IDFM:|DEST:|test-personal-key/);
}

function portableModules() {
  var cache = Object.create(null);
  var context = vm.createContext({ Map: undefined, Set: undefined, Promise: undefined,
    Intl: undefined, URL: undefined, TextEncoder: undefined, TextDecoder: undefined });
  vm.runInContext("String.prototype.normalize = undefined; String.fromCodePoint = undefined;"
    + "String.prototype.codePointAt = undefined; Number.isInteger = undefined; Number.isFinite = undefined;", context);
  function load(name) {
    var filename = path.resolve(__dirname, "../src", name + ".js");
    var module;
    var wrapper;
    if (cache[filename]) return cache[filename].exports;
    module = { exports: {} };
    cache[filename] = module;
    wrapper = vm.runInContext("(function (require, module, exports) {\n"
      + fs.readFileSync(filename, "utf8") + "\n})", context, { filename: filename });
    wrapper(function (specifier) { return load(specifier.replace(/^\.\//, "")); }, module, module.exports);
    return module.exports;
  }
  return { departures: load("prim-departures"), traffic: load("prim-traffic"), paris: load("compactparis-time") };
}

test("all five recorded modes preserve source times, freshness and intervals on the phone", function () {
  var cases = [
    ["bus", 1001, [departure("08:32:00", 2, "ON_TIME", "08:31:00", 6), departure("08:38:00", 8, "ON_TIME", "08:37:30")]],
    ["metro", 2001, [departure("08:34:00", 4, "ON_TIME", "08:33:00")]],
    ["tram", 3001, [departure("08:36:00", 6, "ON_TIME", "08:35:00")]],
    ["rer", 4001, [departure("08:33:00", 3, "ON_TIME", "08:32:30", 14), departure("08:47:00", 17, "ON_TIME", "08:45:00")]],
    ["transilien", 5001, [departure("08:41:00", 11, "ON_TIME", "08:40:00", 14), departure("08:55:00", 25, "ON_TIME", "08:54:00")]]
  ];
  var portable = portableModules();
  cases.forEach(function (entry) {
    var result = departures.normalizePrimDepartureResponse(fixture(entry[0]), routing(entry[1]), FETCHED_AT);
    assert.deepEqual(result, snapshot("REALTIME", entry[2]), entry[0]);
    assert.equal(contracts.isDepartureSnapshot(result), true);
    assert.deepEqual(clone(portable.departures.normalizePrimDepartureResponse(fixture(entry[0]), routing(entry[1]), FETCHED_AT)), result);
    assert.doesNotMatch(JSON.stringify(result), /STIF:|IDFM:|DEST:|Siri/);
  });
});

test("delays, cancelled visits and scheduled-only visits retain their distinct semantics", function () {
  assert.deepEqual(departures.normalizePrimDepartureResponse(fixture("delayed"), routing(2001), FETCHED_AT),
    snapshot("REALTIME", [departure("08:37:00", 7, "DELAYED", "08:33:00")]));
  assert.deepEqual(departures.normalizePrimDepartureResponse(fixture("cancelled"), routing(3001), FETCHED_AT), snapshot("REALTIME", [
    departure("08:32:00", 2, "CANCELLED", "08:31:30"),
    departure("08:35:00", 5, "ON_TIME", "08:34:30", 5),
    departure("08:40:00", 10, "ON_TIME", "08:39:30")
  ]));
  assert.deepEqual(departures.normalizePrimDepartureResponse(fixture("scheduled-only"), routing(5001), FETCHED_AT), snapshot("SCHEDULED", [
    departure("08:44:00", 14, "UNKNOWN", "08:44:00", 14), departure("08:58:00", 28, "UNKNOWN", "08:58:00")
  ]));
  assert.deepEqual(departures.normalizePrimDepartureResponse(fixture("mixed"), routing(4001), FETCHED_AT), snapshot("MIXED", [
    departure("08:33:00", 3, "ON_TIME", "08:32:30", 8),
    departure("08:41:00", 11, "UNKNOWN", "08:41:00", 8),
    departure("08:49:00", 19, "ON_TIME", "08:48:00")
  ]));
});

test("foreign stop, line and destination visits do not contaminate departures or source freshness", function () {
  var payload = fixture("partial");
  var list = visits(payload);
  payload.Siri.ServiceDelivery.StopMonitoringDelivery[1].MonitoredStopVisit[1]
    .MonitoredVehicleJourney.DestinationRef = { value: routing(1001).destinationRef };
  var source = clone(list.filter(function (visit) {
    return visit.MonitoringRef.value === routing(1001).monitoringRef
      && visit.MonitoredVehicleJourney.LineRef.value === routing(1001).lineRef;
  })[0]);
  source.RecordedAtTime = "2026-01-15T12:00:00Z";
  source.MonitoredVehicleJourney.DestinationRef = "other-destination";
  list.push(source);
  assert.deepEqual(departures.normalizePrimDepartureResponse(payload, routing(1001), FETCHED_AT), snapshot("REALTIME", [
    departure("08:34:00", 4, "ON_TIME", "08:33:00", 8), departure("08:42:00", 12, "ON_TIME")
  ], Date.parse("2026-01-15T08:29:35Z") / 1000));
});

test("exact terminal routing ignores Retour, blank and absent SIRI direction labels", function () {
  var refs = {
    monitoringRef: "STIF:StopPoint:Q:12345:",
    lineRef: "STIF:Line::C01371:",
    destinationRef: "STIF:StopPoint:Q:67890:"
  };
  var payload = fixture("metro");
  var visit = visits(payload)[0];
  var journey = visit.MonitoredVehicleJourney;
  visit.MonitoringRef = { value: refs.monitoringRef };
  journey.LineRef = { value: refs.lineRef };
  journey.DestinationRef = { value: refs.destinationRef };
  // A GTFS direction_id of 0 does not mean the live DirectionRef is "0".
  [{ value: "Retour" }, { value: "" }, undefined].forEach(function (label) {
    journey.DirectionRef = label;
    assert.deepEqual(departures.normalizePrimDepartureResponse(payload, refs, FETCHED_AT),
      snapshot("REALTIME", [departure("08:34:00", 4, "ON_TIME", "08:33:00")]));
  });
  var opposite = clone(visit);
  opposite.RecordedAtTime = "2026-01-15T12:00:00Z";
  opposite.MonitoredVehicleJourney.DestinationRef = { value: "STIF:StopPoint:Q:99999:" };
  opposite.MonitoredVehicleJourney.MonitoredCall.ExpectedDepartureTime = "2026-01-15T08:31:00Z";
  visits(payload).push(opposite);
  assert.deepEqual(departures.normalizePrimDepartureResponse(payload, refs, FETCHED_AT),
    snapshot("REALTIME", [departure("08:34:00", 4, "ON_TIME", "08:33:00")]));
  journey.DestinationRef = opposite.MonitoredVehicleJourney.DestinationRef;
  assert.throws(function () { departures.normalizePrimDepartureResponse(payload, refs, FETCHED_AT); });
  delete journey.DestinationRef;
  assert.throws(function () { departures.normalizePrimDepartureResponse(payload, refs, FETCHED_AT); });
});

test("explicit offsets are independent of local timezone and malformed timestamps fail closed", function () {
  var payload = fixture("metro");
  var call = visits(payload)[0].MonitoredVehicleJourney.MonitoredCall;
  call.ExpectedDepartureTime = "2026-01-15T09:34:00.999+01:00";
  assert.equal(departures.normalizePrimDepartureResponse(payload, routing(2001), FETCHED_AT).departures[0].expectedAt,
    Date.parse("2026-01-15T08:34:00Z") / 1000);
  ["2026-01-15T08:32:00", "2026-02-29T08:32:00Z", "2026-01-15T24:00:00Z",
    "2026-01-15T08:60:00Z", "2026-01-15T08:32:60Z", "2026-01-15T08:32:00+24:00",
    "2026-01-15T08:32:00+01:60", "2026-01-15T08:32:00z", "2026-01-15T08:32:00Z\n",
    "1969-12-31T23:59:59Z", "2106-02-07T06:28:16Z"].forEach(function (timestamp) {
    call.ExpectedDepartureTime = timestamp;
    assert.throws(function () { departures.normalizePrimDepartureResponse(payload, routing(2001), FETCHED_AT); });
  });
  assert.throws(function () { departures.normalizePrimDepartureResponse(fixture("malformed"), routing(2001), FETCHED_AT); });
});

test("normalization bounds chronological output but still validates discarded visits", function () {
  var payload = fixture("bus");
  var original = visits(payload)[0];
  payload.Siri.ServiceDelivery.StopMonitoringDelivery[0].MonitoredStopVisit = [40, 35, 38, 37, 36, 39].map(function (minute) {
    var visit = clone(original);
    visit.MonitoredVehicleJourney.MonitoredCall.ExpectedDepartureTime = "2026-01-15T08:" + minute + ":00Z";
    return visit;
  });
  var result = departures.normalizePrimDepartureResponse(payload, routing(1001), FETCHED_AT);
  assert.deepEqual(result.departures.map(function (entry) { return entry.minutes; }), [5, 6, 7, 8]);
  assert.deepEqual(result.departures.map(function (entry) { return entry.nextIntervalMinutes; }), [1, 1, 1, undefined]);
  delete visits(payload)[5].MonitoredVehicleJourney.MonitoredCall;
  assert.throws(function () { departures.normalizePrimDepartureResponse(payload, routing(1001), FETCHED_AT); });
});

test("upstream routing may exceed watch ID lengths without leaking into the snapshot", function () {
  var payload = fixture("metro");
  var refs = routing(2001);
  var visit = visits(payload)[0];
  refs.monitoringRef += "x".repeat(100);
  refs.lineRef += "y".repeat(100);
  refs.destinationRef += "q".repeat(100);
  visit.MonitoringRef.value = refs.monitoringRef;
  visit.MonitoredVehicleJourney.LineRef.value = refs.lineRef;
  visit.MonitoredVehicleJourney.DestinationRef.value = refs.destinationRef;
  assert.deepEqual(departures.normalizePrimDepartureResponse(payload, refs, FETCHED_AT),
    snapshot("REALTIME", [departure("08:34:00", 4, "ON_TIME", "08:33:00")]));
  var trafficPayload = trafficFixture();
  trafficPayload.lines[0].id = "line:" + refs.lineRef;
  assert.equal(trafficDetail(trafficPayload, refs.lineRef).state, "NORMAL");
});

test("traffic distinguishes observed normal, useful disruption and source uncertainty", function () {
  var payload = trafficFixture();
  var expected = {
    C100: "NORMAL", C200: "DELAYED", C300: "UNKNOWN", C400: "UNKNOWN",
    C500: "NORMAL", C600: "NORMAL", C999: "UNKNOWN"
  };
  Object.keys(expected).forEach(function (line) {
    var result = trafficDetail(payload, "IDFM:" + line);
    assert.equal(result.state, expected[line]);
    assertTrafficContract(result);
  });
  assert.deepEqual(trafficDetail(payload, "IDFM:C200"), {
    schemaVersion: 1, state: "DELAYED", checkedAt: TRAFFIC_MS / 1000,
    title: "Métro 2 : ralentissements", text: "Le trafic est ralenti & les temps d’attente sont allongés."
  });
  assert.deepEqual(trafficDetail(payload, "STIF:Line::C100:"), trafficDetail(payload, "IDFM:C100"));
  ["STIF:Line:C100:", "line:IDFM:C100", "IDFM:C100\n", ""].forEach(function (ref) {
    assert.equal(traffic.canonicalCatalogLineRef(ref), undefined);
  });
});

test("BLOQUANTE never invents STOPPED and outranks usable PERTURBEE details", function () {
  var payload = trafficFixture();
  payload.disruptions[2].severity.effect = "NO_SERVICE";
  payload.lines[1].impactedObjects[0].disruptionIds = ["delay-active", "stopped-active"];
  assert.equal(trafficDetail(payload, "IDFM:C200").state, "UNKNOWN");
  payload.lines[1].impactedObjects[0].disruptionIds.reverse();
  assert.equal(trafficDetail(payload, "IDFM:C200").state, "UNKNOWN");
});

test("Paris periods are inclusive at start and exclusive at end, including summer time", function () {
  var payload = trafficFixture();
  payload.disruptions[0].applicationPeriods = [{ begin: "20260115T100000", end: "20260115T100001" }];
  assert.equal(trafficDetail(payload, "IDFM:C200", TRAFFIC_MS).state, "DELAYED");
  assert.equal(trafficDetail(payload, "IDFM:C200", TRAFFIC_MS + 1000).state, "NORMAL");
  payload.disruptions[0].applicationPeriods = [{ begin: "20260715T100000", end: "20260715T100001" }];
  assert.equal(trafficDetail(payload, "IDFM:C200", Date.parse("2026-07-15T08:00:00Z")).state, "DELAYED");
  assert.equal(trafficDetail(payload, "IDFM:C200", Date.parse("2026-07-15T08:00:01Z")).state, "NORMAL");
});

test("generated Paris time covers epoch bounds and exact DST gaps and overlaps without device Intl", function () {
  var portable = portableModules();
  var cases = [
    [0, "19700101T010000"],
    [Date.parse("1975-07-01T00:00:00Z"), "19750701T010000"],
    [Date.parse("2026-03-29T00:59:59Z"), "20260329T015959"],
    [Date.parse("2026-03-29T01:00:00Z"), "20260329T030000"],
    [Date.parse("2026-10-25T00:59:59Z"), "20261025T025959"],
    [Date.parse("2026-10-25T01:00:00Z"), "20261025T020000"],
    [4294967295999, "21060207T072815"]
  ];
  cases.forEach(function (entry) {
    assert.equal(parisTime(entry[0]), entry[1]);
    assert.equal(portable.paris(entry[0]), entry[1]);
  });
  [-1, NaN, Infinity, 4294967296000].forEach(function (value) {
    assert.throws(function () { parisTime(value); });
  });
});

test("generated Paris offsets agree with build-time ICU across the entire epoch range", function () {
  var formatter = new Intl.DateTimeFormat("en-GB-u-nu-latn", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  });
  var year;
  var month;
  var milliseconds;
  var values;
  for (year = 1970; year <= 2106; year += 1) {
    for (month = 0; month < 12; month += 1) {
      milliseconds = Date.UTC(year, month, 1, 23, 45, 31);
      if (milliseconds >= 4294967296000) break;
      values = {};
      formatter.formatToParts(new Date(milliseconds)).forEach(function (part) { values[part.type] = part.value; });
      assert.equal(parisTime(milliseconds), values.year + values.month + values.day + "T" + values.hour + values.minute + values.second);
    }
  }
});

test("portable traffic text strips markup and secrets and truncates only at Unicode codepoint boundaries", function () {
  var payload = trafficFixture();
  var portable = portableModules();
  payload.disruptions[0].title = "IDFM:C999 " + KEY + "\u0000<b>" + "é".repeat(100) + "</b>";
  payload.disruptions[0].message = "<p>STIF:Line::C999: DEST:secret " + KEY + "</p>" + "\ud83d\ude87".repeat(200);
  var result = trafficDetail(payload, "IDFM:C200", TRAFFIC_MS, TRAFFIC_MS, portable.traffic);
  assert.equal(result.state, "DELAYED");
  assert.ok(contracts.utf8Bytes(result.title) <= contracts.LIMITS.trafficTitleUtf8Bytes);
  assert.ok(contracts.utf8Bytes(result.text) <= contracts.LIMITS.trafficTextUtf8Bytes);
  assert.doesNotMatch(result.title + result.text, /[\u0000-\u001f\u007f-\u009f<>]/);
  assert.equal(result.text.charCodeAt(result.text.length - 1), 56967);
  assertTrafficContract(result);
  payload.disruptions[0].message = "<p>\u0000</p>";
  assert.equal(trafficDetail(payload, "IDFM:C200").state, "UNKNOWN");
});

test("traffic redacts entity-decoded and URI-encoded credentials before returning readable text", function () {
  var payload = trafficFixture();
  var key = "personal+é/key";
  var encoded = encodeURIComponent(key);
  payload.disruptions[0].title = encoded + " : ralentissements";
  payload.disruptions[0].message = "&#112;ersonal+é/key " + encoded.replace(/%[0-9A-F]{2}/g, function (part) {
    return part.toLowerCase();
  }) + " <b>Utilisez le métro.</b>";
  var parser = portableModules().traffic;
  var result = parser.trafficForLine(parser.normalizePrimTrafficResponse(payload, key),
    "line:IDFM:C200", TRAFFIC_MS, TRAFFIC_MS);
  assert.equal(result.title, "[REDACTED] : ralentissements");
  assert.equal(result.text, "[REDACTED] [REDACTED] Utilisez le métro.");
});

test("malformed traffic joins, periods, duplicates and severities reject rather than become normal traffic", function () {
  var changes = [
    function (payload) { delete payload.disruptions; },
    function (payload) { payload.lines[1].impactedObjects[0].disruptionIds = ["missing"]; },
    function (payload) { payload.disruptions[0].severity = "MAJEURE"; },
    function (payload) { payload.disruptions[0].applicationPeriods = [{ begin: "20260230T100000", end: "20260230T110000" }]; },
    function (payload) { payload.disruptions[0].applicationPeriods[0].begin += "\n"; },
    function (payload) { payload.lines.push(clone(payload.lines[0])); },
    function (payload) { payload.disruptions.push(clone(payload.disruptions[0])); },
    function (payload) { payload.lines[1].impactedObjects[0].id = "line:IDFM:another"; },
    function (payload) { payload.lines[1].impactedObjects[0].type = "vehicle"; }
  ];
  changes.forEach(function (change) {
    var payload = trafficFixture();
    change(payload);
    assert.throws(function () { traffic.normalizePrimTrafficResponse(payload, KEY); });
  });
});
