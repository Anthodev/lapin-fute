import test from "node:test";
import assert from "node:assert/strict";
import {
  copy,
  formatMinutes,
  normalizeLanguage
} from "../src/embeddedjs/localization.js";

const EXPECTED_COPY = {
  en: {
    unconfigured: "Open phone options\nAdd a PRIM key and favorite",
    loading: "Loading departures…",
    apiKeyInvalid: "PRIM key rejected\nOpen phone options",
    favoriteUnavailable: "Favorite unavailable\nOpen phone options",
    rateLimited: "Too many requests\nTry again later",
    departuresUnavailable: "Departures unavailable\nSelect to retry",
    noDepartures: "No departures",
    delayed: "Delayed",
    cancelled: "Cancelled",
    then: "then",
    freshRealtime: "Live",
    freshScheduled: "Scheduled",
    freshMixed: "Live + schedule",
    freshStale: "Out of date",
    updated: "Updated",
    now: "Now",
    departed: "Departed"
  },
  fr: {
    unconfigured: "Ouvrez les options téléphone\nAjoutez une clé PRIM et un favori",
    loading: "Chargement des départs…",
    apiKeyInvalid: "Clé PRIM refusée\nOuvrez les options téléphone",
    favoriteUnavailable: "Favori indisponible\nOuvrez les options téléphone",
    rateLimited: "Trop de demandes\nRéessayez plus tard",
    departuresUnavailable: "Départs indisponibles\nSélection pour réessayer",
    noDepartures: "Aucun départ",
    delayed: "Retardé",
    cancelled: "Annulé",
    then: "puis",
    freshRealtime: "Temps réel",
    freshScheduled: "Horaires",
    freshMixed: "Temps réel + horaires",
    freshStale: "Périmé",
    updated: "Mis à jour",
    now: "À quai",
    departed: "Parti"
  }
};

test("consultation copy returns every exact authored French and English string", () => {
  const ids = Object.keys(EXPECTED_COPY.en).sort();
  assert.deepEqual(Object.keys(EXPECTED_COPY.fr).sort(), ids);
  for (const language of ["en", "fr"]) {
    for (const id of ids) {
      assert.equal(
        copy(language, id),
        EXPECTED_COPY[language][id],
        language + ":" + id
      );
    }
  }
});

test("French subtags select French and every other input falls back to English", () => {
  ["fr", "fr-FR", "fr_FR", "fr-CA", "FR_fr"].forEach((tag) => {
    assert.equal(normalizeLanguage(tag), "fr");
    assert.equal(copy(tag, "loading"), "Chargement des départs…");
  });
  [undefined, null, "", "en", "en-US", "de-DE", "french"].forEach((tag) => {
    assert.equal(normalizeLanguage(tag), "en");
    assert.equal(copy(tag, "loading"), "Loading departures…");
  });
  assert.equal(copy("fr", "not-a-copy-key"), "");
});

test("countdown copy is bilingual without treating user labels as copy keys", () => {
  assert.equal(formatMinutes("en", -1), "Departed");
  assert.equal(formatMinutes("fr", -1), "Parti");
  assert.equal(formatMinutes("en", 0), "Now");
  assert.equal(formatMinutes("fr", 0), "À quai");
  assert.equal(formatMinutes("en", 12), "12 min");
  assert.equal(formatMinutes("fr", 12), "12 min");
  assert.equal(copy("fr", "Saint-Michel Notre-Dame"), "");
});
