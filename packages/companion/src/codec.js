"use strict";

var contracts = require("./contracts");
var T = contracts.MESSAGE_TYPE;

function base(messageType) {
  return {
    SCHEMA_VERSION: contracts.SCHEMA_VERSION,
    MESSAGE_TYPE: messageType
  };
}

function requireId(value, name) {
  if (!contracts.boundedString(value, contracts.LIMITS.idUtf8Bytes)) {
    throw new TypeError(name + " must be a bounded identifier");
  }
}

function encodeRequest(request) {
  var message;
  requireId(request && request.requestId, "requestId");
  requireId(request && request.favoriteId, "favoriteId");
  if (Object.keys(contracts.REQUEST_TRIGGER).every(function (name) {
    return contracts.REQUEST_TRIGGER[name] !== request.trigger;
  })) {
    throw new TypeError("trigger is not supported");
  }
  message = base(T.REQUEST);
  message.REQUEST_ID = request.requestId;
  message.FAVORITE_ID = request.favoriteId;
  message.REQUEST_TRIGGER = request.trigger;
  return message;
}

function decodeRequest(message) {
  var trigger;
  if (!contracts.isObject(message)
      || !contracts.hasOnlyKeys(message, [
        "SCHEMA_VERSION",
        "MESSAGE_TYPE",
        "REQUEST_ID",
        "FAVORITE_ID",
        "REQUEST_TRIGGER"
      ])
      || message.SCHEMA_VERSION !== contracts.SCHEMA_VERSION
      || message.MESSAGE_TYPE !== T.REQUEST) return null;
  trigger = message.REQUEST_TRIGGER;
  if (!contracts.boundedString(message.REQUEST_ID, contracts.LIMITS.idUtf8Bytes)
      || !contracts.boundedString(message.FAVORITE_ID, contracts.LIMITS.idUtf8Bytes)
      || Object.keys(contracts.REQUEST_TRIGGER).every(function (name) {
        return contracts.REQUEST_TRIGGER[name] !== trigger;
      })) return null;
  return {
    requestId: message.REQUEST_ID,
    favoriteId: message.FAVORITE_ID,
    trigger: trigger
  };
}

function encodeConfiguration(sequenceId, favorites, keyStatus, language) {
  var messages = [];
  var begin;
  requireId(sequenceId, "sequenceId");
  if (!contracts.isFavoriteList(favorites)) throw new TypeError("favorites do not match the contract");
  if (Object.keys(contracts.KEY_STATUS).every(function (name) {
    return contracts.KEY_STATUS[name] !== keyStatus;
  })) throw new TypeError("keyStatus is not supported");
  if (language !== contracts.WIRE_LANGUAGE.EN && language !== contracts.WIRE_LANGUAGE.FR) {
    throw new TypeError("language must be en or fr");
  }

  begin = base(T.CONFIG_BEGIN);
  begin.REQUEST_ID = sequenceId;
  begin.ITEM_COUNT = favorites.length;
  begin.KEY_STATUS = keyStatus;
  begin.DISPLAY_NAME = language;
  messages.push(begin);

  favorites.forEach(function (favorite, index) {
    var message = base(T.FAVORITE);
    message.REQUEST_ID = sequenceId;
    message.ITEM_INDEX = index;
    message.FAVORITE_ID = favorite.id;
    message.SERVICE_ID = favorite.serviceId;
    if (typeof favorite.displayName !== "undefined") message.DISPLAY_NAME = favorite.displayName;
    message.STOP_LABEL = favorite.stopLabel;
    message.LINE_LABEL = favorite.lineLabel;
    message.DESTINATION_LABEL = favorite.destinationLabel;
    message.SORT_ORDER = favorite.sortOrder;
    messages.push(message);
  });

  begin = base(T.CONFIG_COMMIT);
  begin.REQUEST_ID = sequenceId;
  messages.push(begin);
  return messages;
}

function encodeResult(result) {
  var messages = [];
  var message;
  if (!contracts.isDepartureResult(result)) throw new TypeError("result does not match the contract");

  message = base(T.RESULT_BEGIN);
  message.REQUEST_ID = result.requestId;
  message.FAVORITE_ID = result.favoriteId;
  message.ITEM_COUNT = result.departures.length;
  message.FETCHED_AT = result.fetchedAt;
  if (typeof result.sourceUpdatedAt !== "undefined") message.SOURCE_UPDATED_AT = result.sourceUpdatedAt;
  message.FRESHNESS = contracts.FRESHNESS.indexOf(result.freshness);
  messages.push(message);

  result.departures.forEach(function (departure, index) {
    var item = base(T.DEPARTURE);
    item.REQUEST_ID = result.requestId;
    item.FAVORITE_ID = result.favoriteId;
    item.ITEM_INDEX = index;
    item.EXPECTED_AT = departure.expectedAt;
    if (typeof departure.aimedAt !== "undefined") item.AIMED_AT = departure.aimedAt;
    item.MINUTES = departure.minutes;
    item.DEPARTURE_STATUS = contracts.DEPARTURE_STATUS.indexOf(departure.status);
    if (typeof departure.nextIntervalMinutes !== "undefined") {
      item.NEXT_INTERVAL_MINUTES = departure.nextIntervalMinutes;
    }
    messages.push(item);
  });

  message = base(T.RESULT_COMMIT);
  message.REQUEST_ID = result.requestId;
  message.FAVORITE_ID = result.favoriteId;
  messages.push(message);
  return messages;
}

function encodeError(error) {
  var message;
  if (!contracts.isErrorResult(error)) throw new TypeError("error does not match the contract");
  message = base(T.ERROR);
  message.REQUEST_ID = error.requestId;
  if (typeof error.favoriteId !== "undefined") message.FAVORITE_ID = error.favoriteId;
  message.ERROR_CODE = contracts.ERROR_CODE.indexOf(error.code);
  message.OCCURRED_AT = error.occurredAt;
  if (typeof error.retryAfterSeconds !== "undefined") {
    message.RETRY_AFTER_SECONDS = error.retryAfterSeconds;
  }
  return message;
}

module.exports = {
  encodeRequest: encodeRequest,
  decodeRequest: decodeRequest,
  encodeConfiguration: encodeConfiguration,
  encodeResult: encodeResult,
  encodeError: encodeError
};
