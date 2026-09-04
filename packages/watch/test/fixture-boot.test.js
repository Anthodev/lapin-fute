import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createController } from "../src/embeddedjs/controller.js";
import WatchModel, { WATCH_STATE } from "../src/embeddedjs/model.js";
import { createPresentation } from "../src/embeddedjs/presentation.js";
import { RECEIVE_RESULT } from "../src/embeddedjs/protocol.js";

const require = createRequire(import.meta.url);
const companion = require("../../companion/src/index.js");
const fakes = require("../../companion/test/fakes.js");
const fixture = require("../../../fixtures/departures/foundation.json");

const contracts = companion.contracts;
const codec = companion.codec;
const T = contracts.MESSAGE_TYPE;
const TEST_KEY = "test-personal-prim-key";

class WatchQueue {
  constructor() {
    this.messages = [];
  }

  enqueue(message) {
    this.messages.push(message);
    return true;
  }

  close() {}
}

class WatchView {
  constructor() {
    this.frames = [];
    this.screenInfo = { round: false, hour12: false };
  }

  render(snapshot) {
    this.frames.push({
      snapshot,
      presentation: createPresentation(snapshot, this.screenInfo)
    });
  }

  close() {}
}

function aliasMap(dictionary) {
  return new Map(Object.entries(dictionary));
}

function messageTypes(messages) {
  return messages.map((message) => message.MESSAGE_TYPE);
}

function expiredResult(clock) {
  const result = contracts.copyDepartureResult(fixture.result, "cached-seed");
  result.fetchedAt = Math.floor(clock.now() / 1000) - contracts.CACHE_FRESH_SECONDS;
  result.sourceUpdatedAt = result.fetchedAt - 10;
  return result;
}

function configuredStorage(result, storedAt) {
  const storage = new fakes.FakeStorage();
  assert.equal(companion.configuration.saveConfiguration(storage, {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: [fixture.favorite],
    primApiKey: TEST_KEY,
    keyStatus: contracts.KEY_STATUS.CONFIGURED
  }), true);
  assert.equal(companion.configuration.saveResults(storage, {
    schemaVersion: contracts.SCHEMA_VERSION,
    results: [{
      favoriteId: result.favoriteId,
      storedAt,
      result
    }]
  }), true);
  storage.writes.length = 0;
  return storage;
}

function harness(options = {}) {
  const clock = new fakes.FakeClock(fixture.result.fetchedAt * 1000);
  const cachedResult = expiredResult(clock);
  const storage = configuredStorage(cachedResult, clock.now());
  const manualPhoneTransport = options.manualPhoneTransport === true;
  const Pebble = new fakes.FakePebble(!manualPhoneTransport);
  const defer = fakes.createDefer(!manualPhoneTransport);
  const readyDefer = fakes.createDefer(!manualPhoneTransport);
  const xhr = fakes.createXHRFactory();
  const phone = companion.createCompanion({
    Pebble,
    storage,
    XHR: xhr.XHR,
    clock,
    defer,
    readyDefer,
    backendUrl: "https://backend.example.test/departures",
    configurationUrl: "https://config.example.test/index.html"
  });
  const watchQueue = new WatchQueue();
  const watchView = new WatchView();
  const scheduler = {
    set(callback, delayMs) {
      return clock.setTimeout(callback, delayMs);
    },
    clear(timerId) {
      clock.clearTimeout(timerId);
    }
  };
  const controller = createController({
    clock,
    queue: watchQueue,
    scheduler,
    model: new WatchModel(),
    view: watchView
  }).start();
  return {
    cachedResult,
    clock,
    controller,
    defer,
    readyDefer,
    Pebble,
    phone,
    phoneCursor: 0,
    storage,
    watchCursor: 0,
    watchQueue,
    watchView,
    xhr
  };
}

function takePhoneMessages(target) {
  const messages = target.Pebble.sent.slice(target.phoneCursor);
  target.phoneCursor = target.Pebble.sent.length;
  return messages;
}

function deliverPhoneMessages(target, messages) {
  return messages.map((message) => target.controller.onReadable(aliasMap(message)));
}

function pendingPhoneMessage(target) {
  assert.equal(target.Pebble.pending.length, 1);
  const message = target.Pebble.sent[target.phoneCursor];
  assert.ok(message);
  target.phoneCursor += 1;
  return message;
}

function receiveAndAckPhoneMessage(target) {
  const message = pendingPhoneMessage(target);
  const received = target.controller.onReadable(aliasMap(message));
  target.Pebble.ack();
  return { message, received };
}

function nackPhoneMessage(target) {
  const message = pendingPhoneMessage(target);
  target.Pebble.fail();
  return message;
}

function advancePhoneQueue(target) {
  assert.equal(target.defer.pending.length, 1);
  target.defer.runNext();
  assert.equal(target.Pebble.pending.length, 1);
}

function receiveAndAckPhoneSequence(target, types) {
  return types.map((type, index) => {
    if (index > 0) advancePhoneQueue(target);
    const settled = receiveAndAckPhoneMessage(target);
    assert.equal(settled.message.MESSAGE_TYPE, type);
    return settled;
  });
}

function forwardWatchRequest(target) {
  const message = target.watchQueue.messages[target.watchCursor];
  assert.ok(message instanceof Map);
  target.watchCursor += 1;
  const payload = Object.fromEntries(message);
  target.Pebble.emit("appmessage", { payload });
  return payload;
}

function beginCachedConsultation(target) {
  target.Pebble.emit("ready");
  const configurationMessages = takePhoneMessages(target);
  assert.deepEqual(messageTypes(configurationMessages), [
    T.CONFIG_BEGIN,
    T.FAVORITE,
    T.CONFIG_COMMIT
  ]);
  assert.deepEqual(deliverPhoneMessages(target, configurationMessages), [
    RECEIVE_RESULT.STAGED,
    RECEIVE_RESULT.STAGED,
    RECEIVE_RESULT.CONFIG_COMMITTED
  ]);

  assert.equal(target.watchQueue.messages.length, 1);
  const request = forwardWatchRequest(target);
  assert.equal(request.MESSAGE_TYPE, T.REQUEST);
  assert.equal(request.FAVORITE_ID, fixture.favorite.id);
  assert.equal(request.REQUEST_TRIGGER, contracts.REQUEST_TRIGGER.APP_OPEN);
  assert.equal(target.xhr.instances.length, 1);

  const cachedMessages = takePhoneMessages(target);
  assert.deepEqual(messageTypes(cachedMessages), [
    T.RESULT_BEGIN,
    T.DEPARTURE,
    T.DEPARTURE,
    T.RESULT_COMMIT,
    T.REQUEST
  ]);
  const rendersBeforeCache = target.watchView.frames.length;
  assert.deepEqual(deliverPhoneMessages(target, cachedMessages), [
    RECEIVE_RESULT.STAGED,
    RECEIVE_RESULT.STAGED,
    RECEIVE_RESULT.STAGED,
    RECEIVE_RESULT.RESULT_COMMITTED,
    RECEIVE_RESULT.STAGED
  ]);
  assert.equal(target.watchView.frames.length, rendersBeforeCache + 1);

  const cachedFrame = target.watchView.frames.at(-1);
  assert.equal(cachedFrame.snapshot.state, WATCH_STATE.STALE);
  assert.equal(cachedFrame.snapshot.result.requestId, request.REQUEST_ID);
  assert.equal(cachedFrame.snapshot.result.favoriteId, fixture.favorite.id);
  assert.equal(target.xhr.instances[0].status, 0);
  assert.equal(target.xhr.instances[0].responseText, "");
  return { cachedFrame, request };
}

test("expired cache commits before one changed live result replaces it atomically", (t) => {
  const target = harness();
  t.after(() => {
    target.phone.stop();
    target.controller.close();
  });
  const { cachedFrame, request } = beginCachedConsultation(target);
  const changedLive = contracts.copyDepartureResult(fixture.result, request.REQUEST_ID);
  changedLive.fetchedAt = Math.floor(target.clock.now() / 1000);
  changedLive.sourceUpdatedAt = changedLive.fetchedAt - 1;
  changedLive.departures[0].expectedAt += 60;
  changedLive.departures[0].minutes += 1;

  const interrupted = codec.encodeResult(changedLive);
  const mismatchedDeparture = {
    ...interrupted[2],
    REQUEST_ID: "mismatched-live"
  };
  const cachedFrameCount = target.watchView.frames.length;
  assert.deepEqual([
    target.controller.onReadable(aliasMap(interrupted[0])),
    target.controller.onReadable(aliasMap(interrupted[1])),
    target.controller.onReadable(aliasMap(mismatchedDeparture)),
    target.controller.onReadable(aliasMap(interrupted.at(-1)))
  ], [
    RECEIVE_RESULT.STAGED,
    RECEIVE_RESULT.STAGED,
    RECEIVE_RESULT.REJECTED,
    RECEIVE_RESULT.REJECTED
  ]);
  assert.equal(target.watchView.frames.length, cachedFrameCount);
  assert.deepEqual(target.watchView.frames.at(-1).presentation, cachedFrame.presentation);

  target.xhr.instances[0].respond(200, changedLive);
  const liveMessages = takePhoneMessages(target);
  assert.deepEqual(messageTypes(liveMessages), [
    T.RESULT_BEGIN,
    T.DEPARTURE,
    T.DEPARTURE,
    T.RESULT_COMMIT
  ]);
  const liveOutcomes = deliverPhoneMessages(target, liveMessages);
  assert.deepEqual(liveOutcomes, [
    RECEIVE_RESULT.STAGED,
    RECEIVE_RESULT.STAGED,
    RECEIVE_RESULT.STAGED,
    RECEIVE_RESULT.RESULT_COMMITTED
  ]);
  assert.equal(
    liveOutcomes.filter((outcome) => outcome === RECEIVE_RESULT.RESULT_COMMITTED).length,
    1
  );
  assert.equal(target.watchView.frames.length, cachedFrameCount + 1);

  const liveFrame = target.watchView.frames.at(-1);
  assert.equal(liveFrame.snapshot.state, WATCH_STATE.READY);
  assert.equal(liveFrame.snapshot.result.requestId, request.REQUEST_ID);
  assert.notDeepEqual(liveFrame.presentation, cachedFrame.presentation);
});

test("an unchanged live signature sends no second result batch or visible frame", (t) => {
  const target = harness();
  t.after(() => {
    target.phone.stop();
    target.controller.close();
  });
  const { cachedFrame, request } = beginCachedConsultation(target);
  const unchangedLive = contracts.copyDepartureResult(
    target.cachedResult,
    request.REQUEST_ID
  );
  unchangedLive.sourceUpdatedAt += 1;
  unchangedLive.departures[0].aimedAt += 1;
  unchangedLive.departures[0].minutes += 1;
  unchangedLive.departures[1].minutes += 1;
  const frameCount = target.watchView.frames.length;
  const sentCount = target.Pebble.sent.length;

  target.xhr.instances[0].respond(200, unchangedLive);

  assert.deepEqual(takePhoneMessages(target), []);
  assert.equal(target.Pebble.sent.length, sentCount);
  assert.equal(
    target.Pebble.sent.filter((message) => message.MESSAGE_TYPE === T.RESULT_BEGIN).length,
    1
  );
  assert.equal(target.phone.metrics().successes, 1);
  assert.equal(target.watchView.frames.length, frameCount);
  assert.strictEqual(target.watchView.frames.at(-1), cachedFrame);
  assert.deepEqual(target.watchView.frames.at(-1).presentation, cachedFrame.presentation);
});

test("same-favorite supersession accepts the ordered mirror and suppresses matching replay", (t) => {
  const target = harness({ manualPhoneTransport: true });
  t.after(() => {
    target.phone.stop();
    target.controller.close();
  });

  target.Pebble.emit("ready");
  target.readyDefer.runNext();
  const configurationMessages = receiveAndAckPhoneSequence(target, [
    T.CONFIG_BEGIN,
    T.FAVORITE,
    T.CONFIG_COMMIT
  ]);
  assert.deepEqual(
    configurationMessages.map(({ received }) => received),
    [
      RECEIVE_RESULT.STAGED,
      RECEIVE_RESULT.STAGED,
      RECEIVE_RESULT.CONFIG_COMMITTED
    ]
  );

  const firstRequest = forwardWatchRequest(target);
  assert.equal(target.xhr.instances.length, 1);
  const firstCachedMessages = receiveAndAckPhoneSequence(target, [
    T.RESULT_BEGIN,
    T.DEPARTURE,
    T.DEPARTURE,
    T.RESULT_COMMIT
  ]);
  assert.deepEqual(
    firstCachedMessages.map(({ received }) => received),
    [
      RECEIVE_RESULT.STAGED,
      RECEIVE_RESULT.STAGED,
      RECEIVE_RESULT.STAGED,
      RECEIVE_RESULT.RESULT_COMMITTED
    ]
  );
  assert.equal(
    target.watchView.frames.at(-1).snapshot.result.requestId,
    firstRequest.REQUEST_ID
  );
  assert.equal(target.defer.pending.length, 1);

  target.controller.onButton("select");
  const supersedingRequest = forwardWatchRequest(target);
  assert.notEqual(supersedingRequest.REQUEST_ID, firstRequest.REQUEST_ID);
  assert.equal(supersedingRequest.FAVORITE_ID, firstRequest.FAVORITE_ID);
  assert.equal(target.xhr.instances.length, 1);

  advancePhoneQueue(target);
  const orderedMirror = receiveAndAckPhoneMessage(target);
  assert.equal(orderedMirror.message.MESSAGE_TYPE, T.REQUEST);
  assert.equal(orderedMirror.message.REQUEST_ID, firstRequest.REQUEST_ID);
  assert.equal(orderedMirror.received, RECEIVE_RESULT.STAGED);

  advancePhoneQueue(target);
  const reboundMessages = receiveAndAckPhoneSequence(target, [
    T.RESULT_BEGIN,
    T.DEPARTURE,
    T.DEPARTURE,
    T.RESULT_COMMIT,
    T.REQUEST
  ]);
  assert.deepEqual(
    reboundMessages.map(({ received }) => received),
    [
      RECEIVE_RESULT.STAGED,
      RECEIVE_RESULT.STAGED,
      RECEIVE_RESULT.STAGED,
      RECEIVE_RESULT.RESULT_COMMITTED,
      RECEIVE_RESULT.STAGED
    ]
  );
  reboundMessages.forEach(({ message }) => {
    assert.equal(message.REQUEST_ID, supersedingRequest.REQUEST_ID);
  });
  assert.equal(
    target.watchView.frames.at(-1).snapshot.result.requestId,
    supersedingRequest.REQUEST_ID
  );

  const sentBeforeMatchingRequest = target.Pebble.sent.length;
  target.controller.onButton("select");
  const latestRequest = forwardWatchRequest(target);
  assert.notEqual(latestRequest.REQUEST_ID, supersedingRequest.REQUEST_ID);
  assert.equal(target.xhr.instances.length, 1);
  assert.equal(target.Pebble.sent.length, sentBeforeMatchingRequest);
  assert.equal(target.Pebble.pending.length, 0);

  const changedLive = contracts.copyDepartureResult(
    fixture.result,
    firstRequest.REQUEST_ID
  );
  changedLive.fetchedAt = Math.floor(target.clock.now() / 1000);
  changedLive.sourceUpdatedAt = changedLive.fetchedAt - 1;
  changedLive.departures[0].expectedAt += 60;
  changedLive.departures[0].minutes += 1;
  target.xhr.instances[0].respond(200, changedLive);

  const liveMessages = receiveAndAckPhoneSequence(target, [
    T.RESULT_BEGIN,
    T.DEPARTURE,
    T.DEPARTURE,
    T.RESULT_COMMIT
  ]);
  assert.deepEqual(
    liveMessages.map(({ received }) => received),
    [
      RECEIVE_RESULT.STAGED,
      RECEIVE_RESULT.STAGED,
      RECEIVE_RESULT.STAGED,
      RECEIVE_RESULT.RESULT_COMMITTED
    ]
  );
  liveMessages.forEach(({ message }) => {
    assert.equal(message.REQUEST_ID, latestRequest.REQUEST_ID);
  });
  const liveFrame = target.watchView.frames.at(-1);
  assert.equal(liveFrame.snapshot.state, WATCH_STATE.READY);
  assert.equal(liveFrame.snapshot.result.requestId, latestRequest.REQUEST_ID);
  assert.equal(
    liveFrame.snapshot.result.departures[0].expectedAt,
    changedLive.departures[0].expectedAt
  );
  assert.equal(
    target.Pebble.sent.filter((message) => message.MESSAGE_TYPE === T.RESULT_BEGIN).length,
    3
  );
});

test("a NACKed cached-to-live mirror makes that flight cache-only until a later request", (t) => {
  const target = harness({ manualPhoneTransport: true });
  t.after(() => {
    target.phone.stop();
    target.controller.close();
  });

  target.Pebble.emit("ready");
  target.readyDefer.runNext();
  receiveAndAckPhoneSequence(target, [
    T.CONFIG_BEGIN,
    T.FAVORITE,
    T.CONFIG_COMMIT
  ]);
  const firstRequest = forwardWatchRequest(target);
  const cachedMessages = receiveAndAckPhoneSequence(target, [
    T.RESULT_BEGIN,
    T.DEPARTURE,
    T.DEPARTURE,
    T.RESULT_COMMIT
  ]);
  assert.equal(cachedMessages.at(-1).received, RECEIVE_RESULT.RESULT_COMMITTED);
  const cachedFrame = target.watchView.frames.at(-1);

  advancePhoneQueue(target);
  const failedMirror = nackPhoneMessage(target);
  assert.equal(failedMirror.MESSAGE_TYPE, T.REQUEST);
  assert.equal(failedMirror.REQUEST_ID, firstRequest.REQUEST_ID);
  assert.equal(target.defer.pending.length, 0);

  const changedLive = contracts.copyDepartureResult(
    fixture.result,
    firstRequest.REQUEST_ID
  );
  changedLive.fetchedAt = Math.floor(target.clock.now() / 1000);
  changedLive.sourceUpdatedAt = changedLive.fetchedAt - 1;
  changedLive.departures[0].expectedAt += 60;
  changedLive.departures[0].minutes += 1;
  const sentBeforeCompletion = target.Pebble.sent.length;

  target.xhr.instances[0].respond(200, changedLive);
  assert.equal(target.Pebble.sent.length, sentBeforeCompletion);
  assert.strictEqual(target.watchView.frames.at(-1), cachedFrame);

  target.controller.onButton("select");
  const latestRequest = forwardWatchRequest(target);
  assert.notEqual(latestRequest.REQUEST_ID, firstRequest.REQUEST_ID);
  assert.equal(target.xhr.instances.length, 1);

  const reboundMessages = receiveAndAckPhoneSequence(target, [
    T.RESULT_BEGIN,
    T.DEPARTURE,
    T.DEPARTURE,
    T.RESULT_COMMIT
  ]);
  assert.deepEqual(
    reboundMessages.map(({ received }) => received),
    [
      RECEIVE_RESULT.STAGED,
      RECEIVE_RESULT.STAGED,
      RECEIVE_RESULT.STAGED,
      RECEIVE_RESULT.RESULT_COMMITTED
    ]
  );
  reboundMessages.forEach(({ message }) => {
    assert.equal(message.REQUEST_ID, latestRequest.REQUEST_ID);
  });
  const reboundFrame = target.watchView.frames.at(-1);
  assert.equal(reboundFrame.snapshot.state, WATCH_STATE.READY);
  assert.equal(reboundFrame.snapshot.result.requestId, latestRequest.REQUEST_ID);
  assert.equal(
    reboundFrame.snapshot.result.departures[0].expectedAt,
    changedLive.departures[0].expectedAt
  );
});
