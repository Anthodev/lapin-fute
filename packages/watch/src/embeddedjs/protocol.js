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

function onlyKeys(message, type) {
  for (const key of message.keys()) {
    if (typeof key !== "string") return false;
    let allowed = key === "SCHEMA_VERSION"
      || key === "MESSAGE_TYPE"
      || key === "REQUEST_ID";
    if (!allowed) {
      switch (type) {
        case MESSAGE_TYPE.REQUEST:
          allowed = key === "FAVORITE_ID" || key === "REQUEST_TRIGGER";
          break;
        case MESSAGE_TYPE.CONFIG_BEGIN:
          allowed = key === "ITEM_COUNT"
            || key === "KEY_STATUS"
            || key === "DISPLAY_NAME";
          break;
        case MESSAGE_TYPE.FAVORITE:
          allowed = key === "ITEM_INDEX"
            || key === "FAVORITE_ID"
            || key === "SERVICE_ID"
            || key === "DISPLAY_NAME"
            || key === "STOP_LABEL"
            || key === "LINE_LABEL"
            || key === "DESTINATION_LABEL"
            || key === "SORT_ORDER";
          break;
        case MESSAGE_TYPE.RESULT_BEGIN:
          allowed = key === "FAVORITE_ID"
            || key === "ITEM_COUNT"
            || key === "FETCHED_AT"
            || key === "SOURCE_UPDATED_AT"
            || key === "FRESHNESS";
          break;
        case MESSAGE_TYPE.DEPARTURE:
          allowed = key === "FAVORITE_ID"
            || key === "ITEM_INDEX"
            || key === "EXPECTED_AT"
            || key === "AIMED_AT"
            || key === "MINUTES"
            || key === "DEPARTURE_STATUS"
            || key === "NEXT_INTERVAL_MINUTES";
          break;
        case MESSAGE_TYPE.RESULT_COMMIT:
          allowed = key === "FAVORITE_ID";
          break;
        case MESSAGE_TYPE.ERROR:
          allowed = key === "FAVORITE_ID"
            || key === "ERROR_CODE"
            || key === "OCCURRED_AT"
            || key === "RETRY_AFTER_SECONDS";
          break;
        default:
          break;
      }
    }
    if (!allowed) return false;
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


export function decodeMessage(message) {
  if (!(message instanceof Map)
      || message.get("SCHEMA_VERSION") !== SCHEMA_VERSION
      || !integer(message, "MESSAGE_TYPE")) return null;

  const type = message.get("MESSAGE_TYPE");
  let valid = false;
  switch (type) {
    case MESSAGE_TYPE.REQUEST:
      valid = onlyKeys(message, type)
        && string(message, "REQUEST_ID")
        && string(message, "FAVORITE_ID")
        && enumHasValue(REQUEST_TRIGGER, message.get("REQUEST_TRIGGER"));
      break;
    case MESSAGE_TYPE.CONFIG_BEGIN:
      valid = onlyKeys(message, type)
        && string(message, "REQUEST_ID")
        && integer(message, "ITEM_COUNT")
        && message.get("ITEM_COUNT") >= 0
        && message.get("ITEM_COUNT") <= LIMITS.favorites
        && enumHasValue(KEY_STATUS, message.get("KEY_STATUS"))
        && (!message.has("DISPLAY_NAME") || isWireLanguage(message.get("DISPLAY_NAME")));
      break;
    case MESSAGE_TYPE.FAVORITE:
      valid = onlyKeys(message, type)
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
      valid = onlyKeys(message, type)
        && string(message, "REQUEST_ID");
      break;
    case MESSAGE_TYPE.RESULT_BEGIN:
      valid = onlyKeys(message, type)
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
      valid = onlyKeys(message, type)
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
      valid = onlyKeys(message, type)
        && string(message, "REQUEST_ID")
        && string(message, "FAVORITE_ID");
      break;
    case MESSAGE_TYPE.ERROR:
      valid = onlyKeys(message, type)
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
  return message;
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

function sharedFavoriteString(stage, committed, key, value) {
  for (let index = 0; index < stage.favorites.length; index += 1) {
    const candidate = stage.favorites[index][key];
    if (candidate === value) return candidate;
  }
  if (committed) {
    for (let index = 0; index < committed.favorites.length; index += 1) {
      const candidate = committed.favorites[index][key];
      if (candidate === value) return candidate;
    }
  }
  return value;
}

function requestSequence(prefix, requestId) {
  if (!prefix || requestId.length <= prefix.length) return 0;
  let sequence = 0;
  for (let index = 0; index < requestId.length; index += 1) {
    const code = requestId.charCodeAt(index);
    if (index < prefix.length) {
      if (code !== prefix.charCodeAt(index)) return 0;
    } else {
      if (code < 48
          || code > 57
          || (index === prefix.length && code === 48)) return 0;
      sequence = sequence * 10 + code - 48;
    }
  }
  return sequence;
}


export class ProtocolReceiver {
  constructor(initialConfiguration = null) {
    this.configuration = null;
    this.result = null;
    this.error = null;
    this.configStage = null;
    this.resultStage = null;
    this.prefix = null;
    this.favoriteId = null;
    this.latestSeq = 0;
    this.committedSeq = 0;
    this.refreshSeq = 0;
    if (initialConfiguration) this.restoreConfiguration(initialConfiguration);
  }

  restoreState(state, copy = true) {
    const source = state || {};
    this.configuration = copy ? copyConfiguration(source.configuration) : source.configuration || null;
    this.result = copy ? copyResult(source.result) : source.result || null;
    this.error = copy ? copyError(source.error) : source.error || null;
    this.discardStaging();
    this.cancelExpectedResponse();
  }

  restoreConfiguration(configuration, copy = true) {
    this.configuration = copy ? copyConfiguration(configuration) : configuration || null;
    this.result = null;
    this.error = null;
    this.discardStaging();
    this.cancelExpectedResponse();
  }

  expectResponse(requestId, favoriteId, prefix, sequence) {
    if (!boundedString(requestId, LIMITS.idUtf8Bytes)
        || !boundedString(favoriteId, LIMITS.idUtf8Bytes)
        || typeof prefix !== "string"
        || sequence === 0
        || requestSequence(prefix, requestId) !== sequence) return false;
    if (this.latestSeq === 0) {
      this.prefix = prefix;
      this.favoriteId = favoriteId;
      this.committedSeq = sequence - 1;
    } else if (prefix !== this.prefix
        || favoriteId !== this.favoriteId
        || sequence <= this.latestSeq) {
      return false;
    }
    this.latestSeq = sequence;
    return true;
  }

  cancelExpectedResponse() {
    this.prefix = null;
    this.favoriteId = null;
    this.latestSeq = 0;
    this.committedSeq = 0;
    this.refreshSeq = 0;
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

  borrowState() {
    return {
      configuration: this.configuration,
      result: this.result,
      error: this.error
    };
  }

  receive(message) {
    const decoded = decodeMessage(message);
    if (!decoded) {
      this.discardStaging();
      return RECEIVE_RESULT.REJECTED;
    }

    const type = decoded.get("MESSAGE_TYPE");
    const requestId = decoded.get("REQUEST_ID") || "";
    if (type === MESSAGE_TYPE.CONFIG_BEGIN) {
      this.configStage = {
        requestId,
        count: decoded.get("ITEM_COUNT"),
        keyStatus: decoded.get("KEY_STATUS"),
        language: decoded.get("DISPLAY_NAME") === LANGUAGE.FR ? LANGUAGE.FR : LANGUAGE.EN,
        favorites: []
      };
      return RECEIVE_RESULT.STAGED;
    }

    if (type === MESSAGE_TYPE.FAVORITE) {
      const stage = this.configStage;
      let duplicate = false;
      if (stage) {
        for (let index = 0; index < stage.favorites.length; index += 1) {
          if (stage.favorites[index].id === decoded.get("FAVORITE_ID")) duplicate = true;
        }
      }
      if (!stage
          || stage.requestId !== requestId
          || decoded.get("ITEM_INDEX") !== stage.favorites.length
          || stage.favorites.length >= stage.count
          || duplicate) {
        this.configStage = null;
        return RECEIVE_RESULT.REJECTED;
      }
      const committed = this.configuration;
      const previous = committed && committed.favorites[stage.favorites.length];
      if (previous
          && previous.id === decoded.get("FAVORITE_ID")
          && previous.serviceId === decoded.get("SERVICE_ID")
          && previous.displayName === decoded.get("DISPLAY_NAME")
          && previous.stopLabel === decoded.get("STOP_LABEL")
          && previous.lineLabel === decoded.get("LINE_LABEL")
          && previous.destinationLabel === decoded.get("DESTINATION_LABEL")
          && previous.sortOrder === decoded.get("SORT_ORDER")) {
        stage.favorites.push(previous);
        return RECEIVE_RESULT.STAGED;
      }
      const favorite = {
        id: sharedFavoriteString(
          stage,
          committed,
          "id",
          decoded.get("FAVORITE_ID")
        ),
        serviceId: sharedFavoriteString(
          stage,
          committed,
          "serviceId",
          decoded.get("SERVICE_ID")
        ),
        stopLabel: sharedFavoriteString(
          stage,
          committed,
          "stopLabel",
          decoded.get("STOP_LABEL")
        ),
        lineLabel: sharedFavoriteString(
          stage,
          committed,
          "lineLabel",
          decoded.get("LINE_LABEL")
        ),
        destinationLabel: sharedFavoriteString(
          stage,
          committed,
          "destinationLabel",
          decoded.get("DESTINATION_LABEL")
        ),
        sortOrder: decoded.get("SORT_ORDER")
      };
      if (decoded.get("DISPLAY_NAME") !== undefined) {
        favorite.displayName = sharedFavoriteString(
          stage,
          committed,
          "displayName",
          decoded.get("DISPLAY_NAME")
        );
      }
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
      let resultStillConfigured = false;
      if (this.result) {
        for (let index = 0; index < stage.favorites.length; index += 1) {
          if (stage.favorites[index].id === this.result.favoriteId) {
            resultStillConfigured = true;
            break;
          }
        }
      }
      this.configuration = {
        keyStatus: stage.keyStatus,
        language: stage.language,
        favorites: stage.favorites
      };
      if (!resultStillConfigured) this.result = null;
      this.error = null;
      this.configStage = null;
      this.cancelExpectedResponse();
      return RECEIVE_RESULT.CONFIG_COMMITTED;
    }

    if (type === MESSAGE_TYPE.REQUEST) {
      const favoriteId = decoded.get("FAVORITE_ID");
      const sequence = favoriteId === this.favoriteId
        ? requestSequence(this.prefix, requestId)
        : 0;
      if (sequence === 0
          || sequence < this.committedSeq
          || this.refreshSeq !== -sequence
          || !this.result
          || this.result.requestId !== requestId
          || this.result.favoriteId !== favoriteId) {
        return RECEIVE_RESULT.REJECTED;
      }
      this.refreshSeq = sequence;
      this.resultStage = null;
      return RECEIVE_RESULT.STAGED;
    }

    if (type === MESSAGE_TYPE.RESULT_BEGIN) {
      const favoriteId = decoded.get("FAVORITE_ID");
      const sequence = favoriteId === this.favoriteId
        ? requestSequence(this.prefix, requestId)
        : 0;
      const refreshing = sequence !== 0
        && sequence === this.refreshSeq
        && sequence >= this.committedSeq;
      if (!refreshing
          && !(sequence > this.committedSeq && sequence <= this.latestSeq)) {
        this.resultStage = null;
        return RECEIVE_RESULT.REJECTED;
      }
      this.resultStage = {
        requestId,
        favoriteId,
        count: decoded.get("ITEM_COUNT"),
        fetchedAt: decoded.get("FETCHED_AT"),
        sourceUpdatedAt: decoded.get("SOURCE_UPDATED_AT"),
        freshness: FRESHNESS[decoded.get("FRESHNESS")],
        departures: []
      };
      return RECEIVE_RESULT.STAGED;
    }

    if (type === MESSAGE_TYPE.DEPARTURE) {
      const stage = this.resultStage;
      if (!stage
          || stage.requestId !== requestId
          || stage.favoriteId !== decoded.get("FAVORITE_ID")
          || decoded.get("ITEM_INDEX") !== stage.departures.length
          || stage.departures.length >= stage.count) {
        this.resultStage = null;
        return RECEIVE_RESULT.REJECTED;
      }
      const departure = {
        expectedAt: decoded.get("EXPECTED_AT"),
        minutes: decoded.get("MINUTES"),
        status: DEPARTURE_STATUS[decoded.get("DEPARTURE_STATUS")]
      };
      if (decoded.get("AIMED_AT") !== undefined) departure.aimedAt = decoded.get("AIMED_AT");
      if (decoded.get("NEXT_INTERVAL_MINUTES") !== undefined) {
        departure.nextIntervalMinutes = decoded.get("NEXT_INTERVAL_MINUTES");
      }
      stage.departures.push(departure);
      return RECEIVE_RESULT.STAGED;
    }

    if (type === MESSAGE_TYPE.RESULT_COMMIT) {
      const stage = this.resultStage;
      const favoriteId = decoded.get("FAVORITE_ID");
      const sequence = favoriteId === this.favoriteId
        ? requestSequence(this.prefix, requestId)
        : 0;
      const refreshing = sequence !== 0
        && sequence === this.refreshSeq
        && sequence >= this.committedSeq;
      if (!stage
          || (!refreshing
            && !(sequence > this.committedSeq && sequence <= this.latestSeq))
          || stage.requestId !== requestId
          || stage.favoriteId !== favoriteId
          || stage.departures.length !== stage.count) {
        this.resultStage = null;
        return RECEIVE_RESULT.REJECTED;
      }
      this.result = stage;
      this.error = null;
      if (sequence > this.committedSeq) this.committedSeq = sequence;
      this.resultStage = null;
      this.refreshSeq = refreshing ? 0 : -sequence;
      return RECEIVE_RESULT.RESULT_COMMITTED;
    }

    if (type === MESSAGE_TYPE.ERROR) {
      const favoriteId = decoded.get("FAVORITE_ID");
      const sequence = (favoriteId === undefined || favoriteId === this.favoriteId)
        ? requestSequence(this.prefix, requestId)
        : 0;
      const refreshing = sequence !== 0
        && sequence === this.refreshSeq
        && sequence >= this.committedSeq;
      if (!refreshing
          && !(sequence > this.committedSeq && sequence <= this.latestSeq)) {
        this.resultStage = null;
        return RECEIVE_RESULT.REJECTED;
      }
      this.error = {
        requestId,
        code: ERROR_CODE[decoded.get("ERROR_CODE")],
        occurredAt: decoded.get("OCCURRED_AT")
      };
      if (favoriteId !== undefined) this.error.favoriteId = favoriteId;
      if (decoded.get("RETRY_AFTER_SECONDS") !== undefined) {
        this.error.retryAfterSeconds = decoded.get("RETRY_AFTER_SECONDS");
      }
      if (sequence > this.committedSeq) this.committedSeq = sequence;
      this.refreshSeq = 0;
      this.resultStage = null;
      return RECEIVE_RESULT.ERROR_COMMITTED;
    }

    this.discardStaging();
    return RECEIVE_RESULT.REJECTED;
  }
}
