"use strict";

var test = require("node:test");
var assert = require("node:assert/strict");
var path = require("node:path");
var url = require("node:url");
var companion = require("../src");
var fixture = require("../../../fixtures/departures/foundation.json");
var fakes = require("./fakes");

var contracts = companion.contracts;
var codec = companion.codec;

async function sharedContracts() {
  var contractPath = path.resolve(__dirname, "../../contracts/src/index.ts");
  return import(url.pathToFileURL(contractPath).href);
}

test("PebbleKit constants exactly mirror the canonical alias and numeric contracts", async function () {
  var shared = await sharedContracts();
  assert.deepEqual(contracts.APP_MESSAGE_KEY_ORDER, shared.APP_MESSAGE_KEY_ORDER);
  assert.deepEqual(contracts.APP_MESSAGE_KEY, shared.APP_MESSAGE_KEY);
  assert.deepEqual(contracts.MESSAGE_TYPE, shared.MESSAGE_TYPE);
  assert.deepEqual(contracts.KEY_STATUS, shared.KEY_STATUS);
  assert.deepEqual(contracts.REQUEST_TRIGGER, shared.REQUEST_TRIGGER);
  assert.deepEqual(contracts.TRANSPORT_MODE, shared.TRANSPORT_MODE);
  assert.deepEqual(contracts.WIRE_LANGUAGE, shared.WIRE_LANGUAGE);
  assert.deepEqual(contracts.LIMITS, shared.LIMITS);
  assert.equal(contracts.SCHEMA_VERSION, shared.SCHEMA_VERSION);
  assert.equal(contracts.CACHE_FRESH_SECONDS, shared.CACHE_FRESH_SECONDS);
  assert.equal(contracts.FAVORITE_SETTLE_MS, shared.FAVORITE_SETTLE_MS);
});

test("presentation fields form an optional complete group and remain outside AppMessage", function () {
  var copied = contracts.copyFavorite(fixture.favorite);
  var legacy;
  var legacyCopy;
  var presentationFields = ["lineMode", "lineColor", "lineTextColor"];
  assert.deepEqual(copied, fixture.favorite);
  assert.equal(contracts.isFavorite(copied), true);
  assert.equal(contracts.isFavorite(Object.assign({}, copied, { lineColor: "#FFBE00" })), false);
  assert.equal(contracts.isFavorite(Object.assign({}, copied, { lineMode: "metro" })), false);
  delete copied.lineTextColor;
  assert.equal(contracts.isFavorite(copied), false);

  legacy = contracts.copyFavorite(fixture.favorite);
  presentationFields.forEach(function (field) { delete legacy[field]; });
  assert.equal(contracts.isFavorite(legacy), true);
  assert.equal(contracts.isFavorite(Object.assign({}, legacy, { lineMode: "METRO" })), false);
  assert.equal(contracts.isFavorite(Object.assign({}, legacy, {
    lineMode: "METRO",
    lineColor: "#ffbe00"
  })), false);
  legacyCopy = contracts.copyFavorite(legacy);
  assert.deepEqual(legacyCopy, legacy);
  presentationFields.forEach(function (field) {
    assert.equal(Object.prototype.hasOwnProperty.call(legacyCopy, field), false);
  });

  assert.equal(codec.encodeConfiguration(
    "presentation-wire",
    [fixture.favorite],
    contracts.KEY_STATUS.CONFIGURED,
    "en"
  ).some(function (message) {
    return Object.prototype.hasOwnProperty.call(message, "lineMode")
      || Object.prototype.hasOwnProperty.call(message, "lineColor")
      || Object.prototype.hasOwnProperty.call(message, "lineTextColor");
  }), false);
});

test("recorded fixture round trips through symbolic configuration and result payloads", async function () {
  var shared = await sharedContracts();
  var receiver = new shared.ProtocolReceiver();
  var configurationMessages;
  var resultMessages;
  var request;

  assert.equal(shared.isFavorite(fixture.favorite), true);
  assert.equal(shared.isDepartureResult(fixture.result), true);
  configurationMessages = codec.encodeConfiguration(
    "config-round-trip",
    [fixture.favorite],
    contracts.KEY_STATUS.CONFIGURED,
    "fr"
  );
  configurationMessages.forEach(function (message) {
    assert.equal(Object.keys(message).some(function (key) { return /^[0-9]+$/.test(key); }), false);
    assert.equal(shared.isAppMessage(message), true);
    assert.equal(receiver.receive(message), true);
  });
  assert.equal(receiver.committed.configuration.language, "fr");
  assert.equal(receiver.committed.configuration.favorites.length, 1);

  assert.equal(receiver.expectResponse(fixture.result.requestId, fixture.result.favoriteId), true);
  resultMessages = codec.encodeResult(fixture.result);
  resultMessages.forEach(function (message) {
    assert.equal(Object.keys(message).some(function (key) { return /^[0-9]+$/.test(key); }), false);
    assert.equal(shared.isAppMessage(message), true);
    assert.equal(receiver.receive(message), true);
  });
  assert.equal(receiver.committed.result.departures.length, 2);

  request = codec.encodeRequest({
    requestId: "request-round-trip",
    favoriteId: fixture.favorite.id,
    trigger: contracts.REQUEST_TRIGGER.MANUAL_SELECT
  });
  assert.deepEqual(codec.decodeRequest(request), {
    requestId: "request-round-trip",
    favoriteId: fixture.favorite.id,
    trigger: contracts.REQUEST_TRIGGER.MANUAL_SELECT
  });
  assert.equal(shared.isAppMessage(request), true);
});

test("configuration encoder requires a normalized contextual language", function () {
  assert.throws(function () {
    codec.encodeConfiguration("config-1", [], contracts.KEY_STATUS.MISSING, "fr_FR");
  }, /language must be en or fr/);
  assert.equal(
    codec.encodeConfiguration("config-1", [], contracts.KEY_STATUS.MISSING, "en")[0].DISPLAY_NAME,
    "en"
  );
});

test("callback queue completes batches only after their final ACK and preserves FIFO deferral", function () {
  var Pebble = new fakes.FakePebble(false);
  var defer = fakes.createDefer(false);
  var failures = [];
  var completions = [];
  var queue = new companion.MessageQueue(Pebble, defer, function (code) { failures.push(code); });

  queue.enqueue(
    [{ id: "batch-a-1" }, { id: "batch-a-2" }],
    function () { completions.push("a"); }
  );
  queue.enqueue([{ id: "batch-b-1" }], function () { completions.push("b"); });
  assert.deepEqual(Pebble.sent.map(function (message) { return message.id; }), ["batch-a-1"]);
  assert.equal(Pebble.maxInFlight, 1);

  Pebble.ack();
  assert.deepEqual(completions, []);
  assert.deepEqual(Pebble.sent.map(function (message) { return message.id; }), ["batch-a-1"]);
  assert.equal(defer.pending.length, 1);
  queue.enqueue([{ id: "batch-c-1" }], function () { completions.push("c"); });
  assert.equal(defer.pending.length, 1);

  defer.runNext();
  Pebble.ack();
  assert.deepEqual(completions, ["a"]);
  assert.deepEqual(Pebble.sent.map(function (message) { return message.id; }), [
    "batch-a-1",
    "batch-a-2"
  ]);
  defer.runNext();
  Pebble.ack();
  assert.deepEqual(completions, ["a", "b"]);
  defer.runNext();
  Pebble.ack();

  assert.deepEqual(Pebble.sent.map(function (message) { return message.id; }), [
    "batch-a-1",
    "batch-a-2",
    "batch-b-1",
    "batch-c-1"
  ]);
  assert.deepEqual(completions, ["a", "b", "c"]);
  assert.equal(defer.pending.length, 0);
  assert.equal(queue.isSending(), false);
  assert.deepEqual(failures, []);
});

test("clear invalidates a stale deferred advance without blocking a new batch", function () {
  var Pebble = new fakes.FakePebble(false);
  var defer = fakes.createDefer(false);
  var failures = [];
  var queue = new companion.MessageQueue(Pebble, defer, function (code) { failures.push(code); });

  queue.enqueue([{ id: "discarded-1" }, { id: "discarded-2" }]);
  Pebble.ack();
  assert.equal(defer.pending.length, 1);
  queue.clear();
  queue.enqueue([{ id: "fresh" }]);
  assert.deepEqual(Pebble.sent.map(function (message) { return message.id; }), ["discarded-1", "fresh"]);

  defer.runNext();
  assert.deepEqual(Pebble.sent.map(function (message) { return message.id; }), ["discarded-1", "fresh"]);
  Pebble.ack();
  assert.equal(queue.isSending(), false);
  assert.deepEqual(failures, []);
});

test("a stale failure cannot clear or fail a newer queue generation", function () {
  var Pebble = new fakes.FakePebble(false);
  var defer = fakes.createDefer(false);
  var failures = [];
  var queue = new companion.MessageQueue(Pebble, defer, function (code) { failures.push(code); });

  queue.enqueue([{ id: "discarded" }]);
  queue.clear();
  queue.enqueue([{ id: "fresh" }]);
  Pebble.fail();

  assert.deepEqual(failures, []);
  assert.deepEqual(Pebble.sent.map(function (message) { return message.id; }), ["discarded"]);
  assert.equal(defer.pending.length, 1);

  defer.runNext();
  assert.deepEqual(Pebble.sent.map(function (message) { return message.id; }), ["discarded", "fresh"]);
  Pebble.ack();
  assert.equal(queue.isSending(), false);
  assert.deepEqual(failures, []);
});

test("failed AppMessage drops the batch without retry or completion", function () {
  var Pebble = new fakes.FakePebble(false);
  var defer = fakes.createDefer(false);
  var failures = [];
  var completions = [];
  var queue = new companion.MessageQueue(Pebble, defer, function (code) { failures.push(code); });

  queue.enqueue(
    [{ SCHEMA_VERSION: 1 }, { MESSAGE_TYPE: 2 }],
    function () { completions.push("complete"); }
  );
  Pebble.fail();
  assert.equal(Pebble.sent.length, 1);
  assert.equal(defer.pending.length, 0);
  assert.deepEqual(failures, ["APP_MESSAGE_FAILED"]);
  assert.deepEqual(completions, []);
  assert.equal(queue.isSending(), false);
});

test("synchronous AppMessage failure drops the batch and reports one failure", function () {
  var Pebble = new fakes.FakePebble(false);
  var defer = fakes.createDefer(false);
  var failures = [];
  var completions = [];
  var queue;
  Pebble.sendAppMessage = function (message) {
    this.sent.push(message);
    throw new Error("synchronous send failure");
  };
  queue = new companion.MessageQueue(Pebble, defer, function (code) {
    failures.push(code);
  });

  queue.enqueue([{ id: "throws" }], function () { completions.push("complete"); });
  assert.deepEqual(Pebble.sent, [{ id: "throws" }]);
  assert.deepEqual(failures, ["APP_MESSAGE_FAILED"]);
  assert.deepEqual(completions, []);
  assert.equal(queue.isSending(), false);
  assert.equal(defer.pending.length, 0);
});
