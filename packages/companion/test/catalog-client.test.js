"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var createCatalogClient = require("../src/catalog-client").createCatalogClient;
var contracts = require("../src/contracts");
var journeys = require("../src/journey-patterns");
var fakes = require("./fakes");
var REVISION = "a".repeat(64);
var SERVICE = "svc_" + "s".repeat(43);
var GROUP = "grp_" + "g".repeat(43);
var PLACE = "plc_" + "p".repeat(43);
var TERMINAL = "term_" + "t".repeat(43);
var ROUTING = { monitoringRef: "STIF:StopPoint:Q:A:", lineRef: "STIF:Line::L:", destinationRef: "STIF:StopPoint:Q:B:" };

function fixture() {
  var service = { schemaVersion: 1, revision: REVISION, serviceId: SERVICE, groupId: GROUP,
    lineMode: "BUS", routing: Object.assign({}, ROUTING), terminalPlaceId: PLACE };
  var rows = [
    { kind: "place", placeId: PLACE, label: "Arrival" },
    { kind: "terminal", terminalId: TERMINAL, terminalPlaceId: PLACE, refs: [ROUTING.destinationRef], labels: ["Arrival"] },
    { kind: "pattern", patternId: "pat_" + "r".repeat(43), terminalId: TERMINAL,
      stops: [{ stopRef: ROUTING.monitoringRef, placeId: PLACE, pickupType: 0, dropOffType: 0 },
        { stopRef: ROUTING.destinationRef, placeId: PLACE, pickupType: 0, dropOffType: 0 }] }
  ];
  return { service: service,
    index: { schemaVersion: 1, revision: REVISION, groupId: GROUP, lineMode: "BUS", lineRef: ROUTING.lineRef,
      pageCount: 3, rowCount: 3, patternCount: 1 },
    pages: rows.map(function (row, page) { return { schemaVersion: 1, revision: REVISION, groupId: GROUP,
      page: page, nextPage: page < 2 ? page + 1 : null, rows: [row] }; }) };
}
function harness() {
  var transport = fakes.createXHRFactory();
  var clock = new fakes.FakeClock();
  return { transport: transport, clock: clock, client: createCatalogClient({ XHR: transport.XHR,
    clock: clock, configurationUrl: "https://example.test/index.html" }) };
}
function last(h) { return h.transport.instances[h.transport.instances.length - 1]; }
function start(h, data, values) {
  var handle = h.client.lookupJourney(data.service.serviceId, data.service.routing, function (value) { values.push(value); });
  last(h).respond(200, { schemaVersion: 1, revision: data.service.revision });
  last(h).respond(200, data.service);
  return handle;
}
function finish(h, data) {
  last(h).respond(200, data.index);
  data.pages.forEach(function (page) { last(h).respond(200, page); });
}

test("journey requests pin revision and admit only the complete group without retaining it", function () {
  var h = harness(), data = fixture(), values = [];
  start(h, data, values);
  finish(h, data);
  assert.equal(values.length, 1);
  assert.deepEqual(journeys.reachableArrivals(values[0].group, ROUTING.monitoringRef), [data.pages[0].rows[0]]);
  assert.deepEqual(h.transport.instances.map(function (xhr) { return xhr.url; }), [
    "https://example.test/catalog/manifest.json",
    "https://example.test/catalog/" + REVISION + "/journeys/services/" + SERVICE + ".json",
    "https://example.test/catalog/" + REVISION + "/journeys/groups/" + GROUP + "/index.json",
    "https://example.test/catalog/" + REVISION + "/journeys/groups/" + GROUP + "/0.json",
    "https://example.test/catalog/" + REVISION + "/journeys/groups/" + GROUP + "/1.json",
    "https://example.test/catalog/" + REVISION + "/journeys/groups/" + GROUP + "/2.json"
  ]);
  start(h, data, []);
  assert.equal(h.transport.instances.length, 9);
  last(h).respond(404, {});
});

test("invalid or mismatched annexes do not start a group lookup", function () {
  [function (d) { d.service.revision = "b".repeat(64); },
    function (d) { d.service.serviceId = "svc_" + "x".repeat(43); },
    function (d) { d.service.routing.destinationRef = "STIF:StopPoint:Q:OTHER:"; },
    function (d) { d.service.extra = true; }].forEach(function (change) {
    var h = harness(), data = fixture(), values = [];
    h.client.lookupJourney(SERVICE, ROUTING, function (value) { values.push(value); });
    last(h).respond(200, { schemaVersion: 1, revision: REVISION });
    change(data);
    last(h).respond(200, data.service);
    assert.deepEqual(values, [null]);
    assert.equal(h.transport.instances.length, 2);
  });
});

test("missing intermediate pages, bad counts, revisions and duplicate rows fail closed without retries", function () {
  ["missing", "count", "revision", "duplicate"].forEach(function (fault) {
    var h = harness(), data = fixture(), values = [];
    start(h, data, values);
    if (fault === "count") data.index.rowCount += 1;
    if (fault === "revision") data.pages[1].revision = "b".repeat(64);
    if (fault === "duplicate") data.pages[1].rows = data.pages[0].rows;
    last(h).respond(200, data.index);
    last(h).respond(200, data.pages[0]);
    last(h).respond(fault === "missing" ? 404 : 200, data.pages[1]);
    if (values.length === 0) last(h).respond(200, data.pages[2]);
    assert.deepEqual(values, [{ service: data.service, group: null }], fault);
    var count = h.transport.instances.length;
    h.clock.advance(contracts.LIMITS.httpTimeoutMs * 2);
    assert.equal(h.transport.instances.length, count);
    assert.equal(values.length, 1);
  });
});

test("raw document and cumulative group budgets include whitespace and the index", function () {
  var h = harness(), data = fixture(), values = [];
  start(h, data, values);
  last(h).respond(200, JSON.stringify(data.index) + " ".repeat(journeys.JOURNEY_LIMITS.documentBytes));
  assert.deepEqual(values, [{ service: data.service, group: null }]);

  h = harness(); data = fixture(); values = [];
  data.index.pageCount = 32;
  data.index.rowCount = 34;
  data.pages = Array.from({ length: 32 }, function (_, number) {
    var row = { kind: "place", placeId: "plc_" + String(number).padStart(43, "0"), label: "Place" };
    var rows = [row];
    if (number === 31) {
      rows = [fixture().pages[0].rows[0],
        fixture().pages[1].rows[0], fixture().pages[2].rows[0]];
    }
    return { schemaVersion: 1, revision: REVISION, groupId: GROUP, page: number,
      nextPage: number === 31 ? null : number + 1, rows: rows };
  });
  start(h, data, values);
  last(h).respond(200, data.index);
  data.pages.forEach(function (page) {
    var text = JSON.stringify(page);
    last(h).respond(200, text + " ".repeat(journeys.JOURNEY_LIMITS.documentBytes - Buffer.byteLength(text)));
  });
  assert.deepEqual(values, [{ service: data.service, group: null }]);
});

test("shared group flights survive one cancellation but abort when the last subscriber cancels", function () {
  var h = harness(), data = fixture(), first = [], second = [];
  var one = start(h, data, first);
  var indexRequest = last(h);
  var other = fixture();
  other.service.serviceId = "svc_" + "x".repeat(43);
  other.service.routing.monitoringRef = "STIF:StopPoint:Q:OTHER:";
  var two = start(h, other, second);
  assert.equal(h.transport.instances.length, 5);
  one.abort();
  assert.equal(indexRequest.aborted, false);
  indexRequest.respond(200, data.index);
  data.pages.forEach(function (page) { last(h).respond(200, page); });
  assert.deepEqual(first, []);
  assert.equal(second.length, 1);
  assert.equal(second[0].group.patterns.length, 1);
  two.abort();

  var third = [], fourth = [];
  one = start(h, data, third);
  indexRequest = last(h);
  two = start(h, other, fourth);
  var late = indexRequest.onload;
  one.abort(); two.abort();
  assert.equal(indexRequest.aborted, true);
  late();
  h.clock.advance(contracts.LIMITS.httpTimeoutMs);
  assert.deepEqual(third, []);
  assert.deepEqual(fourth, []);
  start(h, data, []);
  assert.notEqual(last(h), indexRequest);
  last(h).respond(404, {});
});

test("deadline keeps valid annex, explicit cancellation suppresses callback, and neither retries", function () {
  var h = harness(), data = fixture(), values = [];
  start(h, data, values);
  var pending = last(h);
  h.clock.advance(contracts.LIMITS.httpTimeoutMs);
  assert.equal(pending.aborted, true);
  assert.deepEqual(values, [{ service: data.service, group: null }]);
  assert.equal(h.transport.instances.length, 3);
  values = [];
  var handle = h.client.lookupJourney(SERVICE, ROUTING, function (value) { values.push(value); });
  pending = last(h);
  var late = pending.onload;
  handle.abort(); late();
  assert.equal(pending.aborted, true);
  assert.deepEqual(values, []);
});

test("the revision is part of the group flight identity", function () {
  var h = harness(), first = fixture(), second = fixture(), one = [], two = [];
  second.service.revision = "b".repeat(64);
  second.index.revision = second.service.revision;
  second.pages.forEach(function (page) { page.revision = second.service.revision; });
  start(h, first, one);
  var firstIndex = last(h);
  start(h, second, two);
  var secondIndex = last(h);
  assert.notEqual(firstIndex, secondIndex);
  firstIndex.respond(200, first.index);
  first.pages.forEach(function (page) { last(h).respond(200, page); });
  secondIndex.respond(200, second.index);
  second.pages.forEach(function (page) { last(h).respond(200, page); });
  assert.equal(one[0].group.revision, REVISION);
  assert.equal(two[0].group.revision, second.service.revision);
});

test("service lookup remains compatible and transport construction failure settles once", function () {
  var h = harness(), values = [];
  var service = { serviceId: SERVICE, stopLabel: "Origin", lineLabel: "42", destinationLabel: "Arrival",
    lineMode: "BUS", lineColor: "#ffffff", lineTextColor: "#000000", routing: ROUTING };
  h.client.lookupService(SERVICE, function (value) { values.push(value); });
  last(h).respond(200, { schemaVersion: 1, revision: REVISION });
  last(h).respond(200, { schemaVersion: 1, revision: REVISION, service: service });
  assert.deepEqual(values, [service]);
  var broken = createCatalogClient({ configurationUrl: "https://example.test/index.html",
    XHR: function () { throw new Error("transport unavailable"); } });
  values = [];
  broken.lookupJourney(SERVICE, ROUTING, function (value) { values.push(value); });
  assert.deepEqual(values, [null]);
});
