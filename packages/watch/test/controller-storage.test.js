import test from "node:test";
import assert from "node:assert/strict";
import {
  KEY_STATUS,
  LIMITS,
  MESSAGE_TYPE,
  REQUEST_TRIGGER,
  SCHEMA_VERSION
} from "../src/embeddedjs/contracts.js";
import { QUEUE_STATE } from "../src/embeddedjs/message-queue.js";
import { createController } from "../src/embeddedjs/controller.js";
import { RECEIVE_RESULT } from "../src/embeddedjs/protocol.js";
import WatchModel, { WATCH_STATE } from "../src/embeddedjs/model.js";
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
}, {
  id: "park",
  serviceId: "opaque:service:park",
  displayName: "Parc",
  stopLabel: "Vincennes",
  lineLabel: "RER A",
  destinationLabel: "Marne-la-Vallée",
  sortOrder: 2
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

class Clock {
  constructor(now = 1_788_000_000_000) {
    this.value = now;
  }

  now() {
    return this.value;
  }

  advance(milliseconds) {
    this.value += milliseconds;
  }
}

class Scheduler {
  constructor(clock) {
    this.clock = clock;
    this.nextId = 1;
    this.lastId = null;
    this.tasks = [];
  }

  set(callback, delayMs) {
    const task = {
      callback,
      cleared: false,
      dueAt: this.clock.now() + delayMs,
      id: this.nextId
    };
    this.nextId += 1;
    this.lastId = task.id;
    this.tasks.push(task);
    return task.id;
  }

  clear(timerId) {
    const task = this.tasks.find((candidate) => candidate.id === timerId);
    if (task) task.cleared = true;
  }

  advance(milliseconds) {
    this.clock.advance(milliseconds);
    const ready = this.tasks
      .filter((task) => !task.cleared && task.dueAt <= this.clock.now())
      .sort((left, right) => left.dueAt - right.dueAt);
    ready.forEach((task) => {
      task.cleared = true;
      task.callback();
    });
  }

  fire(timerId) {
    const task = this.tasks.find((candidate) => candidate.id === timerId);
    if (task) task.callback();
  }
}

class Queue {
  constructor() {
    this.accept = true;
    this.attempts = [];
    this.messages = [];
    this.closed = 0;
  }

  enqueue(message) {
    this.attempts.push(message);
    if (!this.accept) return false;
    this.messages.push(message);
    return true;
  }

  close() {
    this.closed += 1;
  }
}

class View {
  constructor() {
    this.renders = [];
    this.closed = 0;
  }

  render(snapshot) {
    this.renders.push(snapshot);
  }

  close() {
    this.closed += 1;
  }
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

function configurationMessages(
  id,
  favorites = NEW_FAVORITES,
  language = "en",
  keyStatus = KEY_STATUS.CONFIGURED
) {
  return [
    wire(MESSAGE_TYPE.CONFIG_BEGIN, [
      ["REQUEST_ID", id],
      ["ITEM_COUNT", favorites.length],
      ["KEY_STATUS", keyStatus],
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

function resultMessages(
  requestId,
  favoriteId,
  fetchedAt = 1_788_000_000
) {
  return [
    wire(MESSAGE_TYPE.RESULT_BEGIN, [
      ["REQUEST_ID", requestId],
      ["FAVORITE_ID", favoriteId],
      ["ITEM_COUNT", 1],
      ["FETCHED_AT", fetchedAt],
      ["FRESHNESS", 0]
    ]),
    wire(MESSAGE_TYPE.DEPARTURE, [
      ["REQUEST_ID", requestId],
      ["FAVORITE_ID", favoriteId],
      ["ITEM_INDEX", 0],
      ["EXPECTED_AT", 1_788_000_120],
      ["MINUTES", 2],
      ["DEPARTURE_STATUS", 0]
    ]),
    wire(MESSAGE_TYPE.RESULT_COMMIT, [
      ["REQUEST_ID", requestId],
      ["FAVORITE_ID", favoriteId]
    ])
  ];
}

function deliver(controller, messages) {
  return messages.map((message) => controller.onReadable(message));
}

function harness(storage = null) {
  const clock = new Clock();
  const scheduler = new Scheduler(clock);
  const queue = new Queue();
  const view = new View();
  const controller = createController({
    clock,
    queue,
    scheduler,
    model: new WatchModel(),
    storage,
    view
  }).start();
  return { clock, controller, queue, scheduler, view };
}

test("controller requires the one-shot scheduler adapter", () => {
  const adapters = {
    clock: new Clock(),
    model: new WatchModel(),
    queue: new Queue(),
    view: new View()
  };
  assert.throws(() => createController(adapters), /controller adapters are required/u);
  assert.throws(() => createController({
    ...adapters,
    scheduler: { set() {} }
  }), /controller adapters are required/u);
});

test("restored metadata waits for the first phone commit before one app-open request", () => {
  const storage = new StringStorage(stored());
  const target = harness(storage);
  assert.equal(target.view.renders.at(-1).activeFavorite.id, OLD_FAVORITE.id);
  assert.equal(target.view.renders.at(-1).language, "fr");
  assert.equal(target.queue.messages.length, 0);

  target.controller.onQueueState({ type: QUEUE_STATE.WRITABLE });
  assert.equal(target.queue.messages.length, 0);

  const firstCommit = deliver(
    target.controller,
    configurationMessages("sync-1", [OLD_FAVORITE], "fr")
  );
  target.scheduler.advance(0);
  assert.equal(firstCommit.at(-1), RECEIVE_RESULT.CONFIG_COMMITTED);
  assert.equal(target.queue.messages.length, 1);
  assert.equal(target.queue.messages[0].get("MESSAGE_TYPE"), MESSAGE_TYPE.REQUEST);
  assert.equal(target.queue.messages[0].get("FAVORITE_ID"), OLD_FAVORITE.id);
  assert.equal(target.queue.messages[0].get("REQUEST_TRIGGER"), REQUEST_TRIGGER.APP_OPEN);
  assert.equal(
    target.queue.messages[0].get("REQUEST_ID"),
    "consult-" + Math.floor(target.clock.now() / 1000).toString(36) + "-1"
  );

  deliver(target.controller, configurationMessages("edit-1"));
  target.scheduler.advance(0);
  assert.equal(target.queue.messages.length, 1);
  assert.equal(target.view.renders.at(-1).activeFavorite.id, NEW_FAVORITES[0].id);
  assert.deepEqual(deserializeWatchConfiguration(storage.value), {
    keyStatus: KEY_STATUS.CONFIGURED,
    language: "en",
    favorites: NEW_FAVORITES
  });

  const restarted = harness(storage);
  assert.equal(restarted.view.renders.at(-1).activeFavorite.id, NEW_FAVORITES[0].id);
  assert.equal(restarted.queue.messages.length, 0);
  restarted.controller.onQueueState({ type: QUEUE_STATE.WRITABLE });
  assert.equal(restarted.queue.messages.length, 0);
  deliver(restarted.controller, configurationMessages("sync-2"));
  restarted.scheduler.advance(0);
  assert.equal(restarted.queue.messages.length, 1);
  assert.equal(
    restarted.queue.messages[0].get("REQUEST_TRIGGER"),
    REQUEST_TRIGGER.APP_OPEN
  );
});

test("an unconfigured phone commit does not consume the later valid app-open request", () => {
  const target = harness();
  deliver(
    target.controller,
    configurationMessages("missing", [], "fr", KEY_STATUS.MISSING)
  );
  assert.equal(target.queue.messages.length, 0);

  deliver(target.controller, configurationMessages("configured"));
  assert.equal(target.queue.messages.length, 1);
  assert.equal(target.queue.messages[0].get("FAVORITE_ID"), NEW_FAVORITES[0].id);
  assert.equal(target.queue.messages[0].get("REQUEST_TRIGGER"), REQUEST_TRIGGER.APP_OPEN);

  deliver(target.controller, configurationMessages("later-edit", [OLD_FAVORITE]));
  assert.equal(target.queue.messages.length, 1);
});

test("every interrupted sequence position preserves the prior durable list on restart", () => {
  const messages = configurationMessages("interrupted");
  for (let delivered = 0; delivered < messages.length; delivered += 1) {
    const previous = stored();
    const storage = new StringStorage(previous);
    const current = harness(storage);
    deliver(current.controller, messages.slice(0, delivered));
    assert.equal(storage.value, previous, "delivery prefix " + delivered);

    const restarted = harness(storage);
    assert.equal(restarted.view.renders.at(-1).activeFavorite.id, OLD_FAVORITE.id);
    assert.equal(restarted.view.renders.at(-1).language, "fr");
  }
});

test("unsupported input and failed persistence roll back without an app-open request", () => {
  const previous = stored();
  const storage = new StringStorage(previous);
  const target = harness(storage);
  const unsupported = wire(MESSAGE_TYPE.CONFIG_BEGIN, []);
  unsupported.set("SCHEMA_VERSION", SCHEMA_VERSION + 1);
  assert.equal(target.controller.onReadable(unsupported), RECEIVE_RESULT.REJECTED);
  assert.equal(storage.value, previous);

  storage.failNextSet = true;
  const failed = deliver(target.controller, configurationMessages("failed-save"));
  assert.equal(failed.at(-1), RECEIVE_RESULT.CONFIG_COMMITTED);
  assert.equal(storage.value, previous);
  assert.equal(target.queue.messages.length, 0);
  target.scheduler.advance(0);
  assert.equal(storage.value, previous);
  assert.equal(target.queue.messages.length, 0);
  assert.equal(target.view.renders.at(-1).activeFavorite.id, OLD_FAVORITE.id);
  assert.equal(target.view.renders.at(-1).language, "fr");

  deliver(target.controller, configurationMessages("successful-save"));
  target.scheduler.advance(0);
  assert.equal(target.queue.messages.length, 1);
  assert.deepEqual(deserializeWatchConfiguration(storage.value), {
    keyStatus: KEY_STATUS.CONFIGURED,
    language: "en",
    favorites: NEW_FAVORITES
  });
});

test("failed compatible persistence restores the complete READY state", () => {
  const storage = new StringStorage(stored());
  const target = harness(storage);
  deliver(
    target.controller,
    configurationMessages("sync-ready", [OLD_FAVORITE], "fr")
  );
  target.scheduler.advance(0);
  const appOpen = target.queue.messages[0];
  deliver(target.controller, resultMessages(
    appOpen.get("REQUEST_ID"),
    appOpen.get("FAVORITE_ID")
  ));
  const ready = target.view.renders.at(-1);
  const messageCount = target.queue.messages.length;
  const previousBytes = storage.value;
  assert.equal(ready.state, WATCH_STATE.READY);

  storage.failNextSet = true;
  deliver(
    target.controller,
    configurationMessages("failed-compatible", [OLD_FAVORITE], "en")
  );
  target.scheduler.advance(0);

  const rolledBack = target.view.renders.at(-1);
  assert.equal(storage.value, previousBytes);
  assert.equal(rolledBack.state, WATCH_STATE.READY);
  assert.equal(rolledBack.language, "fr");
  assert.deepEqual(rolledBack.result, ready.result);
  assert.deepEqual(rolledBack.error, ready.error);
  assert.equal(rolledBack.expectedRequest, null);
  assert.equal(target.queue.messages.length, messageCount);
});

test("deferred persistence is inert after close and a newer commit supersedes it", () => {
  const previous = stored();
  const storage = new StringStorage(previous);
  const closing = harness(storage);
  deliver(closing.controller, configurationMessages("closing"));
  const closingTimer = closing.scheduler.lastId;
  closing.controller.close();
  closing.scheduler.fire(closingTimer);
  assert.equal(storage.value, previous);
  assert.equal(closing.queue.messages.length, 0);

  const replacing = harness(new StringStorage(previous));
  deliver(replacing.controller, configurationMessages("first", [OLD_FAVORITE], "fr"));
  const firstTimer = replacing.scheduler.lastId;
  deliver(replacing.controller, configurationMessages("second", NEW_FAVORITES, "en"));
  const secondTimer = replacing.scheduler.lastId;
  replacing.scheduler.fire(firstTimer);
  assert.equal(replacing.queue.messages.length, 0);
  replacing.scheduler.fire(secondTimer);
  assert.equal(replacing.queue.messages.length, 1);
  assert.equal(replacing.view.renders.at(-1).activeFavorite.id, NEW_FAVORITES[0].id);
});

test("selection settles at exactly 500 ms and boundary presses are inert", () => {
  const target = harness();
  deliver(target.controller, configurationMessages("config"));
  const baseline = target.queue.messages.length;

  target.controller.onButton("up");
  target.scheduler.advance(LIMITS.favoriteSettleMs);
  assert.equal(target.queue.messages.length, baseline);

  target.controller.onButton("down");
  assert.equal(
    target.view.renders.at(-1).activeFavorite.id,
    NEW_FAVORITES[1].id
  );
  assert.equal(target.view.renders.at(-1).expectedRequest, null);

  target.scheduler.advance(LIMITS.favoriteSettleMs - 1);
  assert.equal(target.queue.messages.length, baseline);
  target.scheduler.advance(1);
  assert.equal(target.queue.messages.length, baseline + 1);
  const request = target.queue.messages.at(-1);
  assert.equal(request.get("FAVORITE_ID"), NEW_FAVORITES[1].id);
  assert.equal(request.get("REQUEST_TRIGGER"), REQUEST_TRIGGER.FAVORITE_SELECTION);
  assert.match(request.get("REQUEST_ID"), /^consult-[0-9a-z]+-2$/u);
});

test("rapid navigation sends only the final settled favorite", () => {
  const target = harness();
  deliver(target.controller, configurationMessages("config"));
  const baseline = target.queue.messages.length;

  target.controller.onButton("down");
  target.scheduler.advance(100);
  target.controller.onButton("down");
  target.scheduler.advance(100);
  target.controller.onButton("up");
  target.scheduler.advance(100);
  target.controller.onButton("down");
  target.controller.onButton("down");

  assert.equal(
    target.view.renders.at(-1).activeFavorite.id,
    NEW_FAVORITES[2].id
  );
  target.scheduler.advance(LIMITS.favoriteSettleMs - 1);
  assert.equal(target.queue.messages.length, baseline);
  target.scheduler.advance(1);
  assert.equal(target.queue.messages.length, baseline + 1);
  assert.equal(
    target.queue.messages.at(-1).get("FAVORITE_ID"),
    NEW_FAVORITES[2].id
  );
  assert.equal(
    target.queue.messages.at(-1).get("REQUEST_TRIGGER"),
    REQUEST_TRIGGER.FAVORITE_SELECTION
  );
});

test("Select cancels settlement and immediately requests only the active favorite", () => {
  const target = harness();
  deliver(target.controller, configurationMessages("config"));
  const baseline = target.queue.messages.length;

  target.controller.onButton("down");
  const cancelledTimer = target.scheduler.lastId;
  target.scheduler.advance(LIMITS.favoriteSettleMs - 1);
  target.controller.onButton("select");

  assert.equal(target.queue.messages.length, baseline + 1);
  assert.equal(
    target.queue.messages.at(-1).get("FAVORITE_ID"),
    NEW_FAVORITES[1].id
  );
  assert.equal(
    target.queue.messages.at(-1).get("REQUEST_TRIGGER"),
    REQUEST_TRIGGER.MANUAL_SELECT
  );
  target.scheduler.advance(1);
  target.scheduler.fire(cancelledTimer);
  assert.equal(target.queue.messages.length, baseline + 1);
});

test("an older handed-off result survives many same-favorite supersessions", () => {
  const target = harness();
  deliver(target.controller, configurationMessages("config"));
  const appOpen = target.queue.messages[0];
  deliver(target.controller, resultMessages(
    appOpen.get("REQUEST_ID"),
    appOpen.get("FAVORITE_ID")
  ));

  target.controller.onButton("select");
  const oldest = target.queue.messages.at(-1);
  for (let index = 0; index < LIMITS.requestQueue + 8; index += 1) {
    target.controller.onButton("select");
  }
  const latest = target.queue.messages.at(-1);
  assert.notEqual(latest.get("REQUEST_ID"), oldest.get("REQUEST_ID"));

  target.clock.advance(30_000);
  assert.deepEqual(deliver(target.controller, resultMessages(
    oldest.get("REQUEST_ID"),
    oldest.get("FAVORITE_ID"),
    1_788_000_030
  )), [
    RECEIVE_RESULT.STAGED,
    RECEIVE_RESULT.STAGED,
    RECEIVE_RESULT.RESULT_COMMITTED
  ]);
  assert.equal(target.view.renders.at(-1).state, WATCH_STATE.READY);
  assert.equal(
    target.view.renders.at(-1).result.requestId,
    oldest.get("REQUEST_ID")
  );

  target.clock.advance(30_000);
  assert.deepEqual(deliver(target.controller, resultMessages(
    latest.get("REQUEST_ID"),
    latest.get("FAVORITE_ID"),
    1_788_000_060
  )), [
    RECEIVE_RESULT.STAGED,
    RECEIVE_RESULT.STAGED,
    RECEIVE_RESULT.RESULT_COMMITTED
  ]);
  assert.equal(
    target.view.renders.at(-1).result.requestId,
    latest.get("REQUEST_ID")
  );
  assert.equal(
    target.controller.onReadable(resultMessages(
      oldest.get("REQUEST_ID"),
      oldest.get("FAVORITE_ID"),
      1_788_000_030
    )[0]),
    RECEIVE_RESULT.REJECTED
  );
});

test("minute and focus callbacks work as direct listeners without queue writes", () => {
  const target = harness();
  const onMinuteChange = target.controller.onMinuteChange;
  const setActive = target.controller.setActive;
  deliver(target.controller, configurationMessages("config"));
  const writes = target.queue.messages.length;
  const renders = target.view.renders.length;

  target.clock.advance(60_000);
  onMinuteChange();
  assert.equal(target.queue.messages.length, writes);
  assert.equal(target.view.renders.length, renders + 1);
  assert.equal(target.view.renders.at(-1).nowMs, target.clock.now());

  setActive(false);
  target.clock.advance(60_000);
  onMinuteChange();
  assert.equal(target.queue.messages.length, writes);
  assert.equal(target.view.renders.length, renders + 1);

  setActive(true);
  onMinuteChange();
  assert.equal(target.queue.messages.length, writes);
  assert.equal(target.view.renders.length, renders + 2);
  assert.equal(target.view.renders.at(-1).nowMs, target.clock.now());
});

test("favorite capture, focus loss, and close make late settlement callbacks inert", () => {
  const target = harness();
  deliver(target.controller, configurationMessages("config"));
  const baseline = target.queue.messages.length;

  target.controller.onButton("down");
  deliver(target.controller, configurationMessages(
    "removed-active",
    [NEW_FAVORITES[0], NEW_FAVORITES[2]]
  ));
  target.scheduler.advance(LIMITS.favoriteSettleMs);
  assert.equal(target.queue.messages.length, baseline);
  assert.equal(
    target.view.renders.at(-1).activeFavorite.id,
    NEW_FAVORITES[0].id
  );

  target.controller.onButton("down");
  const focusTimer = target.scheduler.lastId;
  target.controller.setActive(false);
  target.scheduler.fire(focusTimer);
  assert.equal(target.queue.messages.length, baseline);

  target.controller.setActive(true);
  target.controller.onButton("up");
  const closeTimer = target.scheduler.lastId;
  const renders = target.view.renders.length;
  target.controller.close();
  target.scheduler.fire(closeTimer);
  target.controller.onMinuteChange();
  target.controller.onButton("select");
  assert.equal(target.queue.messages.length, baseline);
  assert.equal(target.view.renders.length, renders);
  assert.equal(target.queue.closed, 1);
  assert.equal(target.view.closed, 1);
});

test("enqueue failure cancels both expectations and consumes the app-open attempt", () => {
  const target = harness();
  target.queue.accept = false;
  deliver(target.controller, configurationMessages("config"));

  assert.equal(target.queue.attempts.length, 1);
  assert.equal(target.queue.messages.length, 0);
  const failedRequest = target.queue.attempts[0];
  const failedSnapshots = target.view.renders.filter((snapshot) => snapshot.sendFailed);
  assert.equal(failedSnapshots.length, 1);
  assert.equal(failedSnapshots[0].expectedRequest, null);

  const late = deliver(target.controller, resultMessages(
    failedRequest.get("REQUEST_ID"),
    failedRequest.get("FAVORITE_ID")
  ));
  assert.deepEqual(late, [
    RECEIVE_RESULT.REJECTED,
    RECEIVE_RESULT.REJECTED,
    RECEIVE_RESULT.REJECTED
  ]);
  assert.equal(target.view.renders.at(-1).result, null);

  target.queue.accept = true;
  deliver(target.controller, configurationMessages("later-config"));
  assert.equal(target.queue.attempts.length, 1);
});

test("queue failure cancels a sent request before any late result can commit", () => {
  const target = harness();
  deliver(target.controller, configurationMessages("config"));
  const request = target.queue.messages[0];

  target.controller.onQueueState({ type: QUEUE_STATE.FAILED });
  assert.equal(target.view.renders.at(-1).sendFailed, true);
  assert.equal(target.view.renders.at(-1).expectedRequest, null);
  assert.equal(
    target.controller.onReadable(resultMessages(
      request.get("REQUEST_ID"),
      request.get("FAVORITE_ID")
    )[0]),
    RECEIVE_RESULT.REJECTED
  );
  assert.equal(target.view.renders.at(-1).result, null);
});
