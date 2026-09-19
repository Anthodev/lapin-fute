"use strict";

var contracts = require("./contracts");

// Admission budgets, not measured maxima of the IDFM network.
var JOURNEY_LIMITS = Object.freeze({
  documentBytes: 262144,
  groupBytes: 8388608,
  pages: 32,
  patterns: 4096,
  stops: 1024,
  places: 8192,
  terminals: 512,
  terminalRefs: 128,
  terminalLabels: 128,
  textUtf8Bytes: 256
});
var STOP_REF = /^STIF:(?:StopPoint:Q|StopArea:SP):[^:\s\x00-\x1f\x7f]+:$/;
var LINE_REF = /^STIF:Line::[^:\s\x00-\x1f\x7f]+:$/;
var ID_SUFFIX = /^[A-Za-z0-9_-]{43}$/;
var REVISION = /^[a-f0-9]{64}$/;
var MAX_ROWS = JOURNEY_LIMITS.places + JOURNEY_LIMITS.terminals + JOURNEY_LIMITS.patterns;

function exact(value, keys) {
  return contracts.isObject(value) && contracts.hasOnlyKeys(value, keys)
    && keys.every(function (key) { return Object.prototype.hasOwnProperty.call(value, key); });
}
function integer(value, min, max) {
  return typeof value === "number" && value === Math.floor(value) && value >= min && value <= max;
}
function id(value, prefix) {
  return typeof value === "string" && value.length === prefix.length + 43
    && value.slice(0, prefix.length) === prefix && ID_SUFFIX.test(value.slice(prefix.length));
}
function text(value) {
  return contracts.boundedString(value, JOURNEY_LIMITS.textUtf8Bytes)
    && !/[\u0080-\u009f]/.test(value) && normalizeDestinationLabel(value) !== "";
}
function ref(value, expression) {
  return contracts.boundedString(value, JOURNEY_LIMITS.textUtf8Bytes)
    && !/[\u0080-\u009f]/.test(value) && expression.test(value);
}
function documentBytes(value) {
  try { return contracts.utf8Bytes(JSON.stringify(value)); } catch (error) { return Infinity; }
}
function envelope(value) {
  return value.schemaVersion === 1 && typeof value.revision === "string"
    && value.revision.length === 64 && REVISION.test(value.revision) && id(value.groupId, "grp_");
}
function sortedStrings(values, maximum, valid) {
  return Array.isArray(values) && values.length <= maximum && values.every(function (value, index) {
    return valid(value) && (index === 0 || values[index - 1] < value);
  });
}
function normalizeDestinationLabel(value) {
  return value.toLowerCase()
    .replace(/[àáâãäå]/g, "a").replace(/[èéêë]/g, "e").replace(/[ìíîï]/g, "i")
    .replace(/[òóôõö]/g, "o").replace(/[ùúûü]/g, "u").replace(/[ýÿ]/g, "y")
    .replace(/ç/g, "c").replace(/œ/g, "oe").replace(/æ/g, "ae")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[!-/:-@\[-`{-~\u00ab\u00bb\u2018-\u201f\u2010-\u2015]/g, " ")
    .split(/[\s\u00a0\u180e]+/).filter(function (word) {
      return word !== "" && ["d", "de", "du", "des", "l", "la", "le", "les"].indexOf(word) === -1;
    }).join(" ");
}
function isServiceJourneyDocument(value) {
  return exact(value, ["schemaVersion", "revision", "serviceId", "groupId", "lineMode", "routing", "terminalPlaceId"])
    && envelope(value) && id(value.serviceId, "svc_") && contracts.TRANSPORT_MODE.indexOf(value.lineMode) !== -1
    && exact(value.routing, ["monitoringRef", "lineRef", "destinationRef"])
    && ref(value.routing.monitoringRef, STOP_REF) && ref(value.routing.lineRef, LINE_REF)
    && ref(value.routing.destinationRef, STOP_REF)
    && (value.terminalPlaceId === null || id(value.terminalPlaceId, "plc_"))
    && documentBytes(value) <= JOURNEY_LIMITS.documentBytes;
}
function isJourneyGroupIndex(value) {
  return exact(value, ["schemaVersion", "revision", "groupId", "lineMode", "lineRef", "pageCount", "rowCount", "patternCount"])
    && envelope(value) && contracts.TRANSPORT_MODE.indexOf(value.lineMode) !== -1 && ref(value.lineRef, LINE_REF)
    && integer(value.pageCount, 1, JOURNEY_LIMITS.pages) && integer(value.rowCount, 3, MAX_ROWS)
    && integer(value.patternCount, 1, JOURNEY_LIMITS.patterns) && value.patternCount <= value.rowCount - 2
    && documentBytes(value) <= JOURNEY_LIMITS.documentBytes;
}
function isRow(value) {
  if (!contracts.isObject(value)) return false;
  if (value.kind === "place") return exact(value, ["kind", "placeId", "label"])
    && id(value.placeId, "plc_") && text(value.label);
  if (value.kind === "terminal") return exact(value, ["kind", "terminalId", "terminalPlaceId", "refs", "labels"])
    && id(value.terminalId, "term_") && id(value.terminalPlaceId, "plc_")
    && sortedStrings(value.refs, JOURNEY_LIMITS.terminalRefs, function (entry) { return ref(entry, STOP_REF); })
    && sortedStrings(value.labels, JOURNEY_LIMITS.terminalLabels, text);
  if (value.kind === "pattern") return exact(value, ["kind", "patternId", "terminalId", "stops"])
    && id(value.patternId, "pat_") && id(value.terminalId, "term_")
    && Array.isArray(value.stops) && integer(value.stops.length, 1, JOURNEY_LIMITS.stops)
    && value.stops.every(function (stop) {
      return exact(stop, ["stopRef", "placeId", "pickupType", "dropOffType"])
        && (stop.stopRef === null || ref(stop.stopRef, STOP_REF)) && id(stop.placeId, "plc_")
        && integer(stop.pickupType, 0, 3) && integer(stop.dropOffType, 0, 3);
    });
  return false;
}
function isJourneyGroupPage(value) {
  return exact(value, ["schemaVersion", "revision", "groupId", "page", "nextPage", "rows"])
    && envelope(value) && integer(value.page, 0, JOURNEY_LIMITS.pages - 1)
    && (value.nextPage === null || (value.nextPage === value.page + 1 && value.nextPage < JOURNEY_LIMITS.pages))
    && Array.isArray(value.rows) && integer(value.rows.length, 1, MAX_ROWS) && value.rows.every(isRow)
    && documentBytes(value) <= JOURNEY_LIMITS.documentBytes;
}
function validateJourneyGroup(index, pages) {
  if (!isJourneyGroupIndex(index) || !Array.isArray(pages) || pages.length !== index.pageCount) return null;
  var group = { revision: index.revision, groupId: index.groupId, lineMode: index.lineMode,
    lineRef: index.lineRef, places: [], terminals: [], patterns: [] };
  var places = Object.create(null), terminals = Object.create(null), patterns = Object.create(null);
  var total = documentBytes(index), rows = 0, pageNumber, rowNumber, page, row, target, key;
  for (pageNumber = 0; pageNumber < pages.length; pageNumber += 1) {
    page = pages[pageNumber];
    if (!isJourneyGroupPage(page) || page.page !== pageNumber || page.revision !== index.revision
        || page.groupId !== index.groupId || page.nextPage !== (pageNumber + 1 < pages.length ? pageNumber + 1 : null)) return null;
    total += documentBytes(page);
    if (total > JOURNEY_LIMITS.groupBytes) return null;
    for (rowNumber = 0; rowNumber < page.rows.length; rowNumber += 1) {
      row = page.rows[rowNumber];
      target = row.kind === "place" ? places : row.kind === "terminal" ? terminals : patterns;
      key = row.kind === "place" ? row.placeId : row.kind === "terminal" ? row.terminalId : row.patternId;
      if (target[key]) return null;
      target[key] = row;
      group[row.kind === "place" ? "places" : row.kind === "terminal" ? "terminals" : "patterns"].push(row);
      rows += 1;
    }
  }
  if (rows !== index.rowCount || group.patterns.length !== index.patternCount
      || !integer(group.places.length, 1, JOURNEY_LIMITS.places)
      || !integer(group.terminals.length, 1, JOURNEY_LIMITS.terminals)) return null;
  if (!group.terminals.every(function (terminal) { return !!places[terminal.terminalPlaceId]; })
      || !group.patterns.every(function (pattern) {
        var terminal = terminals[pattern.terminalId];
        return !!terminal && pattern.stops[pattern.stops.length - 1].placeId === terminal.terminalPlaceId
          && pattern.stops.every(function (stop) { return !!places[stop.placeId]; });
      })) return null;
  return group;
}

function reachableArrivals(group, monitoringRef) {
  if (group === null) return [];
  var reachable = Object.create(null);
  group.patterns.forEach(function (pattern) {
    var boarded = false;
    pattern.stops.forEach(function (stop) {
      if (boarded && stop.dropOffType === 0) reachable[stop.placeId] = true;
      if (stop.stopRef === monitoringRef && stop.pickupType === 0) boarded = true;
    });
  });
  return group.places.filter(function (place) { return !!reachable[place.placeId]; });
}
function combine(left, right) {
  return left === undefined ? right : left === right ? left : "UNCERTAIN";
}
function createJourneyClassifier(group, monitoringRef, arrivalPlaceId) {
  var states = Object.create(null), refs = Object.create(null), labels = Object.create(null), universeState;
  if (group !== null) {
    group.patterns.forEach(function (pattern) {
      var normal = false, conditional = false, state, occurrence, stop, i;
      // Evaluate before extending the suffix: loops also need a later arrival.
      for (i = pattern.stops.length - 1; i >= 0; i -= 1) {
        stop = pattern.stops[i];
        if (stop.stopRef === monitoringRef) {
          occurrence = stop.pickupType === 1 || (!normal && !conditional) ? "INCOMPATIBLE"
            : stop.pickupType === 0 && normal ? "COMPATIBLE" : "UNCERTAIN";
          state = combine(state, occurrence);
        }
        if (stop.placeId === arrivalPlaceId) {
          if (stop.dropOffType === 0) normal = true;
          if (stop.dropOffType === 2 || stop.dropOffType === 3) conditional = true;
        }
      }
      if (state !== undefined) states[pattern.terminalId] = combine(states[pattern.terminalId], state);
    });
    group.terminals.forEach(function (terminal) {
      var state = states[terminal.terminalId];
      if (state === undefined) return;
      universeState = combine(universeState, state);
      terminal.refs.forEach(function (value) { refs[value] = combine(refs[value], state); });
      terminal.labels.forEach(function (value) {
        var label = normalizeDestinationLabel(value);
        labels[label] = combine(labels[label], state);
      });
    });
  }
  return function (evidence) {
    var state, unknown = false;
    evidence.refs.forEach(function (value) {
      if (value === "") return;
      if (refs[value] === undefined) unknown = true;
      else state = combine(state, refs[value]);
    });
    evidence.labels.forEach(function (value) {
      if (value === "") return;
      var label = normalizeDestinationLabel(value);
      if (labels[label] === undefined) unknown = true;
      else state = combine(state, labels[label]);
    });
    // Unrecognized hints widen the candidates to every pattern at this exact boarding point.
    return unknown || state === undefined ? universeState || "UNCERTAIN" : state;
  };
}
function arrivalLabel(value) {
  if (contracts.utf8Bytes(value) <= contracts.LIMITS.labelUtf8Bytes) return value;
  var i = 0, bytes = 0, length, code, next;
  while (i < value.length) {
    code = value.charCodeAt(i);
    next = value.charCodeAt(i + 1);
    length = code >= 55296 && code <= 56319 && next >= 56320 && next <= 57343 ? 2 : 1;
    code = contracts.utf8Bytes(value.slice(i, i + length));
    if (bytes + code > contracts.LIMITS.labelUtf8Bytes - 3) break;
    bytes += code;
    i += length;
  }
  return value.slice(0, i) + "…";
}
function journeyKey(favorite) {
  return JSON.stringify([favorite.serviceId, favorite.arrivalPlaceId]);
}

module.exports = {
  JOURNEY_LIMITS: JOURNEY_LIMITS,
  normalizeDestinationLabel: normalizeDestinationLabel,
  isServiceJourneyDocument: isServiceJourneyDocument,
  isJourneyGroupIndex: isJourneyGroupIndex,
  isJourneyGroupPage: isJourneyGroupPage,
  validateJourneyGroup: validateJourneyGroup,
  reachableArrivals: reachableArrivals,
  createJourneyClassifier: createJourneyClassifier,
  arrivalLabel: arrivalLabel,
  journeyKey: journeyKey
};
