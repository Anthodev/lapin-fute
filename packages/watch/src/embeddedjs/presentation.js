import {
  DEPARTURE_STATUS,
  ERROR_CODE,
  FRESHNESS
} from "./contracts.js";
import { copy, formatMinutes } from "./localization.js";
import { WATCH_STATE } from "./model.js";

function formatClock(seconds, hour12) {
  const date = new Date(seconds * 1000);
  let hours = date.getHours();
  if (hour12) hours = hours % 12 || 12;
  const hourText = hours < 10 ? "0" + hours : String(hours);
  const minutes = date.getMinutes();
  const minuteText = minutes < 10 ? "0" + minutes : String(minutes);
  return hourText + ":" + minuteText;
}

function errorMessage(language, error, sendFailed) {
  if (!error) {
    return copy(language, sendFailed ? "departuresUnavailable" : "apiKeyInvalid");
  }
  switch (error.code) {
    case ERROR_CODE[0]:
      return copy(language, "unconfigured");
    case ERROR_CODE[1]:
      return copy(language, "apiKeyInvalid");
    case ERROR_CODE[2]:
      return copy(language, "favoriteUnavailable");
    case ERROR_CODE[4]:
      return copy(language, "rateLimited");
    case ERROR_CODE[3]:
    case ERROR_CODE[5]:
    default:
      return copy(language, "departuresUnavailable");
  }
}

function freshnessCopyId(state, freshness) {
  if (state === WATCH_STATE.STALE || freshness === FRESHNESS[3]) return "freshStale";
  if (freshness === FRESHNESS[0]) return "freshRealtime";
  if (freshness === FRESHNESS[1]) return "freshScheduled";
  if (freshness === FRESHNESS[2]) return "freshMixed";
  return "freshStale";
}

function departureRow(language, departure, nowMs) {
  if (departure.status === DEPARTURE_STATUS[2]) {
    return copy(language, "cancelled");
  }
  const countdown = departure.countdownMinutes === undefined
    ? Math.ceil((departure.expectedAt * 1000 - nowMs) / 60000)
    : departure.countdownMinutes;
  let row = formatMinutes(language, countdown);
  if (departure.status === DEPARTURE_STATUS[1]) {
    row += " · " + copy(language, "delayed");
  }
  if (departure.nextIntervalMinutes !== undefined) {
    row += " · " + copy(language, "then")
      + " " + departure.nextIntervalMinutes + " min";
  }
  return row;
}

export function createPresentation(snapshot, screenInfo) {
  const language = snapshot.language;
  const favorite = snapshot.activeFavorite;
  const rowLimit = screenInfo && screenInfo.round === true ? 2 : 3;
  const favoriteLabel = favorite
    ? favorite.displayName || favorite.stopLabel
    : "";
  const header = favorite
    ? favorite.lineLabel + "\n" + favorite.destinationLabel
    : "";
  const rows = [];
  let stateMessage = "";
  let footer = "";
  const displaysResult = snapshot.result
    && (snapshot.state === WATCH_STATE.READY || snapshot.state === WATCH_STATE.STALE);

  if (displaysResult) {
    const count = Math.min(rowLimit, snapshot.result.departures.length);
    for (let index = 0; index < count; index += 1) {
      rows.push(departureRow(language, snapshot.result.departures[index], snapshot.nowMs));
    }
    if (rows.length === 0) stateMessage = copy(language, "noDepartures");
    footer = copy(
      language,
      freshnessCopyId(snapshot.state, snapshot.result.freshness)
    ) + " · " + copy(language, "updated") + " "
      + formatClock(snapshot.result.fetchedAt, screenInfo && screenInfo.hour12 === true);
  } else if (snapshot.state === WATCH_STATE.UNCONFIGURED) {
    stateMessage = copy(language, "unconfigured");
  } else if (snapshot.state === WATCH_STATE.LOADING) {
    stateMessage = copy(language, "loading");
  } else if (snapshot.state === WATCH_STATE.UNAVAILABLE) {
    stateMessage = errorMessage(language, snapshot.error, snapshot.sendFailed);
  }

  return {
    favoriteLabel,
    header,
    rows,
    stateMessage,
    footer,
    rowLimit
  };
}
