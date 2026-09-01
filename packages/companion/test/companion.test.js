"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var vm = require("node:vm");
var path = require("node:path");
var url = require("node:url");
var companion = require("../src");
var fixture = require("../../../fixtures/departures/foundation.json");
var fakes = require("./fakes");

var contracts = companion.contracts;
var codec = companion.codec;
var configuration = companion.configuration;
var T = contracts.MESSAGE_TYPE;
var TEST_KEY = "test-personal-prim-key";

function harness(options) {
  var Pebble;
  var storage;
  var clock;
  var xhr;
  var defer;
  var instance;
  options = options || {};
  Pebble = options.Pebble || new fakes.FakePebble(true);
  storage = options.storage || new fakes.FakeStorage();
  clock = options.clock || new fakes.FakeClock();
  xhr = fakes.createXHRFactory();
  defer = typeof options.defer === "function" ? options.defer : fakes.createDefer(true);
  instance = companion.createCompanion({
    Pebble: Pebble,
    storage: storage,
    XHR: xhr.XHR,
    clock: clock,
    defer: defer,
    backendUrl: "https://backend.example.test/departures",
    configurationUrl: "https://config.example.test/index.html",
    fixture: options.fixture
  });
  return {
    Pebble: Pebble,
    storage: storage,
    clock: clock,
    defer: defer,
    xhr: xhr,
    companion: instance
  };
}

function configurationPayload(action, key) {
  var update = {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: [fixture.favorite],
    apiKeyUpdate: { schemaVersion: contracts.SCHEMA_VERSION, action: action }
  };
  if (action === "REPLACE") update.apiKeyUpdate.value = key;
  return update;
}

function closeWith(target, payload) {
  target.Pebble.emit("webviewclosed", {
    response: "pebblejs://close#" + encodeURIComponent(JSON.stringify(payload))
  });
}

function sendRequest(target, requestId, trigger) {
  target.Pebble.emit("appmessage", {
    payload: codec.encodeRequest({
      requestId: requestId,
      favoriteId: fixture.favorite.id,
      trigger: typeof trigger === "number" ? trigger : contracts.REQUEST_TRIGGER.APP_OPEN
    })
  });
}

function dualRequestPayload(requestId) {
  return {
    "0": contracts.SCHEMA_VERSION,
    "1": T.REQUEST,
    "2": requestId,
    "3": fixture.favorite.id,
    "24": contracts.REQUEST_TRIGGER.APP_OPEN,
    SCHEMA_VERSION: contracts.SCHEMA_VERSION,
    MESSAGE_TYPE: T.REQUEST,
    REQUEST_ID: requestId,
    FAVORITE_ID: fixture.favorite.id,
    REQUEST_TRIGGER: contracts.REQUEST_TRIGGER.APP_OPEN
  };
}

function messagesOfType(target, type) {
  return target.Pebble.sent.filter(function (message) {
    return message.MESSAGE_TYPE === type;
  });
}

function responseFor(requestId) {
  var result = contracts.copyDepartureResult(fixture.result, requestId);
  return result;
}

async function watchProtocol() {
  var protocolPath = path.resolve(__dirname, "../../watch/src/embeddedjs/protocol.js");
  return import(url.pathToFileURL(protocolPath).href);
}

function watchMessage(message) {
  return new Map(Object.keys(message).map(function (key) {
    return [key, message[key]];
  }));
}

test("close fragment atomically stores one favorites-and-key record and exposes the key only to Authorization", function () {
  var target = harness();
  var stored;
  var sentText;
  var pageState;

  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  assert.deepEqual(target.storage.keys(), [configuration.CONFIG_STORAGE_KEY]);
  assert.equal(target.storage.writes.length, 1);
  stored = JSON.parse(target.storage.getItem(configuration.CONFIG_STORAGE_KEY));
  assert.equal(stored.primApiKey, TEST_KEY);
  assert.equal(stored.keyStatus, contracts.KEY_STATUS.CONFIGURED);
  assert.deepEqual(stored.favorites, [fixture.favorite]);

  sentText = JSON.stringify(target.Pebble.sent);
  assert.equal(sentText.includes(TEST_KEY), false);
  target.Pebble.emit("showConfiguration");
  assert.equal(target.Pebble.openedUrls[0].includes(TEST_KEY), false);
  pageState = JSON.parse(decodeURIComponent(target.Pebble.openedUrls[0].split("#")[1]));
  assert.deepEqual(pageState, {
    hasKey: true,
    favorites: [fixture.favorite],
    language: "en"
  });

  sendRequest(target, "secret-boundary");
  assert.equal(target.xhr.instances.length, 1);
  assert.equal(target.xhr.instances[0].headers.Authorization, "Bearer " + TEST_KEY);
  assert.equal(target.xhr.instances[0].url.includes(TEST_KEY), false);
  assert.equal(target.xhr.instances[0].body.includes(TEST_KEY), false);
  target.xhr.instances[0].respond(200, responseFor("secret-boundary"));
  assert.equal(JSON.stringify(target.Pebble.sent).includes(TEST_KEY), false);
});
test("a pre-presentation v1 record keeps its API key and legacy favorite on load", function () {
  var storage = new fakes.FakeStorage();
  var legacyRecord = {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: [{
      schemaVersion: contracts.SCHEMA_VERSION,
      id: "legacy-home",
      serviceId: "opaque:legacy-service",
      displayName: "Maison",
      stopLabel: "Châtelet",
      lineLabel: "1",
      destinationLabel: "La Défense",
      sortOrder: 0
    }],
    apiKey: TEST_KEY
  };
  var loaded;

  storage.setItem(configuration.LEGACY_CONFIG_STORAGE_KEY, JSON.stringify(legacyRecord));
  loaded = configuration.loadConfiguration(storage);

  assert.equal(loaded.primApiKey, TEST_KEY);
  assert.equal(loaded.keyStatus, contracts.KEY_STATUS.CONFIGURED);
  assert.equal(loaded.favorites.length, 1);
  assert.equal(
    JSON.parse(storage.getItem(configuration.CONFIG_STORAGE_KEY)).primApiKey,
    TEST_KEY
  );
  assert.deepEqual(storage.keys(), [configuration.CONFIG_STORAGE_KEY]);
  ["lineMode", "lineColor", "lineTextColor"].forEach(function (field) {
    assert.equal(Object.prototype.hasOwnProperty.call(loaded.favorites[0], field), false);
  });
});
test("configuration opening uses the active watch language and safely falls back to English", function () {
  var target = harness();
  var state;

  target.Pebble.getActiveWatchInfo = function () { return { language: "fr_FR" }; };
  target.Pebble.emit("showConfiguration");
  state = JSON.parse(decodeURIComponent(target.Pebble.openedUrls[0].split("#")[1]));
  assert.equal(state.language, "fr");

  target.Pebble.getActiveWatchInfo = function () { throw new Error("unavailable"); };
  target.Pebble.emit("showConfiguration");
  state = JSON.parse(decodeURIComponent(target.Pebble.openedUrls[1].split("#")[1]));
  assert.equal(state.language, "en");
});


test("KEEP, REPLACE, and REMOVE apply to one atomic phone-local record", function () {
  var target = harness();
  var stored;

  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  closeWith(target, configurationPayload("KEEP"));
  stored = JSON.parse(target.storage.getItem(configuration.CONFIG_STORAGE_KEY));
  assert.equal(stored.primApiKey, TEST_KEY);
  assert.equal(stored.keyStatus, contracts.KEY_STATUS.CONFIGURED);
  assert.deepEqual(target.storage.keys(), [configuration.CONFIG_STORAGE_KEY]);

  closeWith(target, configurationPayload("REMOVE"));
  stored = JSON.parse(target.storage.getItem(configuration.CONFIG_STORAGE_KEY));
  assert.equal(stored.primApiKey, null);
  assert.equal(stored.keyStatus, contracts.KEY_STATUS.MISSING);
  assert.deepEqual(target.storage.keys(), [configuration.CONFIG_STORAGE_KEY]);
  assert.equal(target.storage.writes.length, 3);
});

test("failed phone verification rolls back configuration bytes and watch state", function () {
  var target = harness();
  var beforeBytes;
  var beforeMessages;
  var originalSetItem;
  var failNext = false;

  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  beforeBytes = target.storage.getItem(configuration.CONFIG_STORAGE_KEY);
  beforeMessages = target.Pebble.sent.length;
  originalSetItem = target.storage.setItem.bind(target.storage);
  target.storage.setItem = function (key, value) {
    originalSetItem(key, value);
    if (failNext && key === configuration.CONFIG_STORAGE_KEY) {
      failNext = false;
      target.storage.values[key] = "corrupt";
    }
  };
  failNext = true;
  closeWith(target, configurationPayload("REMOVE"));
  assert.equal(target.storage.getItem(configuration.CONFIG_STORAGE_KEY), beforeBytes);
  assert.equal(target.Pebble.sent.length, beforeMessages);
  sendRequest(target, "rollback-still-configured");
  assert.equal(target.xhr.instances.length, 1);
});
test("untrusted webview responses are bounded and cannot persist a key inside favorites", function () {
  var target = harness();
  var replaceLeak = configurationPayload("REPLACE", TEST_KEY);
  var keepLeak;
  var stored;

  target.Pebble.emit("webviewclosed", {
    response: "pebblejs://close#" + "x".repeat(configuration.MAX_CLOSE_RESPONSE_LENGTH)
  });
  assert.equal(target.storage.writes.length, 0);

  replaceLeak.favorites = [
    Object.assign({}, fixture.favorite, { serviceId: "opaque:" + TEST_KEY })
  ];
  closeWith(target, replaceLeak);
  assert.equal(target.storage.writes.length, 0);

  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  assert.equal(target.storage.writes.length, 1);
  keepLeak = configurationPayload("KEEP");
  keepLeak.favorites = [
    Object.assign({}, fixture.favorite, { stopLabel: "Stop " + TEST_KEY })
  ];
  closeWith(target, keepLeak);
  assert.equal(target.storage.writes.length, 1);
  stored = JSON.parse(target.storage.getItem(configuration.CONFIG_STORAGE_KEY));
  assert.equal(JSON.stringify(stored.favorites).includes(TEST_KEY), false);
  assert.equal(stored.primApiKey, TEST_KEY);
});


test("configuration advances one event-loop turn at a time after immediate ACKs", function () {
  var defer = fakes.createDefer(false);
  var target = harness({ fixture: fixture, defer: defer });

  target.Pebble.emit("ready");
  assert.deepEqual(target.Pebble.sent.map(function (message) { return message.MESSAGE_TYPE; }), [
    T.CONFIG_BEGIN
  ]);
  assert.equal(defer.pending.length, 1);

  defer.runNext();
  assert.deepEqual(target.Pebble.sent.map(function (message) { return message.MESSAGE_TYPE; }), [
    T.CONFIG_BEGIN,
    T.FAVORITE
  ]);
  assert.equal(defer.pending.length, 1);

  defer.runNext();
  assert.deepEqual(target.Pebble.sent.map(function (message) { return message.MESSAGE_TYPE; }), [
    T.CONFIG_BEGIN,
    T.FAVORITE,
    T.CONFIG_COMMIT
  ]);
  assert.equal(defer.pending.length, 0);
});

test("stop invalidates a deferred configuration advance", function () {
  var defer = fakes.createDefer(false);
  var target = harness({ fixture: fixture, defer: defer });

  target.Pebble.emit("ready");
  target.companion.stop();
  defer.runNext();
  assert.deepEqual(target.Pebble.sent.map(function (message) { return message.MESSAGE_TYPE; }), [
    T.CONFIG_BEGIN
  ]);
});

test("stop aborts and invalidates a late request callback across restart", function () {
  var target = harness();
  var staleRequest;
  var before;
  var resultBegins;

  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(target, "before-stop");
  staleRequest = target.xhr.instances[0];
  staleRequest.abort = function () { this.aborted = true; };

  target.companion.stop();
  assert.equal(staleRequest.aborted, true);
  target.companion.start();

  before = target.Pebble.sent.length;
  staleRequest.respond(200, responseFor("before-stop"));
  assert.equal(target.Pebble.sent.length, before);

  sendRequest(target, "after-restart");
  assert.equal(target.xhr.instances.length, 2);
  target.xhr.instances[1].respond(200, responseFor("after-restart"));
  resultBegins = messagesOfType(target, T.RESULT_BEGIN);
  assert.equal(resultBegins[resultBegins.length - 1].REQUEST_ID, "after-restart");
});

test("ready sends full config and APP_OPEN returns the fixture without XHR or product timers", function () {
  var target = harness({ fixture: fixture });
  var before;
  var resultBegins;

  target.Pebble.emit("ready");
  assert.deepEqual(target.Pebble.sent.map(function (message) { return message.MESSAGE_TYPE; }), [
    T.CONFIG_BEGIN,
    T.FAVORITE,
    T.CONFIG_COMMIT
  ]);
  assert.equal(target.Pebble.sent[0].DISPLAY_NAME, "en");
  assert.equal(target.Pebble.sent[0].KEY_STATUS, contracts.KEY_STATUS.CONFIGURED);
  assert.equal(target.Pebble.sent.every(function (message) {
    return Object.keys(message).every(function (key) { return !/^[0-9]+$/.test(key); });
  }), true);

  before = target.Pebble.sent.length;
  sendRequest(target, "app-open");
  assert.equal(target.Pebble.sent.length, before + fixture.result.departures.length + 2);
  resultBegins = messagesOfType(target, T.RESULT_BEGIN);
  assert.equal(resultBegins[resultBegins.length - 1].REQUEST_ID, "app-open");
  assert.equal(target.xhr.instances.length, 0);
  assert.equal(target.clock.timers.length, 0);
});

test("pypkjs dual request properties are canonicalized only at the event boundary", function () {
  var target = harness({ fixture: fixture });
  var payload = dualRequestPayload("dual-app-open");
  var before;
  var resultBegins;

  target.Pebble.emit("ready");
  before = target.Pebble.sent.length;
  assert.equal(codec.decodeRequest(payload), null);
  target.Pebble.emit("appmessage", { payload: payload });

  assert.equal(target.Pebble.sent.length, before + fixture.result.departures.length + 2);
  resultBegins = messagesOfType(target, T.RESULT_BEGIN);
  assert.equal(resultBegins[resultBegins.length - 1].REQUEST_ID, "dual-app-open");
  assert.equal(target.xhr.instances.length, 0);
  assert.equal(target.clock.timers.length, 0);
});

test("incoming event normalization rejects numeric-only, unknown, conflicting, extra, and internal properties", function () {
  var target = harness({ fixture: fixture });
  var numericOnly = dualRequestPayload("numeric-only");
  var unknown = dualRequestPayload("unknown");
  var conflicting = dualRequestPayload("conflicting");
  var extra = dualRequestPayload("extra");
  var cases;

  delete numericOnly.SCHEMA_VERSION;
  delete numericOnly.MESSAGE_TYPE;
  delete numericOnly.REQUEST_ID;
  delete numericOnly.FAVORITE_ID;
  delete numericOnly.REQUEST_TRIGGER;
  unknown["25"] = 0;
  conflicting["24"] = contracts.REQUEST_TRIGGER.FAVORITE_SELECTION;
  extra["4"] = fixture.favorite.serviceId;
  extra.SERVICE_ID = fixture.favorite.serviceId;
  cases = [
    { name: "numeric-only", payload: numericOnly },
    { name: "unknown numeric", payload: unknown },
    { name: "conflicting duplicate", payload: conflicting },
    { name: "extra canonical key", payload: extra },
    { name: "internal pypkjs event", payload: { "15025": 1 } }
  ];

  target.Pebble.emit("ready");
  cases.forEach(function (testCase) {
    var before = target.Pebble.sent.length;
    target.Pebble.emit("appmessage", { payload: testCase.payload });
    assert.equal(target.Pebble.sent.length, before, testCase.name);
  });
  assert.equal(target.xhr.instances.length, 0);
  assert.equal(target.clock.timers.length, 0);
});

test("fresh results are rebound from cache for 60 seconds without a network timer", function () {
  var target = harness();
  var before;
  var resultBegins;

  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(target, "network-first");
  assert.equal(target.xhr.instances.length, 1);
  target.xhr.instances[0].respond(200, responseFor("network-first"));

  target.clock.advance(59999);
  before = target.Pebble.sent.length;
  sendRequest(target, "cache-hit");
  assert.equal(target.xhr.instances.length, 1);
  assert.equal(target.Pebble.sent.length, before + fixture.result.departures.length + 2);
  resultBegins = messagesOfType(target, T.RESULT_BEGIN);
  assert.equal(resultBegins[resultBegins.length - 1].REQUEST_ID, "cache-hit");

  target.clock.advance(1);
  sendRequest(target, "cache-expired");
  assert.equal(target.xhr.instances.length, 2);
  assert.equal(target.clock.delays.length, 0);
});

test("selection replays by original fetched age and refreshes at exactly 60 seconds", function () {
  var target = harness();
  var aged = responseFor("aged-network");
  var before;

  aged.fetchedAt = Math.floor(target.clock.now() / 1000) - 59;
  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(target, "aged-network");
  target.xhr.instances[0].respond(200, aged);
  target.clock.advance(1000);
  before = target.Pebble.sent.length;
  sendRequest(target, "selection-refresh", contracts.REQUEST_TRIGGER.FAVORITE_SELECTION);
  assert.equal(
    target.Pebble.sent.length,
    before + fixture.result.departures.length + 3
  );
  assert.equal(target.xhr.instances.length, 2);
});

test("stale cache commits before the same-request fresh result at the watch receiver", async function () {
  var protocol = await watchProtocol();
  var receiver = new protocol.ProtocolReceiver();
  var target = harness();
  var fresh = responseFor("cached-refresh");
  var before;
  var statuses;

  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(target, "network-seed");
  target.xhr.instances[0].respond(200, responseFor("network-seed"));
  target.clock.advance(60000);

  assert.equal(receiver.expectResponse("cached-refresh", fixture.favorite.id), true);
  before = target.Pebble.sent.length;
  sendRequest(target, "cached-refresh", contracts.REQUEST_TRIGGER.FAVORITE_SELECTION);
  statuses = target.Pebble.sent.slice(before).map(function (message) {
    return receiver.receive(watchMessage(message));
  });
  assert.equal(statuses.filter(function (status) {
    return status === protocol.RECEIVE_RESULT.RESULT_COMMITTED;
  }).length, 1);
  assert.equal(receiver.snapshot().result.fetchedAt, fixture.result.fetchedAt);

  fresh.fetchedAt += 60;
  before = target.Pebble.sent.length;
  target.xhr.instances[1].respond(200, fresh);
  statuses = target.Pebble.sent.slice(before).map(function (message) {
    return receiver.receive(watchMessage(message));
  });
  assert.equal(statuses.filter(function (status) {
    return status === protocol.RECEIVE_RESULT.RESULT_COMMITTED;
  }).length, 1);
  assert.equal(receiver.snapshot().result.fetchedAt, fresh.fetchedAt);
});

test("future fetched timestamps cannot extend cache freshness past receipt time", function () {
  var target = harness();
  var future = responseFor("future-network");

  future.fetchedAt = Math.floor(target.clock.now() / 1000) + 3600;
  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(target, "future-network");
  target.xhr.instances[0].respond(200, future);

  target.clock.advance(60000);
  sendRequest(target, "future-expired", contracts.REQUEST_TRIGGER.FAVORITE_SELECTION);
  assert.equal(target.xhr.instances.length, 2);
});

test("future storedAt after restart replays cache but cannot suppress refresh", function () {
  var storage = new fakes.FakeStorage();
  var firstClock = new fakes.FakeClock();
  var first = harness({ storage: storage, clock: firstClock });
  var future = responseFor("future-stored");
  var secondClock;
  var second;
  var begins;

  future.fetchedAt = Math.floor(firstClock.now() / 1000) + 3600;
  closeWith(first, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(first, "future-stored");
  first.xhr.instances[0].respond(200, future);
  first.companion.stop();

  secondClock = new fakes.FakeClock(firstClock.now() - 1000);
  second = harness({ storage: storage, clock: secondClock });
  second.Pebble.emit("ready");
  sendRequest(second, "future-restart");
  assert.equal(second.xhr.instances.length, 1);
  begins = messagesOfType(second, T.RESULT_BEGIN);
  assert.equal(begins[begins.length - 1].REQUEST_ID, "future-restart");
  assert.equal(begins[begins.length - 1].FETCHED_AT, future.fetchedAt);
});

test("a durable result replays across companion restart with original age and no key leak", function () {
  var storage = new fakes.FakeStorage();
  var clock = new fakes.FakeClock();
  var first = harness({ storage: storage, clock: clock });
  var second;
  var begins;
  var storedResults;

  closeWith(first, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(first, "first-request");
  first.xhr.instances[0].respond(200, responseFor("first-request"));
  storedResults = storage.getItem(configuration.RESULTS_STORAGE_KEY);
  assert.equal(typeof storedResults, "string");
  assert.equal(storedResults.includes(TEST_KEY), false);

  first.companion.stop();
  clock.advance(1000);
  second = harness({ storage: storage, clock: clock });
  second.Pebble.emit("ready");
  sendRequest(second, "restart-request");
  assert.equal(second.xhr.instances.length, 0);
  begins = messagesOfType(second, T.RESULT_BEGIN);
  assert.equal(begins[begins.length - 1].REQUEST_ID, "restart-request");
  assert.equal(begins[begins.length - 1].FETCHED_AT, fixture.result.fetchedAt);
  assert.deepEqual(second.companion.metrics(), {
    requests: 0,
    cacheHits: 1,
    cacheMisses: 0,
    successes: 0,
    failures: 0,
    totalLatencyMs: 0,
    lastLatencyMs: 0
  });
});

test("unknown configuration versions preserve stored bytes and prior watch state", function () {
  var storage = new fakes.FakeStorage();
  var bytes = JSON.stringify({ schemaVersion: 99, favorites: [] });
  var target;

  storage.setItem(configuration.CONFIG_STORAGE_KEY, bytes);
  target = harness({ storage: storage });
  target.Pebble.emit("ready");
  assert.equal(storage.getItem(configuration.CONFIG_STORAGE_KEY), bytes);
  assert.equal(target.Pebble.sent.length, 0);
  assert.equal(target.xhr.instances.length, 0);
});

test("invalid key status persists across restart and replacement re-enables XHR", function () {
  var storage = new fakes.FakeStorage();
  var first = harness({ storage: storage });
  var second;
  var stored;

  closeWith(first, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(first, "invalid-first");
  first.xhr.instances[0].respond(401, {
    schemaVersion: contracts.SCHEMA_VERSION,
    requestId: "invalid-first",
    favoriteId: fixture.favorite.id,
    code: "SOURCE_UNAVAILABLE",
    occurredAt: Math.floor(first.clock.now() / 1000)
  });
  stored = JSON.parse(storage.getItem(configuration.CONFIG_STORAGE_KEY));
  assert.equal(stored.keyStatus, contracts.KEY_STATUS.INVALID);
  assert.equal(stored.primApiKey, TEST_KEY);

  first.companion.stop();
  second = harness({ storage: storage });
  second.Pebble.emit("ready");
  sendRequest(second, "invalid-restart");
  assert.equal(second.xhr.instances.length, 0);
  closeWith(second, configurationPayload("REPLACE", "replacement-key"));
  sendRequest(second, "replacement-request");
  assert.equal(second.xhr.instances.length, 1);
  assert.equal(second.xhr.instances[0].headers.Authorization, "Bearer replacement-key");
});

test("failed INVALID config write stays durable and fail-closed across reconstruction", function () {
  var storage = new fakes.FakeStorage();
  var first = harness({ storage: storage });
  var second;
  var beforeBytes;
  var marker;
  var configBegins;
  var originalSetItem;
  var failNext = false;

  closeWith(first, configurationPayload("REPLACE", TEST_KEY));
  beforeBytes = storage.getItem(configuration.CONFIG_STORAGE_KEY);
  originalSetItem = storage.setItem.bind(storage);
  storage.setItem = function (key, value) {
    originalSetItem(key, value);
    if (failNext && key === configuration.CONFIG_STORAGE_KEY) {
      failNext = false;
      storage.values[key] = "corrupt";
    }
  };
  failNext = true;
  sendRequest(first, "invalid-write");
  first.xhr.instances[0].respond(401, "");
  assert.equal(storage.getItem(configuration.CONFIG_STORAGE_KEY), beforeBytes);
  marker = storage.getItem(configuration.INVALID_KEY_STATUS_STORAGE_KEY);
  assert.equal(typeof marker, "string");
  assert.equal(marker.includes(TEST_KEY), false);
  configBegins = messagesOfType(first, T.CONFIG_BEGIN);
  assert.equal(
    configBegins[configBegins.length - 1].KEY_STATUS,
    contracts.KEY_STATUS.INVALID
  );

  first.companion.stop();
  second = harness({ storage: storage });
  second.Pebble.emit("ready");
  configBegins = messagesOfType(second, T.CONFIG_BEGIN);
  assert.equal(
    configBegins[configBegins.length - 1].KEY_STATUS,
    contracts.KEY_STATUS.INVALID
  );
  sendRequest(second, "invalid-write-restart");
  assert.equal(second.xhr.instances.length, 0);
  closeWith(second, configurationPayload("KEEP"));
  sendRequest(second, "invalid-write-after-keep");
  assert.equal(second.xhr.instances.length, 0);

  closeWith(second, configurationPayload("REPLACE", "replacement-key"));
  assert.equal(storage.getItem(configuration.INVALID_KEY_STATUS_STORAGE_KEY), null);
  sendRequest(second, "invalid-write-after-replace");
  assert.equal(second.xhr.instances.length, 1);
  assert.equal(second.xhr.instances[0].headers.Authorization, "Bearer replacement-key");
});

test("same-key replacement clear interruption remains durably INVALID", function () {
  var storage = new fakes.FakeStorage();
  var first = harness({ storage: storage });
  var second;
  var originalRemoveItem;
  var originalSetItem;
  var failConfigWrite = false;
  var failMarkerRemoval = false;
  var stored;
  var configBegins;

  closeWith(first, configurationPayload("REPLACE", TEST_KEY));
  originalSetItem = storage.setItem.bind(storage);
  storage.setItem = function (key, value) {
    originalSetItem(key, value);
    if (failConfigWrite && key === configuration.CONFIG_STORAGE_KEY) {
      failConfigWrite = false;
      storage.values[key] = "corrupt";
    }
  };
  failConfigWrite = true;
  sendRequest(first, "marker-same-key");
  first.xhr.instances[0].respond(401, "");
  assert.equal(
    typeof storage.getItem(configuration.INVALID_KEY_STATUS_STORAGE_KEY),
    "string"
  );

  originalRemoveItem = storage.removeItem.bind(storage);
  storage.removeItem = function (key) {
    if (failMarkerRemoval && key === configuration.INVALID_KEY_STATUS_STORAGE_KEY) {
      failMarkerRemoval = false;
      throw new Error("simulated interruption");
    }
    originalRemoveItem(key);
  };
  failMarkerRemoval = true;
  closeWith(first, configurationPayload("REPLACE", TEST_KEY));
  stored = JSON.parse(storage.getItem(configuration.CONFIG_STORAGE_KEY));
  assert.equal(stored.primApiKey, TEST_KEY);
  assert.equal(stored.keyStatus, contracts.KEY_STATUS.INVALID);
  assert.equal(
    typeof storage.getItem(configuration.INVALID_KEY_STATUS_STORAGE_KEY),
    "string"
  );
  configBegins = messagesOfType(first, T.CONFIG_BEGIN);
  assert.equal(
    configBegins[configBegins.length - 1].KEY_STATUS,
    contracts.KEY_STATUS.INVALID
  );

  first.companion.stop();
  second = harness({ storage: storage });
  second.Pebble.emit("ready");
  configBegins = messagesOfType(second, T.CONFIG_BEGIN);
  assert.equal(
    configBegins[configBegins.length - 1].KEY_STATUS,
    contracts.KEY_STATUS.INVALID
  );
  sendRequest(second, "same-key-after-interruption");
  assert.equal(second.xhr.instances.length, 0);

  closeWith(second, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(second, "same-key-after-success");
  assert.equal(second.xhr.instances.length, 1);
  assert.equal(second.xhr.instances[0].headers.Authorization, "Bearer " + TEST_KEY);
});

test("deleting a favorite prunes its durable result without touching config atomicity", function () {
  var target = harness();
  var removeFavorite = configurationPayload("KEEP");
  var stored;

  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(target, "cache-before-delete");
  target.xhr.instances[0].respond(200, responseFor("cache-before-delete"));
  removeFavorite.favorites = [];
  closeWith(target, removeFavorite);
  stored = JSON.parse(target.storage.getItem(configuration.RESULTS_STORAGE_KEY));
  assert.deepEqual(stored.results, []);
  assert.equal(
    JSON.parse(target.storage.getItem(configuration.CONFIG_STORAGE_KEY)).primApiKey,
    TEST_KEY
  );
});
test("a late older response cannot overwrite or emit after the newest request for a favorite", function () {
  var target = harness();
  var older = responseFor("older");
  var newer = responseFor("newer");
  var beforeOlder;
  var resultBegins;

  older.fetchedAt += 1;
  newer.fetchedAt += 2;
  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(target, "older");
  sendRequest(target, "newer");
  assert.equal(target.xhr.instances.length, 2);

  target.xhr.instances[1].respond(200, newer);
  resultBegins = messagesOfType(target, T.RESULT_BEGIN);
  assert.equal(resultBegins[resultBegins.length - 1].REQUEST_ID, "newer");
  assert.equal(resultBegins[resultBegins.length - 1].FETCHED_AT, newer.fetchedAt);

  beforeOlder = target.Pebble.sent.length;
  target.xhr.instances[0].respond(200, older);
  assert.equal(target.Pebble.sent.length, beforeOlder);

  sendRequest(target, "cache-after-race");
  assert.equal(target.xhr.instances.length, 2);
  resultBegins = messagesOfType(target, T.RESULT_BEGIN);
  assert.equal(resultBegins[resultBegins.length - 1].REQUEST_ID, "cache-after-race");
  assert.equal(resultBegins[resultBegins.length - 1].FETCHED_AT, newer.fetchedAt);
});


test("HTTP failures map to stable error codes, keyStatus only, and never retry", function () {
  var cases = [
    { status: 401, expected: "API_KEY_INVALID" },
    { status: 404, expected: "INVALID_SERVICE" },
    { status: 429, expected: "RATE_LIMITED", headers: { "Retry-After": "17" }, retry: 17 },
    { status: 503, expected: "SOURCE_UNAVAILABLE" }
  ];

  cases.forEach(function (item, index) {
    var target = harness();
    var errors;
    var configBegins;
    var responseStart;
    var lastError;
    closeWith(target, configurationPayload("REPLACE", TEST_KEY));
    sendRequest(target, "error-" + index);
    responseStart = target.Pebble.sent.length;
    target.xhr.instances[0].respond(item.status, "", item.headers);

    errors = messagesOfType(target, T.ERROR);
    lastError = errors[errors.length - 1];
    assert.equal(lastError.ERROR_CODE, contracts.ERROR_CODE.indexOf(item.expected));
    assert.equal(lastError.REQUEST_ID, "error-" + index);
    assert.equal(lastError.FAVORITE_ID, fixture.favorite.id);
    assert.equal(lastError.RETRY_AFTER_SECONDS, item.retry);
    assert.equal(JSON.stringify(target.Pebble.sent).includes(TEST_KEY), false);
    assert.equal(target.xhr.instances.length, 1);
    target.clock.advance(3600000);
    assert.equal(target.xhr.instances.length, 1);

    if (item.expected === "API_KEY_INVALID") {
      configBegins = messagesOfType(target, T.CONFIG_BEGIN);
      assert.equal(configBegins[configBegins.length - 1].KEY_STATUS, contracts.KEY_STATUS.INVALID);
      assert.deepEqual(
        target.Pebble.sent.slice(responseStart).map(function (message) { return message.MESSAGE_TYPE; }),
        [T.ERROR, T.CONFIG_BEGIN, T.FAVORITE, T.CONFIG_COMMIT]
      );
      sendRequest(target, "known-invalid");
      assert.equal(target.xhr.instances.length, 1);
    }
  });
});

test("network failure emits one sanitized error and schedules no retry", function () {
  var target = harness();
  var errors;
  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(target, "network-error");
  target.xhr.instances[0].networkError();
  errors = messagesOfType(target, T.ERROR);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].ERROR_CODE, contracts.ERROR_CODE.indexOf("SOURCE_UNAVAILABLE"));
  assert.equal(target.xhr.instances.length, 1);
  assert.equal(target.clock.timers.length, 0);
  assert.equal(JSON.stringify(errors).includes(TEST_KEY), false);
});
test("build bootstrap validates URLs and injects only the zero-delay ACK defer", async function () {
  var build = await import("../../../scripts/build.mjs");
  var configured;
  var captured = null;
  var scheduled = [];
  var deferred = false;
  var source;

  assert.deepEqual(build.readBuildConfiguration(Object.create(null)), {
    backendUrl: "",
    configurationUrl: ""
  });
  assert.throws(function () {
    build.readBuildConfiguration({ LAPIN_FUTE_BACKEND_URL: "http://backend.example.test" });
  }, /absolute HTTPS URL/);
  assert.throws(function () {
    build.readBuildConfiguration({ LAPIN_FUTE_CONFIG_URL: "/configuration" });
  }, /absolute HTTPS URL/);
  assert.throws(function () {
    build.readBuildConfiguration({ LAPIN_FUTE_CONFIG_URL: "" });
  }, /absolute HTTPS URL/);

  configured = build.readBuildConfiguration({
    LAPIN_FUTE_BACKEND_URL: "https://backend.example.test/departures",
    LAPIN_FUTE_CONFIG_URL: "https://config.example.test/index.html"
  });
  source = build.createBootstrap(fixture, configured);
  vm.runInNewContext(source, {
    Pebble: {},
    localStorage: {},
    XMLHttpRequest: function () {},
    Date: Date,
    setTimeout: function (callback, delay) {
      scheduled.push({ callback: callback, delay: delay });
    },
    require: function (specifier) {
      assert.equal(specifier, "./companion");
      return {
        createCompanion: function (options) {
          captured = options;
        }
      };
    }
  });

  assert.notEqual(captured, null);
  assert.deepEqual(Object.keys(captured.clock), ["now"]);
  captured.defer(function () { deferred = true; });
  assert.equal(deferred, false);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].delay, 0);
  scheduled[0].callback();
  assert.equal(deferred, true);
  assert.equal(captured.backendUrl, configured.backendUrl);
  assert.equal(captured.configurationUrl, configured.configurationUrl);
  assert.equal(JSON.stringify(captured.fixture), JSON.stringify(fixture));
  assert.equal(source.includes("LAPIN_FUTE_"), false);
  assert.equal(source.includes(TEST_KEY), false);
});
