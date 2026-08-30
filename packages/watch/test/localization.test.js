import test from "node:test";
import assert from "node:assert/strict";
import {
  COPY,
  copy,
  formatMinutes,
  normalizeLanguage
} from "../src/embeddedjs/localization.js";

test("foundation fixture copy has complete French and English tables", () => {
  assert.deepEqual(Object.keys(COPY.fr).sort(), Object.keys(COPY.en).sort());
  Object.keys(COPY.en).forEach((key) => {
    assert.equal(typeof COPY.en[key], "string");
    assert.equal(COPY.en[key].length > 0, true);
    assert.equal(typeof COPY.fr[key], "string");
    assert.equal(COPY.fr[key].length > 0, true);
  });
});

test("fr language subtags select French and every other input falls back to English", () => {
  ["fr", "fr-FR", "fr_FR", "fr-CA", "FR_fr"].forEach((tag) => {
    assert.equal(normalizeLanguage(tag), "fr");
  });
  [undefined, null, "", "en", "en-US", "de-DE", "french"].forEach((tag) => {
    assert.equal(normalizeLanguage(tag), "en");
  });
  assert.equal(copy("fr_FR", "waiting"), "En attente des départs enregistrés…");
  assert.equal(copy("de_DE", "waiting"), "Waiting for recorded departures…");
});

test("fixture countdown formatting is bilingual and does not translate transport labels", () => {
  assert.equal(formatMinutes("en", -1), "Departed");
  assert.equal(formatMinutes("fr", 0), "À quai");
  assert.equal(formatMinutes("en", 12), "12 min");
  const labels = {
    displayName: "Bureau – côté Seine",
    stopLabel: "Saint-Michel Notre-Dame",
    lineLabel: "RER B",
    destinationLabel: "Aéroport Charles-de-Gaulle 2 TGV"
  };
  assert.deepEqual({ ...labels }, labels);
  assert.equal(copy("fr", labels.stopLabel), "");
});
