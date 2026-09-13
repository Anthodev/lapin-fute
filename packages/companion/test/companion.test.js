"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var vm = require("node:vm");
var companion = require("../src");
var fixture = require("../../../fixtures/departures/foundation.json");
var fakes = require("./fakes");
var contracts = companion.contracts;
var configuration = companion.configuration;
var T = contracts.MESSAGE_TYPE;
var TEST_KEY = "test-personal-prim-key";
var REVISION = "a".repeat(64);
var EPOCH = "000000000000001";

function phoneFavorite(number, line) {
  return Object.assign({}, fixture.favorite, {
    id: "favorite-" + number, serviceId: "svc_" + String(number).repeat(43), sortOrder: number - 1,
    routing: { monitoringRef: "IDFM:SP:" + number, lineRef: "IDFM:C" + (line || number), destinationRef: "IDFM:DST" + number }
  });
}
var FIRST = phoneFavorite(1);
var SECOND = phoneFavorite(2);
var THIRD = phoneFavorite(3);

function configuredStorage(favorites, status) {
  var storage = new fakes.FakeStorage();
  assert.equal(configuration.saveConfiguration(storage, {
    schemaVersion: 1, favorites: favorites || [FIRST], primApiKey: TEST_KEY,
    keyStatus: typeof status === "number" ? status : contracts.KEY_STATUS.CONFIGURED
  }), true);
  storage.writes.length = 0;
  return storage;
}

function harness(options) {
  options = options || {};
  var target = {
    Pebble: options.Pebble || new fakes.FakePebble(true), storage: options.storage || configuredStorage(),
    clock: options.clock || new fakes.FakeClock(), xhr: fakes.createXHRFactory(),
    defer: options.defer || fakes.createDefer(true), profile: options.profile || 0,
    sequence: 0, ids: Object.create(null), binding: null
  };
  target.companion = companion.createCompanion({
    Pebble: target.Pebble, storage: target.storage, XHR: target.xhr.XHR,
    clock: target.clock, defer: target.defer,
    configurationUrl: typeof options.configurationUrl === "string" ? options.configurationUrl : "https://config.example.test/index.html"
  });
  return target;
}

function messages(target, type) {
  return target.Pebble.sent.filter(function (message) { return message.MESSAGE_TYPE === type; });
}
function emit(target, message) { target.Pebble.emit("appmessage", { payload: message }); }
function drain(target) {
  var turns = 0;
  while (target.Pebble.pending.length || target.defer.pending.length) {
    assert.ok(turns++ < 1000, "AppMessage work must terminate without retries");
    if (target.Pebble.pending.length) target.Pebble.ack(); else target.defer.runNext();
  }
}
function acknowledgeConfiguration(target, mask) {
  drain(target);
  var begin = messages(target, T.CONFIG_BEGIN).at(-1);
  assert.ok(begin, "HELLO must precede configuration inventory");
  target.binding = begin;
  emit(target, {
    SCHEMA_VERSION: 2, MESSAGE_TYPE: T.CONFIG_NEED, REQUEST_ID: begin.REQUEST_ID,
    DISPLAY_GENERATION: begin.DISPLAY_GENERATION, DISPLAY_PROFILE: target.profile, CLOCK_12H: 0,
    CONFIG_NEED_MASK: typeof mask === "number" ? mask : (1 << begin.ITEM_COUNT) - 1
  });
  drain(target);
}
function ready(target, mask) {
  target.Pebble.emit("ready");
  drain(target);
  emit(target, { SCHEMA_VERSION: 2, MESSAGE_TYPE: T.DISPLAY_HELLO,
    REQUEST_ID: "w" + EPOCH, WATCH_SESSION_ID: "w" + EPOCH, DISPLAY_EPOCH: EPOCH,
    DISPLAY_PROFILE: target.profile, CLOCK_12H: 0 });
  acknowledgeConfiguration(target, mask);
}
function sendRequest(target, label, type, favorite, trigger) {
  var id = EPOCH + "r" + (++target.sequence).toString(16).padStart(8, "0");
  var message = { SCHEMA_VERSION: 2, MESSAGE_TYPE: type, REQUEST_ID: id,
    DISPLAY_GENERATION: target.binding.DISPLAY_GENERATION };
  target.ids[label] = id;
  if (favorite) message.FAVORITE_ID = favorite.id;
  if (trigger !== undefined) message.REQUEST_TRIGGER = trigger;
  emit(target, message);
  return id;
}
function sendOverview(target, label, trigger) {
  return sendRequest(target, label, T.OVERVIEW_REQUEST, null,
    typeof trigger === "number" ? trigger : contracts.REQUEST_TRIGGER.APP_OPEN);
}
function sendDetail(target, label, favorite, trigger) {
  return sendRequest(target, label, T.REQUEST, favorite || FIRST,
    typeof trigger === "number" ? trigger : contracts.REQUEST_TRIGGER.FAVORITE_SELECTION);
}
function sendTraffic(target, label, favorite) { return sendRequest(target, label, T.TRAFFIC_REQUEST, favorite || FIRST); }

// Observe complete consumer-visible D2 transfers, including multiple snapshots
// on one token. Incomplete transfers are deliberately not considered results.
function transfers(target, label) {
  var completed = [], active = null;
  target.Pebble.sent.forEach(function (message) {
    if (message.REQUEST_ID !== target.ids[label]) return;
    if (message.MESSAGE_TYPE === T.DISPLAY_BEGIN) {
      assert.equal(active, null, "transfers cannot overlap");
      active = { kind: message.DISPLAY_KIND, generation: message.DISPLAY_GENERATION,
        favoriteId: message.FAVORITE_ID, count: message.ITEM_COUNT, records: [] };
    } else if (message.MESSAGE_TYPE === T.DISPLAY_RECORD) {
      assert.ok(active);
      assert.equal(message.ITEM_INDEX, active.records.length);
      active.records.push(message.DISPLAY_RECORD);
    } else if (message.MESSAGE_TYPE === T.DISPLAY_COMMIT) {
      assert.ok(active);
      assert.equal(active.records.length, active.count);
      completed.push(active);
      active = null;
    }
  });
  return completed;
}
function finalTransfer(target, label) {
  var transfer = transfers(target, label).at(-1);
  assert.ok(transfer, "Expected completed token " + label);
  return transfer;
}
function row(record) {
  var value = function (offset, width) { return parseInt(record.slice(offset, offset + width), 16); };
  var departures = [];
  for (var index = 0; index < value(22, 1); index += 1) {
    departures.push({ expectedAt: value(23 + index * 9, 8), status: value(31 + index * 9, 1) });
  }
  return { hasData: !!(value(0, 2) & 1), stale: !!(value(0, 2) & 2), fetchedAt: value(2, 8),
    caption: value(10, 1), error: value(11, 2), traffic: value(13, 1), checkedAt: value(14, 8), departures: departures };
}
function rows(target, label) { return finalTransfer(target, label).records.map(row); }

function snapshot(favorite, clock, offset) {
  var result = contracts.copyDepartureResult(fixture.result, "seed");
  result.fetchedAt = Math.floor((clock.now() + (offset || 0)) / 1000);
  result.sourceUpdatedAt = result.fetchedAt;
  delete result.schemaVersion; delete result.requestId; delete result.favoriteId;
  return result;
}
function seedOverview(storage, favorites, clock, offsets) {
  var result = { schemaVersion: 1, requestId: "seed", items: favorites.map(function (favorite, index) {
    return { favoriteId: favorite.id, departures: { status: "AVAILABLE", data: snapshot(favorite, clock, offsets && offsets[index]) },
      traffic: { state: "NORMAL", checkedAt: Math.floor(clock.now() / 1000) } };
  }) };
  var cache = configuration.mergeOverview(configuration.emptyCache(), favorites, result, Math.floor(clock.now()));
  assert.notEqual(cache, null);
  assert.equal(configuration.saveCache(storage, cache, TEST_KEY), true);
  storage.writes.length = 0;
  return cache;
}
function siri(favorite, clock) {
  var visit = { RecordedAtTime: new Date(clock.now() - 1000).toISOString(), MonitoringRef: { value: favorite.routing.monitoringRef },
    MonitoredVehicleJourney: {
      LineRef: { value: favorite.routing.lineRef }, DirectionRef: { value: "Retour" }, DestinationRef: { value: favorite.routing.destinationRef },
      MonitoredCall: { ExpectedDepartureTime: new Date(clock.now() + 120000).toISOString(),
        AimedDepartureTime: new Date(clock.now() + 60000).toISOString(), DepartureStatus: "delayed" }
    } };
  return { Siri: { ServiceDelivery: { ResponseTimestamp: new Date(clock.now()).toISOString(),
    StopMonitoringDelivery: [{ MonitoredStopVisit: [visit] }] } } };
}
function trafficBody(favorites) {
  var seen = Object.create(null);
  return { disruptions: [], lines: favorites.filter(function (favorite) {
    if (seen[favorite.routing.lineRef]) return false;
    seen[favorite.routing.lineRef] = true;
    return true;
  }).map(function (favorite) { return { id: "line:" + favorite.routing.lineRef, impactedObjects: [] }; }) };
}
function requests(target, kind) {
  return target.xhr.instances.filter(function (xhr) {
    return kind === "departures" ? xhr.url.includes("stop-monitoring")
      : kind === "traffic" ? xhr.url.includes("disruptions_bulk") : xhr.url.includes("config.example.test/");
  });
}
function respond(target, xhr, status, body) { xhr.respond(status, body); target.clock.advance(0); }
function resolveProduction(target, favorites) {
  target.xhr.instances.filter(function (xhr) {
    return !xhr.aborted && xhr.status === 0 && xhr.url.includes("prim.iledefrance-mobilites.fr/");
  }).forEach(function (xhr) {
    if (xhr.url.includes("stop-monitoring")) {
      var favorite = favorites.filter(function (candidate) { return xhr.url.includes(encodeURIComponent(candidate.routing.monitoringRef)); })[0];
      assert.ok(favorite);
      respond(target, xhr, 200, siri(favorite, target.clock));
    } else respond(target, xhr, 200, trafficBody(favorites));
  });
}
function closeWith(target, action, favorites, value, forceFull) {
  var update = { schemaVersion: 1, favorites: favorites, apiKeyUpdate: { schemaVersion: 1, action: action } };
  if (action === "REPLACE") update.apiKeyUpdate.value = value;
  if (forceFull) update.forceFullSync = true;
  target.Pebble.emit("webviewclosed", { response: "pebblejs://close#" + encodeURIComponent(JSON.stringify(update)) });
}

test("Core Android decoded close responses preserve favorites with line colors", function () {
  var target = harness({ storage: configuredStorage([]) });
  var update = {
    schemaVersion: 1,
    favorites: [Object.assign({}, FIRST, { sortOrder: 0 })],
    apiKeyUpdate: { schemaVersion: 1, action: "KEEP" }
  };

  target.Pebble.emit("webviewclosed", { response: JSON.stringify(update) });

  assert.deepEqual(configuration.loadConfiguration(target.storage).favorites, update.favorites);
  target.companion.stop();
});

function serviceRow(favorite) {
  return { serviceId: favorite.serviceId, stopLabel: favorite.stopLabel, lineLabel: favorite.lineLabel,
    destinationLabel: favorite.destinationLabel, lineMode: favorite.lineMode,
    lineColor: favorite.lineColor, lineTextColor: favorite.lineTextColor, routing: favorite.routing };
}
function resolveRouting(target, favorite) {
  respond(target, requests(target, "static").at(-1), 200, {
    schemaVersion: 1, revision: REVISION, sourceRevision: "source", createdAt: "2026-09-05T00:00:00Z", attribution: []
  });
  assert.equal(requests(target, "static").at(-1).url,
    "https://config.example.test/catalog/" + REVISION + "/services/" + favorite.serviceId + ".json");
  respond(target, requests(target, "static").at(-1), 200, { schemaVersion: 1, revision: REVISION, service: serviceRow(favorite) });
}

test("ready coalesces and an early APP_OPEN waits for the sent COMMIT's transport completion", function () {
  var target = harness({ Pebble: new fakes.FakePebble(false), defer: fakes.createDefer(false) });
  target.Pebble.emit("ready"); target.Pebble.emit("ready"); drain(target);
  assert.equal(messages(target, T.DISPLAY_READY).length, 1);
  assert.equal(messages(target, T.CONFIG_BEGIN).length, 0);
  emit(target, { SCHEMA_VERSION: 2, MESSAGE_TYPE: T.DISPLAY_HELLO, REQUEST_ID: "w" + EPOCH,
    WATCH_SESSION_ID: "w" + EPOCH, DISPLAY_EPOCH: EPOCH, DISPLAY_PROFILE: 0, CLOCK_12H: 0 });
  drain(target);
  var begin = messages(target, T.CONFIG_BEGIN)[0];
  target.binding = begin;
  assert.equal(messages(target, T.FAVORITE).length, 0);
  emit(target, { SCHEMA_VERSION: 2, MESSAGE_TYPE: T.CONFIG_NEED, REQUEST_ID: begin.REQUEST_ID,
    DISPLAY_GENERATION: begin.DISPLAY_GENERATION, CONFIG_NEED_MASK: 1, DISPLAY_PROFILE: 0, CLOCK_12H: 0 });
  target.Pebble.ack(); target.defer.runNext();
  assert.equal(target.Pebble.sent.at(-1).MESSAGE_TYPE, T.CONFIG_COMMIT);
  sendOverview(target, "early-open");
  assert.equal(target.xhr.instances.length, 0);
  drain(target);
  assert.equal(requests(target, "departures").length, 1);
  assert.equal(requests(target, "traffic").length, 1);
  resolveProduction(target, [FIRST]); drain(target);
  assert.equal(rows(target, "early-open")[0].error, 0);
  target.companion.stop();
});

test("SDK readiness bypasses D2 normalization and a queued echo survives a failed application send", function () {
  var target = harness({ Pebble: new fakes.FakePebble(false), defer: fakes.createDefer(false) });
  target.Pebble.emit("ready");
  emit(target, { "15025": 1 });
  target.Pebble.fail(); drain(target);
  assert.deepEqual(target.Pebble.sent.at(-1), { "15025": 1 });
  assert.equal(target.Pebble.sent.length, 2);
  target.companion.stop();
});

test("production PRIM GETs are once per service, traffic is coalesced, and D2 carries no routing or credential", function () {
  var favorites = [FIRST, Object.assign({}, FIRST, { id: "same-service", sortOrder: 1 }), phoneFavorite(3, 1)];
  var target = harness({ storage: configuredStorage(favorites) });
  ready(target); sendOverview(target, "phone-only");
  assert.equal(requests(target, "departures").length, 2);
  assert.equal(requests(target, "traffic").length, 1);
  target.xhr.instances.forEach(function (xhr) {
    assert.equal(xhr.method, "GET"); assert.equal(xhr.headers.apikey, TEST_KEY);
    assert.equal(xhr.headers.Authorization, undefined); assert.equal(xhr.body, null); assert.equal(xhr.responseType, "arraybuffer");
  });
  resolveProduction(target, favorites);
  assert.equal(rows(target, "phone-only").length, 3);
  assert.deepEqual(rows(target, "phone-only").map(function (item) { return item.departures[0].status; }), [1, 1, 1]);
  assert.equal(JSON.stringify(target.Pebble.sent).includes(TEST_KEY), false);
  assert.equal(JSON.stringify(target.Pebble.sent).includes("IDFM:SP:"), false);
  target.Pebble.sent.forEach(function (message) { assert.equal(contracts.isAppMessage(message), true); });
  assert.equal(configuration.loadCache(target.storage, favorites).overview.length, 3);
  target.companion.stop();
});

test("ordinary warm refresh preserves the old snapshot until the complete fresh aggregate is ready", function () {
  var storage = configuredStorage(), clock = new fakes.FakeClock();
  var old = seedOverview(storage, [FIRST], clock), target = harness({ storage: storage, clock: clock });
  ready(target); clock.advance(60000); sendOverview(target, "warm", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(transfers(target, "warm").length, 1);
  assert.equal(rows(target, "warm")[0].fetchedAt, old.overview[0].result.fetchedAt);
  assert.equal(rows(target, "warm")[0].stale, true);
  respond(target, requests(target, "departures")[0], 200, siri(FIRST, clock));
  assert.equal(configuration.loadCache(storage, [FIRST]).overview[0].result.fetchedAt, old.overview[0].result.fetchedAt);
  assert.equal(transfers(target, "warm").length, 1);
  respond(target, requests(target, "traffic")[0], 200, trafficBody([FIRST]));
  assert.equal(transfers(target, "warm").length, 2);
  assert.equal(rows(target, "warm")[0].fetchedAt, Math.floor(clock.now() / 1000));
  assert.equal(rows(target, "warm")[0].error, 0);
  target.companion.stop();
});

test("every refresh trigger observes the strict sixty-second departure gate despite old UNKNOWN traffic", function () {
  var storage = configuredStorage(), clock = new fakes.FakeClock();
  var cache = seedOverview(storage, [FIRST], clock);
  cache.overview[0].traffic = { state: "UNKNOWN", checkedAt: Math.floor(clock.now() / 1000) - 60 };
  assert.equal(configuration.saveCache(storage, cache, TEST_KEY), true);
  var target = harness({ storage: storage, clock: clock });
  ready(target); sendOverview(target, "fresh-open"); clock.advance(59999);
  sendOverview(target, "fresh-all", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  sendDetail(target, "fresh-manual", FIRST, contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  sendDetail(target, "fresh-selection", FIRST);
  assert.equal(target.xhr.instances.length, 0);
  ["fresh-open", "fresh-all", "fresh-manual", "fresh-selection"].forEach(function (id) { assert.equal(rows(target, id)[0].error, 0); });
  clock.advance(1); sendDetail(target, "boundary", FIRST, contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(requests(target, "departures").length, 1);
  resolveProduction(target, [FIRST]);
  assert.equal(rows(target, "boundary")[0].fetchedAt, Math.floor(clock.now() / 1000));
  target.companion.stop();
});

test("refresh-all skips fresh services, preserves failed snapshot age, and fills missing rows", function () {
  var favorites = [FIRST, SECOND, THIRD], storage = configuredStorage(favorites), clock = new fakes.FakeClock();
  var old = seedOverview(storage, favorites.slice(0, 2), clock, [0, -60000]);
  var target = harness({ storage: storage, clock: clock });
  ready(target); sendOverview(target, "subset", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(requests(target, "departures").length, 2);
  assert.equal(requests(target, "departures").some(function (xhr) { return xhr.url.includes(encodeURIComponent(FIRST.routing.monitoringRef)); }), false);
  respond(target, requests(target, "departures")[0], 503, ""); resolveProduction(target, favorites);
  var record = configuration.loadCache(storage, favorites);
  assert.deepEqual(record.overview[0], old.overview[0]);
  assert.equal(record.overview[1].result.fetchedAt, old.overview[1].result.fetchedAt);
  assert.equal(record.overview[1].resultStoredAt, old.overview[1].resultStoredAt);
  assert.equal(record.overview[1].refreshError.code, "SOURCE_UNAVAILABLE");
  assert.equal(record.overview[2].result.fetchedAt, Math.floor(clock.now() / 1000));
  assert.deepEqual(rows(target, "subset").map(function (item) { return item.error; }), [0, 7, 0]);
  assert.equal(rows(target, "subset")[1].hasData, true);
  assert.equal(rows(target, "subset")[1].stale, true);
  target.companion.stop();
});

test("overview and detail CACHE_ONLY finish misses and stale hits without PRIM or a refreshing echo", function () {
  var target = harness(); ready(target);
  sendOverview(target, "missing-overview", contracts.REQUEST_TRIGGER.CACHE_ONLY);
  sendDetail(target, "missing-entry", FIRST, contracts.REQUEST_TRIGGER.CACHE_ONLY);
  assert.equal(target.xhr.instances.length, 0);
  assert.equal(rows(target, "missing-overview")[0].error, 6);
  assert.equal(rows(target, "missing-entry")[0].error, 6);
  sendDetail(target, "settled-selection", FIRST); resolveProduction(target, [FIRST]); target.clock.advance(60000);
  sendOverview(target, "stale-overview", contracts.REQUEST_TRIGGER.CACHE_ONLY);
  sendDetail(target, "stale-entry", FIRST, contracts.REQUEST_TRIGGER.CACHE_ONLY);
  assert.equal(target.xhr.instances.length, 2);
  assert.equal(transfers(target, "stale-overview").length, 1);
  assert.equal(transfers(target, "stale-entry").length, 1);
  assert.equal(rows(target, "stale-entry")[0].stale, true);
  sendDetail(target, "explicit-refresh", FIRST, contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(requests(target, "departures").length, 2);
  target.companion.stop();
});

test("complete cached results are stale only before the fifteen-minute useful boundary", function () {
  var boundary = contracts.USEFUL_STALE_SECONDS * 1000;
  [
    { age: boundary - 1, hasData: true, error: 0 },
    { age: boundary, hasData: false, error: 6 },
    { age: boundary + 1, hasData: false, error: 6 }
  ].forEach(function (expected) {
    var clock = new fakes.FakeClock();
    var storage = configuredStorage();
    seedOverview(storage, [FIRST], clock);
    clock.advance(expected.age);
    var target = harness({ storage: storage, clock: clock });
    ready(target);
    sendDetail(target, "cached", FIRST, contracts.REQUEST_TRIGGER.CACHE_ONLY);
    drain(target);
    var cached = rows(target, "cached")[0];
    assert.equal(cached.hasData, expected.hasData);
    assert.equal(cached.stale, true);
    assert.equal(cached.error, expected.error);
    assert.equal(requests(target, "departures").length, 0);
    assert.equal(requests(target, "traffic").length, 0);
  });
});

test("429 is terminal for one event, preserves useful stale data, and increments only a safe counter", function () {
  var clock = new fakes.FakeClock();
  var storage = configuredStorage();
  seedOverview(storage, [FIRST], clock);
  clock.advance(contracts.CACHE_FRESH_SECONDS * 1000);
  var target = harness({ storage: storage, clock: clock });
  ready(target);
  sendDetail(target, "quota", FIRST, contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  var departure = requests(target, "departures")[0];
  departure.respond(429, "", { "Retry-After": "17" });
  target.clock.advance(0);
  resolveProduction(target, [FIRST]);
  drain(target);
  var quota = rows(target, "quota").at(-1);
  assert.equal(quota.hasData, true);
  assert.equal(quota.stale, true);
  assert.equal(quota.error, 5);
  assert.equal(target.companion.metrics().rateLimitedResponses, 1);
  assert.doesNotMatch(JSON.stringify(target.companion.metrics()), /test-personal|favorite|IDFM|apikey|Authorization/);
  target.clock.advance(contracts.LIMITS.httpTimeoutMs * 2);
  assert.equal(requests(target, "departures").length, 1);
  assert.equal(requests(target, "traffic").length, 1);
});

test("the failure table deterministically projects unconfigured, stale, or unavailable", function () {
  [
    { name: "missing key", keyStatus: contracts.KEY_STATUS.MISSING, error: 1, state: "UNCONFIGURED" },
    { name: "invalid key", keyStatus: contracts.KEY_STATUS.INVALID, error: 3, state: "UNCONFIGURED" },
    { name: "revoked key", status: 401, error: 3, state: "UNCONFIGURED" },
    { name: "disconnect", status: 0, error: 7, state: "STALE" },
    { name: "source failure", status: 503, error: 7, state: "STALE" },
    { name: "rate limit", status: 429, error: 5, state: "STALE" },
    { name: "malformed response", status: 200, body: {}, error: 7, state: "STALE" },
    { name: "partial response", status: 200, body: { Siri: {} }, error: 7, state: "STALE" },
    { name: "timeout without cache", timeout: true, noCache: true, error: 7, state: "UNAVAILABLE" }
  ].forEach(function (failure) {
    var clock = new fakes.FakeClock();
    var storage;
    if (failure.keyStatus === contracts.KEY_STATUS.MISSING) {
      storage = new fakes.FakeStorage();
      assert.equal(configuration.saveConfiguration(storage, {
        schemaVersion: 1, favorites: [FIRST], primApiKey: null, keyStatus: contracts.KEY_STATUS.MISSING
      }), true);
    } else storage = configuredStorage([FIRST], failure.keyStatus);
    if (!failure.noCache) seedOverview(storage, [FIRST], clock);
    clock.advance(contracts.CACHE_FRESH_SECONDS * 1000);
    var target = harness({ storage: storage, clock: clock });
    ready(target);
    sendDetail(target, failure.name, FIRST, contracts.REQUEST_TRIGGER.MANUAL_SELECT);
    if (typeof failure.status === "number" || failure.timeout) {
      respond(target, requests(target, "traffic")[0], 200, trafficBody([FIRST]));
      if (failure.timeout) target.clock.advance(contracts.LIMITS.httpTimeoutMs);
      else respond(target, requests(target, "departures")[0], failure.status,
        typeof failure.body === "undefined" ? "" : failure.body);
    }
    drain(target);
    var record = rows(target, failure.name).at(-1);
    var state = record.error === 1 || record.error === 3
      ? "UNCONFIGURED" : record.hasData ? "STALE" : "UNAVAILABLE";
    assert.equal(record.error, failure.error, failure.name);
    assert.equal(state, failure.state, failure.name);
    target.companion.stop();
  });
});

test("an opening overview completes after cache-only detail entry and local Back", function () {
  var target = harness(); ready(target); sendOverview(target, "opening-overview");
  sendDetail(target, "empty-detail", FIRST, contracts.REQUEST_TRIGGER.CACHE_ONLY);
  assert.equal(rows(target, "empty-detail")[0].error, 6);
  resolveProduction(target, [FIRST]);
  assert.equal(rows(target, "opening-overview")[0].error, 0);
  assert.equal(target.xhr.instances.length, 2);
  target.companion.stop();
});

test("slow ACKs preserve every accepted token even when later data bytes are identical", function () {
  var target = harness({ Pebble: new fakes.FakePebble(false), defer: fakes.createDefer(false) });
  ready(target); sendOverview(target, "old-overview");
  sendDetail(target, "cache-miss", FIRST, contracts.REQUEST_TRIGGER.CACHE_ONLY);
  resolveProduction(target, [FIRST]);
  sendOverview(target, "latest-overview", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  sendDetail(target, "cached-detail", FIRST, contracts.REQUEST_TRIGGER.CACHE_ONLY);
  drain(target);
  ["old-overview", "cache-miss", "latest-overview", "cached-detail"].forEach(function (id) { assert.equal(transfers(target, id).length, 1); });
  assert.deepEqual(finalTransfer(target, "old-overview").records, finalTransfer(target, "latest-overview").records);
  assert.equal(target.Pebble.maxInFlight, 1); assert.equal(target.xhr.instances.length, 2);
  target.companion.stop();
});

test("bounded overflow retains latest demand per kind after four accepted slow requests", function () {
  var favorites = [FIRST, phoneFavorite(2, 1)];
  var target = harness({ storage: configuredStorage(favorites), Pebble: new fakes.FakePebble(false), defer: fakes.createDefer(false) });
  ready(target);
  for (var index = 0; index < 4; index += 1) sendDetail(target, "accepted-" + index, FIRST);
  for (index = 0; index < 100; index += 1) sendDetail(target, "overflow-" + index, favorites[1]);
  sendOverview(target, "latest-overview", contracts.REQUEST_TRIGGER.CACHE_ONLY);
  sendTraffic(target, "latest-traffic", favorites[1]);
  assert.equal(requests(target, "departures").length, 1);
  resolveProduction(target, favorites); drain(target);
  assert.equal(requests(target, "departures").length, 2, "latest settled favorite must not be stranded");
  resolveProduction(target, favorites); drain(target);
  for (index = 0; index < 4; index += 1) assert.equal(transfers(target, "accepted-" + index).length, 1);
  for (index = 0; index < 99; index += 1) assert.equal(transfers(target, "overflow-" + index).length, 0);
  assert.equal(rows(target, "overflow-99")[0].error, 0);
  assert.deepEqual(rows(target, "latest-overview").map(function (item) { return item.error; }), [0, 6]);
  assert.equal(finalTransfer(target, "latest-traffic").favoriteId, favorites[1].id);
  assert.equal(requests(target, "traffic").length, 1);
  assert.equal(target.Pebble.maxInFlight, 1);
  target.clock.advance(3600000);
  assert.equal(target.xhr.instances.length, 3);
  target.companion.stop();
});

test("warm refresh keeps loading feedback for usable and missing rows until terminal outcomes", function () {
  var favorites = [FIRST, SECOND], storage = configuredStorage(favorites), clock = new fakes.FakeClock();
  seedOverview(storage, [FIRST], clock, [-60000]);
  var target = harness({ storage: storage, clock: clock });
  ready(target); sendDetail(target, "refreshing-detail", FIRST);
  assert.equal(rows(target, "refreshing-detail")[0].error, 2);
  assert.equal(rows(target, "refreshing-detail")[0].hasData, true);
  sendOverview(target, "refreshing-overview", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.deepEqual(rows(target, "refreshing-overview").map(function (item) { return [item.hasData, item.error]; }), [[true, 2], [false, 2]]);
  resolveProduction(target, favorites);
  assert.equal(rows(target, "refreshing-detail")[0].error, 0);
  assert.equal(transfers(target, "refreshing-overview").length, 1);
  respond(target, requests(target, "departures")[1], 503, "");
  resolveProduction(target, favorites);
  assert.deepEqual(rows(target, "refreshing-overview").map(function (item) { return item.error; }), [0, 7]);
  target.companion.stop();
  storage = configuredStorage([FIRST], contracts.KEY_STATUS.INVALID);
  seedOverview(storage, [FIRST], clock, [-60000]);
  target = harness({ storage: storage, clock: clock }); ready(target);
  sendOverview(target, "invalid-key", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(rows(target, "invalid-key")[0].error, 3);
  assert.equal(target.xhr.instances.length, 0);
  target.companion.stop();
});

test("credential lifecycle cancellation prevents old network completion from reaching the watch", function () {
  var target = harness(); ready(target); sendOverview(target, "canceled-overview");
  var old = requests(target, "departures")[0], late = old.onload;
  closeWith(target, "REPLACE", [FIRST], "replacement-key"); acknowledgeConfiguration(target, 0);
  old.respond(200, siri(FIRST, target.clock)); late(); target.clock.advance(0);
  assert.equal(transfers(target, "canceled-overview").length, 0);
  assert.equal(requests(target, "traffic")[0].aborted, true);
  target.companion.stop();
});

test("joined overview fetches only uncovered services and completes both original tokens", function () {
  var favorites = [FIRST, SECOND], target = harness({ storage: configuredStorage(favorites) });
  ready(target); sendDetail(target, "first-detail", FIRST); sendOverview(target, "joined-overview");
  assert.equal(requests(target, "departures").length, 1);
  resolveProduction(target, favorites);
  assert.equal(requests(target, "departures").length, 2); assert.equal(requests(target, "traffic").length, 1);
  assert.equal(transfers(target, "joined-overview").length, 0);
  assert.equal(rows(target, "first-detail")[0].error, 0);
  resolveProduction(target, favorites);
  assert.deepEqual(rows(target, "joined-overview").map(function (item) { return item.error; }), [0, 0]);
  target.companion.stop();
});

test("superseded settled selections get terminal data without launching obsolete service fetches", function () {
  var favorites = [FIRST, SECOND, THIRD], target = harness({ storage: configuredStorage(favorites) });
  ready(target); sendDetail(target, "first", FIRST); sendDetail(target, "abandoned", SECOND); sendDetail(target, "current", THIRD);
  respond(target, requests(target, "departures")[0], 503, ""); resolveProduction(target, favorites);
  assert.equal(requests(target, "departures").length, 2);
  assert.ok(requests(target, "departures")[1].url.includes(encodeURIComponent(THIRD.routing.monitoringRef)));
  assert.equal(rows(target, "first")[0].error, 7);
  assert.equal(rows(target, "abandoned")[0].error, 6);
  resolveProduction(target, favorites);
  assert.equal(rows(target, "current")[0].error, 0);
  target.companion.stop();
});

test("traffic completion remains token-bound and its line cache is language-specific", function () {
  var favorites = [FIRST, phoneFavorite(2, 1)], storage = configuredStorage(favorites), clock = new fakes.FakeClock();
  seedOverview(storage, favorites, clock);
  var language = "en", target = harness({ storage: storage, clock: clock });
  target.Pebble.getActiveWatchInfo = function () { return { language: language }; };
  ready(target); sendTraffic(target, "old-traffic", FIRST); sendDetail(target, "back", FIRST, contracts.REQUEST_TRIGGER.CACHE_ONLY);
  resolveProduction(target, favorites);
  assert.equal(finalTransfer(target, "old-traffic").favoriteId, FIRST.id);
  assert.equal(finalTransfer(target, "back").kind, 1);
  sendTraffic(target, "same-line", favorites[1]);
  assert.equal(requests(target, "traffic").length, 1);
  assert.equal(finalTransfer(target, "same-line").favoriteId, favorites[1].id);
  language = "fr"; closeWith(target, "KEEP", favorites); acknowledgeConfiguration(target);
  sendTraffic(target, "translated", FIRST);
  assert.equal(requests(target, "traffic").length, 2);
  assert.equal(requests(target, "traffic")[1].headers["Accept-Language"], "fr");
  resolveProduction(target, favorites);
  assert.notDeepEqual(finalTransfer(target, "translated").records, finalTransfer(target, "old-traffic").records);
  target.companion.stop();
});

test("order-only settings preserve active fetches and cache, with zero favorite bodies", function () {
  var favorites = [FIRST, SECOND], storage = configuredStorage(favorites), clock = new fakes.FakeClock();
  seedOverview(storage, favorites, clock);
  var target = harness({ storage: storage, clock: clock }); ready(target); clock.advance(60000);
  sendDetail(target, "selected-id", FIRST);
  var bytes = storage.getItem(configuration.RESULTS_STORAGE_KEY), before = messages(target, T.FAVORITE).length;
  var oldGeneration = target.binding.DISPLAY_GENERATION;
  closeWith(target, "KEEP", [Object.assign({}, SECOND, { sortOrder: 0 }), Object.assign({}, FIRST, { sortOrder: 1 })]);
  assert.equal(target.xhr.instances.some(function (xhr) { return xhr.aborted; }), false);
  assert.equal(storage.getItem(configuration.RESULTS_STORAGE_KEY), bytes);
  acknowledgeConfiguration(target, 0);
  assert.equal(messages(target, T.FAVORITE).length, before);
  resolveProduction(target, favorites);
  assert.equal(finalTransfer(target, "selected-id").favoriteId, FIRST.id);
  assert.equal(finalTransfer(target, "selected-id").generation, oldGeneration);
  sendOverview(target, "reordered", contracts.REQUEST_TRIGGER.CACHE_ONLY);
  assert.equal(finalTransfer(target, "reordered").generation, target.binding.DISPLAY_GENERATION);
  assert.equal(rows(target, "reordered")[1].stale, false);
  assert.equal(rows(target, "reordered")[0].stale, true);
  target.companion.stop();
});

test("explicit FULL is one-shot, sends complete inventory, and is not persisted", function () {
  var target = harness(); ready(target);
  closeWith(target, "KEEP", [FIRST], undefined, true);
  var full = messages(target, T.CONFIG_BEGIN).at(-1);
  assert.equal(full.CONFIG_MODE, contracts.CONFIG_MODE.FULL);
  assert.equal(messages(target, T.CONFIG_ENTRY).filter(function (message) { return message.REQUEST_ID === full.REQUEST_ID; }).length, 1);
  acknowledgeConfiguration(target);
  assert.equal(Object.hasOwn(JSON.parse(target.storage.getItem(configuration.CONFIG_STORAGE_KEY)), "forceFullSync"), false);
  target.companion.stop(); target = harness({ storage: target.storage }); ready(target, 0);
  assert.equal(target.binding.CONFIG_MODE, contracts.CONFIG_MODE.DIFF);
  target.companion.stop();
});

test("unresolved routing uses a pinned public revision once per service without metadata resynchronization", function () {
  var unresolved = contracts.copyFavorite(FIRST), duplicate = Object.assign({}, unresolved, { id: "unresolved-copy", sortOrder: 1 });
  var storage = configuredStorage([unresolved, duplicate]), target = harness({ storage: storage });
  ready(target); var before = messages(target, T.CONFIG_BEGIN).length;
  sendOverview(target, "hydrate");
  assert.equal(requests(target, "static").length, 1); assert.equal(requests(target, "departures").length, 0);
  resolveRouting(target, FIRST);
  requests(target, "static").forEach(function (xhr) { assert.equal(xhr.headers.apikey, undefined); assert.equal(xhr.headers.Authorization, undefined); });
  assert.equal(requests(target, "departures").length, 1);
  assert.deepEqual(configuration.loadConfiguration(storage).favorites[1].routing, FIRST.routing);
  assert.equal(storage.writes.filter(function (write) { return write.key === configuration.CONFIG_STORAGE_KEY; }).length, 1);
  assert.equal(messages(target, T.CONFIG_BEGIN).length, before);
  resolveProduction(target, [FIRST]);
  assert.deepEqual(rows(target, "hydrate").map(function (item) { return item.error; }), [0, 0]);
  target.companion.stop();
});

test("obsolete routing preserves valid favorite/key data, rehydrates exactly, and never renders an old cache format", function () {
  var storage = configuredStorage(), clock = new fakes.FakeClock();
  var record = JSON.parse(storage.getItem(configuration.CONFIG_STORAGE_KEY));
  record.favorites[0].routing.directionId = "0"; storage.setItem(configuration.CONFIG_STORAGE_KEY, JSON.stringify(record));
  seedOverview(storage, [FIRST], clock);
  var cache = JSON.parse(storage.getItem(configuration.RESULTS_STORAGE_KEY)); cache.schemaVersion = 1;
  storage.setItem(configuration.RESULTS_STORAGE_KEY, JSON.stringify(cache));
  assert.equal(configuration.isConfigurationUpdate({ schemaVersion: 1, favorites: record.favorites, apiKeyUpdate: { schemaVersion: 1, action: "KEEP" } }), false);
  var target = harness({ storage: storage, clock: clock }); ready(target);
  assert.deepEqual(configuration.loadConfiguration(storage).favorites, [contracts.copyFavorite(FIRST)]);
  assert.equal(configuration.loadConfiguration(storage).primApiKey, TEST_KEY);
  sendDetail(target, "obsolete-cache", FIRST, contracts.REQUEST_TRIGGER.CACHE_ONLY);
  assert.equal(requests(target, "static").length, 0); assert.equal(rows(target, "obsolete-cache")[0].error, 6);
  sendOverview(target, "recover-routing"); resolveRouting(target, FIRST);
  assert.equal(requests(target, "departures").length, 1);
  assert.deepEqual(configuration.loadConfiguration(storage).favorites, [FIRST]);
  assert.deepEqual(configuration.loadCache(storage, [FIRST]), configuration.emptyCache());
  resolveProduction(target, [FIRST]);
  assert.equal(configuration.loadCache(storage, [FIRST]).overview[0].result.departures[0].minutes, 2);
  target.companion.stop();
});

test("routing recovery keeps invalid-key journal authority and rejects unrelated corruption", function () {
  var storage = configuredStorage(), record = configuration.loadConfiguration(storage), write = storage.setItem;
  record.keyStatus = contracts.KEY_STATUS.INVALID;
  storage.setItem = function (key, value) { if (key === configuration.CONFIG_STORAGE_KEY) throw new Error("interrupted"); write.call(this, key, value); };
  assert.equal(configuration.saveInvalidConfiguration(storage, record), true); storage.setItem = write;
  record = configuration.loadConfiguration(storage); record.keyStatus = contracts.KEY_STATUS.CONFIGURED; record.favorites[0].routing = { obsolete: true };
  storage.setItem(configuration.CONFIG_STORAGE_KEY, JSON.stringify(record));
  var recovered = configuration.loadConfiguration(storage);
  assert.equal(recovered.keyStatus, contracts.KEY_STATUS.INVALID); assert.equal(recovered.primApiKey, TEST_KEY);
  assert.deepEqual(recovered.favorites, [contracts.copyFavorite(FIRST)]);
  record.favorites[0].unexpected = true; storage.setItem(configuration.CONFIG_STORAGE_KEY, JSON.stringify(record));
  assert.equal(configuration.loadConfiguration(storage), null);
});

test("failed routing persistence retains durable bytes and usable hydrated session state", function () {
  var storage = configuredStorage([contracts.copyFavorite(FIRST)]), bytes = storage.getItem(configuration.CONFIG_STORAGE_KEY), write = storage.setItem;
  var target = harness({ storage: storage }); ready(target);
  storage.setItem = function (key, value) { if (key === configuration.CONFIG_STORAGE_KEY) throw new Error("storage full"); write.call(this, key, value); };
  sendOverview(target, "hydrated-memory"); resolveRouting(target, FIRST); resolveProduction(target, [FIRST]);
  assert.equal(storage.getItem(configuration.CONFIG_STORAGE_KEY), bytes);
  target.clock.advance(60000); sendOverview(target, "memory-routing", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(requests(target, "static").length, 2);
  assert.equal(requests(target, "departures").length, 2);
  resolveProduction(target, [FIRST]); assert.equal(rows(target, "memory-routing")[0].error, 0);
  target.companion.stop();
});

test("oversized hydrated routing serves one flight without making settings or credentials unrecoverable", function () {
  var unresolved = contracts.copyFavorite(FIRST), oversized = Object.assign({}, FIRST, {
    routing: Object.assign({}, FIRST.routing, { destinationRef: "IDFM:DST" + "x".repeat(33000) })
  });
  var storage = configuredStorage([unresolved]), original = storage.getItem(configuration.CONFIG_STORAGE_KEY), target = harness({ storage: storage });
  ready(target); sendOverview(target, "oversized-routing"); resolveRouting(target, oversized);
  assert.equal(storage.getItem(configuration.CONFIG_STORAGE_KEY), original);
  target.Pebble.emit("showConfiguration");
  var opening = target.Pebble.openedUrls[0].split("#")[1];
  assert.ok(opening.length <= configuration.MAX_CLOSE_RESPONSE_LENGTH);
  assert.deepEqual(JSON.parse(decodeURIComponent(opening)).favorites, [unresolved]);
  assert.equal(configuration.loadConfiguration(storage).primApiKey, TEST_KEY);
  resolveProduction(target, [oversized]); assert.equal(rows(target, "oversized-routing")[0].error, 0);
  target.clock.advance(60000); sendOverview(target, "routing-is-flight-only", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(requests(target, "static").length, 3); assert.equal(storage.getItem(configuration.CONFIG_STORAGE_KEY), original);
  target.companion.stop();
});

test("unresolved service IDs remain editable and canceled catalog lookups cannot launch PRIM", function () {
  var unresolved = contracts.copyFavorite(FIRST), target = harness({ storage: configuredStorage([unresolved]) });
  ready(target); sendOverview(target, "unresolved"); respond(target, requests(target, "static")[0], 404, "");
  assert.equal(requests(target, "departures").length, 0); assert.equal(rows(target, "unresolved")[0].error, 4);
  assert.deepEqual(configuration.loadConfiguration(target.storage).favorites, [unresolved]);
  target.Pebble.emit("showConfiguration"); assert.equal(target.Pebble.openedUrls.length, 1);
  assert.equal(target.Pebble.openedUrls[0].includes(TEST_KEY), false);
  sendOverview(target, "cancel-lookup"); var before = requests(target, "static").at(-1);
  target.companion.stop(); assert.equal(before.aborted, true);
  respond(target, before, 200, { schemaVersion: 1, revision: REVISION });
  assert.equal(requests(target, "departures").length, 0);
});

test("a stalled catalog lookup terminates as INVALID_SERVICE without PRIM or polling", function () {
  var target = harness({ storage: configuredStorage([contracts.copyFavorite(FIRST)]) });
  ready(target); sendOverview(target, "catalog-deadline"); target.clock.advance(contracts.LIMITS.httpTimeoutMs);
  assert.equal(requests(target, "static")[0].aborted, true); assert.equal(rows(target, "catalog-deadline")[0].error, 4);
  target.clock.advance(60000); assert.equal(target.xhr.instances.length, 1);
  assert.deepEqual(configuration.loadConfiguration(target.storage).favorites, [contracts.copyFavorite(FIRST)]);
  target.companion.stop();
});

test("stopping a six-favorite refresh cancels all pending PRIM work", function () {
  var favorites = Array.from({ length: 6 }, function (_, index) { return phoneFavorite(index + 1); });
  var target = harness({ storage: configuredStorage(favorites) }); ready(target); sendOverview(target, "cancel-all");
  var started = target.xhr.instances.length;
  assert.equal(requests(target, "departures").length, 6); assert.equal(requests(target, "traffic").length, 1);
  target.companion.stop(); target.clock.advance(60000);
  assert.equal(target.xhr.instances.length, started); assert.equal(target.xhr.instances.every(function (xhr) { return xhr.aborted; }), true);
});

test("catalog revision mismatch cannot hydrate favorites or send credentials to the static host", function () {
  var target = harness({ storage: configuredStorage([contracts.copyFavorite(FIRST)]) });
  ready(target); sendOverview(target, "revision-mismatch");
  respond(target, requests(target, "static")[0], 200, { schemaVersion: 1, revision: REVISION });
  respond(target, requests(target, "static")[1], 200, { schemaVersion: 1, revision: "b".repeat(64), service: serviceRow(FIRST) });
  assert.equal(configuration.loadConfiguration(target.storage).favorites[0].routing, undefined);
  assert.equal(requests(target, "departures").length, 0); assert.equal(rows(target, "revision-mismatch")[0].error, 4);
  requests(target, "static").forEach(function (xhr) { assert.equal(xhr.headers.apikey, undefined); });
  target.companion.stop();
});

test("authentication rejection invalidates credentials durably, cancels network, and completes accepted tokens", function () {
  var favorites = [FIRST, SECOND], target = harness({ storage: configuredStorage(favorites) });
  ready(target); sendOverview(target, "old-screen"); sendTraffic(target, "current-screen", SECOND);
  respond(target, requests(target, "departures")[0], 401, "");
  assert.equal(configuration.loadConfiguration(target.storage).keyStatus, contracts.KEY_STATUS.INVALID);
  assert.deepEqual(configuration.loadConfiguration(target.storage).favorites[0].routing, FIRST.routing);
  assert.equal(requests(target, "departures")[1].aborted, true); assert.equal(requests(target, "traffic")[0].aborted, true);
  acknowledgeConfiguration(target, 0);
  assert.equal(rows(target, "old-screen")[0].error, 3);
  assert.deepEqual(finalTransfer(target, "current-screen").records, ["e03"]);
  var before = target.xhr.instances.length;
  sendOverview(target, "blocked"); target.clock.advance(3600000);
  assert.equal(target.xhr.instances.length, before); assert.equal(rows(target, "blocked")[0].error, 3);
  target.companion.stop(); target = harness({ storage: target.storage }); ready(target, 0);
  sendOverview(target, "blocked-after-restart"); assert.equal(target.xhr.instances.length, 0);
  assert.equal(rows(target, "blocked-after-restart")[0].error, 3); target.companion.stop();
});

test("the invalid-key journal blocks restart even when the primary configuration write fails", function () {
  var storage = configuredStorage(), write = storage.setItem, target = harness({ storage: storage }); ready(target);
  storage.setItem = function (key, value) { if (key === configuration.CONFIG_STORAGE_KEY) throw new Error("unavailable"); write.call(this, key, value); };
  sendTraffic(target, "bad-key"); respond(target, requests(target, "traffic")[0], 403, "");
  assert.equal(configuration.loadConfiguration(storage).keyStatus, contracts.KEY_STATUS.INVALID);
  target.companion.stop(); storage.setItem = write; target = harness({ storage: storage }); ready(target, 0);
  sendTraffic(target, "restart"); assert.equal(target.xhr.instances.length, 0);
  assert.deepEqual(finalTransfer(target, "restart").records, ["e03"]); target.companion.stop();
});

test("credential replacement ignores saved callbacks from the canceled lifecycle", function () {
  var target = harness(); ready(target); sendTraffic(target, "old-key");
  var xhr = requests(target, "traffic")[0], late = xhr.onload;
  closeWith(target, "REPLACE", [FIRST], "replacement-key"); acknowledgeConfiguration(target, 0);
  xhr.status = 401; late(); sendOverview(target, "new-key");
  assert.equal(xhr.aborted, true); assert.equal(configuration.loadConfiguration(target.storage).keyStatus, contracts.KEY_STATUS.CONFIGURED);
  assert.equal(requests(target, "departures")[0].headers.apikey, "replacement-key");
  target.companion.stop();
});

test("credential removal erases the key, retains favorites, and blocks PRIM until replacement", function () {
  var storage = configuredStorage([FIRST, SECOND]);
  var target = harness({ storage: storage });
  ready(target);
  closeWith(target, "REMOVE", [FIRST, SECOND]);
  acknowledgeConfiguration(target, 0);
  var saved = configuration.loadConfiguration(storage);
  assert.equal(saved.primApiKey, null);
  assert.equal(saved.keyStatus, contracts.KEY_STATUS.MISSING);
  assert.deepEqual(saved.favorites, [FIRST, SECOND]);
  assert.doesNotMatch(JSON.stringify(storage.values), new RegExp(TEST_KEY));
  sendDetail(target, "removed-key", FIRST, contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(rows(target, "removed-key")[0].error, 1);
  assert.equal(requests(target, "departures").length, 0);
  assert.equal(requests(target, "traffic").length, 0);
  target.companion.stop();
});

test("interrupted same-key replacement never clears durable invalid-key authority", function () {
  ["marker-removal", "configured-write"].forEach(function (failure) {
    var storage = configuredStorage(), target = harness({ storage: storage }), write = storage.setItem, remove = storage.removeItem;
    ready(target); sendTraffic(target, "invalid-before-replacement"); respond(target, requests(target, "traffic")[0], 401, "");
    storage.setItem = function (key, value) {
      if (failure === "configured-write" && key === configuration.CONFIG_STORAGE_KEY && JSON.parse(value).keyStatus === contracts.KEY_STATUS.CONFIGURED) throw new Error("interrupted");
      write.call(this, key, value);
    };
    storage.removeItem = function (key) {
      if (failure === "marker-removal" && key === configuration.INVALID_KEY_STATUS_STORAGE_KEY) throw new Error("retained marker");
      remove.call(this, key);
    };
    closeWith(target, "REPLACE", [FIRST], TEST_KEY); target.companion.stop();
    assert.equal(configuration.loadConfiguration(storage).keyStatus, contracts.KEY_STATUS.INVALID);
  });
});

test("malformed traffic gets a final error token without cache writes or retries", function () {
  var target = harness(); ready(target); sendTraffic(target, "malformed");
  respond(target, requests(target, "traffic")[0], 200, { lines: [], disruptions: "not-an-array" });
  assert.deepEqual(finalTransfer(target, "malformed").records, ["e07"]);
  assert.equal(target.storage.getItem(configuration.RESULTS_STORAGE_KEY), null);
  target.clock.advance(3600000); assert.equal(target.xhr.instances.length, 1); target.companion.stop();
});

test("traffic failure keeps useful departures with unobserved UNKNOWN summaries", function () {
  var favorites = [FIRST, SECOND], target = harness({ storage: configuredStorage(favorites) });
  ready(target); sendOverview(target, "cold-traffic-failure");
  requests(target, "departures").forEach(function (xhr, index) { respond(target, xhr, 200, siri(favorites[index], target.clock)); });
  respond(target, requests(target, "traffic")[0], 503, "");
  assert.deepEqual(rows(target, "cold-traffic-failure").map(function (item) { return [item.fetchedAt, item.traffic, item.checkedAt, item.error]; }),
    favorites.map(function () { return [Math.floor(target.clock.now() / 1000), 3, 0, 0]; }));
  assert.equal(configuration.loadCache(target.storage, favorites).overview[0].result.departures[0].minutes, 2);
  target.companion.stop();
});

test("failed traffic refresh keeps the old detail cache and original checked time", function () {
  var target = harness(); ready(target); sendOverview(target, "initial"); resolveProduction(target, [FIRST]);
  var previous = configuration.loadCache(target.storage, [FIRST]); target.clock.advance(60000);
  sendOverview(target, "traffic-failed", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  respond(target, requests(target, "departures")[1], 200, siri(FIRST, target.clock));
  respond(target, requests(target, "traffic")[1], 200, { disruptions: "malformed", lines: [] });
  var current = configuration.loadCache(target.storage, [FIRST]);
  assert.equal(current.overview[0].result.fetchedAt, Math.floor(target.clock.now() / 1000));
  assert.deepEqual(current.trafficDetails, previous.trafficDetails);
  assert.equal(rows(target, "traffic-failed")[0].traffic, 3);
  assert.equal(rows(target, "traffic-failed")[0].checkedAt, previous.overview[0].traffic.checkedAt);
  assert.equal(rows(target, "traffic-failed")[0].error, 0);
  sendTraffic(target, "explicit-traffic"); respond(target, requests(target, "traffic")[2], 503, "");
  assert.deepEqual(finalTransfer(target, "explicit-traffic").records, ["e07"]); target.companion.stop();
});

test("cache persistence failure keeps fresh data usable in this phone session", function () {
  var target = harness(), write = target.storage.setItem; ready(target);
  target.storage.setItem = function (key, value) { if (key === configuration.RESULTS_STORAGE_KEY) throw new Error("storage full"); write.call(this, key, value); };
  sendOverview(target, "memory-overview"); resolveProduction(target, [FIRST]);
  assert.equal(rows(target, "memory-overview")[0].error, 0);
  sendDetail(target, "memory-detail", FIRST, contracts.REQUEST_TRIGGER.CACHE_ONLY); sendTraffic(target, "memory-traffic", FIRST);
  assert.equal(rows(target, "memory-detail")[0].error, 0); assert.equal(finalTransfer(target, "memory-traffic").records[0][0], "0");
  assert.equal(target.xhr.instances.length, 2); assert.equal(target.storage.getItem(configuration.RESULTS_STORAGE_KEY), null);
  target.companion.stop();
});

test("slow ACK FIFO keeps a started transfer atomic and completes subsequent cache-only tokens", function () {
  var storage = configuredStorage(), clock = new fakes.FakeClock(); seedOverview(storage, [FIRST], clock);
  var target = harness({ storage: storage, clock: clock, Pebble: new fakes.FakePebble(false), defer: fakes.createDefer(false) });
  ready(target); var before = target.Pebble.sent.length;
  sendOverview(target, "atomic"); target.Pebble.emit("ready");
  sendDetail(target, "detail", FIRST, contracts.REQUEST_TRIGGER.CACHE_ONLY); sendOverview(target, "latest"); drain(target);
  assert.deepEqual(target.Pebble.sent.slice(before, before + 3).map(function (message) { return message.MESSAGE_TYPE; }),
    [T.DISPLAY_BEGIN, T.DISPLAY_RECORD, T.DISPLAY_COMMIT]);
  ["atomic", "detail", "latest"].forEach(function (id) { assert.equal(transfers(target, id).length, 1); });
  assert.equal(target.Pebble.maxInFlight, 1); assert.equal(target.xhr.instances.length, 0); target.companion.stop();
});

test("favorite removal prunes departure and traffic cache across restart", function () {
  var favorites = [FIRST, SECOND], target = harness({ storage: configuredStorage(favorites) });
  ready(target); sendOverview(target, "seed-all"); resolveProduction(target, favorites);
  closeWith(target, "KEEP", [FIRST]); acknowledgeConfiguration(target, 0); target.companion.stop();
  var cache = configuration.loadCache(target.storage, [FIRST]);
  assert.deepEqual(cache.overview.map(function (entry) { return entry.favoriteId; }), [FIRST.id]);
  assert.equal(cache.trafficDetails.some(function (entry) { return entry.serviceId === SECOND.serviceId; }), false);
});

test("foreign cache formats fail closed and credential echoes cannot replace durable cache bytes", function () {
  var storage = configuredStorage(), oldBytes = JSON.stringify({ schemaVersion: 1, results: [{ favoriteId: FIRST.id, storedAt: 1, result: fixture.result }] });
  storage.setItem(configuration.RESULTS_STORAGE_KEY, oldBytes);
  var cache = configuration.loadCache(storage, [FIRST]); assert.deepEqual(cache, configuration.emptyCache());
  cache.trafficDetails.push({ serviceId: FIRST.serviceId, language: "en", storedAt: 1, result: {
    schemaVersion: 1, requestId: "cache", favoriteId: FIRST.id, state: "DELAYED", checkedAt: 1, title: "Perturbation", text: "echo " + TEST_KEY
  } });
  assert.equal(configuration.saveCache(storage, cache, TEST_KEY), false);
  assert.equal(storage.getItem(configuration.RESULTS_STORAGE_KEY), oldBytes);
});

test("generated bootstrap starts the real companion and answers SDK readiness without a timing gate", async function () {
  var build = await import("../../../scripts/build.mjs");
  var configured = build.readBuildConfiguration({ LAPIN_FUTE_CONFIG_URL: "https://config.example.test/index.html" });
  var Pebble = new fakes.FakePebble(false), storage = configuredStorage(), clock = new fakes.FakeClock();
  assert.throws(function () { harness({ configurationUrl: "http://config.example.test/" }); }, TypeError);
  assert.throws(function () { build.readBuildConfiguration({ LAPIN_FUTE_CONFIG_URL: "https://user:pass@config.example.test/" }); }, TypeError);
  vm.runInNewContext(build.createBootstrap(configured), {
    require: function () { return companion; }, Pebble: Pebble, localStorage: storage,
    XMLHttpRequest: fakes.createXHRFactory().XHR, Date: Date,
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock)
  });
  Pebble.emit("ready"); Pebble.emit("appmessage", { payload: { "15025": 1 } });
  assert.equal(Pebble.sent[0].MESSAGE_TYPE, T.DISPLAY_READY);
  Pebble.ack(); clock.advance(0);
  assert.deepEqual(Pebble.sent[1], { "15025": 1 });
  Pebble.ack(); clock.advance(0);
  assert.equal(Pebble.maxInFlight, 1); assert.equal(clock.delays.includes(250), false);
});
