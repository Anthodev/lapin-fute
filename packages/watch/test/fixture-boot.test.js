import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createController } from "../src/embeddedjs/controller.js";
import WatchModel from "../src/embeddedjs/model.js";

const require = createRequire(import.meta.url);
const companion = require("../../companion/src/index.js");
const fixture = require("../../../fixtures/departures/foundation.json");
const fakes = require("../../companion/test/fakes.js");

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
    this.snapshots = [];
  }

  render(snapshot) {
    this.snapshots.push(snapshot);
  }

  close() {}
}

function aliasMap(dictionary) {
  return new Map(Object.entries(dictionary));
}

test("foundation fixture completes the PKJS to Alloy round trip without a key or XHR", () => {
  const Pebble = new fakes.FakePebble(true);
  const storage = new fakes.FakeStorage();
  const phoneClock = new fakes.FakeClock(fixture.result.fetchedAt * 1000);
  const xhr = fakes.createXHRFactory();
  companion.createCompanion({
    Pebble,
    storage,
    XHR: xhr.XHR,
    clock: phoneClock,
    defer: fakes.createDefer(true),
    backendUrl: "",
    configurationUrl: "",
    fixture
  });

  const watchQueue = new WatchQueue();
  const watchView = new WatchView();
  const controller = createController({
    clock: { now: () => phoneClock.now() },
    queue: watchQueue,
    view: watchView,
    model: new WatchModel()
  }).start();

  Pebble.emit("ready");
  const configurationMessages = Pebble.sent.slice();
  assert.deepEqual(configurationMessages.map((message) => message.MESSAGE_TYPE), [
    companion.contracts.MESSAGE_TYPE.CONFIG_BEGIN,
    companion.contracts.MESSAGE_TYPE.FAVORITE,
    companion.contracts.MESSAGE_TYPE.CONFIG_COMMIT
  ]);
  assert.equal(configurationMessages[0].KEY_STATUS, companion.contracts.KEY_STATUS.CONFIGURED);
  assert.equal(configurationMessages[0].DISPLAY_NAME, "en");
  configurationMessages.forEach((message) => controller.onReadable(aliasMap(message)));

  assert.equal(watchQueue.messages.length, 1);
  const request = Object.fromEntries(watchQueue.messages[0]);
  assert.equal(request.REQUEST_TRIGGER, companion.contracts.REQUEST_TRIGGER.APP_OPEN);
  assert.equal(Object.keys(request).some((key) => /^\d+$/u.test(key)), false);

  const resultStart = Pebble.sent.length;
  Pebble.emit("appmessage", { payload: request });
  const resultMessages = Pebble.sent.slice(resultStart);
  assert.deepEqual(resultMessages.map((message) => message.MESSAGE_TYPE), [
    companion.contracts.MESSAGE_TYPE.RESULT_BEGIN,
    companion.contracts.MESSAGE_TYPE.DEPARTURE,
    companion.contracts.MESSAGE_TYPE.DEPARTURE,
    companion.contracts.MESSAGE_TYPE.RESULT_COMMIT
  ]);
  resultMessages.forEach((message) => controller.onReadable(aliasMap(message)));

  const finalSnapshot = watchView.snapshots.at(-1);
  assert.equal(finalSnapshot.favorite.id, fixture.favorite.id);
  assert.equal(finalSnapshot.result.favoriteId, fixture.result.favoriteId);
  assert.equal(finalSnapshot.result.departures.length, 2);
  assert.equal(finalSnapshot.result.departures[0].minutes, fixture.result.departures[0].minutes);
  assert.equal(finalSnapshot.sendFailed, false);
  assert.equal(xhr.instances.length, 0);
  assert.equal(storage.writes.length, 0);
  controller.close();
});
