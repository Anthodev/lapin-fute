"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { contracts: C, codec, MessageQueue } = require("../src");
const { createConfigurationSync } = require("../src/configuration-sync");
const layout = require("../src/display-layout");
const display = require("../src/display");
const fixture = require("../../../fixtures/departures/foundation.json");
const fakes = require("./fakes");
const T = C.MESSAGE_TYPE;
const EPOCH = "000000000000001";
const id = (kind, sequence, epoch = EPOCH) => epoch + kind + sequence.toString(16).padStart(8, "0");
function frames(...messages) { let index = 0; return () => index < messages.length ? messages[index++] : null; }
function harness() {
  const Pebble = new fakes.FakePebble(false), defer = fakes.createDefer(false), failures = [];
  const queue = new MessageQueue(Pebble, defer, code => failures.push(code));
  return { Pebble, defer, queue, failures };
}
function drain(h) {
  for (let i = 0; h.Pebble.pending.length || h.defer.pending.length; i++) {
    assert.ok(i < 1000, "transport settles without retries");
    if (h.Pebble.pending.length) h.Pebble.ack(); else h.defer.runNext();
  }
}
function hello(epoch = EPOCH, profile = 0, clock = 0, token = "w" + epoch) {
  return { SCHEMA_VERSION: 2, MESSAGE_TYPE: T.DISPLAY_HELLO, REQUEST_ID: token,
    WATCH_SESSION_ID: "w" + epoch, DISPLAY_EPOCH: epoch, DISPLAY_PROFILE: profile, CLOCK_12H: clock };
}
function syncHarness() {
  const h = harness(); h.completed = [];
  h.sync = createConfigurationSync({ queue: h.queue, onSynchronized: binding => h.completed.push(binding) });
  h.sync.ready(); drain(h);
  assert.equal(h.sync.hello(hello()).changed, true);
  return h;
}
function target(favorites = [fixture.favorite]) {
  return { favorites, records: favorites.map(f => layout.prepareAppearance(f, 0, "fr")),
    keyStatus: 1, language: "fr", lifecycleGeneration: 7 };
}
function need(h, token, mask, additions = {}) {
  return h.sync.receive(Object.assign({ SCHEMA_VERSION: 2, MESSAGE_TYPE: T.CONFIG_NEED,
    REQUEST_ID: token, DISPLAY_GENERATION: parseInt(token.slice(16), 16),
    CONFIG_NEED_MASK: mask, DISPLAY_PROFILE: 0, CLOCK_12H: 0 }, additions));
}

// The foreign-session, wrong-epoch and wrong-kind inputs are independent
// admission failures, not snapshots of mirrored constants.
test("strict watch decoder admits overview CACHE_ONLY but rejects retired and mismatched envelopes", () => {
  const request = { SCHEMA_VERSION: 2, MESSAGE_TYPE: T.OVERVIEW_REQUEST,
    REQUEST_ID: id("r", 1), DISPLAY_GENERATION: 1, REQUEST_TRIGGER: 5 };
  assert.deepEqual(codec.decodeDataRequest(request), {
    kind: "overview", requestId: id("r", 1), wireGeneration: 1, trigger: 5
  });
  for (const change of [{ SCHEMA_VERSION: 1 }, { REQUEST_TRIGGER: 1 }, { REQUEST_TRIGGER: 3 },
    { REQUEST_ID: id("c", 1) }, { REQUEST_ID: id("r", 0) }, { DISPLAY_GENERATION: 0 }, { EXTRA: 1 }]) {
    assert.equal(codec.decodeDataRequest({ ...request, ...change }), null);
  }
  const detail = { ...request, MESSAGE_TYPE: T.REQUEST, FAVORITE_ID: "🚆" };
  assert.equal(codec.decodeDataRequest(detail).favoriteId, "🚆");
  assert.equal(codec.decodeDataRequest({ ...detail, FAVORITE_ID: "\ud800" }), null);
  assert.equal(codec.decodeDataRequest({ ...detail, REQUEST_TRIGGER: 0 }), null);
});

test("lazy configuration waits for correlated NEED and COMMIT ACK before exposing the binding", () => {
  const h = syncHarness(), prepared = target();
  const token = h.sync.synchronize(prepared, false);
  drain(h);
  assert.deepEqual(h.Pebble.sent.slice(1).map(m => m.MESSAGE_TYPE), [T.CONFIG_BEGIN, T.CONFIG_ENTRY]);
  const data = { requestId: id("r", 1), wireGeneration: 1 };
  assert.equal(h.sync.resolveDataBinding(data), null);
  need(h, id("c", 2), 1);
  assert.equal(h.Pebble.sent.length, 3);
  need(h, token, 1);
  while (h.Pebble.sent.at(-1).MESSAGE_TYPE !== T.CONFIG_COMMIT) {
    if (h.Pebble.pending.length) h.Pebble.ack(); else h.defer.runNext();
  }
  assert.equal(h.completed.length, 0);
  assert.equal(h.sync.pendingDataBinding(data), true);
  drain(h);
  assert.equal(h.completed.length, 1);
  assert.equal(h.sync.resolveDataBinding(data).favorites[0].id, prepared.favorites[0].id);
  assert.equal(h.sync.pendingDataBinding(data), false);
});

test("FULL sends complete inventory and requires every body bit; reorder DIFF sends no bodies", () => {
  const h = syncHarness();
  const favorites = [fixture.favorite, { ...fixture.favorite, id: "second", sortOrder: 1 }];
  const token = h.sync.synchronize(target(favorites), true);
  drain(h);
  assert.equal(h.Pebble.sent.filter(m => m.MESSAGE_TYPE === T.CONFIG_ENTRY).length, 2);
  need(h, token, 1); drain(h);
  assert.equal(h.Pebble.sent.filter(m => m.MESSAGE_TYPE === T.FAVORITE).length, 0);
  need(h, token, 3); drain(h);
  assert.equal(h.completed.length, 1);
  const before = h.Pebble.sent.length;
  const reversed = favorites.slice().reverse().map((f, sortOrder) => ({ ...f, sortOrder }));
  const reorder = h.sync.synchronize(target(reversed), false);
  drain(h); need(h, reorder, 0); drain(h);
  assert.equal(h.Pebble.sent.slice(before).some(m => m.MESSAGE_TYPE === T.FAVORITE), false);
  assert.deepEqual(h.completed.at(-1).favorites.map(f => f.id), reversed.map(f => f.id));
});

test("HELLO correlation, epoch floor and profile changes guard configuration preparation", () => {
  const h = syncHarness();
  const token = h.sync.synchronize(target(), false); drain(h); need(h, token, 1); drain(h);
  assert.equal(h.sync.hello(hello()).changed, false);
  assert.equal(h.sync.hello(hello("000000000000002", 0, 0, "obsolete-phone-token")).changed, false);
  assert.equal(h.sync.hello(hello("000000000000002")).changed, true);
  assert.equal(h.sync.resolveDataBinding({ requestId: id("r", 1), wireGeneration: 1 }), null);
  assert.equal(h.sync.hello(hello()).changed, false);
  const next = h.sync.synchronize(target(), false);
  assert.equal(next, id("c", 1, "000000000000002"));
  drain(h);
  need(h, next, 1, { CLOCK_12H: 1 }); drain(h);
  assert.equal(h.completed.length, 1);
  assert.equal(h.sync.hello(hello("000000000000002", 1, 1)).changed, true);
});

test("superseded sync ignores stale NEED and late transport failure without resetting c-sequence", () => {
  const h = syncHarness();
  const first = h.sync.synchronize(target(), false);
  const second = h.sync.synchronize(target(), false);
  h.Pebble.fail(); drain(h);
  need(h, first, 1); drain(h);
  assert.equal(h.completed.length, 0);
  need(h, second, 1); drain(h);
  assert.equal(h.completed[0].generation, 2);
  assert.deepEqual(h.failures, []);
});

test("Unicode appearance and traffic continuation strings cross D2 without clipping source data", () => {
  const f = { ...fixture.favorite, id: "🚆🇫🇷", stopLabel: "Étoile 🚆" };
  const record = layout.prepareAppearance(f, 1, "fr");
  assert.equal(display.recordField(record, 0), f.id);
  const body = codec.encodeFavoriteBody({ requestId: id("c", 1), generation: 1, index: 0, record });
  assert.ok(codec.dictionaryBytes(body) <= C.APP_MESSAGE_INBOX_BYTES);
  const fragments = layout.prepareTraffic(1, 1788000000, "Perturbations", "", "é".repeat(192), 1);
  const request = { requestId: id("r", 1), wireGeneration: 1, kind: "traffic", favoriteId: f.id };
  const next = codec.createDisplayTransfer(request, fragments);
  const sent = []; for (let m; (m = next()) !== null;) sent.push(m);
  assert.equal(sent[0].ITEM_COUNT, fragments.length);
  assert.equal(sent.at(-1).MESSAGE_TYPE, T.DISPLAY_COMMIT);
  assert.equal(sent.slice(1, -1).map(m => m.DISPLAY_RECORD).join(""), fragments.join(""));
  sent.forEach(m => assert.ok(codec.dictionaryBytes(m) <= C.APP_MESSAGE_INBOX_BYTES));
});

test("queue is lazy, bounded, atomic and yields after each ACK including final completion", () => {
  const h = harness(), complete = [];
  let produced = 0;
  h.queue.enqueue(() => ++produced <= 2 ? { n: produced } : null, () => complete.push("a"));
  h.queue.enqueue(frames({ n: 3 }), () => complete.push("b"));
  h.queue.enqueue(frames({ n: 4 })); h.queue.enqueue(frames({ n: 5 }));
  assert.equal(h.queue.enqueue(frames({ n: 6 })), false);
  assert.equal(produced, 1);
  h.Pebble.ack();
  assert.equal(produced, 1);
  h.defer.runNext(); h.Pebble.ack();
  assert.deepEqual(complete, []);
  drain(h);
  assert.deepEqual(h.Pebble.sent.map(m => m.n), [1, 2, 3, 4, 5]);
  assert.deepEqual(complete, ["a", "b"]);
  assert.equal(h.Pebble.maxInFlight, 1);
});

test("an unattempted SDK echo survives failed D2 work, but the echo itself is never retried", () => {
  const h = harness();
  h.queue.enqueue(frames({ n: "failed" }, { n: "discarded" }));
  h.queue.enqueue(codec.one({ "15025": 1 }), undefined, true);
  h.queue.enqueue(frames({ n: "discarded-too" }));
  h.Pebble.fail();
  h.defer.runNext();
  assert.deepEqual(h.Pebble.sent, [{ n: "failed" }, { "15025": 1 }]);
  h.Pebble.fail(); drain(h);
  assert.equal(h.Pebble.sent.length, 2);
  assert.deepEqual(h.failures, ["APP_MESSAGE_FAILED", "APP_MESSAGE_FAILED"]);
});

test("clear waits for the physical flight and stale callbacks cannot corrupt its replacement", () => {
  const h = harness();
  h.queue.enqueue(frames({ n: "old" }));
  const old = h.Pebble.pending[0];
  h.queue.clear(); h.queue.enqueue(frames({ n: "new" }));
  assert.equal(h.Pebble.sent.length, 1);
  h.Pebble.fail(); h.defer.runNext();
  old.success(); old.failure();
  assert.equal(h.Pebble.sent.length, 2);
  assert.equal(h.queue.isSending(), true);
  drain(h);
  assert.equal(h.Pebble.maxInFlight, 1);
  assert.deepEqual(h.failures, []);
});

test("cancellation retires old deferred work and synchronous transport throws fail once", () => {
  const h = harness();
  h.queue.enqueue(frames({ n: "old" }, { n: "never" }));
  h.Pebble.ack(); h.queue.cancelApplication(); h.queue.enqueue(frames({ n: "new" }));
  drain(h);
  assert.deepEqual(h.Pebble.sent.map(m => m.n), ["old", "new"]);
  const broken = harness();
  broken.Pebble.sendAppMessage = () => { throw new Error("send failed"); };
  broken.queue.enqueue(frames({ n: 1 })); drain(broken);
  assert.deepEqual(broken.failures, ["APP_MESSAGE_FAILED"]);
});
