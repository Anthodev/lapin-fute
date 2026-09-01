import test from "node:test";
import assert from "node:assert/strict";
import {
  KEY_STATUS,
  MESSAGE_TYPE,
  SCHEMA_VERSION
} from "../src/embeddedjs/contracts.js";
import { createController } from "../src/embeddedjs/controller.js";
import { RECEIVE_RESULT } from "../src/embeddedjs/protocol.js";
import WatchModel from "../src/embeddedjs/model.js";
import {
  WATCH_CONFIGURATION_KEY,
  deserializeWatchConfiguration,
  serializeWatchConfiguration
} from "../src/embeddedjs/storage.js";

const OLD_FAVORITE = {
  id: "home",
  serviceId: "opaque:service:home",
  displayName: "Maison",
  stopLabel: "Châtelet",
  lineLabel: "Métro 1",
  destinationLabel: "La Défense",
  sortOrder: 0
};
const NEW_FAVORITES = [{
  id: "work",
  serviceId: "opaque:service:work",
  displayName: "Travail",
  stopLabel: "Nation",
  lineLabel: "RER A",
  destinationLabel: "Cergy",
  sortOrder: 0
}, {
  id: "gym",
  serviceId: "opaque:service:gym",
  stopLabel: "République",
  lineLabel: "Métro 9",
  destinationLabel: "Pont de Sèvres",
  sortOrder: 1
}];

class StringStorage {
  constructor(value) {
    this.value = value;
    this.failNextSet = false;
  }

  getItem(key) {
    return key === WATCH_CONFIGURATION_KEY ? this.value : null;
  }

  setItem(key, value) {
    if (key !== WATCH_CONFIGURATION_KEY) return;
    if (this.failNextSet) {
      this.failNextSet = false;
      throw new Error("write failed");
    }
    this.value = value;
  }

  removeItem(key) {
    if (key === WATCH_CONFIGURATION_KEY) this.value = null;
  }
}

class Queue {
  constructor() {
    this.messages = [];
  }

  enqueue(message) {
    this.messages.push(message);
    return true;
  }

  close() {}
}

class View {
  constructor() {
    this.renders = [];
  }

  render(snapshot) {
    this.renders.push(snapshot);
  }

  close() {}
}

function stored(favorites = [OLD_FAVORITE], language = "fr") {
  return serializeWatchConfiguration({
    keyStatus: KEY_STATUS.CONFIGURED,
    language,
    favorites
  });
}

function wire(type, entries = []) {
  return new Map([
    ["SCHEMA_VERSION", SCHEMA_VERSION],
    ["MESSAGE_TYPE", type],
    ...entries
  ]);
}

function configurationMessages(id, favorites = NEW_FAVORITES, language = "en") {
  return [
    wire(MESSAGE_TYPE.CONFIG_BEGIN, [
      ["REQUEST_ID", id],
      ["ITEM_COUNT", favorites.length],
      ["KEY_STATUS", KEY_STATUS.CONFIGURED],
      ["DISPLAY_NAME", language]
    ]),
    ...favorites.map((favorite, index) => wire(MESSAGE_TYPE.FAVORITE, [
      ["REQUEST_ID", id],
      ["ITEM_INDEX", index],
      ["FAVORITE_ID", favorite.id],
      ["SERVICE_ID", favorite.serviceId],
      ...(favorite.displayName === undefined ? [] : [["DISPLAY_NAME", favorite.displayName]]),
      ["STOP_LABEL", favorite.stopLabel],
      ["LINE_LABEL", favorite.lineLabel],
      ["DESTINATION_LABEL", favorite.destinationLabel],
      ["SORT_ORDER", favorite.sortOrder]
    ])),
    wire(MESSAGE_TYPE.CONFIG_COMMIT, [["REQUEST_ID", id]])
  ];
}

function harness(storage) {
  const queue = new Queue();
  const view = new View();
  const controller = createController({
    clock: { now: () => 1_788_000_000_000 },
    queue,
    model: new WatchModel(),
    storage,
    view
  }).start();
  return { controller, queue, view };
}

test("stored configuration renders offline and refreshes after phone synchronization", () => {
  const storage = new StringStorage(stored());
  const first = harness(storage);
  assert.equal(first.view.renders.at(-1).favorite.id, OLD_FAVORITE.id);
  assert.equal(first.view.renders.at(-1).language, "fr");
  assert.equal(first.queue.messages.length, 0);
  first.controller.onQueueState({ type: "writable" });
  assert.equal(first.queue.messages.length, 1);

  configurationMessages("edit-1").forEach(first.controller.onReadable);
  assert.equal(first.view.renders.at(-1).favorite.id, NEW_FAVORITES[0].id);
  assert.deepEqual(deserializeWatchConfiguration(storage.value), {
    keyStatus: KEY_STATUS.CONFIGURED,
    language: "en",
    favorites: NEW_FAVORITES
  });

  const restarted = harness(storage);
  assert.equal(restarted.view.renders.at(-1).favorite.id, NEW_FAVORITES[0].id);
  assert.equal(restarted.view.renders.at(-1).language, "en");
  assert.equal(restarted.queue.messages.length, 0);
  restarted.controller.onQueueState({ type: "writable" });
  assert.equal(restarted.queue.messages.length, 1);
});

test("every interrupted sequence position preserves the prior durable list on restart", () => {
  const messages = configurationMessages("interrupted");
  for (let delivered = 0; delivered < messages.length; delivered += 1) {
    const previous = stored();
    const storage = new StringStorage(previous);
    const current = harness(storage);
    messages.slice(0, delivered).forEach(current.controller.onReadable);
    assert.equal(storage.value, previous, "delivery prefix " + delivered);

    const restarted = harness(storage);
    assert.equal(restarted.view.renders.at(-1).favorite.id, OLD_FAVORITE.id);
    assert.equal(restarted.view.renders.at(-1).language, "fr");
  }
});

test("unsupported input and failed persistence roll back to the prior configuration", () => {
  const previous = stored();
  const storage = new StringStorage(previous);
  const target = harness(storage);
  const unsupported = wire(MESSAGE_TYPE.CONFIG_BEGIN, []);
  unsupported.set("SCHEMA_VERSION", SCHEMA_VERSION + 1);
  assert.equal(target.controller.onReadable(unsupported), RECEIVE_RESULT.REJECTED);
  assert.equal(storage.value, previous);

  storage.failNextSet = true;
  const results = configurationMessages("failed-save").map(target.controller.onReadable);
  assert.equal(results.at(-1), RECEIVE_RESULT.REJECTED);
  assert.equal(storage.value, previous);
  assert.equal(target.view.renders.at(-1).favorite.id, OLD_FAVORITE.id);
  assert.equal(target.view.renders.at(-1).language, "fr");
});
