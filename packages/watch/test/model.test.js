import test from "node:test";
import assert from "node:assert/strict";
import {
  KEY_STATUS,
  MESSAGE_TYPE,
  REQUEST_TRIGGER,
  SCHEMA_VERSION
} from "../src/embeddedjs/contracts.js";
import { createController } from "../src/embeddedjs/controller.js";
import { RECEIVE_RESULT } from "../src/embeddedjs/protocol.js";
import WatchModel from "../src/embeddedjs/model.js";

const FAVORITE = {
  id: "foundation-home",
  serviceId: "opaque:foundation:service:1",
  displayName: "Commute home",
  stopLabel: "Châtelet",
  lineLabel: "Métro 1",
  destinationLabel: "La Défense",
  sortOrder: 0
};

function wire(type, entries = []) {
  return new Map([
    ["SCHEMA_VERSION", SCHEMA_VERSION],
    ["MESSAGE_TYPE", type],
    ...entries
  ]);
}

function configurationMessages(id) {
  return [
    wire(MESSAGE_TYPE.CONFIG_BEGIN, [
      ["REQUEST_ID", id],
      ["ITEM_COUNT", 1],
      ["KEY_STATUS", KEY_STATUS.CONFIGURED],
      ["DISPLAY_NAME", "fr"]
    ]),
    wire(MESSAGE_TYPE.FAVORITE, [
      ["REQUEST_ID", id],
      ["ITEM_INDEX", 0],
      ["FAVORITE_ID", FAVORITE.id],
      ["SERVICE_ID", FAVORITE.serviceId],
      ["DISPLAY_NAME", FAVORITE.displayName],
      ["STOP_LABEL", FAVORITE.stopLabel],
      ["LINE_LABEL", FAVORITE.lineLabel],
      ["DESTINATION_LABEL", FAVORITE.destinationLabel],
      ["SORT_ORDER", FAVORITE.sortOrder]
    ]),
    wire(MESSAGE_TYPE.CONFIG_COMMIT, [["REQUEST_ID", id]])
  ];
}

function resultMessages(requestId) {
  return [
    wire(MESSAGE_TYPE.RESULT_BEGIN, [
      ["REQUEST_ID", requestId],
      ["FAVORITE_ID", FAVORITE.id],
      ["ITEM_COUNT", 1],
      ["FETCHED_AT", 1_788_000_000],
      ["FRESHNESS", 0]
    ]),
    wire(MESSAGE_TYPE.DEPARTURE, [
      ["REQUEST_ID", requestId],
      ["FAVORITE_ID", FAVORITE.id],
      ["ITEM_INDEX", 0],
      ["EXPECTED_AT", 1_788_000_120],
      ["MINUTES", 2],
      ["DEPARTURE_STATUS", 0],
      ["NEXT_INTERVAL_MINUTES", 4]
    ]),
    wire(MESSAGE_TYPE.RESULT_COMMIT, [
      ["REQUEST_ID", requestId],
      ["FAVORITE_ID", FAVORITE.id]
    ])
  ];
}

class FakeQueue {
  constructor() {
    this.messages = [];
    this.closed = 0;
  }

  enqueue(message) {
    this.messages.push(message);
    return true;
  }

  close() {
    this.closed += 1;
  }
}

class FakeView {
  constructor() {
    this.renders = [];
  }

  render(snapshot) {
    this.renders.push(snapshot);
  }

  close() {}
}

function harness() {
  const queue = new FakeQueue();
  const view = new FakeView();
  const controller = createController({
    clock: { now: () => 1_788_000_000_000 },
    queue,
    model: new WatchModel(),
    view
  }).start();
  return { queue, view, controller };
}

test("foundation model exposes the first committed favorite and one fixture request", () => {
  const model = new WatchModel();
  assert.deepEqual(model.commitProtocol({
    configuration: {
      keyStatus: KEY_STATUS.MISSING,
      language: "en",
      favorites: [FAVORITE]
    },
    result: null,
    error: null
  }, "CONFIG_COMMITTED"), { requestFixture: false });
  assert.equal(model.beginFixtureRequest("missing-key"), null);

  const effect = model.commitProtocol({
    configuration: {
      keyStatus: KEY_STATUS.CONFIGURED,
      language: "fr",
      favorites: [FAVORITE]
    },
    result: null,
    error: null
  }, "CONFIG_COMMITTED");

  assert.deepEqual(effect, { requestFixture: true });
  const request = model.beginFixtureRequest("foundation-1");
  assert.deepEqual(request, {
    requestId: "foundation-1",
    favoriteId: FAVORITE.id,
    trigger: REQUEST_TRIGGER.APP_OPEN
  });
  assert.equal(model.beginFixtureRequest("foundation-duplicate"), null);
  assert.equal(model.snapshot().favorite.id, FAVORITE.id);
  assert.equal(model.snapshot().language, "fr");
});

test("controller performs one APP_OPEN fixture round trip and preserves the committed result", () => {
  const target = harness();
  configurationMessages("config-1").forEach(target.controller.onReadable);

  assert.equal(target.queue.messages.length, 1);
  assert.equal(target.queue.messages[0].get("REQUEST_TRIGGER"), REQUEST_TRIGGER.APP_OPEN);
  const requestId = target.queue.messages[0].get("REQUEST_ID");
  resultMessages(requestId).forEach(target.controller.onReadable);

  const committed = target.view.renders.at(-1);
  assert.equal(committed.favorite.id, FAVORITE.id);
  assert.equal(committed.result.favoriteId, FAVORITE.id);
  assert.equal(committed.result.departures[0].minutes, 2);

  const rejected = target.controller.onReadable(new Map([
    ["SCHEMA_VERSION", SCHEMA_VERSION + 1],
    ["MESSAGE_TYPE", MESSAGE_TYPE.CONFIG_BEGIN]
  ]));
  assert.equal(rejected, RECEIVE_RESULT.REJECTED);
  assert.equal(target.view.renders.at(-1), committed);

  configurationMessages("config-2").forEach(target.controller.onReadable);
  assert.equal(target.queue.messages.length, 1);
});
