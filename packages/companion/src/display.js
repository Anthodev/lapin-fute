"use strict";

var contracts = require("./contracts");
var layout = require("./display-layout");
var corpus = require("./display-copy.json");
var copyByName = Object.create(null);
corpus.forEach(function (entry) { copyByName[entry.token] = entry; });

var EXCEPTIONS = {
  API_KEY_REQUIRED: 1, API_KEY_INVALID: 3, INVALID_SERVICE: 4,
  RATE_LIMITED: 5, NO_CACHED_DATA: 6, SOURCE_UNAVAILABLE: 7, INVALID_RESPONSE: 7
};

function copy(language, token) { return copyByName[token][language]; }

// lp3 prefixes count Unicode scalars; phone slice offsets count UTF-16 units.
function recordField(record, index) {
  var offset = 0;
  for (var field = 0; field <= index; field += 1) {
    var prefix = record.slice(offset, offset + 3);
    if (!/^[0-9a-f]{3}$/.test(prefix)) throw new TypeError("Invalid lp3 prefix");
    var count = parseInt(prefix, 16);
    var start = offset + 3;
    offset = start;
    for (var scalar = 0; scalar < count; scalar += 1) {
      if (offset >= record.length) throw new TypeError("Truncated lp3 field");
      var code = record.charCodeAt(offset++);
      if (code >= 0xd800 && code <= 0xdbff) {
        var low = record.charCodeAt(offset++);
        if (!(low >= 0xdc00 && low <= 0xdfff)) throw new TypeError("Invalid Unicode scalar");
      } else if (code >= 0xdc00 && code <= 0xdfff) throw new TypeError("Invalid Unicode scalar");
    }
    if (field === index) return record.slice(start, offset);
  }
  throw new TypeError("Invalid lp3 field index");
}

function exceptionToken(code) {
  if (code === null || code === undefined) return 0;
  if (!Object.prototype.hasOwnProperty.call(EXCEPTIONS, code)) throw new TypeError("Unknown display error");
  return EXCEPTIONS[code];
}

function timestamp(value) {
  if (!contracts.uint32(value)) throw new TypeError("Invalid display timestamp");
  return layout.fixed(value, 8);
}

// Preserve the watch's existing local HH:MM formatting, including 12-hour
// modulo and leading zero, without introducing new copy or a timezone policy.
function formatWireClock(seconds, hour12) {
  var date = new Date(seconds * 1000);
  var hours = date.getHours();
  if (hour12) hours = hours % 12 || 12;
  var minutes = date.getMinutes();
  return (hours < 10 ? "0" : "") + hours + ":" + (minutes < 10 ? "0" : "") + minutes;
}

function departureRecord(view) {
  var departures = view.departures;
  if (!Array.isArray(departures) || departures.length > contracts.LIMITS.departures
      || !view.hasData && departures.length) throw new TypeError("Invalid departure count");
  var freshness = contracts.FRESHNESS.indexOf(view.freshness);
  var palette = contracts.TRAFFIC_STATE.indexOf(view.trafficPalette);
  if (freshness < 0 || palette < 0) throw new TypeError("Invalid display state");
  var token = exceptionToken(view.exceptionToken);
  if (view.refreshing && token !== 1 && token !== 3) token = 2;
  var flags = (view.hasData ? 1 : 0) | (view.forcedStale || view.freshness === "STALE" ? 2 : 0);
  var record = layout.fixed(flags, 2) + timestamp(view.fetchedAt)
    + layout.fixed(freshness, 1) + layout.fixed(token, 2)
    + layout.fixed(palette, 1) + timestamp(view.trafficCheckedAt) + layout.fixed(departures.length, 1);
  for (var i = 0; i < departures.length; i += 1) {
    var status = contracts.DEPARTURE_STATUS.indexOf(departures[i].status);
    if (status < 0) throw new TypeError("Invalid departure status");
    record += timestamp(departures[i].expectedAt) + layout.fixed(status, 1);
  }
  return record;
}

function validity(traffic, language, hour12) {
  var from = traffic.validFrom !== undefined;
  var until = traffic.validUntil !== undefined;
  var text = "";
  if (from) text = copy(language, "validFrom") + " " + formatWireClock(traffic.validFrom, hour12);
  if (until) text += (from ? " " + copy(language, "validRangeTo") : copy(language, "validUntil"))
    + " " + formatWireClock(traffic.validUntil, hour12);
  return text;
}

function trafficFragments(traffic, context) {
  var palette = contracts.TRAFFIC_STATE.indexOf(traffic.state);
  var title = traffic.title;
  var body = traffic.text;
  var period = "";
  if (traffic.state === "NORMAL") {
    title = copy(context.language, "trafficNormalTitle");
    body = copy(context.language, "trafficNormalCheckedPrefix")
      + " " + formatWireClock(traffic.checkedAt, context.hour12) + ".";
  } else if (traffic.state === "UNKNOWN") {
    title = copy(context.language, "trafficUnknownTitle");
    body = copy(context.language, "trafficUnknownMessage");
  } else period = validity(traffic, context.language, context.hour12);
  return layout.prepareTraffic(palette, traffic.checkedAt, title, period, body, context.profile);
}

function trafficErrorRecord(code) {
  var token = exceptionToken(code);
  if (!token) throw new TypeError("Traffic errors require a final error code");
  return "e" + layout.fixed(token, 2);
}

module.exports = {
  recordField: recordField,
  departureRecord: departureRecord,
  trafficFragments: trafficFragments,
  trafficErrorRecord: trafficErrorRecord
};
