"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var vm = require("node:vm");
var companion = require("../src");
var fixture = require("../../../fixtures/departures/foundation.json");
var fakes = require("./fakes");

var contracts = companion.contracts;
var codec = companion.codec;
var configuration = companion.configuration;
var T = contracts.MESSAGE_TYPE;
var TEST_KEY = "test-personal-prim-key";
var SECOND_FAVORITE = Object.freeze(Object.assign({}, fixture.favorite, {
  id: "foundation-work",
  serviceId: "opaque:foundation:service:2",
  displayName: "Commute work",
  destinationLabel: "Château de Vincennes",
  sortOrder: 1
}));

function harness(options) {
  var Pebble;
  var storage;
  var clock;
  var xhr;
  var defer;
  var readyDefer;
  var instance;
  options = options || {};
  Pebble = options.Pebble || new fakes.FakePebble(true);
  storage = options.storage || new fakes.FakeStorage();
  clock = options.clock || new fakes.FakeClock();
  xhr = fakes.createXHRFactory();
  defer = typeof options.defer === "function" ? options.defer : fakes.createDefer(true);
  readyDefer = typeof options.readyDefer === "function"
    ? options.readyDefer
    : fakes.createDefer(true);
  instance = companion.createCompanion({
    Pebble: Pebble,
    storage: storage,
    XHR: options.XHR || xhr.XHR,
    clock: clock,
    defer: defer,
    readyDefer: readyDefer,
    backendUrl: "https://backend.example.test/departures",
    configurationUrl: "https://config.example.test/index.html"
  });
  return {
    Pebble: Pebble,
    storage: storage,
    clock: clock,
    defer: defer,
    readyDefer: readyDefer,
    xhr: xhr,
    companion: instance
  };
}

function configurationPayload(action, key, favorites) {
  var update = {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: favorites || [fixture.favorite],
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

function sendRequest(target, requestId, trigger, favorite) {
  target.Pebble.emit("appmessage", {
    payload: codec.encodeRequest({
      requestId: requestId,
      favoriteId: (favorite || fixture.favorite).id,
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

function responseFor(requestId, favorite) {
  var result = contracts.copyDepartureResult(fixture.result, requestId);
  result.favoriteId = (favorite || fixture.favorite).id;
  return result;
}

function configuredStorage(favorites, keyStatus) {
  var storage = new fakes.FakeStorage();
  configuration.saveConfiguration(storage, {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: favorites || [fixture.favorite],
    primApiKey: TEST_KEY,
    keyStatus: typeof keyStatus === "number"
      ? keyStatus
      : contracts.KEY_STATUS.CONFIGURED
  });
  storage.writes.length = 0;
  return storage;
}

function storeResult(storage, result, storedAt) {
  configuration.saveResults(storage, {
    schemaVersion: contracts.SCHEMA_VERSION,
    results: [{
      favoriteId: result.favoriteId,
      storedAt: storedAt,
      result: result
    }]
  });
  storage.writes.length = 0;
}

function drainQueue(target) {
  while (target.Pebble.pending.length > 0 || target.defer.pending.length > 0) {
    if (target.Pebble.pending.length > 0) target.Pebble.ack();
    else target.defer.runNext();
  }
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


test("ready settling is distinct from ACK backpressure deferrals", function () {
  var defer = fakes.createDefer(false);
  var readyDefer = fakes.createDefer(false);
  var target = harness({
    storage: configuredStorage(),
    defer: defer,
    readyDefer: readyDefer
  });

  target.Pebble.emit("ready");
  assert.deepEqual(target.Pebble.sent, []);
  assert.equal(readyDefer.pending.length, 1);
  assert.equal(defer.pending.length, 0);

  readyDefer.runNext();
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

test("stop invalidates a deferred ready synchronization", function () {
  var readyDefer = fakes.createDefer(false);
  var target = harness({
    storage: configuredStorage(),
    readyDefer: readyDefer
  });

  target.Pebble.emit("ready");
  assert.deepEqual(target.Pebble.sent, []);
  target.companion.stop();
  readyDefer.runNext();
  assert.deepEqual(target.Pebble.sent, []);
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

test("ready keeps a missing-key configuration with no favorites unconfigured", function () {
  var target = harness();

  target.Pebble.emit("ready");
  assert.deepEqual(target.Pebble.sent.map(function (message) { return message.MESSAGE_TYPE; }), [
    T.CONFIG_BEGIN,
    T.CONFIG_COMMIT
  ]);
  assert.equal(target.Pebble.sent[0].DISPLAY_NAME, "en");
  assert.equal(target.Pebble.sent[0].KEY_STATUS, contracts.KEY_STATUS.MISSING);
  assert.equal(JSON.stringify(target.Pebble.sent).includes(fixture.favorite.id), false);
  assert.equal(target.xhr.instances.length, 0);
  assert.equal(target.clock.timers.length, 0);
});

test("pypkjs dual request properties are canonicalized only at the event boundary", function () {
  var target = harness({ storage: configuredStorage() });
  var payload = dualRequestPayload("dual-app-open");
  var before;
  var resultBegins;

  target.Pebble.emit("ready");
  before = target.Pebble.sent.length;
  assert.equal(codec.decodeRequest(payload), null);
  target.Pebble.emit("appmessage", { payload: payload });
  assert.equal(target.xhr.instances.length, 1);
  target.xhr.instances[0].respond(200, responseFor("dual-app-open"));

  assert.equal(target.Pebble.sent.length, before + fixture.result.departures.length + 2);
  resultBegins = messagesOfType(target, T.RESULT_BEGIN);
  assert.equal(resultBegins[resultBegins.length - 1].REQUEST_ID, "dual-app-open");
  assert.equal(target.xhr.instances.length, 1);
  assert.equal(target.clock.timers.length, 0);
});

test("incoming event normalization rejects numeric-only, unknown, conflicting, extra, and internal properties", function () {
  var target = harness({ storage: configuredStorage() });
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

test("all three triggers send fresh cache with zero XHR and expired cache before one XHR", function () {
  Object.keys(contracts.REQUEST_TRIGGER).forEach(function (name, index) {
    var trigger = contracts.REQUEST_TRIGGER[name];
    var freshClock = new fakes.FakeClock();
    var freshStorage = configuredStorage();
    var freshResult = responseFor("stored-fresh-" + index);
    var freshTarget;
    var expiredClock = new fakes.FakeClock();
    var expiredStorage = configuredStorage();
    var expiredResult = responseFor("stored-expired-" + index);
    var expiredTarget;
    var sent;

    storeResult(freshStorage, freshResult, freshClock.now());
    freshTarget = harness({ storage: freshStorage, clock: freshClock });
    freshTarget.Pebble.emit("ready");
    sent = freshTarget.Pebble.sent.length;
    sendRequest(freshTarget, "fresh-" + index, trigger);
    assert.equal(freshTarget.xhr.instances.length, 0, name);
    assert.deepEqual(
      freshTarget.Pebble.sent.slice(sent).map(function (message) {
        return message.MESSAGE_TYPE;
      }),
      [T.RESULT_BEGIN, T.DEPARTURE, T.DEPARTURE, T.RESULT_COMMIT],
      name
    );

    expiredResult.fetchedAt -= contracts.CACHE_FRESH_SECONDS;
    storeResult(expiredStorage, expiredResult, expiredClock.now());
    expiredTarget = harness({ storage: expiredStorage, clock: expiredClock });
    expiredTarget.Pebble.emit("ready");
    sent = expiredTarget.Pebble.sent.length;
    sendRequest(expiredTarget, "expired-" + index, trigger);
    assert.equal(expiredTarget.xhr.instances.length, 1, name);
    assert.deepEqual(
      expiredTarget.Pebble.sent.slice(sent).map(function (message) {
        return message.MESSAGE_TYPE;
      }),
      [T.RESULT_BEGIN, T.DEPARTURE, T.DEPARTURE, T.RESULT_COMMIT, T.REQUEST],
      name
    );
    assert.equal(expiredTarget.clock.timers.length, 0, name);
  });
});

test("cache age is exact and a suppressed expired cache sends no redundant mirror", function () {
  var target = harness();
  var before;

  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(target, "network-first");
  target.xhr.instances[0].respond(200, responseFor("network-first"));

  target.clock.advance(59999);
  before = target.Pebble.sent.length;
  sendRequest(target, "fresh-suppressed", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(target.xhr.instances.length, 1);
  assert.equal(target.Pebble.sent.length, before);

  target.clock.advance(1);
  sendRequest(target, "expired-suppressed", contracts.REQUEST_TRIGGER.FAVORITE_SELECTION);
  assert.equal(target.xhr.instances.length, 2);
  assert.equal(target.Pebble.sent.length, before);
});

test("an unchanged live signature is cached without a second result batch", function () {
  var target = harness();
  var seed = responseFor("visible-seed");
  var unchanged;
  var changed;
  var before;
  var third = {
    expectedAt: fixture.result.departures[1].expectedAt + 300,
    minutes: 11,
    status: "ON_TIME"
  };
  var fourth = {
    expectedAt: fixture.result.departures[1].expectedAt + 600,
    minutes: 16,
    status: "UNKNOWN"
  };

  seed.departures.push(third, fourth);
  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(target, "visible-seed");
  target.xhr.instances[0].respond(200, seed);
  target.clock.advance(60000);

  sendRequest(target, "silent-live", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(target.xhr.instances.length, 2);
  before = messagesOfType(target, T.RESULT_BEGIN).length;
  unchanged = responseFor("silent-live");
  unchanged.departures.push(
    Object.assign({}, third),
    Object.assign({}, fourth, { expectedAt: fourth.expectedAt + 60 })
  );
  unchanged.sourceUpdatedAt += 1;
  unchanged.departures[0].minutes += 1;
  unchanged.departures[0].aimedAt += 1;
  target.xhr.instances[1].respond(200, unchanged);
  assert.equal(messagesOfType(target, T.RESULT_BEGIN).length, before);

  sendRequest(target, "changed-live", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(target.xhr.instances.length, 3);
  changed = responseFor("changed-live");
  changed.fetchedAt += 60;
  target.xhr.instances[2].respond(200, changed);
  assert.equal(messagesOfType(target, T.RESULT_BEGIN).length, before + 1);
});

test("an ACKed older result remains suppressible after a later request handoff", function () {
  var storage = configuredStorage();
  var Pebble = new fakes.FakePebble(false);
  var defer = fakes.createDefer(false);
  var target = harness({ storage: storage, Pebble: Pebble, defer: defer });
  var changed = responseFor("ordered-first");
  var before;
  var index;

  target.Pebble.emit("ready");
  drainQueue(target);
  sendRequest(target, "ordered-first");
  changed.fetchedAt += 1;
  target.xhr.instances[0].respond(200, changed);
  drainQueue(target);

  before = target.Pebble.sent.length;
  for (index = 2; index <= 50; index += 1) {
    sendRequest(
      target,
      "ordered-" + index,
      contracts.REQUEST_TRIGGER.MANUAL_SELECT
    );
  }
  assert.equal(target.xhr.instances.length, 1);
  assert.equal(target.Pebble.sent.length, before);
  assert.equal(target.Pebble.pending.length, 0);
  assert.equal(target.defer.pending.length, 0);
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
test("same-favorite requests share one XHR and bind a valid launch response to the latest request", function () {
  var target = harness();
  var outbound;
  var resultBegins;
  var live = responseFor("launch-request");

  live.fetchedAt += 1;
  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(target, "launch-request");
  sendRequest(target, "latest-request", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(target.xhr.instances.length, 1);
  outbound = JSON.parse(target.xhr.instances[0].body);
  assert.deepEqual(outbound, {
    schemaVersion: contracts.SCHEMA_VERSION,
    requestId: "launch-request",
    favoriteId: fixture.favorite.id,
    serviceId: fixture.favorite.serviceId
  });

  target.xhr.instances[0].respond(200, live);
  resultBegins = messagesOfType(target, T.RESULT_BEGIN);
  assert.equal(resultBegins.length, 1);
  assert.equal(resultBegins[0].REQUEST_ID, "latest-request");
  assert.equal(resultBegins[0].FETCHED_AT, live.fetchedAt);
});

test("same-favorite single-flight validates the immutable launch identity", function () {
  var target = harness();
  var errors;

  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(target, "immutable-launch");
  sendRequest(target, "latest-binding", contracts.REQUEST_TRIGGER.FAVORITE_SELECTION);
  assert.equal(target.xhr.instances.length, 1);
  target.xhr.instances[0].respond(200, responseFor("latest-binding"));

  assert.equal(messagesOfType(target, T.RESULT_BEGIN).length, 0);
  errors = messagesOfType(target, T.ERROR);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].REQUEST_ID, "latest-binding");
  assert.equal(
    errors[0].ERROR_CODE,
    contracts.ERROR_CODE.indexOf("INVALID_RESPONSE")
  );
});


test("missing, invalid, empty, and unknown favorite paths start zero XHR", function () {
  var missing = harness();
  var invalid = harness({
    storage: configuredStorage([fixture.favorite], contracts.KEY_STATUS.INVALID)
  });
  var empty = harness();
  var unknown = harness({ storage: configuredStorage() });
  var errors;

  closeWith(missing, configurationPayload("REMOVE"));
  sendRequest(missing, "missing-key");
  assert.equal(missing.xhr.instances.length, 0);
  errors = messagesOfType(missing, T.ERROR);
  assert.equal(errors[0].ERROR_CODE, contracts.ERROR_CODE.indexOf("API_KEY_REQUIRED"));

  invalid.Pebble.emit("ready");
  sendRequest(invalid, "invalid-key");
  assert.equal(invalid.xhr.instances.length, 0);
  errors = messagesOfType(invalid, T.ERROR);
  assert.equal(errors[0].ERROR_CODE, contracts.ERROR_CODE.indexOf("API_KEY_INVALID"));

  closeWith(empty, configurationPayload("REPLACE", TEST_KEY, []));
  sendRequest(empty, "no-favorite");
  assert.equal(empty.xhr.instances.length, 0);
  errors = messagesOfType(empty, T.ERROR);
  assert.equal(errors[0].ERROR_CODE, contracts.ERROR_CODE.indexOf("INVALID_SERVICE"));

  unknown.Pebble.emit("ready");
  sendRequest(unknown, "unknown-favorite", undefined, SECOND_FAVORITE);
  assert.equal(unknown.xhr.instances.length, 0);
  errors = messagesOfType(unknown, T.ERROR);
  assert.equal(errors[0].ERROR_CODE, contracts.ERROR_CODE.indexOf("INVALID_SERVICE"));
});

test("different favorites own independent flights and inactive completion is cache-only", function () {
  var target = harness();
  var first = responseFor("a-seed");
  var aBegins;
  var before;

  first.fetchedAt += 60;
  closeWith(target, configurationPayload(
    "REPLACE",
    TEST_KEY,
    [fixture.favorite, SECOND_FAVORITE]
  ));
  sendRequest(target, "a-seed");
  target.xhr.instances[0].respond(200, first);
  target.clock.advance(60000);

  sendRequest(target, "a-refresh", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  sendRequest(
    target,
    "b-launch",
    contracts.REQUEST_TRIGGER.FAVORITE_SELECTION,
    SECOND_FAVORITE
  );
  assert.equal(target.xhr.instances.length, 3);
  before = messagesOfType(target, T.RESULT_BEGIN).length;

  target.xhr.instances[1].respond(
    200,
    contracts.copyDepartureResult(first, "a-refresh")
  );
  assert.equal(messagesOfType(target, T.RESULT_BEGIN).length, before);
  target.xhr.instances[2].respond(200, responseFor("b-launch", SECOND_FAVORITE));

  sendRequest(target, "a-return", contracts.REQUEST_TRIGGER.FAVORITE_SELECTION);
  assert.equal(target.xhr.instances.length, 3);
  aBegins = messagesOfType(target, T.RESULT_BEGIN).filter(function (message) {
    return message.FAVORITE_ID === fixture.favorite.id;
  });
  assert.equal(aBegins[aBegins.length - 1].REQUEST_ID, "a-return");
  assert.equal(aBegins[aBegins.length - 1].FETCHED_AT, first.fetchedAt);
});

test("an inactive favorite failure is transport-inert while the current error is sent", function () {
  var target = harness();
  var before;
  var errors;

  closeWith(target, configurationPayload(
    "REPLACE",
    TEST_KEY,
    [fixture.favorite, SECOND_FAVORITE]
  ));
  sendRequest(target, "inactive-failure");
  sendRequest(
    target,
    "current-failure",
    contracts.REQUEST_TRIGGER.FAVORITE_SELECTION,
    SECOND_FAVORITE
  );
  assert.equal(target.xhr.instances.length, 2);
  before = target.Pebble.sent.length;
  target.xhr.instances[0].networkError();
  assert.equal(target.Pebble.sent.length, before);

  target.xhr.instances[1].networkError();
  errors = messagesOfType(target, T.ERROR);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].REQUEST_ID, "current-failure");
  assert.equal(errors[0].FAVORITE_ID, SECOND_FAVORITE.id);
});

test("visible signature changes each enqueue one atomic replacement", function () {
  var cases = [
    {
      name: "fetchedAt",
      change: function (result) { result.fetchedAt += 60; }
    },
    {
      name: "freshness",
      change: function (result) { result.freshness = "SCHEDULED"; }
    },
    {
      name: "expectedAt",
      change: function (result) { result.departures[0].expectedAt += 1; }
    },
    {
      name: "status",
      change: function (result) { result.departures[0].status = "CANCELLED"; }
    },
    {
      name: "nextIntervalMinutes",
      change: function (result) { delete result.departures[0].nextIntervalMinutes; }
    }
  ];

  cases.forEach(function (item, index) {
    var target = harness();
    var seed = responseFor("signature-seed-" + index);
    var replacement;
    var before;
    closeWith(target, configurationPayload("REPLACE", TEST_KEY));
    sendRequest(target, "signature-seed-" + index);
    target.xhr.instances[0].respond(200, seed);
    target.clock.advance(60000);
    sendRequest(target, "signature-live-" + index);
    before = messagesOfType(target, T.RESULT_BEGIN).length;
    replacement = responseFor("signature-live-" + index);
    item.change(replacement);
    target.xhr.instances[1].respond(200, replacement);
    assert.equal(
      messagesOfType(target, T.RESULT_BEGIN).length,
      before + 1,
      item.name
    );
  });
});

test("delayed ACKs retain only one latest-bound same-signature replacement", function () {
  var storage = configuredStorage();
  var clock = new fakes.FakeClock();
  var Pebble = new fakes.FakePebble(false);
  var defer = fakes.createDefer(false);
  var stored = responseFor("coalesced-stored");
  var target;
  var baseline;
  var latestRequestId = null;
  var sent;
  var batchLength;
  var index;

  stored.fetchedAt -= contracts.CACHE_FRESH_SECONDS;
  storeResult(storage, stored, clock.now());
  target = harness({ storage: storage, clock: clock, Pebble: Pebble, defer: defer });
  target.Pebble.emit("ready");
  drainQueue(target);
  baseline = target.Pebble.sent.length;

  sendRequest(target, "coalesced-1");
  for (index = 2; index <= 50; index += 1) {
    latestRequestId = "coalesced-" + index;
    sendRequest(
      target,
      latestRequestId,
      contracts.REQUEST_TRIGGER.MANUAL_SELECT
    );
  }
  assert.equal(target.xhr.instances.length, 1);
  assert.equal(target.Pebble.sent.length, baseline + 1);

  drainQueue(target);
  sent = target.Pebble.sent.slice(baseline);
  batchLength = stored.departures.length + 3;
  assert.equal(sent.length, batchLength * 2);
  assert.equal(sent.slice(0, batchLength).every(function (message) {
    return message.REQUEST_ID === "coalesced-1";
  }), true);
  assert.equal(sent.slice(batchLength).every(function (message) {
    return message.REQUEST_ID === latestRequestId;
  }), true);
  assert.deepEqual(sent.map(function (message) {
    return message.MESSAGE_TYPE;
  }), [
    T.RESULT_BEGIN,
    T.DEPARTURE,
    T.DEPARTURE,
    T.RESULT_COMMIT,
    T.REQUEST,
    T.RESULT_BEGIN,
    T.DEPARTURE,
    T.DEPARTURE,
    T.RESULT_COMMIT,
    T.REQUEST
  ]);
  assert.equal(target.Pebble.maxInFlight, 1);
  assert.equal(target.Pebble.pending.length, 0);
  assert.equal(target.defer.pending.length, 0);
});

test("queue NACK clears superseded result batches without retrying or duplicating XHR", function () {
  var storage = configuredStorage();
  var clock = new fakes.FakeClock();
  var Pebble = new fakes.FakePebble(false);
  var defer = fakes.createDefer(false);
  var stored = responseFor("stored-pending");
  var target;
  var before;

  stored.fetchedAt -= 60;
  storeResult(storage, stored, clock.now());
  target = harness({ storage: storage, clock: clock, Pebble: Pebble, defer: defer });
  target.Pebble.emit("ready");
  drainQueue(target);

  sendRequest(target, "pending-first");
  assert.equal(target.xhr.instances.length, 1);
  before = target.Pebble.sent.length;
  sendRequest(target, "pending-latest", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(target.Pebble.sent.length, before);
  assert.equal(target.xhr.instances.length, 1);

  target.Pebble.fail();
  assert.equal(target.Pebble.sent.length, before);
  assert.equal(target.defer.pending.length, 0);
  sendRequest(target, "pending-after-nack");
  assert.equal(target.Pebble.sent.length, before + 1);
  assert.equal(target.xhr.instances.length, 1);
});

test("accepted configuration changes abort flights and make late callbacks inert", function () {
  var target = harness();
  var flight;
  var before;

  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(target, "before-config-change");
  flight = target.xhr.instances[0];
  flight.abort = function () { this.aborted = true; };
  closeWith(target, configurationPayload("KEEP"));
  assert.equal(flight.aborted, true);

  before = target.Pebble.sent.length;
  flight.respond(200, responseFor("before-config-change"));
  assert.equal(target.Pebble.sent.length, before);
  sendRequest(target, "after-config-change");
  assert.equal(target.xhr.instances.length, 2);
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

test("network failure emits one latest-bound sanitized error without retry", function () {
  var target = harness();
  var errors;
  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  sendRequest(target, "network-launch");
  sendRequest(target, "network-latest", contracts.REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(target.xhr.instances.length, 1);
  target.xhr.instances[0].networkError();
  errors = messagesOfType(target, T.ERROR);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].REQUEST_ID, "network-latest");
  assert.equal(errors[0].ERROR_CODE, contracts.ERROR_CODE.indexOf("SOURCE_UNAVAILABLE"));
  assert.equal(target.xhr.instances.length, 1);
  assert.equal(target.clock.timers.length, 0);
  assert.equal(JSON.stringify(errors).includes(TEST_KEY), false);
});

test("throwing XHR constructor emits one current sanitized error without retry", function () {
  var target;
  var errors;

  function ThrowingXHR() {
    throw new Error("constructor failure " + TEST_KEY);
  }

  target = harness({
    storage: configuredStorage(),
    XHR: ThrowingXHR
  });
  sendRequest(target, "constructor-failure", contracts.REQUEST_TRIGGER.MANUAL_SELECT);

  errors = messagesOfType(target, T.ERROR);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].REQUEST_ID, "constructor-failure");
  assert.equal(errors[0].FAVORITE_ID, fixture.favorite.id);
  assert.equal(
    errors[0].ERROR_CODE,
    contracts.ERROR_CODE.indexOf("SOURCE_UNAVAILABLE")
  );
  assert.equal(target.xhr.instances.length, 0);
  assert.equal(target.companion.metrics().requests, 0);
  assert.equal(target.companion.metrics().failures, 1);
  assert.equal(target.clock.timers.length, 0);
  assert.equal(JSON.stringify(errors).includes(TEST_KEY), false);

  target.clock.advance(3600000);
  assert.equal(messagesOfType(target, T.ERROR).length, 1);
});

test("build bootstrap keeps ACK and one-shot ready settling schedulers distinct", async function () {
  var build = await import("../../../scripts/build.mjs");
  var configured;
  var captured = null;
  var scheduled = [];
  var deferred = false;
  var readyDeferred = false;
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
  source = build.createBootstrap(configured);
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
  captured.readyDefer(function () { readyDeferred = true; });
  assert.equal(deferred, false);
  assert.equal(readyDeferred, false);
  assert.equal(scheduled.length, 2);
  assert.equal(scheduled[0].delay, 0);
  assert.equal(scheduled[1].delay, 250);
  scheduled[0].callback();
  scheduled[1].callback();
  assert.equal(deferred, true);
  assert.equal(readyDeferred, true);
  assert.equal(captured.backendUrl, configured.backendUrl);
  assert.equal(captured.configurationUrl, configured.configurationUrl);
  assert.deepEqual(Object.keys(captured), [
    "Pebble",
    "storage",
    "XHR",
    "clock",
    "defer",
    "readyDefer",
    "backendUrl",
    "configurationUrl"
  ]);
  assert.equal(source.includes("fixture"), false);
  assert.equal(source.includes("LAPIN_FUTE_"), false);
  assert.equal(source.includes(TEST_KEY), false);
});
