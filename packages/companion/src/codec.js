"use strict";

var contracts = require("./contracts");
var T = contracts.MESSAGE_TYPE;

function dictionaryBytes(message) {
  return Object.keys(message).reduce(function (size, key) {
    var value = message[key];
    return size + 7 + (typeof value === "number" ? 4 : contracts.utf8Bytes(value) + 1);
  }, 1);
}

function packet(type, requestId, generation) {
  var message = {
    SCHEMA_VERSION: contracts.DISPLAY_WIRE_VERSION,
    MESSAGE_TYPE: type,
    REQUEST_ID: requestId
  };
  if (generation !== undefined) message.DISPLAY_GENERATION = generation;
  return message;
}

function outgoing(message) {
  if (!contracts.isAppMessage(message)) throw new TypeError("Invalid D2 display dictionary");
  if (dictionaryBytes(message) > contracts.APP_MESSAGE_INBOX_BYTES) {
    throw new RangeError("D2 dictionary exceeds the watch inbox");
  }
  return message;
}

function one(message) {
  var pending = true;
  return function () {
    if (!pending) return null;
    pending = false;
    return message;
  };
}

function encodeReady(token) { return outgoing(packet(T.DISPLAY_READY, token)); }

function encodeConfigurationStart(target) {
  var message = packet(T.CONFIG_BEGIN, target.requestId, target.generation);
  message.KEY_STATUS = target.keyStatus;
  message.ITEM_COUNT = target.itemCount;
  message.CONFIG_MODE = target.mode;
  message.LANGUAGE = target.language;
  message.DISPLAY_PROFILE = target.profile;
  return outgoing(message);
}

function encodeConfigurationEntry(entry) {
  var message = packet(T.CONFIG_ENTRY, entry.requestId, entry.generation);
  message.FAVORITE_ID = entry.favoriteId;
  message.ITEM_INDEX = entry.index;
  message.DISPLAY_HASH = entry.hash;
  return outgoing(message);
}

function encodeFavoriteBody(body) {
  var message = packet(T.FAVORITE, body.requestId, body.generation);
  message.ITEM_INDEX = body.index;
  message.DISPLAY_RECORD = body.record;
  return outgoing(message);
}

function encodeConfigurationCommit(commit) {
  return outgoing(packet(T.CONFIG_COMMIT, commit.requestId, commit.generation));
}

function encodeDisplayBegin(transfer) {
  var message = packet(T.DISPLAY_BEGIN, transfer.requestId, transfer.generation);
  message.ITEM_COUNT = transfer.count;
  message.DISPLAY_KIND = transfer.kind;
  if (transfer.favoriteId !== undefined) message.FAVORITE_ID = transfer.favoriteId;
  return outgoing(message);
}

function encodeDisplayRecord(item) {
  var message = packet(T.DISPLAY_RECORD, item.requestId, item.generation);
  message.ITEM_INDEX = item.index;
  message.DISPLAY_RECORD = item.record;
  message.DISPLAY_KIND = item.kind;
  return outgoing(message);
}

function encodeDisplayCommit(commit) {
  var message = packet(T.DISPLAY_COMMIT, commit.requestId, commit.generation);
  message.DISPLAY_KIND = commit.kind;
  return outgoing(message);
}

function createDisplayTransfer(request, records) {
  var index = -1;
  var kind = request.kind === "overview" ? 0 : request.kind === "detail" ? 1 : 2;
  return function () {
    var envelope = { requestId: request.requestId, generation: request.wireGeneration, kind: kind };
    if (index === -1) {
      index = 0;
      envelope.count = records.length;
      if (kind) envelope.favoriteId = request.favoriteId;
      return encodeDisplayBegin(envelope);
    }
    if (index < records.length) {
      envelope.index = index;
      envelope.record = records[index++];
      return encodeDisplayRecord(envelope);
    }
    if (index++ === records.length) return encodeDisplayCommit(envelope);
    return null;
  };
}

function decodeHello(message) {
  if (!contracts.isAppMessage(message) || message.MESSAGE_TYPE !== T.DISPLAY_HELLO) return null;
  return {
    token: message.REQUEST_ID, session: message.WATCH_SESSION_ID,
    profile: message.DISPLAY_PROFILE, clock12: message.CLOCK_12H,
    epoch: message.DISPLAY_EPOCH
  };
}

function decodeNeed(message) {
  if (!contracts.isAppMessage(message) || message.MESSAGE_TYPE !== T.CONFIG_NEED) return null;
  return {
    requestId: message.REQUEST_ID, generation: message.DISPLAY_GENERATION,
    needMask: message.CONFIG_NEED_MASK, profile: message.DISPLAY_PROFILE, clock12: message.CLOCK_12H
  };
}

function decodeDataRequest(message) {
  if (!contracts.isAppMessage(message)) return null;
  var kind;
  if (message.MESSAGE_TYPE === T.OVERVIEW_REQUEST) kind = "overview";
  else if (message.MESSAGE_TYPE === T.REQUEST) kind = "detail";
  else if (message.MESSAGE_TYPE === T.TRAFFIC_REQUEST) kind = "traffic";
  else return null;
  var request = { kind: kind, requestId: message.REQUEST_ID, wireGeneration: message.DISPLAY_GENERATION };
  if (kind !== "overview") request.favoriteId = message.FAVORITE_ID;
  if (kind !== "traffic") request.trigger = message.REQUEST_TRIGGER;
  return request;
}

module.exports = {
  dictionaryBytes: dictionaryBytes,
  one: one,
  encodeReady: encodeReady,
  encodeConfigurationStart: encodeConfigurationStart,
  encodeConfigurationEntry: encodeConfigurationEntry,
  encodeFavoriteBody: encodeFavoriteBody,
  encodeConfigurationCommit: encodeConfigurationCommit,
  encodeDisplayBegin: encodeDisplayBegin,
  encodeDisplayRecord: encodeDisplayRecord,
  encodeDisplayCommit: encodeDisplayCommit,
  createDisplayTransfer: createDisplayTransfer,
  decodeHello: decodeHello,
  decodeNeed: decodeNeed,
  decodeDataRequest: decodeDataRequest
};
