import {
  DEPARTURE_STATUS,
  ERROR_CODE,
  FRESHNESS,
  KEY_STATUS,
  REQUEST_TRIGGER
} from "./contracts.js";

const CACHE_FRESH_MS = 60 * 1000;

export const WATCH_STATE = Object.freeze({
  UNCONFIGURED: "UNCONFIGURED",
  LOADING: "LOADING",
  READY: "READY",
  STALE: "STALE",
  UNAVAILABLE: "UNAVAILABLE"
});

function copyFavorite(favorite) {
  if (!favorite) return null;
  const copy = {
    id: favorite.id,
    serviceId: favorite.serviceId,
    stopLabel: favorite.stopLabel,
    lineLabel: favorite.lineLabel,
    destinationLabel: favorite.destinationLabel,
    sortOrder: favorite.sortOrder
  };
  if (favorite.displayName !== undefined) copy.displayName = favorite.displayName;
  return copy;
}

function copyDeparture(departure, nowMs) {
  const copy = {
    expectedAt: departure.expectedAt,
    minutes: departure.minutes,
    status: departure.status,
    countdownMinutes: departure.status === DEPARTURE_STATUS[2]
      ? null
      : Math.ceil((departure.expectedAt * 1000 - nowMs) / 60000)
  };
  if (departure.aimedAt !== undefined) copy.aimedAt = departure.aimedAt;
  if (departure.nextIntervalMinutes !== undefined) {
    copy.nextIntervalMinutes = departure.nextIntervalMinutes;
  }
  return copy;
}

function copyResult(result, nowMs) {
  if (!result) return null;
  const departures = [];
  for (let index = 0; index < result.departures.length; index += 1) {
    departures.push(copyDeparture(result.departures[index], nowMs));
  }
  const copy = {
    requestId: result.requestId,
    favoriteId: result.favoriteId,
    fetchedAt: result.fetchedAt,
    freshness: result.freshness,
    departures
  };
  if (result.sourceUpdatedAt !== undefined) copy.sourceUpdatedAt = result.sourceUpdatedAt;
  return copy;
}

function copyError(error) {
  if (!error) return null;
  const copy = {
    requestId: error.requestId,
    code: error.code,
    occurredAt: error.occurredAt
  };
  if (error.favoriteId !== undefined) copy.favoriteId = error.favoriteId;
  if (error.retryAfterSeconds !== undefined) {
    copy.retryAfterSeconds = error.retryAfterSeconds;
  }
  return copy;
}

function findFavorite(configuration, favoriteId) {
  if (!configuration) return null;
  for (let index = 0; index < configuration.favorites.length; index += 1) {
    if (configuration.favorites[index].id === favoriteId) {
      return configuration.favorites[index];
    }
  }
  return null;
}

function activeResult(result, favorite) {
  return favorite && result && result.favoriteId === favorite.id ? result : null;
}

function activeError(error, favorite) {
  return favorite
    && error
    && (error.favoriteId === undefined || error.favoriteId === favorite.id)
    ? error
    : null;
}

function validTrigger(trigger) {
  return trigger === REQUEST_TRIGGER.APP_OPEN
    || trigger === REQUEST_TRIGGER.FAVORITE_SELECTION
    || trigger === REQUEST_TRIGGER.MANUAL_SELECT;
}

function stateFor(configuration, favorite, result, error, sendFailed, nowMs) {
  if (!configuration
      || configuration.keyStatus === KEY_STATUS.MISSING
      || !favorite
      || (error && error.code === ERROR_CODE[0])) {
    return WATCH_STATE.UNCONFIGURED;
  }
  if (configuration.keyStatus === KEY_STATUS.INVALID
      || (error && error.code === ERROR_CODE[1])) {
    return WATCH_STATE.UNAVAILABLE;
  }
  if (result) {
    const age = nowMs - result.fetchedAt * 1000;
    if (error
        || sendFailed
        || result.freshness === FRESHNESS[3]
        || age < 0
        || age >= CACHE_FRESH_MS) {
      return WATCH_STATE.STALE;
    }
    return WATCH_STATE.READY;
  }
  if (error || sendFailed) return WATCH_STATE.UNAVAILABLE;
  return WATCH_STATE.LOADING;
}

export class WatchModel {
  constructor() {
    this.configuration = null;
    this.activeFavoriteId = null;
    this.result = null;
    this.error = null;
    this.expected = null;
    this.sendFailureFavoriteId = null;
  }

  commitProtocol(protocolSnapshot, event) {
    const previousActiveId = this.activeFavoriteId;
    this.configuration = protocolSnapshot.configuration;
    this.result = protocolSnapshot.result;
    this.error = protocolSnapshot.error;

    const preserved = findFavorite(this.configuration, previousActiveId);
    const first = this.configuration && this.configuration.favorites.length > 0
      ? this.configuration.favorites[0]
      : null;
    this.activeFavoriteId = preserved ? preserved.id : first ? first.id : null;

    if (event === "CONFIG_COMMITTED" || event === "CONFIG_RESTORED") {
      this.cancelRequest();
      this.sendFailureFavoriteId = null;
    } else if (event === "RESULT_COMMITTED" || event === "ERROR_COMMITTED") {
      this.cancelRequest();
      this.sendFailureFavoriteId = null;
    }
  }

  moveSelection(delta) {
    if (!this.configuration
        || this.configuration.favorites.length === 0
        || typeof delta !== "number"
        || !isFinite(delta)
        || Math.floor(delta) !== delta
        || delta === 0) {
      return false;
    }

    const favorites = this.configuration.favorites;
    let currentIndex = 0;
    for (let index = 0; index < favorites.length; index += 1) {
      if (favorites[index].id === this.activeFavoriteId) {
        currentIndex = index;
        break;
      }
    }
    const nextIndex = Math.max(0, Math.min(favorites.length - 1, currentIndex + delta));
    const nextId = favorites[nextIndex].id;
    if (nextId === this.activeFavoriteId) return false;
    this.activeFavoriteId = nextId;
    return true;
  }

  beginRequest(requestId, trigger) {
    const favorite = findFavorite(this.configuration, this.activeFavoriteId);
    if (!favorite
        || this.configuration.keyStatus !== KEY_STATUS.CONFIGURED
        || !validTrigger(trigger)
        || (this.expected && !activeResult(this.result, favorite))) {
      return null;
    }
    this.expected = {
      requestId,
      favoriteId: favorite.id,
      trigger
    };
    if (this.sendFailureFavoriteId === favorite.id) {
      this.sendFailureFavoriteId = null;
    }
    return this.expected;
  }

  cancelRequest() {
    this.expected = null;
  }

  markSendFailure() {
    const favorite = findFavorite(this.configuration, this.activeFavoriteId);
    this.expected = null;
    this.sendFailureFavoriteId = favorite ? favorite.id : null;
  }

  snapshot(nowMs, copy = true) {
    const favorite = findFavorite(this.configuration, this.activeFavoriteId);
    const result = activeResult(this.result, favorite);
    const error = activeError(this.error, favorite);
    const sendFailed = Boolean(
      favorite && this.sendFailureFavoriteId === favorite.id
    );
    return {
      state: stateFor(
        this.configuration,
        favorite,
        result,
        error,
        sendFailed,
        nowMs
      ),
      language: this.configuration ? this.configuration.language : "en",
      nowMs,
      activeFavorite: copy ? copyFavorite(favorite) : favorite,
      result: copy ? copyResult(result, nowMs) : result,
      error: copy ? copyError(error) : error,
      sendFailed,
      expectedRequest: copy && this.expected ? { ...this.expected } : this.expected
    };
  }
}

export default WatchModel;
