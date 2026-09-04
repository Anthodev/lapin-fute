import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import {
  DEPARTURE_STATUS,
  ERROR_CODE,
  FRESHNESS
} from "../src/embeddedjs/contracts.js";
import { WATCH_STATE } from "../src/embeddedjs/model.js";
import { createPresentation } from "../src/embeddedjs/presentation.js";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "piu/MC") {
      return {
        shortCircuit: true,
        url: "data:text/javascript,export {}"
      };
    }
    return nextResolve(specifier, context);
  }
});

globalThis.Behavior = class {};
globalThis.Style = class {
  constructor(options) {
    Object.assign(this, options);
  }
};
globalThis.Port = class {
  constructor(_, options) {
    this.behavior = new options.Behavior();
    this.behavior.onCreate();
  }

  invalidate() {}
};
globalThis.Application = class {
  constructor(_, options) {
    Object.assign(this, options);
  }

  empty() {
    this.contents = [];
  }
};

const { createWatchView } = await import("../src/embeddedjs/ui.js");

function localSeconds(hours, minutes) {
  return Math.floor(new Date(2026, 8, 4, hours, minutes, 0, 0).getTime() / 1000);
}

const FETCHED_AT = localSeconds(15, 5);
const EXPECTED_COPY = {
  en: {
    unconfigured: "Open phone options\nAdd a PRIM key and favorite",
    loading: "Loading departures…",
    apiKeyInvalid: "PRIM key rejected\nOpen phone options",
    favoriteUnavailable: "Favorite unavailable\nOpen phone options",
    rateLimited: "Too many requests\nTry again later",
    departuresUnavailable: "Departures unavailable\nSelect to retry",
    noDepartures: "No departures",
    freshRealtime: "Live",
    freshScheduled: "Scheduled",
    freshMixed: "Live + schedule",
    freshStale: "Out of date",
    updated: "Updated"
  },
  fr: {
    unconfigured: "Ouvrez les options téléphone\nAjoutez une clé PRIM et un favori",
    loading: "Chargement des départs…",
    apiKeyInvalid: "Clé PRIM refusée\nOuvrez les options téléphone",
    favoriteUnavailable: "Favori indisponible\nOuvrez les options téléphone",
    rateLimited: "Trop de demandes\nRéessayez plus tard",
    departuresUnavailable: "Départs indisponibles\nSélection pour réessayer",
    noDepartures: "Aucun départ",
    freshRealtime: "Temps réel",
    freshScheduled: "Horaires",
    freshMixed: "Temps réel + horaires",
    freshStale: "Périmé",
    updated: "Mis à jour"
  }
};

function favorite(overrides = {}) {
  return {
    id: "home",
    serviceId: "opaque:service:home",
    stopLabel: "Saint-Michel Notre-Dame",
    lineLabel: "RER B",
    destinationLabel: "Aéroport Charles-de-Gaulle 2 TGV",
    sortOrder: 0,
    displayName: "Bureau – côté Seine",
    ...overrides
  };
}

function departure(overrides = {}) {
  return {
    expectedAt: FETCHED_AT + 120,
    aimedAt: FETCHED_AT + 60,
    minutes: 999,
    countdownMinutes: 2,
    status: DEPARTURE_STATUS[0],
    ...overrides
  };
}

function result(overrides = {}) {
  return {
    requestId: "result-1",
    favoriteId: "home",
    fetchedAt: FETCHED_AT,
    sourceUpdatedAt: FETCHED_AT - 10,
    freshness: FRESHNESS[0],
    departures: [departure()],
    ...overrides
  };
}

function snapshot(overrides = {}) {
  return {
    state: WATCH_STATE.READY,
    language: "en",
    nowMs: FETCHED_AT * 1000,
    activeFavorite: favorite(),
    result: result(),
    error: null,
    sendFailed: false,
    expectedRequest: null,
    ...overrides
  };
}

function present(value, screenInfo = {}) {
  return createPresentation(value, {
    width: 200,
    height: 228,
    round: false,
    hour12: false,
    ...screenInfo
  });
}

test("the five consultation states select result, loading, and critical content", () => {
  const unconfigured = present(snapshot({
    state: WATCH_STATE.UNCONFIGURED,
    activeFavorite: null,
    result: null
  }));
  assert.equal(unconfigured.stateMessage, EXPECTED_COPY.en.unconfigured);
  assert.deepEqual(unconfigured.rows, []);
  assert.equal(unconfigured.footer, "");

  const loading = present(snapshot({
    state: WATCH_STATE.LOADING,
    language: "fr",
    result: null
  }));
  assert.equal(loading.stateMessage, EXPECTED_COPY.fr.loading);
  assert.deepEqual(loading.rows, []);
  assert.equal(loading.footer, "");

  const ready = present(snapshot());
  assert.equal(ready.stateMessage, "");
  assert.deepEqual(ready.rows, ["2 min"]);
  assert.equal(ready.footer, "Live · Updated 15:05");

  const stale = present(snapshot({
    state: WATCH_STATE.STALE,
    error: {
      requestId: "failed-refresh",
      favoriteId: "home",
      code: ERROR_CODE[3],
      occurredAt: FETCHED_AT
    }
  }));
  assert.equal(stale.stateMessage, "");
  assert.deepEqual(stale.rows, ["2 min"]);
  assert.equal(stale.footer, "Out of date · Updated 15:05");

  const unavailable = present(snapshot({
    state: WATCH_STATE.UNAVAILABLE,
    result: null,
    error: {
      requestId: "failed-load",
      favoriteId: "home",
      code: ERROR_CODE[3],
      occurredAt: FETCHED_AT
    }
  }));
  assert.equal(unavailable.stateMessage, EXPECTED_COPY.en.departuresUnavailable);
  assert.deepEqual(unavailable.rows, []);
  assert.equal(unavailable.footer, "");
});

test("every frozen error code maps to the authored critical message", () => {
  const scenarios = [
    { state: WATCH_STATE.UNCONFIGURED, code: ERROR_CODE[0], copyId: "unconfigured" },
    { state: WATCH_STATE.UNAVAILABLE, code: ERROR_CODE[1], copyId: "apiKeyInvalid" },
    { state: WATCH_STATE.UNAVAILABLE, code: ERROR_CODE[2], copyId: "favoriteUnavailable" },
    { state: WATCH_STATE.UNAVAILABLE, code: ERROR_CODE[3], copyId: "departuresUnavailable" },
    { state: WATCH_STATE.UNAVAILABLE, code: ERROR_CODE[4], copyId: "rateLimited" },
    { state: WATCH_STATE.UNAVAILABLE, code: ERROR_CODE[5], copyId: "departuresUnavailable" }
  ];

  for (const language of ["en", "fr"]) {
    for (const scenario of scenarios) {
      const presentation = present(snapshot({
        state: scenario.state,
        language,
        result: null,
        error: {
          requestId: "error-" + scenario.code,
          favoriteId: "home",
          code: scenario.code,
          occurredAt: FETCHED_AT
        }
      }));
      assert.equal(presentation.stateMessage, EXPECTED_COPY[language][scenario.copyId]);
      assert.deepEqual(presentation.rows, []);
      assert.equal(presentation.footer, "");
    }

    assert.equal(present(snapshot({
      state: WATCH_STATE.UNAVAILABLE,
      language,
      result: null,
      error: null
    })).stateMessage, EXPECTED_COPY[language].apiKeyInvalid);
    assert.equal(present(snapshot({
      state: WATCH_STATE.UNAVAILABLE,
      language,
      result: null,
      error: null,
      sendFailed: true
    })).stateMessage, EXPECTED_COPY[language].departuresUnavailable);
  }
});

test("language fallback and maximum labels remain verbatim without mutating inputs", () => {
  const displayName = "é".repeat(48);
  const stopLabel = "S".repeat(96);
  const lineLabel = "L".repeat(96);
  const destinationLabel = "D".repeat(96);
  const value = snapshot({
    state: WATCH_STATE.LOADING,
    language: "de-DE",
    activeFavorite: favorite({
      displayName,
      stopLabel,
      lineLabel,
      destinationLabel
    }),
    result: null
  });
  const screenInfo = {
    width: 200,
    height: 228,
    round: false,
    hour12: false
  };
  const originalValue = structuredClone(value);
  const originalScreen = { ...screenInfo };
  const presentation = createPresentation(value, screenInfo);

  assert.equal(new TextEncoder().encode(displayName).length, 96);
  assert.equal(presentation.favoriteLabel, displayName);
  assert.equal(presentation.header, lineLabel + "\n" + destinationLabel);
  assert.equal(presentation.stateMessage, EXPECTED_COPY.en.loading);
  assert.deepEqual(value, originalValue);
  assert.deepEqual(screenInfo, originalScreen);

  const fallback = present(snapshot({
    state: WATCH_STATE.LOADING,
    language: "fr-CA",
    activeFavorite: favorite({ displayName: "", stopLabel }),
    result: null
  }));
  assert.equal(fallback.favoriteLabel, stopLabel);
  assert.equal(fallback.stateMessage, EXPECTED_COPY.fr.loading);
});

test("emery shows three rows and round gabbro shows two formatted rows", () => {
  const value = snapshot({
    result: result({
      sourceUpdatedAt: 123,
      departures: [
        departure({ aimedAt: 456, minutes: 88, countdownMinutes: 0 }),
        departure({
          minutes: -50,
          countdownMinutes: 12,
          status: DEPARTURE_STATUS[1],
          nextIntervalMinutes: 5
        }),
        departure({
          minutes: 45,
          countdownMinutes: null,
          status: DEPARTURE_STATUS[2],
          nextIntervalMinutes: 9
        }),
        departure({ minutes: 0, countdownMinutes: -1 })
      ]
    })
  });
  const emery = present(value);
  const gabbro = present(value, {
    width: 180,
    height: 180,
    round: true
  });

  assert.deepEqual(Object.keys(emery).sort(), [
    "favoriteLabel",
    "footer",
    "header",
    "rowLimit",
    "rows",
    "stateMessage"
  ]);
  assert.equal(emery.rowLimit, 3);
  assert.deepEqual(emery.rows, [
    "Now",
    "12 min · Delayed · then 5 min",
    "Cancelled"
  ]);
  assert.equal(gabbro.rowLimit, 2);
  assert.deepEqual(gabbro.rows, emery.rows.slice(0, 2));
  assert.equal(gabbro.favoriteLabel, emery.favoriteLabel);
  assert.equal(gabbro.header, emery.header);
  assert.equal(gabbro.stateMessage, emery.stateMessage);
  assert.equal(gabbro.footer, emery.footer);

  const french = present(snapshot({
    language: "fr",
    result: result({
      departures: [
        departure({
          countdownMinutes: -1,
          status: DEPARTURE_STATUS[1],
          nextIntervalMinutes: 0
        }),
        departure({
          countdownMinutes: null,
          status: DEPARTURE_STATUS[2],
          nextIntervalMinutes: 4
        })
      ]
    })
  }), { round: true });
  assert.deepEqual(french.rows, [
    "Parti · Retardé · puis 0 min",
    "Annulé"
  ]);
});

test("derived countdown text changes at minute boundaries and ignores wire minutes", () => {
  const expectedAtMs = (FETCHED_AT + 600) * 1000;
  function rowAt(offsetMs) {
    const nowMs = expectedAtMs + offsetMs;
    const countdownMinutes = Math.ceil((expectedAtMs - nowMs) / 60000);
    return present(snapshot({
      nowMs,
      result: result({
        departures: [departure({
          expectedAt: expectedAtMs / 1000,
          minutes: 777,
          countdownMinutes
        })]
      })
    })).rows[0];
  }

  assert.equal(rowAt(-60_001), "2 min");
  assert.equal(rowAt(-60_000), "1 min");
  assert.equal(rowAt(0), "Now");
  assert.equal(rowAt(1), "Now");
  assert.equal(rowAt(60_000), "Departed");
});

test("every freshness label and 12/24-hour refresh time is localized", () => {
  const freshnessCases = [
    { freshness: FRESHNESS[0], copyId: "freshRealtime" },
    { freshness: FRESHNESS[1], copyId: "freshScheduled" },
    { freshness: FRESHNESS[2], copyId: "freshMixed" },
    { freshness: FRESHNESS[3], copyId: "freshStale" }
  ];

  for (const language of ["en", "fr"]) {
    for (const scenario of freshnessCases) {
      const presentation = present(snapshot({
        state: scenario.freshness === FRESHNESS[3]
          ? WATCH_STATE.STALE
          : WATCH_STATE.READY,
        language,
        result: result({ freshness: scenario.freshness })
      }));
      assert.equal(
        presentation.footer,
        EXPECTED_COPY[language][scenario.copyId]
          + " · " + EXPECTED_COPY[language].updated + " 15:05"
      );
    }
  }

  const twelveHour = present(snapshot(), { hour12: true });
  const twentyFourHour = present(snapshot(), { hour12: false });
  assert.equal(twelveHour.footer, "Live · Updated 03:05");
  assert.equal(twentyFourHour.footer, "Live · Updated 15:05");
  assert.deepEqual(
    { ...twelveHour, footer: "" },
    { ...twentyFourHour, footer: "" }
  );

  const midnight = localSeconds(0, 7);
  assert.equal(present(snapshot({
    result: result({ fetchedAt: midnight })
  }), { hour12: true }).footer, "Live · Updated 12:07");
  assert.equal(present(snapshot({
    result: result({ fetchedAt: midnight })
  }), { hour12: false }).footer, "Live · Updated 00:07");
});

test("empty results and every critical copy stay within authored line bounds", () => {
  const empty = present(snapshot({
    language: "fr",
    result: result({ departures: [] })
  }));
  assert.equal(empty.stateMessage, EXPECTED_COPY.fr.noDepartures);
  assert.deepEqual(empty.rows, []);
  assert.equal(empty.footer, "Temps réel · Mis à jour 15:05");

  const criticalIds = [
    "unconfigured",
    "loading",
    "apiKeyInvalid",
    "favoriteUnavailable",
    "rateLimited",
    "departuresUnavailable"
  ];
  for (const language of ["en", "fr"]) {
    for (const copyId of criticalIds) {
      const lines = EXPECTED_COPY[language][copyId].split("\n");
      assert.equal(lines.length <= 2, true, language + ":" + copyId);
      assert.equal(
        lines.every((line) => Array.from(line).length <= 33),
        true,
        language + ":" + copyId
      );
    }
  }
});

function drawWatchFrame(screenInfo, activeFavorite) {
  const view = createWatchView(screenInfo);
  const port = view.application.contents[0];
  const draws = [];
  const drawingPort = {
    width: screenInfo.width,
    height: screenInfo.height,
    fillColor() {},
    pushClip() {},
    popClip() {},
    measureString(string) {
      let width = 0;
      for (const character of string) {
        if (character === "W") width += 9;
        else if (character === "i") width += 3;
        else if (character === "…") width += 5;
        else width += 7;
      }
      return { width };
    },
    drawStyle(string, style, x, y, width, height) {
      draws.push({
        string,
        x,
        y,
        width,
        height,
        measuredWidth: this.measureString(string, style).width
      });
    }
  };
  view.render(snapshot({ activeFavorite }));
  port.behavior.onDraw(drawingPort);
  view.releasePresentation();
  return draws;
}

test("route drawing reserves one pixel-bounded line for each contract-max label", () => {
  const platforms = [
    { width: 200, height: 228, round: false },
    { width: 180, height: 180, round: true }
  ];
  const lineLabel = "W".repeat(96);
  const destinationLabel = "i".repeat(96);

  for (const screenInfo of platforms) {
    const longDraws = drawWatchFrame(screenInfo, favorite({
      displayName: "Desk",
      lineLabel,
      destinationLabel
    }));
    const lineDraw = longDraws.find((draw) => draw.string.startsWith("W"));
    const destinationDraw = longDraws.find((draw) => draw.string.startsWith("i"));

    assert.ok(lineDraw, "line label is visibly represented");
    assert.ok(destinationDraw, "destination label is visibly represented");
    assert.equal(lineDraw.string.endsWith("…"), true);
    assert.equal(destinationDraw.string.endsWith("…"), true);
    assert.equal(lineDraw.measuredWidth <= lineDraw.width, true);
    assert.equal(destinationDraw.measuredWidth <= destinationDraw.width, true);
    assert.equal(lineDraw.height, 16);
    assert.equal(destinationDraw.height, 16);
    assert.equal(destinationDraw.y - lineDraw.y, 16);

    const normalDraws = drawWatchFrame(screenInfo, favorite({
      displayName: "Desk",
      lineLabel: "RER B",
      destinationLabel: "Paris"
    }));
    assert.ok(normalDraws.some((draw) => draw.string === "RER B"));
    assert.ok(normalDraws.some((draw) => draw.string === "Paris"));
  }
});
