"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var fs = require("node:fs");
var path = require("node:path");
var vm = require("node:vm");
var createPrimClient = require("../src/prim-client").createPrimClient;
var contracts = require("../src/contracts");
var fakes = require("./fakes");
var KEY_A = "test-personal-key-a";
var KEY_B = "test-personal-key-b";
var DEPARTURE_MS = Date.parse("2026-01-15T08:30:00Z");
var TRAFFIC_MS = Date.parse("2026-01-15T09:00:00Z");
var ROUTING = { monitoringRef: "IDFM:SP:1001", lineRef: "IDFM:C1001", destinationRef: "IDFM:1001DST" };

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function departureFixture() {
  return clone(require("../../../fixtures/departures/prim/bus.json"));
}

function trafficFixture() {
  return clone(require("../../../fixtures/traffic/global.json"));
}

function fakeTransport() {
  var factory = fakes.createXHRFactory();
  factory.XHR.prototype.abort = function () { this.aborts = (this.aborts || 0) + 1; };
  factory.XHR.prototype.respondBytes = function (status, bytes, headers) {
    this.status = status;
    this.readyState = 4;
    this.responseHeaders = headers || {};
    this.response = Uint8Array.from(bytes).buffer;
    if (this.onload) this.onload();
    if (this.onloadend) this.onloadend();
    if (this.onreadystatechange) this.onreadystatechange();
  };
  factory.XHR.prototype.respond = function (status, payload, headers) {
    this.respondBytes(status, Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8"), headers);
  };
  // pypkjs network failures emit loadend/readystatechange, not onerror.
  factory.XHR.prototype.networkError = function () {
    this.status = 0;
    this.readyState = 4;
    this.statusText = "private exception " + KEY_A;
    if (this.onloadend) this.onloadend();
    if (this.onreadystatechange) this.onreadystatechange();
  };
  return factory;
}

function harness(milliseconds, factory, createClient) {
  var transport = factory || fakeTransport();
  var clock = new fakes.FakeClock(typeof milliseconds === "undefined" ? DEPARTURE_MS : milliseconds);
  return { transport: transport, clock: clock, client: (createClient || createPrimClient)({ XHR: transport.XHR, clock: clock }) };
}

function collect() {
  var values = [];
  return { values: values, complete: function (value) { values.push(value); } };
}

function requestTraffic(h, lineRef, result, apiKey, language) {
  return h.client.traffic({ lineRef: lineRef, language: language || "fr", apiKey: apiKey || KEY_A }, result.complete);
}

function assertError(result, code, milliseconds, retryAfterSeconds) {
  var error = { code: code, occurredAt: Math.floor(milliseconds / 1000) };
  if (typeof retryAfterSeconds !== "undefined") error.retryAfterSeconds = retryAfterSeconds;
  assert.deepEqual(result, { status: "UNAVAILABLE", error: error });
  assert.doesNotMatch(JSON.stringify(result), /test-personal-key|Siri|STIF:|IDFM:|exception/);
}

function portableFactory() {
  var context = vm.createContext({ Map: undefined, Set: undefined, Promise: undefined, Intl: undefined,
    URL: undefined, TextEncoder: undefined, TextDecoder: undefined });
  var cache = Object.create(null);
  vm.runInContext("String.prototype.normalize = undefined; Number.isInteger = undefined; Number.isFinite = undefined;", context);
  function load(name) {
    var filename = path.resolve(__dirname, "../src", name + ".js");
    var module;
    var wrapper;
    if (cache[filename]) return cache[filename].exports;
    module = { exports: {} };
    cache[filename] = module;
    wrapper = vm.runInContext("(function (require, module, exports) {\n" + fs.readFileSync(filename, "utf8") + "\n})", context);
    wrapper(function (specifier) { return load(specifier.replace(/^\.\//, "")); }, module, module.exports);
    return module.exports;
  }
  return load("prim-client").createPrimClient;
}

test("departures issue only the fixed PRIM GET and deliver a binding-free snapshot asynchronously", function () {
  var h = harness();
  var result = collect();
  h.client.departures({ routing: ROUTING, apiKey: KEY_A }, result.complete);
  var xhr = h.transport.instances[0];
  assert.equal(xhr.method, "GET");
  assert.equal(xhr.url, "https://prim.iledefrance-mobilites.fr/marketplace/stop-monitoring?MonitoringRef=IDFM%3ASP%3A1001&LineRef=IDFM%3AC1001");
  assert.equal(xhr.headers.apikey, KEY_A);
  assert.equal(xhr.headers.Accept, "application/json");
  assert.equal(xhr.headers.Authorization, undefined);
  assert.equal(xhr.body, null);
  assert.equal(xhr.responseType, "arraybuffer");
  xhr.respond(200, departureFixture());
  assert.deepEqual(result.values, []);
  h.clock.advance(0);
  assert.equal(result.values.length, 1);
  assert.equal(result.values[0].status, "AVAILABLE");
  assert.equal(contracts.isDepartureSnapshot(result.values[0].data), true);
  assert.deepEqual(result.values[0].data.departures.map(function (entry) { return entry.minutes; }), [2, 8]);
  assert.doesNotMatch(JSON.stringify(result.values[0]), /Siri|IDFM:|test-personal-key|requestId|favoriteId|schemaVersion/);
});

test("client executes byte decoding and both parsers without modern runtime collections or codecs", function () {
  var h = harness(TRAFFIC_MS, null, portableFactory());
  var result = collect();
  requestTraffic(h, "IDFM:C200", result);
  h.transport.instances[0].respond(200, trafficFixture());
  h.clock.advance(0);
  assert.deepEqual(clone(result.values), [{ status: "AVAILABLE", data: {
    schemaVersion: 1, state: "DELAYED", checkedAt: TRAFFIC_MS / 1000,
    title: "Métro 2 : ralentissements", text: "Le trafic est ralenti & les temps d’attente sont allongés."
  } }]);
});

test("synchronous XHR completion or construction failure still settles later and only once", function () {
  var factory = fakeTransport();
  factory.XHR.prototype.send = function () {
    var load = this.onload;
    var error = this.onerror;
    this.respond(200, departureFixture());
    load();
    error();
  };
  var h = harness(DEPARTURE_MS, factory);
  var result = collect();
  var handle = h.client.departures({ routing: ROUTING, apiKey: KEY_A }, result.complete);
  assert.equal(result.values.length, 0);
  h.clock.advance(0);
  assert.equal(result.values.length, 1);
  assert.equal(result.values[0].status, "AVAILABLE");
  handle.abort();
  h.clock.advance(10000);
  assert.equal(result.values.length, 1);

  h = harness(DEPARTURE_MS, { XHR: function () { throw new Error(KEY_A); } });
  result = collect();
  h.client.departures({ routing: ROUTING, apiKey: KEY_A }, result.complete);
  assert.equal(result.values.length, 0);
  h.clock.advance(0);
  assertError(result.values[0], "SOURCE_UNAVAILABLE", DEPARTURE_MS);
});

test("abort is final before completion and between completion and deferred delivery", function () {
  var h = harness();
  var result = collect();
  var handle = h.client.departures({ routing: ROUTING, apiKey: KEY_A }, result.complete);
  var xhr = h.transport.instances[0];
  var lateLoad = xhr.onload;
  var lateError = xhr.onerror;
  handle.abort();
  handle.abort();
  lateLoad();
  lateError();
  h.clock.advance(10000);
  assert.equal(xhr.aborts, 1);
  assert.deepEqual(result.values, []);
  handle = h.client.departures({ routing: ROUTING, apiKey: KEY_A }, result.complete);
  xhr = h.transport.instances[1];
  xhr.respond(200, departureFixture());
  handle.abort();
  h.clock.advance(0);
  assert.deepEqual(result.values, []);
});

test("watchdog timeout and pypkjs event-only network failure produce one safe error", function () {
  var h = harness();
  var result = collect();
  h.client.departures({ routing: ROUTING, apiKey: KEY_A }, result.complete);
  var xhr = h.transport.instances[0];
  var lateLoad = xhr.onload;
  h.clock.advance(contracts.LIMITS.httpTimeoutMs);
  lateLoad();
  assert.equal(xhr.aborts, 1);
  assert.deepEqual(result.values.length, 1);
  assertError(result.values[0], "SOURCE_UNAVAILABLE", DEPARTURE_MS + contracts.LIMITS.httpTimeoutMs);
  result = collect();
  h.client.departures({ routing: ROUTING, apiKey: KEY_A }, result.complete);
  h.transport.instances[1].networkError();
  h.clock.advance(0);
  assertError(result.values[0], "SOURCE_UNAVAILABLE", h.clock.now());
});

test("HTTP authentication and quota failures retain semantic codes and bounded Retry-After", function () {
  [[401, undefined, "API_KEY_INVALID", undefined], [403, undefined, "API_KEY_INVALID", undefined],
    [429, "17", "RATE_LIMITED", 17], [429, "0", "RATE_LIMITED", 0],
    [429, "86400", "RATE_LIMITED", 86400], [429, "86401", "RATE_LIMITED", undefined],
    [429, "Wed, 21 Oct 2026 07:28:00 GMT", "RATE_LIMITED", undefined],
    [429, "5\n", "RATE_LIMITED", undefined], [503, undefined, "SOURCE_UNAVAILABLE", undefined]
  ].forEach(function (entry) {
    var h = harness(TRAFFIC_MS);
    var result = collect();
    requestTraffic(h, "IDFM:C100", result);
    h.transport.instances[0].respond(entry[0], { private: KEY_A }, { "Retry-After": entry[1] });
    h.clock.advance(0);
    assertError(result.values[0], entry[2], TRAFFIC_MS, entry[3]);
  });
});

test("missing routing and malformed keys never start transport and remain abortable", function () {
  var h = harness();
  var result = collect();
  h.client.departures({ routing: null, apiKey: KEY_A }, result.complete);
  h.clock.advance(0);
  assertError(result.values[0], "INVALID_SERVICE", DEPARTURE_MS);
  result = collect();
  var handle = h.client.departures({ routing: ROUTING, apiKey: "" }, result.complete);
  handle.abort();
  h.clock.advance(0);
  assert.deepEqual(result.values, []);
  h.client.departures({ routing: ROUTING, apiKey: "bad\nheader" }, result.complete);
  h.clock.advance(0);
  assertError(result.values[0], "API_KEY_INVALID", DEPARTURE_MS);
  assert.equal(h.transport.instances.length, 0);
});

test("routing is copied at dispatch and credentials cannot be embedded in request URLs", function () {
  var h = harness();
  var result = collect();
  var refs = clone(ROUTING);
  h.client.departures({ routing: refs, apiKey: KEY_A }, result.complete);
  refs.destinationRef = "another-destination";
  h.transport.instances[0].respond(200, departureFixture());
  h.clock.advance(0);
  assert.equal(result.values[0].status, "AVAILABLE");
  refs = clone(ROUTING);
  refs.monitoringRef = "IDFM:" + encodeURIComponent(encodeURIComponent(KEY_A));
  result = collect();
  h.client.departures({ routing: refs, apiKey: KEY_A }, result.complete);
  h.clock.advance(0);
  assertError(result.values[0], "INVALID_SERVICE", DEPARTURE_MS);
  assert.equal(h.transport.instances.length, 1);
});

test("malformed UTF-8, missing byte responses and oversized bodies never enter normalized output", function () {
  var invalidBytes = [
    [255], [192, 175], [224, 128, 175], [237, 160, 128], [244, 144, 128, 128], [226, 130]
  ];
  invalidBytes.forEach(function (bytes) {
    var h = harness();
    var result = collect();
    var prefix = Buffer.from('{"ignored":"');
    var suffix = Buffer.from('",' + JSON.stringify(departureFixture()).slice(1));
    h.client.departures({ routing: ROUTING, apiKey: KEY_A }, result.complete);
    h.transport.instances[0].respondBytes(200, Buffer.concat([prefix, Buffer.from(bytes), suffix]));
    h.clock.advance(0);
    assertError(result.values[0], "INVALID_RESPONSE", DEPARTURE_MS);
  });
  var h = harness();
  var result = collect();
  h.client.departures({ routing: ROUTING, apiKey: KEY_A }, result.complete);
  var oversizedJson = Buffer.from(JSON.stringify(departureFixture()));
  h.transport.instances[0].respondBytes(200, Buffer.concat([oversizedJson,
    Buffer.alloc(contracts.LIMITS.httpResponseBytes + 1 - oversizedJson.length, 32)]));
  h.clock.advance(0);
  assertError(result.values[0], "INVALID_RESPONSE", DEPARTURE_MS);
  result = collect();
  h.client.departures({ routing: ROUTING, apiKey: KEY_A }, result.complete);
  var xhr = h.transport.instances[1];
  xhr.status = 200;
  xhr.responseText = JSON.stringify(departureFixture());
  xhr.onload();
  h.clock.advance(0);
  assertError(result.values[0], "INVALID_RESPONSE", DEPARTURE_MS);
});

test("a BOM and a byte-exact maximum response remain valid", function () {
  var h = harness();
  var result = collect();
  var json = Buffer.from(JSON.stringify(departureFixture()));
  var bytes = Buffer.concat([Buffer.from([239, 187, 191]), json,
    Buffer.alloc(contracts.LIMITS.httpResponseBytes - json.length - 3, 32)]);
  h.client.departures({ routing: ROUTING, apiKey: KEY_A }, result.complete);
  h.transport.instances[0].respondBytes(200, bytes);
  h.clock.advance(0);
  assert.equal(result.values[0].status, "AVAILABLE");
});

test("only traffic accepts a valid two MiB body and rejects one byte beyond its own cap", function () {
  var h = harness(TRAFFIC_MS);
  var result = collect();
  var maximum = 2097152;
  var json = Buffer.from(JSON.stringify(trafficFixture()));
  var bytes = Buffer.concat([json, Buffer.alloc(maximum - json.length, 32)]);
  requestTraffic(h, "IDFM:C200", result);
  h.transport.instances[0].respondBytes(200, bytes);
  h.clock.advance(0);
  assert.deepEqual(result.values[0], { status: "AVAILABLE", data: {
    schemaVersion: 1, state: "DELAYED", checkedAt: TRAFFIC_MS / 1000,
    title: "Métro 2 : ralentissements", text: "Le trafic est ralenti & les temps d’attente sont allongés."
  } });
  h = harness(TRAFFIC_MS);
  result = collect();
  requestTraffic(h, "IDFM:C200", result);
  h.transport.instances[0].respondBytes(200, Buffer.concat([bytes, Buffer.from(" ")]));
  h.clock.advance(0);
  assertError(result.values[0], "INVALID_RESPONSE", TRAFFIC_MS);
});

test("traffic calls coalesce across lines but not languages or credentials", function () {
  var h = harness(TRAFFIC_MS);
  var normal = collect();
  var delayed = collect();
  var english = collect();
  var anotherKey = collect();
  requestTraffic(h, "IDFM:C100", normal);
  requestTraffic(h, "IDFM:C200", delayed);
  requestTraffic(h, "IDFM:C100", english, KEY_A, "en");
  requestTraffic(h, "IDFM:C100", anotherKey, KEY_B);
  assert.equal(h.transport.instances.length, 3);
  assert.equal(h.transport.instances[0].url, "https://prim.iledefrance-mobilites.fr/marketplace/disruptions_bulk/disruptions/v2");
  assert.equal(h.transport.instances[0].headers["Accept-Language"], "fr");
  assert.equal(h.transport.instances[1].headers["Accept-Language"], "en");
  assert.equal(h.transport.instances[2].headers.apikey, KEY_B);
  h.transport.instances[0].respond(200, trafficFixture());
  h.transport.instances[1].respond(200, trafficFixture());
  h.transport.instances[2].respond(401, {});
  h.clock.advance(0);
  assert.equal(normal.values[0].data.state, "NORMAL");
  assert.equal(delayed.values[0].data.state, "DELAYED");
  assert.equal(english.values[0].data.state, "NORMAL");
  assertError(anotherKey.values[0], "API_KEY_INVALID", TRAFFIC_MS);
  assert.equal(h.transport.instances.length, 3);
});

test("coalesced cancellation preserves the remaining subscriber and cancels the final one", function () {
  var h = harness(TRAFFIC_MS);
  var normal = collect();
  var delayed = collect();
  var first = requestTraffic(h, "IDFM:C100", normal);
  requestTraffic(h, "IDFM:C200", delayed);
  first.abort();
  assert.equal(h.transport.instances[0].aborts, undefined);
  h.transport.instances[0].respond(200, trafficFixture());
  h.clock.advance(0);
  assert.deepEqual(normal.values, []);
  assert.equal(delayed.values[0].data.state, "DELAYED");
  h.clock.advance(60000);
  var last = requestTraffic(h, "IDFM:C100", normal);
  last.abort();
  assert.equal(h.transport.instances[1].aborts, 1);
  h.clock.advance(10000);
  assert.deepEqual(normal.values, []);
});

test("traffic cache reevaluates periods, retains checkedAt, expires at exactly 60 seconds and rejects clock rollback", function () {
  var h = harness(TRAFFIC_MS);
  var result = collect();
  var payload = trafficFixture();
  payload.disruptions[0].applicationPeriods = [{ begin: "20260115T100000", end: "20260115T100030" }];
  requestTraffic(h, "IDFM:C200", result);
  h.transport.instances[0].respond(200, payload);
  h.clock.advance(0);
  assert.equal(result.values[0].data.state, "DELAYED");
  result.values[0].data.title = "consumer change";
  h.clock.advance(59999);
  requestTraffic(h, "IDFM:C200", result);
  h.clock.advance(0);
  assert.deepEqual(result.values[1], { status: "AVAILABLE", data: { schemaVersion: 1, state: "NORMAL", checkedAt: TRAFFIC_MS / 1000 } });
  assert.equal(h.transport.instances.length, 1);
  h.clock.advance(1);
  var expired = requestTraffic(h, "IDFM:C200", result);
  assert.equal(h.transport.instances.length, 2);
  expired.abort();
  h.clock.time = TRAFFIC_MS - 1;
  var rolledBack = requestTraffic(h, "IDFM:C200", result);
  assert.equal(h.transport.instances.length, 3);
  rolledBack.abort();
});

test("credential changes never reuse another key's traffic cache and callbacks cannot mutate cached text", function () {
  var h = harness(TRAFFIC_MS);
  var result = collect();
  requestTraffic(h, "IDFM:C200", result);
  h.transport.instances[0].respond(200, trafficFixture());
  h.clock.advance(0);
  result.values[0].data.title = "changed";
  requestTraffic(h, "IDFM:C200", result);
  h.clock.advance(0);
  assert.equal(result.values[1].data.title, "Métro 2 : ralentissements");
  requestTraffic(h, "IDFM:C200", result, KEY_B);
  assert.equal(h.transport.instances.length, 2);
  h.transport.instances[1].respond(429, {}, { "Retry-After": "5" });
  h.clock.advance(0);
  assertError(result.values[2], "RATE_LIMITED", TRAFFIC_MS, 5);
});

test("transport errors and malformed traffic are unavailable, not successful UNKNOWN, and are not cached", function () {
  var h = harness(TRAFFIC_MS);
  var result = collect();
  requestTraffic(h, "IDFM:C100", result);
  h.transport.instances[0].respond(200, { lines: [] });
  h.clock.advance(0);
  assertError(result.values[0], "INVALID_RESPONSE", TRAFFIC_MS);
  requestTraffic(h, "IDFM:C100", result);
  assert.equal(h.transport.instances.length, 2);
  h.transport.instances[1].respond(503, {});
  h.clock.advance(0);
  assertError(result.values[1], "SOURCE_UNAVAILABLE", TRAFFIC_MS);
  requestTraffic(h, "IDFM:C300", result);
  h.transport.instances[2].respond(200, trafficFixture());
  h.clock.advance(0);
  assert.deepEqual(result.values[2], { status: "AVAILABLE", data: { schemaVersion: 1, state: "UNKNOWN", checkedAt: TRAFFIC_MS / 1000 } });
});

test("eight shared transport slots bound departures and traffic without starting cancelled queued work", function () {
  var h = harness();
  var result = collect();
  var handles = [];
  var index;
  for (index = 0; index < 8; index += 1) handles.push(h.client.departures({ routing: ROUTING, apiKey: KEY_A }, result.complete));
  var cancelled = requestTraffic(h, "IDFM:C100", result);
  var queued = h.client.departures({ routing: ROUTING, apiKey: KEY_A }, result.complete);
  assert.equal(h.transport.instances.length, 8);
  cancelled.abort();
  handles[0].abort();
  assert.equal(h.transport.instances.length, 8);
  h.clock.advance(0);
  assert.equal(h.transport.instances.length, 9);
  assert.match(h.transport.instances[8].url, /stop-monitoring/);
  handles.slice(1).forEach(function (handle) { handle.abort(); });
  queued.abort();
  h.clock.advance(10000);
  assert.deepEqual(result.values, []);
});

test("aborting a lifecycle batch never starts its queued bulk request", function () {
  var h = harness(TRAFFIC_MS);
  var result = collect();
  var handles = [];
  var index;
  for (index = 0; index < 8; index += 1) {
    handles.push(h.client.departures({ routing: ROUTING, apiKey: KEY_A }, result.complete));
  }
  handles.push(requestTraffic(h, "IDFM:C100", result));
  assert.equal(h.transport.instances.length, 8);
  handles.forEach(function (handle) { handle.abort(); });
  assert.equal(h.transport.instances.length, 8);
  h.clock.advance(10000);
  assert.equal(h.transport.instances.length, 8);
  assert.deepEqual(result.values, []);
  h.transport.instances.forEach(function (xhr) { assert.equal(xhr.aborts, 1); });
  var resumed = requestTraffic(h, "IDFM:C100", result, KEY_B);
  assert.equal(h.transport.instances.length, 9);
  assert.equal(h.transport.instances[8].headers.apikey, KEY_B);
  resumed.abort();
});

test("no request retries or polling occur after success or failure", function () {
  var h = harness(TRAFFIC_MS);
  var result = collect();
  requestTraffic(h, "IDFM:C100", result);
  h.transport.instances[0].respond(429, {}, { "Retry-After": "1" });
  h.clock.advance(600000);
  assert.equal(h.transport.instances.length, 1);
  assert.equal(result.values.length, 1);
  requestTraffic(h, "IDFM:C100", result);
  h.transport.instances[1].respond(200, trafficFixture());
  h.clock.advance(600000);
  assert.equal(h.transport.instances.length, 2);
  assert.equal(result.values.length, 2);
});
