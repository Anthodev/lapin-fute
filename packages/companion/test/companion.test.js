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

function harness(options) {
  var Pebble = new fakes.FakePebble(true);
  var storage = new fakes.FakeStorage();
  var clock = new fakes.FakeClock();
  var xhr = fakes.createXHRFactory();
  var defer;
  var instance;
  options = options || {};
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

function sendRequest(target, requestId) {
  target.Pebble.emit("appmessage", {
    payload: codec.encodeRequest({
      requestId: requestId,
      favoriteId: fixture.favorite.id,
      trigger: contracts.REQUEST_TRIGGER.APP_OPEN
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

test("close fragment atomically stores one favorites-and-key record and exposes the key only to Authorization", function () {
  var target = harness();
  var stored;
  var sentText;
  var pageState;

  closeWith(target, configurationPayload("REPLACE", TEST_KEY));
  assert.deepEqual(target.storage.keys(), [configuration.STORAGE_KEY]);
  assert.equal(target.storage.writes.length, 1);
  stored = JSON.parse(target.storage.getItem(configuration.STORAGE_KEY));
  assert.equal(stored.apiKey, TEST_KEY);
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

  storage.setItem(configuration.STORAGE_KEY, JSON.stringify(legacyRecord));
  loaded = configuration.loadConfiguration(storage);

  assert.deepEqual(loaded, legacyRecord);
  assert.equal(loaded.apiKey, TEST_KEY);
  assert.equal(loaded.favorites.length, 1);
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
  stored = JSON.parse(target.storage.getItem(configuration.STORAGE_KEY));
  assert.equal(stored.apiKey, TEST_KEY);
  assert.deepEqual(target.storage.keys(), [configuration.STORAGE_KEY]);

  closeWith(target, configurationPayload("REMOVE"));
  stored = JSON.parse(target.storage.getItem(configuration.STORAGE_KEY));
  assert.equal(stored.apiKey, null);
  assert.deepEqual(target.storage.keys(), [configuration.STORAGE_KEY]);
  assert.equal(target.storage.writes.length, 3);
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
  stored = JSON.parse(target.storage.getItem(configuration.STORAGE_KEY));
  assert.equal(JSON.stringify(stored.favorites).includes(TEST_KEY), false);
  assert.equal(stored.apiKey, TEST_KEY);
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
