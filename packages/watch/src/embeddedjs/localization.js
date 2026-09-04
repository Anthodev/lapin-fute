import { LANGUAGE as CONTRACT_LANGUAGE } from "./contracts.js";

export const LANGUAGE = CONTRACT_LANGUAGE;

export function normalizeLanguage(tag) {
  if (typeof tag !== "string") return LANGUAGE.EN;
  const french = (tag.charCodeAt(0) === 70 || tag.charCodeAt(0) === 102)
    && (tag.charCodeAt(1) === 82 || tag.charCodeAt(1) === 114)
    && (tag.length === 2 || tag[2] === "-" || tag[2] === "_");
  return french ? LANGUAGE.FR : LANGUAGE.EN;
}

export function copy(language, id) {
  const french = normalizeLanguage(language) === LANGUAGE.FR;
  switch (id) {
    case "unconfigured":
      return french
        ? "Ouvrez les options téléphone\nAjoutez une clé PRIM et un favori"
        : "Open phone options\nAdd a PRIM key and favorite";
    case "loading":
      return french ? "Chargement des départs…" : "Loading departures…";
    case "apiKeyInvalid":
      return french
        ? "Clé PRIM refusée\nOuvrez les options téléphone"
        : "PRIM key rejected\nOpen phone options";
    case "favoriteUnavailable":
      return french
        ? "Favori indisponible\nOuvrez les options téléphone"
        : "Favorite unavailable\nOpen phone options";
    case "rateLimited":
      return french
        ? "Trop de demandes\nRéessayez plus tard"
        : "Too many requests\nTry again later";
    case "departuresUnavailable":
      return french
        ? "Départs indisponibles\nSélection pour réessayer"
        : "Departures unavailable\nSelect to retry";
    case "noDepartures":
      return french ? "Aucun départ" : "No departures";
    case "delayed":
      return french ? "Retardé" : "Delayed";
    case "cancelled":
      return french ? "Annulé" : "Cancelled";
    case "then":
      return french ? "puis" : "then";
    case "freshRealtime":
      return french ? "Temps réel" : "Live";
    case "freshScheduled":
      return french ? "Horaires" : "Scheduled";
    case "freshMixed":
      return french ? "Temps réel + horaires" : "Live + schedule";
    case "freshStale":
      return french ? "Périmé" : "Out of date";
    case "updated":
      return french ? "Mis à jour" : "Updated";
    case "now":
      return french ? "À quai" : "Now";
    case "departed":
      return french ? "Parti" : "Departed";
    default:
      return "";
  }
}

export function formatMinutes(language, minutes) {
  if (minutes < 0) return copy(language, "departed");
  if (minutes === 0) return copy(language, "now");
  return String(minutes) + " min";
}
