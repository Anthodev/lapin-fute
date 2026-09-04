import test from "node:test";
import assert from "node:assert/strict";
import {
  DEPARTURE_STATUS,
  ERROR_CODE,
  FRESHNESS,
  KEY_STATUS,
  REQUEST_TRIGGER
} from "../src/embeddedjs/contracts.js";
import WatchModel, { WATCH_STATE } from "../src/embeddedjs/model.js";

const NOW_SECONDS = 1_788_000_000;
const NOW_MS = NOW_SECONDS * 1000;

function favorite(id, sortOrder, displayName) {
  const value = {
    id,
    serviceId: "opaque:service:" + id,
    stopLabel: "Stop " + id,
    lineLabel: "Line " + id,
    destinationLabel: "Destination " + id,
    sortOrder
  };
  if (displayName !== undefined) value.displayName = displayName;
  return value;
}

const FIRST = favorite("z-last-by-name", 80, "Trajet préféré très long");
const SECOND = favorite("a-first-by-name", 5);
const THIRD = favorite("middle", 20, "Middle");

function configuration(overrides = {}) {
  return {
    keyStatus: KEY_STATUS.CONFIGURED,
    language: "fr",
    favorites: [FIRST],
    ...overrides
  };
}

function departure(overrides = {}) {
  return {
    expectedAt: NOW_SECONDS + 120,
    minutes: 99,
    status: DEPARTURE_STATUS[0],
    ...overrides
  };
}

function result(overrides = {}) {
  return {
    requestId: "result-1",
    favoriteId: FIRST.id,
    fetchedAt: NOW_SECONDS,
    freshness: FRESHNESS[0],
    departures: [departure()],
    ...overrides
  };
}

function protocolError(code = ERROR_CODE[3], favoriteId = FIRST.id) {
  const value = {
    requestId: "error-1",
    code,
    occurredAt: NOW_SECONDS
  };
  if (favoriteId !== undefined) value.favoriteId = favoriteId;
  return value;
}

function commit(model, options = {}) {
  model.commitProtocol({
    configuration: options.configuration === undefined
      ? configuration()
      : options.configuration,
    result: options.result === undefined ? null : options.result,
    error: options.error === undefined ? null : options.error
  }, options.event || "CONFIG_COMMITTED");
  return model;
}

test("WATCH_STATE and the initial snapshot expose only the consultation model", () => {
  assert.deepEqual(WATCH_STATE, {
    UNCONFIGURED: "UNCONFIGURED",
    LOADING: "LOADING",
    READY: "READY",
    STALE: "STALE",
    UNAVAILABLE: "UNAVAILABLE"
  });
  assert.equal(Object.isFrozen(WATCH_STATE), true);

  const snapshot = new WatchModel().snapshot(NOW_MS);
  assert.deepEqual(snapshot, {
    state: WATCH_STATE.UNCONFIGURED,
    language: "en",
    nowMs: NOW_MS,
    activeFavorite: null,
    result: null,
    error: null,
    sendFailed: false,
    expectedRequest: null
  });
  assert.equal("favorite" in snapshot, false);
});

test("configuration and API key failures follow the fixed state precedence", () => {
  const complete = result();
  const scenarios = [
    {
      name: "missing configuration",
      configuration: null,
      error: protocolError(ERROR_CODE[1]),
      expected: WATCH_STATE.UNCONFIGURED
    },
    {
      name: "missing key before an invalid-key error",
      configuration: configuration({ keyStatus: KEY_STATUS.MISSING }),
      error: protocolError(ERROR_CODE[1]),
      expected: WATCH_STATE.UNCONFIGURED
    },
    {
      name: "empty favorites before an invalid-key error",
      configuration: configuration({ favorites: [] }),
      error: protocolError(ERROR_CODE[1]),
      expected: WATCH_STATE.UNCONFIGURED
    },
    {
      name: "required-key error before an invalid key status",
      configuration: configuration({ keyStatus: KEY_STATUS.INVALID }),
      error: protocolError(ERROR_CODE[0]),
      expected: WATCH_STATE.UNCONFIGURED
    },
    {
      name: "invalid key status before a complete result",
      configuration: configuration({ keyStatus: KEY_STATUS.INVALID }),
      error: null,
      expected: WATCH_STATE.UNAVAILABLE
    },
    {
      name: "invalid-key error before a complete result",
      configuration: configuration(),
      error: protocolError(ERROR_CODE[1]),
      expected: WATCH_STATE.UNAVAILABLE
    }
  ];

  for (const scenario of scenarios) {
    const model = commit(new WatchModel(), {
      configuration: scenario.configuration,
      result: complete,
      error: scenario.error
    });
    assert.equal(model.snapshot(NOW_MS).state, scenario.expected, scenario.name);
  }
});

test("configured states distinguish loading, unavailable, ready, and stale", () => {
  const loading = commit(new WatchModel());
  assert.equal(loading.snapshot(NOW_MS).state, WATCH_STATE.LOADING);
  assert.deepEqual(
    loading.beginRequest("app-open", REQUEST_TRIGGER.APP_OPEN),
    {
      requestId: "app-open",
      favoriteId: FIRST.id,
      trigger: REQUEST_TRIGGER.APP_OPEN
    }
  );
  assert.equal(loading.snapshot(NOW_MS).state, WATCH_STATE.LOADING);
  loading.markSendFailure();
  assert.equal(loading.snapshot(NOW_MS).state, WATCH_STATE.UNAVAILABLE);

  const ready = commit(new WatchModel(), {
    result: result(),
    event: "RESULT_COMMITTED"
  });
  assert.equal(ready.snapshot(NOW_MS).state, WATCH_STATE.READY);
  ready.beginRequest("refresh", REQUEST_TRIGGER.MANUAL_SELECT);
  assert.equal(ready.snapshot(NOW_MS).state, WATCH_STATE.READY);
  ready.markSendFailure();
  assert.equal(ready.snapshot(NOW_MS).state, WATCH_STATE.STALE);

  const failedRefresh = commit(new WatchModel(), {
    result: result(),
    error: protocolError(),
    event: "ERROR_COMMITTED"
  });
  assert.equal(failedRefresh.snapshot(NOW_MS).state, WATCH_STATE.STALE);

  const unavailable = commit(new WatchModel(), {
    error: protocolError(),
    event: "ERROR_COMMITTED"
  });
  assert.equal(unavailable.snapshot(NOW_MS).state, WATCH_STATE.UNAVAILABLE);

  const mismatchedResult = commit(new WatchModel(), {
    result: result({ favoriteId: SECOND.id }),
    event: "RESULT_COMMITTED"
  });
  assert.equal(mismatchedResult.snapshot(NOW_MS).state, WATCH_STATE.LOADING);
  assert.equal(mismatchedResult.snapshot(NOW_MS).result, null);

  const unrelatedFailure = commit(new WatchModel(), {
    result: result(),
    error: protocolError(ERROR_CODE[3], SECOND.id),
    event: "ERROR_COMMITTED"
  });
  assert.equal(unrelatedFailure.snapshot(NOW_MS).state, WATCH_STATE.READY);
  assert.equal(unrelatedFailure.snapshot(NOW_MS).error, null);
});

test("source age and frozen freshness use the exact stale boundary", () => {
  const model = commit(new WatchModel(), {
    result: result(),
    event: "RESULT_COMMITTED"
  });

  assert.equal(model.snapshot(NOW_MS - 1).state, WATCH_STATE.STALE);
  assert.equal(model.snapshot(NOW_MS).state, WATCH_STATE.READY);
  assert.equal(model.snapshot(NOW_MS + 59_999).state, WATCH_STATE.READY);
  assert.equal(model.snapshot(NOW_MS + 60_000).state, WATCH_STATE.STALE);

  commit(model, {
    result: result({ freshness: FRESHNESS[3] }),
    event: "RESULT_COMMITTED"
  });
  assert.equal(model.snapshot(NOW_MS).state, WATCH_STATE.STALE);
});

test("selection follows committed order and clamps without rewriting favorites", () => {
  const favorites = [FIRST, SECOND, THIRD];
  const before = structuredClone(favorites);
  const model = commit(new WatchModel(), {
    configuration: configuration({ favorites })
  });

  assert.deepEqual(model.snapshot(NOW_MS).activeFavorite, FIRST);
  assert.equal(model.moveSelection(-1), false);
  assert.equal(model.moveSelection(1), true);
  assert.deepEqual(model.snapshot(NOW_MS).activeFavorite, SECOND);
  assert.equal(model.moveSelection(20), true);
  assert.deepEqual(model.snapshot(NOW_MS).activeFavorite, THIRD);
  assert.equal(model.moveSelection(1), false);
  assert.equal(model.moveSelection(-20), true);
  assert.deepEqual(model.snapshot(NOW_MS).activeFavorite, FIRST);
  assert.equal(model.moveSelection(-1), false);
  assert.deepEqual(favorites, before);
});

test("configuration replacement preserves the active ID or falls back to index zero", () => {
  const model = commit(new WatchModel(), {
    configuration: configuration({ favorites: [FIRST, SECOND, THIRD] })
  });
  assert.equal(model.moveSelection(1), true);

  const updatedSecond = {
    ...SECOND,
    stopLabel: "Nouvel arrêt",
    sortOrder: 700
  };
  commit(model, {
    configuration: configuration({
      favorites: [THIRD, updatedSecond, FIRST]
    })
  });
  assert.deepEqual(model.snapshot(NOW_MS).activeFavorite, updatedSecond);

  commit(model, {
    configuration: configuration({ favorites: [THIRD, FIRST] })
  });
  assert.deepEqual(model.snapshot(NOW_MS).activeFavorite, THIRD);

  commit(model, {
    configuration: configuration({ favorites: [] })
  });
  assert.equal(model.snapshot(NOW_MS).activeFavorite, null);
});

test("beginRequest accepts only configured active-favorite consultation triggers", () => {
  const unavailableModels = [
    new WatchModel(),
    commit(new WatchModel(), {
      configuration: configuration({ keyStatus: KEY_STATUS.MISSING })
    }),
    commit(new WatchModel(), {
      configuration: configuration({ keyStatus: KEY_STATUS.INVALID })
    }),
    commit(new WatchModel(), {
      configuration: configuration({ favorites: [] })
    })
  ];
  for (const model of unavailableModels) {
    assert.equal(model.beginRequest("rejected", REQUEST_TRIGGER.APP_OPEN), null);
  }

  const model = commit(new WatchModel());
  const triggers = [
    REQUEST_TRIGGER.APP_OPEN,
    REQUEST_TRIGGER.FAVORITE_SELECTION,
    REQUEST_TRIGGER.MANUAL_SELECT
  ];
  for (let index = 0; index < triggers.length; index += 1) {
    const requestId = "accepted-" + index;
    assert.deepEqual(model.beginRequest(requestId, triggers[index]), {
      requestId,
      favoriteId: FIRST.id,
      trigger: triggers[index]
    });
    model.cancelRequest();
  }

  for (const trigger of [-1, 3, "APP_OPEN", null, undefined]) {
    assert.equal(model.beginRequest("invalid-trigger", trigger), null);
  }
});

test("pending requests suppress duplicates until a complete active result exists", () => {
  const loading = commit(new WatchModel());
  const first = loading.beginRequest("pending-1", REQUEST_TRIGGER.APP_OPEN);
  assert.equal(
    loading.beginRequest("pending-2", REQUEST_TRIGGER.FAVORITE_SELECTION),
    null
  );
  assert.deepEqual(loading.snapshot(NOW_MS).expectedRequest, first);

  const ready = commit(new WatchModel(), {
    result: result(),
    event: "RESULT_COMMITTED"
  });
  ready.beginRequest("refresh-1", REQUEST_TRIGGER.FAVORITE_SELECTION);
  assert.deepEqual(
    ready.beginRequest("refresh-2", REQUEST_TRIGGER.MANUAL_SELECT),
    {
      requestId: "refresh-2",
      favoriteId: FIRST.id,
      trigger: REQUEST_TRIGGER.MANUAL_SELECT
    }
  );
  const snapshot = ready.snapshot(NOW_MS);
  assert.equal(snapshot.state, WATCH_STATE.READY);
  assert.equal(snapshot.result.requestId, "result-1");
  assert.equal(snapshot.expectedRequest.requestId, "refresh-2");
});

test("snapshot derives countdowns from expectedAt without changing wire data", () => {
  const received = result({
    sourceUpdatedAt: NOW_SECONDS - 10,
    departures: [
      departure({
        expectedAt: NOW_SECONDS + 61,
        minutes: 44,
        aimedAt: NOW_SECONDS + 40
      }),
      departure({
        expectedAt: NOW_SECONDS,
        minutes: 27,
        status: DEPARTURE_STATUS[1],
        nextIntervalMinutes: 4
      }),
      departure({
        expectedAt: NOW_SECONDS - 120,
        minutes: -2,
        status: DEPARTURE_STATUS[2]
      }),
      departure({
        expectedAt: NOW_SECONDS - 61,
        minutes: 8,
        status: DEPARTURE_STATUS[3]
      })
    ]
  });
  const original = structuredClone(received);
  const model = commit(new WatchModel(), {
    result: received,
    event: "RESULT_COMMITTED"
  });

  const snapshot = model.snapshot(NOW_MS);
  assert.equal(snapshot.nowMs, NOW_MS);
  assert.deepEqual(
    snapshot.result.departures.map((item) => item.minutes),
    [44, 27, -2, 8]
  );
  assert.deepEqual(
    snapshot.result.departures.map((item) => item.countdownMinutes),
    [2, 0, null, -1]
  );
  assert.equal(snapshot.result.departures[2].status, DEPARTURE_STATUS[2]);
  assert.deepEqual(received, original);

  snapshot.result.departures[0].minutes = -100;
  const oneMinuteLater = model.snapshot(NOW_MS + 60_000);
  assert.equal(oneMinuteLater.result.departures[0].minutes, 44);
  assert.equal(oneMinuteLater.result.departures[0].countdownMinutes, 1);
  assert.equal(oneMinuteLater.result.departures[1].countdownMinutes, -1);
  assert.equal(oneMinuteLater.result.departures[2].countdownMinutes, null);
  assert.deepEqual(received, original);
});
