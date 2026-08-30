import { LANGUAGE as CONTRACT_LANGUAGE } from "./contracts.js";

export const LANGUAGE = CONTRACT_LANGUAGE;

export const COPY = Object.freeze({
  en: Object.freeze({
    appName: "Lapin Futé",
    synchronizing: "Synchronizing fixture…",
    waiting: "Waiting for recorded departures…",
    unavailable: "Fixture unavailable",
    noDepartures: "No recorded departures",
    recordedFixture: "Recorded foundation fixture",
    now: "Now",
    departed: "Departed"
  }),
  fr: Object.freeze({
    appName: "Lapin Futé",
    synchronizing: "Synchronisation du scénario…",
    waiting: "En attente des départs enregistrés…",
    unavailable: "Scénario indisponible",
    noDepartures: "Aucun départ enregistré",
    recordedFixture: "Scénario de fondation enregistré",
    now: "À quai",
    departed: "Parti"
  })
});

export function normalizeLanguage(tag) {
  if (typeof tag !== "string") return LANGUAGE.EN;
  return tag.toLowerCase().split(/[-_]/)[0] === LANGUAGE.FR
    ? LANGUAGE.FR
    : LANGUAGE.EN;
}

export function copy(language, id) {
  const table = COPY[normalizeLanguage(language)];
  return Object.prototype.hasOwnProperty.call(table, id) ? table[id] : "";
}

export function formatMinutes(language, minutes) {
  if (minutes < 0) return copy(language, "departed");
  if (minutes === 0) return copy(language, "now");
  return String(minutes) + " min";
}
