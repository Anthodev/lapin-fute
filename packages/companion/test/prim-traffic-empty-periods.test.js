"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var traffic = require("../src/prim-traffic");
var contracts = require("../src/contracts");
var createPrimClient = require("../src/prim-client").createPrimClient;
var fakes = require("./fakes");
var KEY = "synthetic-offline-traffic-key";
var INSTANT = Date.parse("2026-09-06T09:25:00Z");

// Representative source shape: an empty-period blocking entry occurs alongside
// independently usable lines and a real nonempty disruption. No vendor body is stored.
function fixture() {
  return {
    disruptions: [
      {
        id: "empty-blocking-periods",
        applicationPeriods: [
          { begin: "20260906T112500", end: "20260906T112500" },
          { begin: "20260913T112500", end: "20260913T112500" },
          { begin: "20260920T112500", end: "20260920T112500" }
        ],
        lastUpdate: "20260905T100000",
        cause: "PERTURBATION",
        severity: "BLOQUANTE",
        title: "Modification de circulation",
        message: "<p>Consultez les horaires de la ligne.</p>"
      },
      {
        id: "active-delay",
        applicationPeriods: [{ begin: "20260906T110000", end: "20260906T120000" }],
        severity: "PERTURBEE",
        title: "Temps d'attente allongés",
        message: "<p>Le trafic est ralenti.</p>"
      }
    ],
    lines: [
      { id: "line:IDFM:C100", impactedObjects: [] },
      {
        id: "line:IDFM:C200",
        impactedObjects: [{ type: "line", id: "line:IDFM:C200", disruptionIds: ["empty-blocking-periods"] }]
      },
      {
        id: "line:IDFM:C300",
        impactedObjects: [{ type: "line", id: "line:IDFM:C300", disruptionIds: ["empty-blocking-periods", "active-delay"] }]
      }
    ],
    lastUpdatedDate: "2026-09-05T08:00:00.000Z"
  };
}

function stateAt(envelope, lineId, milliseconds) {
  return traffic.trafficForLine(envelope, lineId, milliseconds, INSTANT).state;
}

test("empty half-open traffic periods stay inactive without discarding other source information", function () {
  var envelope = traffic.normalizePrimTrafficResponse(fixture(), KEY);
  [INSTANT - 1000, INSTANT, INSTANT + 1000].forEach(function (milliseconds) {
    assert.equal(stateAt(envelope, "line:IDFM:C200", milliseconds), "NORMAL");
    assert.equal(stateAt(envelope, "line:IDFM:C300", milliseconds), "DELAYED");
    assert.equal(stateAt(envelope, "line:IDFM:C100", milliseconds), "NORMAL");
  });
  var detail = traffic.trafficForLine(envelope, "line:IDFM:C300", INSTANT, INSTANT);
  assert.equal(detail.title, "Temps d'attente allongés");
  assert.equal(detail.text, "Le trafic est ralenti.");
  assert.equal(contracts.isTrafficDetailResult(Object.assign({}, detail, {
    requestId: "request", favoriteId: "favorite"
  })), true);
});

test("a bulk body containing empty periods succeeds through the production client", function () {
  var source = fixture();
  var bytes = Buffer.from(JSON.stringify(source));
  var clock = new fakes.FakeClock(INSTANT);
  var outcomes = [];
  function RecordedXHR() {}
  RecordedXHR.prototype.open = function (method, url) {
    assert.equal(method, "GET");
    assert.equal(url, "https://prim.iledefrance-mobilites.fr/marketplace/disruptions_bulk/disruptions/v2");
  };
  RecordedXHR.prototype.setRequestHeader = function () {};
  RecordedXHR.prototype.send = function () {
    this.status = 200;
    this.response = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    this.onload();
  };
  var client = createPrimClient({ XHR: RecordedXHR, clock: clock });
  client.traffic({ lineRef: "STIF:Line::C100:", language: "fr", apiKey: KEY }, function (outcome) {
    outcomes.push(outcome);
  });
  clock.advance(0);
  assert.deepEqual(outcomes, [{ status: "AVAILABLE", data: {
    schemaVersion: 1, state: "NORMAL", checkedAt: INSTANT / 1000
  } }]);
});

test("reversed or invalid traffic periods still reject instead of becoming empty or invented ranges", function () {
  var cases = [
    { begin: "20260906T112501", end: "20260906T112500" },
    { begin: "20260230T112500", end: "20260230T112500" },
    { begin: "20260906T252500", end: "20260906T252500" },
    { begin: "20260906T112500\n", end: "20260906T112500\n" }
  ];
  cases.forEach(function (period) {
    var source = fixture();
    source.disruptions[0].applicationPeriods[0] = period;
    assert.throws(function () { traffic.normalizePrimTrafficResponse(source, KEY); });
  });
  var missingPeriods = fixture();
  missingPeriods.disruptions[0].applicationPeriods = [];
  assert.throws(function () { traffic.normalizePrimTrafficResponse(missingPeriods, KEY); });
});
