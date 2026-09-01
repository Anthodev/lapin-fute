import {
  DEPARTURE_STATUS,
  ERROR_CODE,
  FRESHNESS,
  KEY_STATUS,
  LANGUAGE,
  LIMITS,
  MESSAGE_TYPE,
  REQUEST_TRIGGER,
  SCHEMA_VERSION,
  boundedString,
  enumHasValue,
  isWireLanguage,
  uint32
} from "./contracts.js";

export const RECEIVE_RESULT = Object.freeze({
  REJECTED: 0,
  STAGED: 1,
  CONFIG_COMMITTED: 2,
  RESULT_COMMITTED: 3,
  ERROR_COMMITTED: 4
});

const COMMON_KEYS = Object.freeze(["SCHEMA_VERSION", "MESSAGE_TYPE"]);

function onlyKeys(message, allowed) {
  for (const key of message.keys()) {
    if (typeof key !== "string" || allowed.indexOf(key) === -1) return false;
  }
  return true;
}

function integer(message, key) {
  const value = message.get(key);
  return typeof value === "number" && isFinite(value) && Math.floor(value) === value;
}

function string(message, key, maximum = LIMITS.idUtf8Bytes) {
  return boundedString(message.get(key), maximum);
}

function optionalUint32(message, key) {
  return !message.has(key) || uint32(message.get(key));
}

function aliases(message) {
  const decoded = Object.create(null);
  for (const entry of message) decoded[entry[0]] = entry[1];
  return decoded;
}

export function decodeMessage(message) {
  if (!(message instanceof Map)
      || message.get("SCHEMA_VERSION") !== SCHEMA_VERSION
      || !integer(message, "MESSAGE_TYPE")) return null;

  const type = message.get("MESSAGE_TYPE");
  let valid = false;
  switch (type) {
    case MESSAGE_TYPE.REQUEST:
      valid = onlyKeys(message, COMMON_KEYS.concat(["REQUEST_ID", "FAVORITE_ID", "REQUEST_TRIGGER"]))
        && string(message, "REQUEST_ID")
        && string(message, "FAVORITE_ID")
        && enumHasValue(REQUEST_TRIGGER, message.get("REQUEST_TRIGGER"));
      break;
    case MESSAGE_TYPE.CONFIG_BEGIN:
      valid = onlyKeys(message, COMMON_KEYS.concat([
        "REQUEST_ID",
        "ITEM_COUNT",
        "KEY_STATUS",
        "DISPLAY_NAME"
      ]))
        && string(message, "REQUEST_ID")
        && integer(message, "ITEM_COUNT")
        && message.get("ITEM_COUNT") >= 0
        && message.get("ITEM_COUNT") <= LIMITS.favorites
        && enumHasValue(KEY_STATUS, message.get("KEY_STATUS"))
        && (!message.has("DISPLAY_NAME") || isWireLanguage(message.get("DISPLAY_NAME")));
      break;
    case MESSAGE_TYPE.FAVORITE:
      valid = onlyKeys(message, COMMON_KEYS.concat([
        "REQUEST_ID",
        "ITEM_INDEX",
        "FAVORITE_ID",
        "SERVICE_ID",
        "DISPLAY_NAME",
        "STOP_LABEL",
        "LINE_LABEL",
        "DESTINATION_LABEL",
        "SORT_ORDER"
      ]))
        && string(message, "REQUEST_ID")
        && integer(message, "ITEM_INDEX")
        && message.get("ITEM_INDEX") >= 0
        && message.get("ITEM_INDEX") < LIMITS.favorites
        && string(message, "FAVORITE_ID")
        && string(message, "SERVICE_ID")
        && (!message.has("DISPLAY_NAME") || string(message, "DISPLAY_NAME", LIMITS.labelUtf8Bytes))
        && string(message, "STOP_LABEL", LIMITS.labelUtf8Bytes)
        && string(message, "LINE_LABEL", LIMITS.labelUtf8Bytes)
        && string(message, "DESTINATION_LABEL", LIMITS.labelUtf8Bytes)
        && integer(message, "SORT_ORDER")
        && message.get("SORT_ORDER") >= 0
        && message.get("SORT_ORDER") < LIMITS.favorites;
      break;
    case MESSAGE_TYPE.CONFIG_COMMIT:
      valid = onlyKeys(message, COMMON_KEYS.concat(["REQUEST_ID"]))
        && string(message, "REQUEST_ID");
      break;
    case MESSAGE_TYPE.RESULT_BEGIN:
      valid = onlyKeys(message, COMMON_KEYS.concat([
        "REQUEST_ID",
        "FAVORITE_ID",
        "ITEM_COUNT",
        "FETCHED_AT",
        "SOURCE_UPDATED_AT",
        "FRESHNESS"
      ]))
        && string(message, "REQUEST_ID")
        && string(message, "FAVORITE_ID")
        && integer(message, "ITEM_COUNT")
        && message.get("ITEM_COUNT") >= 0
        && message.get("ITEM_COUNT") <= LIMITS.departures
        && uint32(message.get("FETCHED_AT"))
        && optionalUint32(message, "SOURCE_UPDATED_AT")
        && integer(message, "FRESHNESS")
        && message.get("FRESHNESS") >= 0
        && message.get("FRESHNESS") < FRESHNESS.length;
      break;
    case MESSAGE_TYPE.DEPARTURE:
      valid = onlyKeys(message, COMMON_KEYS.concat([
        "REQUEST_ID",
        "FAVORITE_ID",
        "ITEM_INDEX",
        "EXPECTED_AT",
        "AIMED_AT",
        "MINUTES",
        "DEPARTURE_STATUS",
        "NEXT_INTERVAL_MINUTES"
      ]))
        && string(message, "REQUEST_ID")
        && string(message, "FAVORITE_ID")
        && integer(message, "ITEM_INDEX")
        && message.get("ITEM_INDEX") >= 0
        && message.get("ITEM_INDEX") < LIMITS.departures
        && uint32(message.get("EXPECTED_AT"))
        && optionalUint32(message, "AIMED_AT")
        && integer(message, "MINUTES")
        && message.get("MINUTES") >= -1440
        && message.get("MINUTES") <= 1440
        && integer(message, "DEPARTURE_STATUS")
        && message.get("DEPARTURE_STATUS") >= 0
        && message.get("DEPARTURE_STATUS") < DEPARTURE_STATUS.length
        && (!message.has("NEXT_INTERVAL_MINUTES")
          || (integer(message, "NEXT_INTERVAL_MINUTES")
            && message.get("NEXT_INTERVAL_MINUTES") >= 0
            && message.get("NEXT_INTERVAL_MINUTES") <= 1440));
      break;
    case MESSAGE_TYPE.RESULT_COMMIT:
      valid = onlyKeys(message, COMMON_KEYS.concat(["REQUEST_ID", "FAVORITE_ID"]))
        && string(message, "REQUEST_ID")
        && string(message, "FAVORITE_ID");
      break;
    case MESSAGE_TYPE.ERROR:
      valid = onlyKeys(message, COMMON_KEYS.concat([
        "REQUEST_ID",
        "FAVORITE_ID",
        "ERROR_CODE",
        "OCCURRED_AT",
        "RETRY_AFTER_SECONDS"
      ]))
        && string(message, "REQUEST_ID")
        && (!message.has("FAVORITE_ID") || string(message, "FAVORITE_ID"))
        && integer(message, "ERROR_CODE")
        && message.get("ERROR_CODE") >= 0
        && message.get("ERROR_CODE") < ERROR_CODE.length
        && uint32(message.get("OCCURRED_AT"))
        && optionalUint32(message, "RETRY_AFTER_SECONDS");
      break;
    default:
      return null;
  }
  if (!valid) return null;
  return aliases(message);
}

export function encodeRequest(request) {
  if (!request
      || !boundedString(request.requestId, LIMITS.idUtf8Bytes)
      || !boundedString(request.favoriteId, LIMITS.idUtf8Bytes)
      || !enumHasValue(REQUEST_TRIGGER, request.trigger)) {
    throw new TypeError("request does not match the watch protocol");
  }
  return new Map([
    ["SCHEMA_VERSION", SCHEMA_VERSION],
    ["MESSAGE_TYPE", MESSAGE_TYPE.REQUEST],
    ["REQUEST_ID", request.requestId],
    ["FAVORITE_ID", request.favoriteId],
    ["REQUEST_TRIGGER", request.trigger]
  ]);
}

function copyFavorite(favorite) {
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

function copyDeparture(departure) {
  const copy = {
    expectedAt: departure.expectedAt,
    minutes: departure.minutes,
    status: departure.status
  };
  if (departure.aimedAt !== undefined) copy.aimedAt = departure.aimedAt;
  if (departure.nextIntervalMinutes !== undefined) {
    copy.nextIntervalMinutes = departure.nextIntervalMinutes;
  }
  return copy;
}

function copyConfiguration(configuration) {
  if (!configuration) return null;
  return {
    keyStatus: configuration.keyStatus,
    language: configuration.language,
    favorites: configuration.favorites.map(copyFavorite)
  };
}

function copyResult(result) {
  if (!result) return null;
  const copy = {
    requestId: result.requestId,
    favoriteId: result.favoriteId,
    fetchedAt: result.fetchedAt,
    freshness: result.freshness,
    departures: result.departures.map(copyDeparture)
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
  if (error.retryAfterSeconds !== undefined) copy.retryAfterSeconds = error.retryAfterSeconds;
  return copy;
}

export class ProtocolReceiver {
  constructor(initialConfiguration = null) {
    this.configuration = null;
    this.result = null;
    this.error = null;
    this.configStage = null;
    this.resultStage = null;
    this.expected = null;
    this.refreshCandidate = null;
    if (initialConfiguration) this.restoreConfiguration(initialConfiguration);
  }

  restoreConfiguration(configuration) {
    this.configuration = copyConfiguration(configuration);
    this.result = null;
    this.error = null;
    this.discardStaging();
    this.cancelExpectedResponse();
  }

  expectResponse(requestId, favoriteId) {
    if (!boundedString(requestId, LIMITS.idUtf8Bytes)
        || !boundedString(favoriteId, LIMITS.idUtf8Bytes)) return false;
    this.expected = { requestId, favoriteId, refresh: false };
    this.refreshCandidate = null;
    this.resultStage = null;
    return true;
  }

  cancelExpectedResponse() {
    this.expected = null;
    this.refreshCandidate = null;
    this.resultStage = null;
  }

  discardStaging() {
    this.configStage = null;
    this.resultStage = null;
  }

  snapshot() {
    return {
      configuration: copyConfiguration(this.configuration),
      result: copyResult(this.result),
      error: copyError(this.error)
    };
  }

  receive(message) {
    const decoded = decodeMessage(message);
    if (!decoded) {
      this.discardStaging();
      return RECEIVE_RESULT.REJECTED;
    }

    const type = decoded.MESSAGE_TYPE;
    const requestId = decoded.REQUEST_ID || "";
    if (type === MESSAGE_TYPE.CONFIG_BEGIN) {
      this.configStage = {
        requestId,
        count: decoded.ITEM_COUNT,
        keyStatus: decoded.KEY_STATUS,
        language: isWireLanguage(decoded.DISPLAY_NAME) ? decoded.DISPLAY_NAME : LANGUAGE.EN,
        favorites: []
      };
      return RECEIVE_RESULT.STAGED;
    }

    if (type === MESSAGE_TYPE.FAVORITE) {
      const stage = this.configStage;
      let duplicate = false;
      if (stage) {
        for (let index = 0; index < stage.favorites.length; index += 1) {
          if (stage.favorites[index].id === decoded.FAVORITE_ID) duplicate = true;
        }
      }
      if (!stage
          || stage.requestId !== requestId
          || decoded.ITEM_INDEX !== stage.favorites.length
          || stage.favorites.length >= stage.count
          || duplicate) {
        this.configStage = null;
        return RECEIVE_RESULT.REJECTED;
      }
      const favorite = {
        id: decoded.FAVORITE_ID,
        serviceId: decoded.SERVICE_ID,
        stopLabel: decoded.STOP_LABEL,
        lineLabel: decoded.LINE_LABEL,
        destinationLabel: decoded.DESTINATION_LABEL,
        sortOrder: decoded.SORT_ORDER
      };
      if (decoded.DISPLAY_NAME !== undefined) favorite.displayName = decoded.DISPLAY_NAME;
      stage.favorites.push(favorite);
      return RECEIVE_RESULT.STAGED;
    }

    if (type === MESSAGE_TYPE.CONFIG_COMMIT) {
      const stage = this.configStage;
      if (!stage
          || stage.requestId !== requestId
          || stage.favorites.length !== stage.count) {
        this.configStage = null;
        return RECEIVE_RESULT.REJECTED;
      }
      this.configuration = {
        keyStatus: stage.keyStatus,
        language: stage.language,
        favorites: stage.favorites.map(copyFavorite)
      };
      this.result = null;
      this.error = null;
      this.configStage = null;
      this.cancelExpectedResponse();
      return RECEIVE_RESULT.CONFIG_COMMITTED;
    }

    if (type === MESSAGE_TYPE.REQUEST) {
      const candidate = this.refreshCandidate;
      if (this.expected
          || !candidate
          || candidate.requestId !== requestId
          || candidate.favoriteId !== decoded.FAVORITE_ID) {
        return RECEIVE_RESULT.REJECTED;
      }
      this.expected = {
        requestId,
        favoriteId: decoded.FAVORITE_ID,
        refresh: true
      };
      this.refreshCandidate = null;
      this.resultStage = null;
      return RECEIVE_RESULT.STAGED;
    }

    if (type === MESSAGE_TYPE.RESULT_BEGIN) {
      if (!this.expected
          || this.expected.requestId !== requestId
          || this.expected.favoriteId !== decoded.FAVORITE_ID) {
        this.resultStage = null;
        return RECEIVE_RESULT.REJECTED;
      }
      this.resultStage = {
        requestId,
        favoriteId: decoded.FAVORITE_ID,
        count: decoded.ITEM_COUNT,
        fetchedAt: decoded.FETCHED_AT,
        sourceUpdatedAt: decoded.SOURCE_UPDATED_AT,
        freshness: FRESHNESS[decoded.FRESHNESS],
        departures: []
      };
      return RECEIVE_RESULT.STAGED;
    }

    if (type === MESSAGE_TYPE.DEPARTURE) {
      const stage = this.resultStage;
      if (!stage
          || !this.expected
          || stage.requestId !== requestId
          || stage.favoriteId !== decoded.FAVORITE_ID
          || this.expected.requestId !== requestId
          || this.expected.favoriteId !== decoded.FAVORITE_ID
          || decoded.ITEM_INDEX !== stage.departures.length
          || stage.departures.length >= stage.count) {
        this.resultStage = null;
        return RECEIVE_RESULT.REJECTED;
      }
      const departure = {
        expectedAt: decoded.EXPECTED_AT,
        minutes: decoded.MINUTES,
        status: DEPARTURE_STATUS[decoded.DEPARTURE_STATUS]
      };
      if (decoded.AIMED_AT !== undefined) departure.aimedAt = decoded.AIMED_AT;
      if (decoded.NEXT_INTERVAL_MINUTES !== undefined) {
        departure.nextIntervalMinutes = decoded.NEXT_INTERVAL_MINUTES;
      }
      stage.departures.push(departure);
      return RECEIVE_RESULT.STAGED;
    }

    if (type === MESSAGE_TYPE.RESULT_COMMIT) {
      const stage = this.resultStage;
      if (!stage
          || !this.expected
          || stage.requestId !== requestId
          || stage.favoriteId !== decoded.FAVORITE_ID
          || this.expected.requestId !== requestId
          || this.expected.favoriteId !== decoded.FAVORITE_ID
          || stage.departures.length !== stage.count) {
        this.resultStage = null;
        return RECEIVE_RESULT.REJECTED;
      }
      const refresh = this.expected.refresh;
      this.result = copyResult(stage);
      this.error = null;
      this.expected = null;
      this.resultStage = null;
      this.refreshCandidate = refresh
        ? null
        : { requestId, favoriteId: decoded.FAVORITE_ID };
      return RECEIVE_RESULT.RESULT_COMMITTED;
    }

    if (type === MESSAGE_TYPE.ERROR) {
      if (!this.expected
          || this.expected.requestId !== requestId
          || (decoded.FAVORITE_ID !== undefined
            && this.expected.favoriteId !== decoded.FAVORITE_ID)) {
        this.resultStage = null;
        return RECEIVE_RESULT.REJECTED;
      }
      this.error = {
        requestId,
        code: ERROR_CODE[decoded.ERROR_CODE],
        occurredAt: decoded.OCCURRED_AT
      };
      if (decoded.FAVORITE_ID !== undefined) this.error.favoriteId = decoded.FAVORITE_ID;
      if (decoded.RETRY_AFTER_SECONDS !== undefined) {
        this.error.retryAfterSeconds = decoded.RETRY_AFTER_SECONDS;
      }
      this.cancelExpectedResponse();
      return RECEIVE_RESULT.ERROR_COMMITTED;
    }

    this.discardStaging();
    return RECEIVE_RESULT.REJECTED;
  }
}
