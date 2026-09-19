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
    destinationRef: "STIF:StopPoint:Q:" + number + "DST:"
  };
}

function departure(time, minutes, status, aimed, interval) {
  var result = { expectedAt: Date.parse("2026-01-15T" + time + "Z") / 1000, minutes: minutes, status: status, journeyUncertain: false };
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

function quayPayload(visitList) {
  return { Siri: { ServiceDelivery: { ResponseTimestamp: "2026-01-15T08:30:00Z",
    StopMonitoringDelivery: [{ ResponseTimestamp: "2026-01-15T08:30:00Z", MonitoredStopVisit: visitList }] } } };
}

function quayVisit(monitoringRef, lineRef, destinationRef, expectedIso) {
  return {
    RecordedAtTime: "2026-01-15T08:29:00Z",
    MonitoringRef: { value: monitoringRef },
    MonitoredVehicleJourney: {
      LineRef: { value: lineRef },
      DestinationRef: { value: destinationRef },
      MonitoredCall: { ExpectedDepartureTime: expectedIso, DepartureStatus: "ontime" }
    }
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

function placeId(letter) { return "plc_" + letter.repeat(43); }

function stop(ref, place, pickup, dropOff) {
  return { stopRef: ref, placeId: placeId(place), pickupType: pickup || 0, dropOffType: dropOff || 0 };
}

function journeyContext(refs, arrival, sequences, terminals) {
  return { arrivalPlaceId: placeId(arrival), patterns: {
    revision: "a".repeat(64), groupId: "grp_" + "g".repeat(43), lineMode: "BUS", lineRef: refs.lineRef,
    places: ["a", "b", "c"].map(function (letter) { return { kind: "place", placeId: placeId(letter), label: letter }; }),
    terminals: terminals || [
      { kind: "terminal", terminalId: "full", terminalPlaceId: placeId("c"), refs: [refs.destinationRef], labels: ["Full"] },
      { kind: "terminal", terminalId: "short", terminalPlaceId: placeId("b"), refs: ["STIF:StopPoint:Q:SHORT:"], labels: ["Short"] }
    ],
    patterns: (sequences || [
      [stop(refs.monitoringRef, "a"), stop(null, "b"), stop(null, "c")],
      [stop(refs.monitoringRef, "a"), stop(null, "b")]
    ]).map(function (stops, index) {
      return { kind: "pattern", patternId: "pattern" + index,
        terminalId: stops[stops.length - 1].placeId === placeId("c") ? "full" : "short", stops: stops };
    })
  } };
}

function normalize(payload, refs, context, parser) {
  return (parser || departures).normalizePrimDepartureResponse(payload, refs, FETCHED_AT, context);
}

function live(refs, terminal, minute, status) {
  var visit = quayVisit(refs.monitoringRef, refs.lineRef, terminal, "2026-01-15T08:" + minute + ":00Z");
  visit.MonitoredVehicleJourney.MonitoredCall.DepartureStatus = status || "ontime";
  return visit;
}

test("all five recorded modes preserve source times, freshness and confirmed intervals in ES5", function () {
  var cases = [
    ["bus", 1001, [departure("08:32:00", 2, "ON_TIME", "08:31:00", 6), departure("08:38:00", 8, "ON_TIME", "08:37:30")]],
    ["metro", 2001, [departure("08:34:00", 4, "ON_TIME", "08:33:00")]],
    ["tram", 3001, [departure("08:36:00", 6, "ON_TIME", "08:35:00")]],
    ["rer", 4001, [departure("08:33:00", 3, "ON_TIME", "08:32:30", 14), departure("08:47:00", 17, "ON_TIME", "08:45:00")]],
    ["transilien", 5001, [departure("08:41:00", 11, "ON_TIME", "08:40:00", 14), departure("08:55:00", 25, "ON_TIME", "08:54:00")]]
  ];
  var portable = portableModules();
  cases.forEach(function (entry) {
    var refs = routing(entry[1]), context = journeyContext(refs, "c");
    context.patterns.lineMode = entry[0].toUpperCase();
    var result = normalize(fixture(entry[0]), refs, context);
    assert.deepEqual(result, snapshot("REALTIME", entry[2]), entry[0]);
    assert.equal(contracts.isDepartureSnapshot(result), true);
    assert.deepEqual(clone(normalize(fixture(entry[0]), refs, context, portable.departures)), result);
  });
});

test("delay, cancellation, expected then aimed, and mixed freshness remain independent of journey evidence", function () {
  [
    ["delayed", 2001, "REALTIME", [departure("08:37:00", 7, "DELAYED", "08:33:00")]],
    ["cancelled", 3001, "REALTIME", [departure("08:32:00", 2, "CANCELLED", "08:31:30"),
      departure("08:35:00", 5, "ON_TIME", "08:34:30", 5), departure("08:40:00", 10, "ON_TIME", "08:39:30")]],
    ["scheduled-only", 5001, "SCHEDULED", [departure("08:44:00", 14, "UNKNOWN", "08:44:00", 14),
      departure("08:58:00", 28, "UNKNOWN", "08:58:00")]],
    ["mixed", 4001, "MIXED", [departure("08:33:00", 3, "ON_TIME", "08:32:30", 8),
      departure("08:41:00", 11, "UNKNOWN", "08:41:00", 8), departure("08:49:00", 19, "ON_TIME", "08:48:00")]]
  ].forEach(function (entry) {
    var refs = routing(entry[1]);
    assert.deepEqual(normalize(fixture(entry[0]), refs, journeyContext(refs, "c")), snapshot(entry[2], entry[3]));
  });
});

test("common arrivals combine full and partial chronologically; beyond partial excludes only proven partials", function () {
  var refs = routing(1001);
  var payload = quayPayload([live(refs, refs.destinationRef, 50), live(refs, "STIF:StopPoint:Q:SHORT:", 35),
    live(refs, refs.destinationRef, 42)]);
  assert.deepEqual(normalize(payload, refs, journeyContext(refs, "b")).departures.map(function (d) { return d.minutes; }), [5, 12, 20]);
  assert.deepEqual(normalize(payload, refs, journeyContext(refs, "c")).departures.map(function (d) { return d.minutes; }), [12, 20]);
  var fromB = journeyContext(refs, "c");
  fromB.patterns.patterns[0].stops[0].stopRef = null;
  fromB.patterns.patterns[0].stops[1].stopRef = refs.monitoringRef;
  fromB.patterns.patterns[1].stops[0].stopRef = null;
  fromB.patterns.patterns[1].stops[1].stopRef = refs.monitoringRef;
  assert.deepEqual(normalize(payload, refs, fromB).departures.map(function (d) { return d.minutes; }), [12, 20]);
});

test("unknown short names and absent terminal hints prove only universally compatible journeys", function () {
  var refs = { monitoringRef: "STIF:StopPoint:Q:34214:", lineRef: "STIF:Line::C01246:",
    destinationRef: "STIF:StopPoint:Q:462557:" };
  var context = journeyContext(refs, "b");
  context.patterns.terminals[0].labels = ["Porte de Clignancourt"];
  var abbreviated = live(refs, refs.destinationRef, 32);
  abbreviated.MonitoredVehicleJourney.DestinationName = "Porte de Clignancourt";
  abbreviated.MonitoredVehicleJourney.DestinationShortName = "Clignancourt";
  abbreviated.MonitoredVehicleJourney.MonitoredCall.DestinationDisplay = "Clignancourt";
  var missing = live(refs, refs.destinationRef, 35);
  delete missing.MonitoredVehicleJourney.DestinationRef;
  var payload = quayPayload([missing, abbreviated]);
  assert.deepEqual(normalize(payload, refs, context).departures,
    [departure("08:32:00", 2, "ON_TIME", undefined, 3), departure("08:35:00", 5, "ON_TIME")]);
  context.arrivalPlaceId = placeId("c");
  assert.deepEqual(normalize(payload, refs, context).departures.map(function (d) { return [d.minutes, d.journeyUncertain]; }),
    [[2, true], [5, true]]);
  context.arrivalPlaceId = placeId("a");
  assert.deepEqual(normalize(payload, refs, context).departures, []);
});

test("reduced 255 south and north contradictions confirm only shared arrivals and honor proven Q aliases", function () {
  [
    ["34214", "462557", "39931", ["Porte de Clignancourt"], ["Porte de Paris"], [], "Clignancourt"],
    ["25446", "2181", "493344", ["Les Prévoyants", "Prevoyants"], ["Mairie", "Stains Mairie"], ["STIF:StopPoint:Q:7969:"], "Prevoyants"]
  ].forEach(function (row) {
    var refs = { monitoringRef: "STIF:StopPoint:Q:" + row[0] + ":", lineRef: "STIF:Line::C01246:",
      destinationRef: "STIF:StopPoint:Q:" + row[1] + ":" };
    var context = journeyContext(refs, "b");
    context.patterns.terminals[0].labels = row[3];
    context.patterns.terminals[1].labels = row[4];
    context.patterns.terminals[1].refs = ["STIF:StopPoint:Q:" + row[2] + ":"].concat(row[5]);
    var visit = live(refs, refs.destinationRef, 32);
    visit.MonitoredVehicleJourney.DestinationName = [{ value: row[3][0] }];
    visit.MonitoredVehicleJourney.MonitoredCall.DestinationDisplay = row[4][0];
    assert.equal(normalize(quayPayload([visit]), refs, context).departures[0].journeyUncertain, false);
    context.arrivalPlaceId = placeId("c");
    assert.equal(normalize(quayPayload([visit]), refs, context).departures[0].journeyUncertain, true);
    visit.MonitoredVehicleJourney.DestinationRef = context.patterns.terminals[1].refs.slice(-1)[0];
    visit.MonitoredVehicleJourney.DestinationName = row[4][0];
    visit.MonitoredVehicleJourney.DestinationShortName = { value: row[4][row[4].length - 1] };
    visit.MonitoredVehicleJourney.MonitoredCall.DestinationDisplay = row[6];
    assert.equal(normalize(quayPayload([visit]), refs, context).departures[0].journeyUncertain, true);
    delete visit.MonitoredVehicleJourney.MonitoredCall.DestinationDisplay;
    assert.deepEqual(normalize(quayPayload([visit]), refs, context).departures, []);
    visit.MonitoredVehicleJourney.DestinationDisplay = "Unknown operator text";
    assert.equal(normalize(quayPayload([visit]), refs, context).departures[0].journeyUncertain, true);
  });
});

test("express, loops, order and boarding restrictions cannot be confirmed by one favorable occurrence", function () {
  var refs = routing(1001), payload = quayPayload([live(refs, refs.destinationRef, 35)]);
  var a = function (pickup) { return stop(refs.monitoringRef, "a", pickup); };
  var b = function (drop) { return stop(null, "b", 0, drop); };
  var c = function () { return stop(null, "c"); };
  [
    ["b", [[a(), b(), c()], [a(), c()]], true],
    ["b", [[a(), b(), a(), c()]], true],
    ["b", [[b(), a(), c()]], null],
    ["b", [[a(1), b(), c()]], null],
    ["b", [[a(), b(1), c()]], null],
    ["b", [[a(2), b(), c()]], true],
    ["b", [[a(3), b(), c()]], true],
    ["b", [[a(), b(2), c()]], true],
    ["b", [[a(), b(3), c()]], true],
    ["a", [[a(), b(), c()]], null],
    ["a", [[a(), b(), a(), c()]], true]
  ].forEach(function (entry) {
    var result = normalize(payload, refs, journeyContext(refs, entry[0], entry[1])).departures;
    if (entry[2] === null) assert.deepEqual(result, []);
    else assert.equal(result[0].journeyUncertain, entry[2]);
  });
});

test("SP opposite directions and a different Q quay never become equivalent by place", function () {
  ["STIF:StopArea:SP:AREA:", "STIF:StopPoint:Q:QUAY:"].forEach(function (monitoring) {
    var refs = routing(1001); refs.monitoringRef = monitoring;
    var context = journeyContext(refs, "b", [
      [stop(monitoring, "a"), stop(null, "b"), stop(null, "c")],
      [stop(null, "c"), stop(null, "b"), stop(monitoring, "a"), stop(null, "c")]
    ]);
    assert.equal(normalize(quayPayload([live(refs, refs.destinationRef, 35)]), refs, context).departures[0].journeyUncertain, true);
    context.patterns.patterns[1].stops[2].stopRef = "STIF:StopPoint:Q:OTHER:";
    assert.equal(normalize(quayPayload([live(refs, refs.destinationRef, 35)]), refs, context).departures[0].journeyUncertain, false);
  });
});

test("four total entries prioritize confirmation, preserve ties and never synthesize missing visits", function () {
  var refs = routing(1001), context = journeyContext(refs, "b");
  context.patterns.terminals.push({ kind: "terminal", terminalId: "branch", terminalPlaceId: placeId("c"),
    refs: ["STIF:StopPoint:Q:BRANCH:"], labels: ["Branch"] });
  context.patterns.patterns.push({ kind: "pattern", patternId: "branch", terminalId: "branch",
    stops: [stop(refs.monitoringRef, "a"), stop(null, "c")] });
  var known = live(refs, refs.destinationRef, 40), short = live(refs, "STIF:StopPoint:Q:SHORT:", 40, "delayed");
  known.MonitoredVehicleJourney.DestinationName = ["Full", { value: "Short" }];
  var unknown = live(refs, "STIF:StopPoint:Q:UNKNOWN:", 31);
  var result = normalize(quayPayload([unknown, known, short, live(refs, refs.destinationRef, 50),
    live(refs, "STIF:StopPoint:Q:UNKNOWN:", 32)]), refs, context).departures;
  assert.deepEqual(result.map(function (d) { return [d.minutes, d.status, d.journeyUncertain, d.nextIntervalMinutes]; }),
    [[10, "ON_TIME", false, undefined], [10, "DELAYED", false, 10], [20, "ON_TIME", false, undefined],
      [1, "ON_TIME", true, undefined]]);
  [0, 1, 2, 3, 4, 5].forEach(function (count) {
    var list = [45, 33, 39, 42, 36].slice(0, count).map(function (minute) { return live(refs, refs.destinationRef, minute); });
    assert.deepEqual(normalize(quayPayload(list), refs, context).departures.map(function (d) { return d.minutes; }),
      [45, 33, 39, 42, 36].slice(0, count).sort(function (a, b) { return a - b; }).slice(0, 4).map(function (n) { return n - 30; }));
  });
  result = normalize(quayPayload([live(refs, refs.destinationRef, 32), live(refs, refs.destinationRef, 35, "cancelled"),
    live(refs, refs.destinationRef, 40), unknown]), refs, context).departures;
  assert.deepEqual(result.map(function (d) { return d.nextIntervalMinutes; }), [8, undefined, undefined, undefined]);
  var bad = live(refs, refs.destinationRef, 59);
  bad.MonitoredVehicleJourney.DestinationName = 42;
  assert.throws(function () { normalize(quayPayload([known, known, known, known, bad]), refs, context); });
});

test("every supported SIRI evidence field accepts strings, value objects and flat arrays without coercion", function () {
  var refs = routing(1001), context = journeyContext(refs, "c");
  ["DestinationName", "DestinationShortName", "DestinationDisplay", "call"].forEach(function (field) {
    ["Full", { value: "Full" }, ["Full", { value: "Full" }]].forEach(function (value) {
      var visit = live(refs, refs.destinationRef, 35), journey = visit.MonitoredVehicleJourney;
      delete journey.DestinationRef;
      (field === "call" ? journey.MonitoredCall : journey)[field === "call" ? "DestinationDisplay" : field] = value;
      assert.equal(normalize(quayPayload([visit]), refs, context).departures[0].journeyUncertain, false);
    });
    [42, false, {}, { value: null }, ["Full", 7], [["Full"]], [null]].forEach(function (value) {
      var visit = live(refs, refs.destinationRef, 35), journey = visit.MonitoredVehicleJourney;
      (field === "call" ? journey.MonitoredCall : journey)[field === "call" ? "DestinationDisplay" : field] = value;
      assert.throws(function () { normalize(quayPayload([visit]), refs, context); });
    });
  });
  [refs.destinationRef, { value: refs.destinationRef }, [refs.destinationRef, { value: refs.destinationRef }]].forEach(function (value) {
    var visit = live(refs, refs.destinationRef, 35);
    visit.MonitoredVehicleJourney.DestinationRef = value;
    assert.equal(normalize(quayPayload([visit]), refs, context).departures[0].journeyUncertain, false);
  });
  ["", "IDFM:bad", "STIF:StopPoint:Q:bad space:", "STIF:StopPoint:Q:bad:\n", 7, {}, [null]].forEach(function (value) {
    var visit = live(refs, refs.destinationRef, 35);
    visit.MonitoredVehicleJourney.DestinationRef = value;
    assert.throws(function () { normalize(quayPayload([visit]), refs, context); });
  });
  [undefined, null].forEach(function (value) {
    var visit = live(refs, refs.destinationRef, 35), journey = visit.MonitoredVehicleJourney;
    journey.DestinationRef = value;
    journey.DestinationName = ["", { value: "" }];
    journey.DirectionRef = refs.destinationRef;
    journey.DirectionName = "Full";
    assert.equal(normalize(quayPayload([visit]), refs, context).departures[0].journeyUncertain, true);
  });
});

test("resolved arrival context is mandatory; unavailable patterns keep actual uncertain times and statuses", function () {
  var refs = routing(1001), payload = quayPayload([live(refs, refs.destinationRef, 35, "delayed"),
    live(refs, refs.destinationRef, 40, "cancelled")]);
  [undefined, null, {}, { arrivalPlaceId: null, patterns: null }, { arrivalPlaceId: placeId("c") },
    { arrivalPlaceId: placeId("c"), patterns: undefined }, { arrivalPlaceId: "plc_bad", patterns: null },
    { arrivalPlaceId: placeId("c"), patterns: {} }].forEach(function (context) {
    assert.throws(function () { normalize(payload, refs, context); });
  });
  var result = normalize(payload, refs, { arrivalPlaceId: placeId("c"), patterns: null }).departures;
  assert.deepEqual(result.map(function (d) { return [d.minutes, d.status, d.journeyUncertain, d.nextIntervalMinutes]; }),
    [[5, "DELAYED", true, undefined], [10, "CANCELLED", true, undefined]]);
});

test("foreign line and monitoring visits do not contaminate source freshness", function () {
  var refs = routing(1001), good = live(refs, refs.destinationRef, 35), other = clone(good);
  other.RecordedAtTime = "2026-01-15T12:00:00Z";
  other.MonitoringRef = "other-stop";
  var wrongLine = clone(other); wrongLine.MonitoringRef = refs.monitoringRef;
  wrongLine.MonitoredVehicleJourney.LineRef = "other-line";
  assert.deepEqual(normalize(quayPayload([other, good, wrongLine]), refs, journeyContext(refs, "c")),
    snapshot("REALTIME", [departure("08:35:00", 5, "ON_TIME")]));
});

test("explicit offsets and strict source dates remain independent of local timezone", function () {
  var refs = routing(2001), payload = fixture("metro"), context = journeyContext(refs, "c");
  var call = visits(payload)[0].MonitoredVehicleJourney.MonitoredCall;
  call.ExpectedDepartureTime = "2026-01-15T09:34:00.999+01:00";
  assert.equal(normalize(payload, refs, context).departures[0].expectedAt, Date.parse("2026-01-15T08:34:00Z") / 1000);
  ["2026-01-15T08:32:00", "2026-02-29T08:32:00Z", "2026-01-15T24:00:00Z",
    "2026-01-15T08:60:00Z", "2026-01-15T08:32:60Z", "2026-01-15T08:32:00+24:00",
    "2026-01-15T08:32:00+01:60", "2026-01-15T08:32:00z", "2026-01-15T08:32:00Z\n",
    "1969-12-31T23:59:59Z", "2106-02-07T06:28:16Z"].forEach(function (timestamp) {
    call.ExpectedDepartureTime = timestamp;
    assert.throws(function () { normalize(payload, refs, context); });
  });
  assert.throws(function () { normalize(fixture("malformed"), refs, context); });
});
test("traffic distinguishes observed normal, useful disruption and source uncertainty", function () {
  var payload = trafficFixture();
  var expected = {
    C100: "NORMAL", C200: "DELAYED", C300: "STOPPED", C400: "STOPPED",
    C500: "NORMAL", C600: "NORMAL", C999: "NORMAL"
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

test("lines omitted from the disruption-only bulk feed have normal traffic", function () {
  var payload = trafficFixture();
  payload.lines = payload.lines.filter(function (line) { return line.id !== "line:IDFM:C100"; });
  assert.equal(trafficDetail(payload, "IDFM:C100").state, "NORMAL");
  assert.equal(trafficDetail(payload, "invalid-line").state, "UNKNOWN");
});

test("the latest active update wins even over a more severe incident", function () {
  var payload = trafficFixture();
  payload.lines[1].impactedObjects[0].disruptionIds = ["delay-active", "blocking-unclassified"];
  payload.disruptions[0].lastUpdate = "20260115T095900";
  assert.deepEqual(trafficDetail(payload, "IDFM:C200"), {
    schemaVersion: 1, state: "DELAYED", checkedAt: TRAFFIC_MS / 1000,
    title: "Métro 2 : ralentissements", text: "Le trafic est ralenti & les temps d’attente sont allongés."
  });
  payload.lines[1].impactedObjects[0].disruptionIds.reverse();
  assert.equal(trafficDetail(payload, "IDFM:C200").state, "DELAYED");
});

test("dated incidents outrank undated ones and equal dates use ID rather than input order", function () {
  var payload = trafficFixture();
  payload.lines[1].impactedObjects[0].disruptionIds = ["delay-active", "blocking-unclassified"];
  delete payload.disruptions[3].lastUpdate;
  assert.equal(trafficDetail(payload, "IDFM:C200").state, "DELAYED");
  payload.disruptions[3].lastUpdate = payload.disruptions[0].lastUpdate;
  assert.equal(trafficDetail(payload, "IDFM:C200").title, "Tram T3 : incident");
  payload.lines[1].impactedObjects[0].disruptionIds.reverse();
  assert.equal(trafficDetail(payload, "IDFM:C200").title, "Tram T3 : incident");
  delete payload.disruptions[0].lastUpdate;
  delete payload.disruptions[3].lastUpdate;
  assert.equal(trafficDetail(payload, "IDFM:C200").title, "Tram T3 : incident");
});

test("newer future and active works are excluded and cannot mask older active incidents", function () {
  var payload = trafficFixture();
  payload.lines[1].impactedObjects[0].disruptionIds = ["delay-active", "future-delay", "blocking-unclassified"];
  payload.disruptions[3].lastUpdate = "20260115T095900";
  payload.disruptions[3].applicationPeriods = [{ begin: "20260115T090000", end: "20260115T100000" }];
  payload.disruptions[4].lastUpdate = "20260115T100000";
  assert.equal(trafficDetail(payload, "IDFM:C200").title, "Métro 2 : ralentissements");
  payload.disruptions[4].applicationPeriods[0].begin = "20260115T100000";
  assert.equal(trafficDetail(payload, "IDFM:C200").title, "Métro 2 : ralentissements");
  payload.lines[1].impactedObjects[0].disruptionIds = ["future-delay"];
  assert.equal(trafficDetail(payload, "IDFM:C200").state, "NORMAL");
});

test("works exclusion follows the explicit TRAVAUX cause, never the title, a missing or unknown cause", function () {
  var payload = trafficFixture();
  payload.lines[1].impactedObjects[0].disruptionIds = ["delay-active", "future-delay"];
  payload.disruptions[4].applicationPeriods[0].begin = "20260115T100000";
  payload.disruptions[4].lastUpdate = "20260115T100000";
  payload.disruptions[0].lastUpdate = "20260115T090000";
  payload.disruptions[0].title = "Travaux en cours sur la ligne";
  assert.equal(trafficDetail(payload, "IDFM:C200").title, "Travaux en cours sur la ligne");
  payload.disruptions[0].cause = "TRAVAUX";
  assert.equal(trafficDetail(payload, "IDFM:C200").state, "NORMAL");
  payload.disruptions[0].cause = "MANIFESTATION";
  assert.equal(trafficDetail(payload, "IDFM:C200").title, "Travaux en cours sur la ligne");
  delete payload.disruptions[0].cause;
  assert.equal(trafficDetail(payload, "IDFM:C200").title, "Travaux en cours sur la ligne");
});

test("an active disruption without complete details remains UNKNOWN", function () {
  var payload = trafficFixture();
  delete payload.disruptions[3].message;
  assert.equal(trafficDetail(payload, "IDFM:C400").state, "UNKNOWN");
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
    function (payload) { payload.disruptions[0].lastUpdate = "20260230T100000"; },
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
