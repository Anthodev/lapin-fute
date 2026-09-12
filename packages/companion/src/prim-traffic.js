"use strict";

var contracts = require("./contracts");
var currentParisTimestamp = require("./compactparis-time");
var BASIC_LOCAL_TIMESTAMP = /^([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})$/;
var CATALOG_IDFM_LINE = /^IDFM:([A-Za-z0-9][A-Za-z0-9._-]*)$/;
var CATALOG_STIF_LINE = /^STIF:Line::([A-Za-z0-9][A-Za-z0-9._-]*):$/;
var CANONICAL_LINE = /^line:IDFM:[A-Za-z0-9][A-Za-z0-9._-]*$/;
var RAW_PRIVATE_REFERENCE = /(?:STIF|IDFM|DEST):[^\s<>"'()[\]{}]*/gi;
var ENTITY = /&(?:#([0-9]{1,7})|#x([0-9A-Fa-f]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g;
var NAMED_ENTITIES = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\"" };
var hasOwn = Object.prototype.hasOwnProperty;
var MAX_DISRUPTIONS = 4096;
var MAX_LINES = 4096;
var MAX_PERIODS_PER_DISRUPTION = 128;
var MAX_IMPACTED_OBJECTS = 16384;
var MAX_DISRUPTION_REFERENCES = 32768;

function fail() {
  throw new Error("Invalid PRIM traffic payload");
}

function boundedIdentifier(value) {
  return typeof value === "string" && !/[\u0000-\u001f\u007f-\u009f]/.test(value)
    && contracts.utf8Bytes(value) >= 1 && contracts.utf8Bytes(value) <= contracts.LIMITS.idUtf8Bytes;
}

function boundedArray(value, maximum) {
  if (!Array.isArray(value) || value.length > maximum) fail();
  return value;
}

function exactMatch(pattern, value) {
  var match = pattern.exec(value);
  return match !== null && match[0].length === value.length ? match : null;
}

function canonicalCatalogLineRef(value) {
  var match;
  if (typeof value !== "string") return undefined;
  match = exactMatch(CATALOG_IDFM_LINE, value) || exactMatch(CATALOG_STIF_LINE, value);
  // Upstream routing references are not watch IDs and do not have the watch's 64-byte cap.
  return match === null ? undefined : "line:IDFM:" + match[1];
}

function localTimestamp(value) {
  var match;
  var year;
  var month;
  var day;
  var maximumDay;
  if (typeof value !== "string") fail();
  match = exactMatch(BASIC_LOCAL_TIMESTAMP, value);
  if (match === null) fail();
  year = Number(match[1]);
  month = Number(match[2]);
  day = Number(match[3]);
  maximumDay = month === 2
    ? year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28
    : month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
  if (year < 1970 || month < 1 || month > 12 || day < 1 || day > maximumDay
      || Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59) fail();
  return value;
}

function decodedEntity(full, decimal, hexadecimal, named) {
  var value;
  if (typeof named !== "undefined") return hasOwn.call(NAMED_ENTITIES, named) ? NAMED_ENTITIES[named] : full;
  value = parseInt(typeof decimal === "undefined" ? hexadecimal : decimal, typeof decimal === "undefined" ? 16 : 10);
  if (!isFinite(value) || Math.floor(value) !== value || value <= 0 || value > 1114111
      || (value >= 55296 && value <= 57343)) return "\ufffd";
  if (value <= 65535) return String.fromCharCode(value);
  value -= 65536;
  return String.fromCharCode(55296 + Math.floor(value / 1024), 56320 + value % 1024);
}

function stripMarkup(value) {
  var output = "";
  var offset = 0;
  var end;
  while (offset < value.length) {
    if (value.charCodeAt(offset) !== 60) {
      output += value.charAt(offset);
      offset += 1;
    } else {
      end = value.indexOf(">", offset + 1);
      output += " ";
      offset = end < 0 ? offset + 1 : end + 1;
    }
  }
  return output;
}

function secretVariants(apiKey) {
  var variants = [];
  function add(value) {
    if (value.length > 0 && variants.indexOf(value) < 0) variants.push(value);
  }
  function addEncoded(value) {
    var encoded;
    add(value);
    try {
      encoded = encodeURIComponent(value);
      add(encoded);
      add(encoded.replace(/%[0-9A-F]{2}/g, function (part) { return part.toLowerCase(); }));
    } catch (ignored) {
      // A lone surrogate is replaced by the text sanitizer.
    }
  }
  addEncoded(apiKey);
  if (typeof apiKey.normalize === "function") addEncoded(apiKey.normalize("NFC"));
  return variants.sort(function (left, right) { return right.length - left.length; });
}

function redactSensitive(value, variants) {
  var index;
  var redacted = value.replace(RAW_PRIVATE_REFERENCE, "[REDACTED]");
  for (index = 0; index < variants.length; index += 1) {
    redacted = redacted.split(variants[index]).join("[REDACTED]");
  }
  return redacted;
}

function truncateUtf8(value, maximum) {
  var bytes = 0;
  var index;
  var code;
  var width;
  var units;
  for (index = 0; index < value.length; index += units) {
    code = value.charCodeAt(index);
    units = code >= 55296 && code <= 56319 ? 2 : 1;
    width = units === 2 ? 4 : code <= 127 ? 1 : code <= 2047 ? 2 : 3;
    if (bytes + width > maximum) break;
    bytes += width;
  }
  return value.slice(0, index).replace(/\s+$/, "");
}

function plainBoundedText(value, maximum, variants) {
  var decoded = stripMarkup(value.replace(ENTITY, decodedEntity));
  var safe = "";
  var code;
  var next;
  var index;
  var bounded;
  for (index = 0; index < decoded.length; index += 1) {
    code = decoded.charCodeAt(index);
    if (code <= 31 || (code >= 127 && code <= 159) || code === 8232 || code === 8233) {
      safe += " ";
    } else if (code >= 55296 && code <= 56319) {
      next = decoded.charCodeAt(index + 1);
      if (next >= 56320 && next <= 57343) {
        safe += decoded.slice(index, index + 2);
        index += 1;
      } else safe += "\ufffd";
    } else if (code >= 56320 && code <= 57343) safe += "\ufffd";
    else safe += decoded.charAt(index);
  }
  safe = redactSensitive(safe, variants);
  // NFC is optional in ES5 engines. Text remains Unicode and byte-bounded without it.
  if (typeof safe.normalize === "function") safe = safe.normalize("NFC");
  safe = redactSensitive(safe, variants).replace(/\s+/g, " ").trim();
  bounded = truncateUtf8(safe, maximum);
  return bounded.length === 0 ? undefined : bounded;
}

function parseSeverity(value) {
  var name = contracts.isObject(value) ? value.name : value;
  if (name !== "INFORMATION" && name !== "PERTURBEE" && name !== "BLOQUANTE") fail();
  return name;
}

function normalizePrimTrafficResponse(value, apiKey) {
  var sourceDisruptions;
  var sourceLines;
  var disruptions = Object.create(null);
  var lines = Object.create(null);
  var variants = secretVariants(apiKey);
  var candidate;
  var sourcePeriods;
  var periods;
  var sourcePeriod;
  var begin;
  var end;
  var title;
  var text;
  var disruption;
  var sourceObjects;
  var sourceObject;
  var sourceIds;
  var disruptionId;
  var lineDisruptions;
  var unique;
  var impactedObjectCount = 0;
  var disruptionReferenceCount = 0;
  var index;
  var offset;
  var reference;
  if (!contracts.isObject(value)) fail();
  sourceDisruptions = boundedArray(value.disruptions, MAX_DISRUPTIONS);
  sourceLines = boundedArray(value.lines, MAX_LINES);
  for (index = 0; index < sourceDisruptions.length; index += 1) {
    candidate = sourceDisruptions[index];
    if (!contracts.isObject(candidate) || !boundedIdentifier(candidate.id)
        || hasOwn.call(disruptions, candidate.id)) fail();
    sourcePeriods = boundedArray(candidate.applicationPeriods, MAX_PERIODS_PER_DISRUPTION);
    if (sourcePeriods.length === 0) fail();
    periods = [];
    for (offset = 0; offset < sourcePeriods.length; offset += 1) {
      sourcePeriod = sourcePeriods[offset];
      if (!contracts.isObject(sourcePeriod)) fail();
      begin = localTimestamp(sourcePeriod.begin);
      end = localTimestamp(sourcePeriod.end);
      // Equal endpoints describe an empty [begin, end) period, never an active impact.
      if (begin > end) fail();
      periods.push(Object.freeze({ begin: begin, end: end }));
    }
    if (typeof candidate.lastUpdate !== "undefined") localTimestamp(candidate.lastUpdate);
    if (typeof candidate.title !== "undefined" && typeof candidate.title !== "string") fail();
    if (typeof candidate.message !== "undefined" && typeof candidate.message !== "string") fail();
    title = typeof candidate.title === "undefined" ? undefined
      : plainBoundedText(candidate.title, contracts.LIMITS.trafficTitleUtf8Bytes, variants);
    text = typeof candidate.message === "undefined" ? undefined
      : plainBoundedText(candidate.message, contracts.LIMITS.trafficTextUtf8Bytes, variants);
    disruption = { id: candidate.id, severity: parseSeverity(candidate.severity), periods: Object.freeze(periods) };
    if (typeof title !== "undefined") disruption.title = title;
    if (typeof text !== "undefined") disruption.text = text;
    disruptions[candidate.id] = Object.freeze(disruption);
  }
  for (index = 0; index < sourceLines.length; index += 1) {
    candidate = sourceLines[index];
    if (!contracts.isObject(candidate) || typeof candidate.id !== "string"
        || exactMatch(CANONICAL_LINE, candidate.id) === null || hasOwn.call(lines, candidate.id)) fail();
    sourceObjects = boundedArray(candidate.impactedObjects, MAX_IMPACTED_OBJECTS);
    impactedObjectCount += sourceObjects.length;
    if (impactedObjectCount > MAX_IMPACTED_OBJECTS) fail();
    lineDisruptions = [];
    unique = Object.create(null);
    for (offset = 0; offset < sourceObjects.length; offset += 1) {
      sourceObject = sourceObjects[offset];
      if (!contracts.isObject(sourceObject)
          || (sourceObject.type !== "line" && sourceObject.type !== "network"
            && sourceObject.type !== "stop_point" && sourceObject.type !== "stop_area")) fail();
      if (sourceObject.type === "line") {
        if (sourceObject.id !== candidate.id) fail();
      } else if (!boundedIdentifier(sourceObject.id)) fail();
      sourceIds = boundedArray(sourceObject.disruptionIds, MAX_DISRUPTION_REFERENCES);
      disruptionReferenceCount += sourceIds.length;
      if (disruptionReferenceCount > MAX_DISRUPTION_REFERENCES) fail();
      for (reference = 0; reference < sourceIds.length; reference += 1) {
        disruptionId = sourceIds[reference];
        if (!boundedIdentifier(disruptionId) || !hasOwn.call(disruptions, disruptionId)) fail();
        if (sourceObject.type === "line" && !hasOwn.call(unique, disruptionId)) {
          unique[disruptionId] = true;
          lineDisruptions.push(disruptionId);
        }
      }
    }
    lines[candidate.id] = Object.freeze(lineDisruptions);
  }
  return Object.freeze({ disruptions: Object.freeze(disruptions), lines: Object.freeze(lines) });
}

function active(disruption, localNow) {
  var index;
  var period;
  for (index = 0; index < disruption.periods.length; index += 1) {
    period = disruption.periods[index];
    if (period.begin <= localNow && localNow < period.end) return true;
  }
  return false;
}

function trafficForLine(envelope, lineId, evaluatedAtMilliseconds, checkedAtMilliseconds) {
  var localNow = currentParisTimestamp(evaluatedAtMilliseconds);
  var line = envelope.lines[lineId];
  var best;
  var bestPriority = 0;
  var disruption;
  var priority;
  var index;
  var result = {
    schemaVersion: contracts.SCHEMA_VERSION,
    state: "UNKNOWN",
    checkedAt: Math.floor(checkedAtMilliseconds / 1000)
  };
  if (!contracts.uint32(result.checkedAt)) fail();
  if (typeof line === "undefined") return result;
  for (index = 0; index < line.length; index += 1) {
    disruption = envelope.disruptions[line[index]];
    if (!active(disruption, localNow) || disruption.severity === "INFORMATION") continue;
    priority = disruption.severity === "PERTURBEE"
      && typeof disruption.title !== "undefined" && typeof disruption.text !== "undefined" ? 1 : 2;
    if (typeof best === "undefined" || priority > bestPriority
        || (priority === bestPriority && disruption.id < best.id)) {
      best = disruption;
      bestPriority = priority;
    }
  }
  if (typeof best === "undefined") result.state = "NORMAL";
  else if (bestPriority === 1) {
    result.state = "DELAYED";
    result.title = best.title;
    result.text = best.text;
  }
  return result;
}

module.exports = {
  canonicalCatalogLineRef: canonicalCatalogLineRef,
  normalizePrimTrafficResponse: normalizePrimTrafficResponse,
  trafficForLine: trafficForLine
};
