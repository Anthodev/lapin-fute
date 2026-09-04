import test from "node:test";
import assert from "node:assert/strict";
import {
  KEY_STATUS,
  LIMITS,
  MESSAGE_TYPE,
  REQUEST_TRIGGER,
  SCHEMA_VERSION
} from "../src/embeddedjs/contracts.js";
import {
  ProtocolReceiver,
  RECEIVE_RESULT,
  decodeMessage,
  encodeRequest
} from "../src/embeddedjs/protocol.js";

function message(type, entries = []) {
  return new Map([
    ["SCHEMA_VERSION", SCHEMA_VERSION],
    ["MESSAGE_TYPE", type],
    ...entries
  ]);
}

function configBegin(
  id = "config-1",
  count = 1,
  language = "fr",
  keyStatus = KEY_STATUS.CONFIGURED
) {
  return message(MESSAGE_TYPE.CONFIG_BEGIN, [
    ["REQUEST_ID", id],
    ["ITEM_COUNT", count],
    ["KEY_STATUS", keyStatus],
    ["DISPLAY_NAME", language]
  ]);
}

function favorite(id = "config-1", index = 0, favoriteId = "home") {
  return message(MESSAGE_TYPE.FAVORITE, [
    ["REQUEST_ID", id],
    ["ITEM_INDEX", index],
    ["FAVORITE_ID", favoriteId],
    ["SERVICE_ID", "opaque:service:1"],
    ["DISPLAY_NAME", "Maison"],
    ["STOP_LABEL", "Châtelet"],
    ["LINE_LABEL", "Métro 1"],
    ["DESTINATION_LABEL", "La Défense"],
    ["SORT_ORDER", index]
  ]);
}

function configCommit(id = "config-1") {
  return message(MESSAGE_TYPE.CONFIG_COMMIT, [["REQUEST_ID", id]]);
}

function resultBegin(requestId = "consult-test-1", favoriteId = "home", count = 1) {
  return message(MESSAGE_TYPE.RESULT_BEGIN, [
    ["REQUEST_ID", requestId],
    ["FAVORITE_ID", favoriteId],
    ["ITEM_COUNT", count],
    ["FETCHED_AT", 1_788_000_000],
    ["SOURCE_UPDATED_AT", 1_787_999_990],
    ["FRESHNESS", 0]
  ]);
}

function departure(requestId = "consult-test-1", favoriteId = "home", index = 0) {
  return message(MESSAGE_TYPE.DEPARTURE, [
    ["REQUEST_ID", requestId],
    ["FAVORITE_ID", favoriteId],
    ["ITEM_INDEX", index],
    ["EXPECTED_AT", 1_788_000_120],
    ["AIMED_AT", 1_788_000_100],
    ["MINUTES", 2],
    ["DEPARTURE_STATUS", 1],
    ["NEXT_INTERVAL_MINUTES", 4]
  ]);
}

function resultCommit(requestId = "consult-test-1", favoriteId = "home") {
  return message(MESSAGE_TYPE.RESULT_COMMIT, [
    ["REQUEST_ID", requestId],
    ["FAVORITE_ID", favoriteId]
  ]);
}

function errorMessage(requestId = "consult-test-1", favoriteId = "home") {
  return message(MESSAGE_TYPE.ERROR, [
    ["REQUEST_ID", requestId],
    ["FAVORITE_ID", favoriteId],
    ["ERROR_CODE", 3],
    ["OCCURRED_AT", 1_788_000_001],
    ["RETRY_AFTER_SECONDS", 30]
  ]);
}

function commitConfiguration(receiver) {
  assert.equal(receiver.receive(configBegin()), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(favorite()), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(configCommit()), RECEIVE_RESULT.CONFIG_COMMITTED);
}

function commitResult(receiver) {
  assert.equal(receiver.expectResponse("consult-test-1", "home", "consult-test-", 1), true);
  assert.equal(receiver.receive(resultBegin()), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(departure()), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(resultCommit()), RECEIVE_RESULT.RESULT_COMMITTED);
}

test("decoder validates all eight message types and request encoder returns aliases", () => {
  const request = encodeRequest({
    requestId: "consult-test-1",
    favoriteId: "home",
    trigger: REQUEST_TRIGGER.MANUAL_SELECT
  });
  const all = [
    request,
    configBegin(),
    favorite(),
    configCommit(),
    resultBegin(),
    departure(),
    resultCommit(),
    errorMessage()
  ];
  all.forEach((value) => assert.notEqual(decodeMessage(value), null));
  assert.deepEqual([...request.keys()], [
    "SCHEMA_VERSION",
    "MESSAGE_TYPE",
    "REQUEST_ID",
    "FAVORITE_ID",
    "REQUEST_TRIGGER"
  ]);
  assert.equal([...request.keys()].some((key) => /^\d+$/u.test(key)), false);
  assert.throws(() => encodeRequest({
    requestId: "consult-test-1",
    favoriteId: "home",
    trigger: 99
  }), TypeError);
});

test("decoder enforces exact aliases, types, UTF-8 bounds, and contextual locale", () => {
  const numericAlias = configBegin();
  numericAlias.set(0, SCHEMA_VERSION);
  assert.equal(decodeMessage(numericAlias), null);

  const unknownAlias = favorite();
  unknownAlias.set("UNKNOWN", 1);
  assert.equal(decodeMessage(unknownAlias), null);

  const longLabel = favorite();
  longLabel.set("STOP_LABEL", "é".repeat(49));
  assert.equal(decodeMessage(longLabel), null);

  assert.notEqual(decodeMessage(configBegin("config-1", 0, "en")), null);
  assert.notEqual(decodeMessage(configBegin("config-1", 0, "fr")), null);
  assert.equal(decodeMessage(configBegin("config-1", 0, "fr_FR")), null);
  assert.equal(decodeMessage(configBegin("config-1", 0, "de")), null);
});

test("configuration language and favorites stay private until complete commit", () => {
  const receiver = new ProtocolReceiver();
  assert.equal(receiver.receive(configBegin()), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.snapshot().configuration, null);
  assert.equal(receiver.receive(favorite()), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.snapshot().configuration, null);
  assert.equal(receiver.receive(configCommit()), RECEIVE_RESULT.CONFIG_COMMITTED);
  assert.deepEqual(receiver.snapshot().configuration, {
    keyStatus: KEY_STATUS.CONFIGURED,
    language: "fr",
    favorites: [{
      id: "home",
      serviceId: "opaque:service:1",
      displayName: "Maison",
      stopLabel: "Châtelet",
      lineLabel: "Métro 1",
      destinationLabel: "La Défense",
      sortOrder: 0
    }]
  });
});

test("idempotent restart synchronization reuses committed favorite objects", () => {
  const receiver = new ProtocolReceiver();
  commitConfiguration(receiver);
  const previous = receiver.borrowState().configuration.favorites[0];

  assert.equal(receiver.receive(configBegin("restart")), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(favorite("restart")), RECEIVE_RESULT.STAGED);
  assert.strictEqual(receiver.configStage.favorites[0], previous);
  assert.equal(receiver.receive(configCommit("restart")), RECEIVE_RESULT.CONFIG_COMMITTED);
  assert.strictEqual(receiver.borrowState().configuration.favorites[0], previous);
});

test("out-of-order, duplicate, and incomplete configuration cannot replace committed state", () => {
  const receiver = new ProtocolReceiver();
  commitConfiguration(receiver);
  const committed = receiver.snapshot().configuration;

  assert.equal(receiver.receive(configBegin("config-2", 2, "en")), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(favorite("config-2", 1, "work")), RECEIVE_RESULT.REJECTED);
  assert.equal(receiver.receive(configCommit("config-2")), RECEIVE_RESULT.REJECTED);
  assert.deepEqual(receiver.snapshot().configuration, committed);

  assert.equal(receiver.receive(configBegin("config-3", 2, "en")), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(favorite("config-3", 0, "home")), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(favorite("config-3", 1, "home")), RECEIVE_RESULT.REJECTED);
  assert.equal(receiver.receive(configCommit("config-3")), RECEIVE_RESULT.REJECTED);
  assert.deepEqual(receiver.snapshot().configuration, committed);
});

test("result stages atomically only for the expected request and favorite", () => {
  const receiver = new ProtocolReceiver();
  assert.equal(receiver.receive(resultBegin()), RECEIVE_RESULT.REJECTED);
  assert.equal(receiver.expectResponse("consult-test-1", "home", "consult-test-", 1), true);
  assert.equal(receiver.receive(resultBegin()), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.snapshot().result, null);
  assert.equal(receiver.receive(departure()), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.snapshot().result, null);
  assert.equal(receiver.receive(resultCommit()), RECEIVE_RESULT.RESULT_COMMITTED);
  assert.deepEqual(receiver.snapshot().result, {
    requestId: "consult-test-1",
    favoriteId: "home",
    fetchedAt: 1_788_000_000,
    sourceUpdatedAt: 1_787_999_990,
    freshness: "REALTIME",
    departures: [{
      expectedAt: 1_788_000_120,
      aimedAt: 1_788_000_100,
      minutes: 2,
      status: "DELAYED",
      nextIntervalMinutes: 4
    }]
  });
});

test("matching request handshake permits one cached result replacement", () => {
  const receiver = new ProtocolReceiver();
  const request = encodeRequest({
    requestId: "consult-test-1",
    favoriteId: "home",
    trigger: REQUEST_TRIGGER.APP_OPEN
  });
  const freshBegin = resultBegin();
  freshBegin.set("FETCHED_AT", 1_788_000_060);

  assert.equal(receiver.expectResponse("consult-test-1", "home", "consult-test-", 1), true);
  assert.equal(receiver.receive(resultBegin()), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(departure()), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(resultCommit()), RECEIVE_RESULT.RESULT_COMMITTED);
  assert.equal(receiver.snapshot().result.fetchedAt, 1_788_000_000);

  assert.equal(receiver.receive(request), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(freshBegin), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(departure()), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(resultCommit()), RECEIVE_RESULT.RESULT_COMMITTED);
  assert.equal(receiver.snapshot().result.fetchedAt, 1_788_000_060);
  assert.equal(receiver.receive(request), RECEIVE_RESULT.REJECTED);
});

test("every generated request above the commit watermark remains acceptable", () => {
  const receiver = new ProtocolReceiver();
  assert.equal(receiver.expectResponse("consult-test-1", "home", "consult-test-", 1), true);
  assert.equal(receiver.expectResponse("consult-test-2", "home", "consult-test-", 2), true);
  assert.equal(receiver.expectResponse("consult-test-3", "home", "consult-test-", 3), true);

  assert.equal(receiver.receive(resultBegin("consult-test-2")), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(departure("consult-test-2")), RECEIVE_RESULT.STAGED);
  assert.equal(
    receiver.receive(resultCommit("consult-test-2")),
    RECEIVE_RESULT.RESULT_COMMITTED
  );
  assert.equal(receiver.snapshot().result.requestId, "consult-test-2");

  assert.equal(receiver.receive(resultBegin("consult-test-1")), RECEIVE_RESULT.REJECTED);
  assert.equal(receiver.receive(resultBegin("consult-test-3")), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(departure("consult-test-3")), RECEIVE_RESULT.STAGED);
  assert.equal(
    receiver.receive(resultCommit("consult-test-3")),
    RECEIVE_RESULT.RESULT_COMMITTED
  );
  assert.equal(receiver.snapshot().result.requestId, "consult-test-3");
});

test("late items, count mismatches, unsupported schema, and mismatched errors preserve state", () => {
  const receiver = new ProtocolReceiver();
  commitConfiguration(receiver);
  commitResult(receiver);
  const committed = receiver.snapshot();

  assert.equal(receiver.expectResponse("consult-test-2", "home", "consult-test-", 2), true);
  assert.equal(receiver.receive(resultBegin("consult-test-1", "home", 0)), RECEIVE_RESULT.REJECTED);
  assert.equal(receiver.receive(resultBegin("consult-test-2", "home", 2)), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(departure("consult-test-2", "home", 0)), RECEIVE_RESULT.STAGED);
  assert.equal(receiver.receive(resultCommit("consult-test-2", "home")), RECEIVE_RESULT.REJECTED);
  assert.deepEqual(receiver.snapshot(), committed);

  assert.equal(receiver.receive(errorMessage("consult-test-1", "home")), RECEIVE_RESULT.REJECTED);
  const unsupported = configBegin("config-new", 0, "en");
  unsupported.set("SCHEMA_VERSION", 99);
  assert.equal(receiver.receive(unsupported), RECEIVE_RESULT.REJECTED);
  assert.deepEqual(receiver.snapshot(), committed);
});

test("matching error commits without destroying the prior complete result", () => {
  const receiver = new ProtocolReceiver();
  commitResult(receiver);
  const result = receiver.snapshot().result;
  assert.equal(receiver.expectResponse("consult-test-2", "home", "consult-test-", 2), true);
  assert.equal(receiver.receive(errorMessage("consult-test-2", "home")), RECEIVE_RESULT.ERROR_COMMITTED);
  assert.deepEqual(receiver.snapshot().result, result);
  assert.deepEqual(receiver.snapshot().error, {
    requestId: "consult-test-2",
    favoriteId: "home",
    code: "SOURCE_UNAVAILABLE",
    occurredAt: 1_788_000_001,
    retryAfterSeconds: 30
  });
});

test("state restoration preserves a complete result and error but cancels transport state", () => {
  const receiver = new ProtocolReceiver();
  commitConfiguration(receiver);
  commitResult(receiver);
  assert.equal(receiver.expectResponse("consult-test-2", "home", "consult-test-", 2), true);
  assert.equal(
    receiver.receive(errorMessage("consult-test-2", "home")),
    RECEIVE_RESULT.ERROR_COMMITTED
  );
  const committed = receiver.snapshot();

  assert.equal(receiver.expectResponse("consult-test-3", "home", "consult-test-", 3), true);
  assert.equal(
    receiver.receive(resultBegin("consult-test-3", "home")),
    RECEIVE_RESULT.STAGED
  );
  receiver.restoreState(committed);

  assert.deepEqual(receiver.snapshot(), committed);
  assert.equal(
    receiver.receive(resultCommit("consult-test-3", "home")),
    RECEIVE_RESULT.REJECTED
  );
  assert.deepEqual(receiver.snapshot(), committed);
});

test("receiver seeds, restores, and idempotently repeats complete configuration", () => {
  const initial = {
    keyStatus: KEY_STATUS.CONFIGURED,
    language: "fr",
    favorites: [{
      id: "home",
      serviceId: "opaque:service:1",
      displayName: "Maison",
      stopLabel: "Châtelet",
      lineLabel: "Métro 1",
      destinationLabel: "La Défense",
      sortOrder: 0
    }]
  };
  const receiver = new ProtocolReceiver(initial);
  initial.favorites[0].stopLabel = "mutated after construction";
  assert.equal(receiver.snapshot().configuration.favorites[0].stopLabel, "Châtelet");

  commitConfiguration(receiver);
  const committed = receiver.snapshot();
  commitConfiguration(receiver);
  assert.deepEqual(receiver.snapshot(), committed);

  assert.equal(receiver.receive(configBegin("interrupted", 1, "en")), RECEIVE_RESULT.STAGED);
  receiver.restoreConfiguration(committed.configuration);
  assert.equal(receiver.receive(configCommit("interrupted")), RECEIVE_RESULT.REJECTED);
  assert.deepEqual(receiver.snapshot(), committed);
});

test("configuration commits preserve only compatible results and cancel transport state", () => {
  const receiver = new ProtocolReceiver();
  commitConfiguration(receiver);
  commitResult(receiver);
  const result = receiver.snapshot().result;

  assert.equal(receiver.expectResponse("consult-test-2", "home", "consult-test-", 2), true);
  assert.equal(
    receiver.receive(errorMessage("consult-test-2", "home")),
    RECEIVE_RESULT.ERROR_COMMITTED
  );
  assert.notEqual(receiver.snapshot().error, null);

  assert.equal(receiver.expectResponse("consult-test-3", "home", "consult-test-", 3), true);
  assert.equal(
    receiver.receive(resultBegin("consult-test-3", "home", 1)),
    RECEIVE_RESULT.STAGED
  );
  assert.equal(
    receiver.receive(departure("consult-test-3", "home", 0)),
    RECEIVE_RESULT.STAGED
  );
  assert.equal(
    receiver.receive(configBegin("config-2", 1, "en", KEY_STATUS.INVALID)),
    RECEIVE_RESULT.STAGED
  );
  assert.equal(
    receiver.receive(favorite("config-2", 0, "home")),
    RECEIVE_RESULT.STAGED
  );
  assert.equal(
    receiver.receive(configCommit("config-2")),
    RECEIVE_RESULT.CONFIG_COMMITTED
  );

  const compatible = receiver.snapshot();
  assert.equal(compatible.configuration.keyStatus, KEY_STATUS.INVALID);
  assert.equal(compatible.configuration.language, "en");
  assert.deepEqual(compatible.result, result);
  assert.equal(compatible.error, null);
  assert.equal(
    receiver.receive(resultCommit("consult-test-3", "home")),
    RECEIVE_RESULT.REJECTED
  );
  assert.deepEqual(receiver.snapshot(), compatible);

  assert.equal(
    receiver.receive(configBegin("config-3", 1, "fr")),
    RECEIVE_RESULT.STAGED
  );
  assert.equal(
    receiver.receive(favorite("config-3", 0, "work")),
    RECEIVE_RESULT.STAGED
  );
  assert.equal(
    receiver.receive(configCommit("config-3")),
    RECEIVE_RESULT.CONFIG_COMMITTED
  );
  assert.equal(receiver.snapshot().result, null);
  assert.equal(receiver.snapshot().error, null);
});
