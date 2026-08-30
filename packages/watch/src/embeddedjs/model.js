import { KEY_STATUS, REQUEST_TRIGGER } from "./contracts.js";

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

function matchingFavorite(configuration) {
  if (!configuration || configuration.favorites.length === 0) return null;
  return configuration.favorites[0];
}
function fixtureFavorite(configuration) {
  return configuration && configuration.keyStatus === KEY_STATUS.CONFIGURED
    ? matchingFavorite(configuration)
    : null;
}


export class WatchModel {
  constructor() {
    this.configuration = null;
    this.result = null;
    this.error = null;
    this.expected = null;
    this.appOpenPending = true;
    this.sendFailed = false;
  }

  commitProtocol(protocolSnapshot, event) {
    this.configuration = protocolSnapshot.configuration;
    this.result = protocolSnapshot.result;
    this.error = protocolSnapshot.error;

    if (event === "CONFIG_COMMITTED") {
      this.expected = null;
      this.sendFailed = false;
      if (this.appOpenPending && fixtureFavorite(this.configuration)) {
        this.appOpenPending = false;
        return { requestFixture: true };
      }
    } else if (event === "RESULT_COMMITTED" || event === "ERROR_COMMITTED") {
      this.expected = null;
      this.sendFailed = false;
    }
    return { requestFixture: false };
  }

  beginFixtureRequest(requestId) {
    const favorite = fixtureFavorite(this.configuration);
    if (!favorite || this.expected) return null;
    this.expected = {
      requestId,
      favoriteId: favorite.id,
      trigger: REQUEST_TRIGGER.APP_OPEN
    };
    this.sendFailed = false;
    return { ...this.expected };
  }

  markSendFailure() {
    this.expected = null;
    this.sendFailed = true;
  }

  snapshot() {
    const favorite = matchingFavorite(this.configuration);
    const result = favorite && this.result && this.result.favoriteId === favorite.id
      ? this.result
      : null;
    const error = favorite
      && this.error
      && (this.error.favoriteId === undefined || this.error.favoriteId === favorite.id)
      ? this.error
      : null;
    return {
      language: this.configuration ? this.configuration.language : "en",
      favorite: copyFavorite(favorite),
      result,
      error,
      sendFailed: this.sendFailed,
      expectedRequest: this.expected ? { ...this.expected } : null
    };
  }
}

export default WatchModel;
