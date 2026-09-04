"use strict";

var contracts = require("./contracts");
var departureParser = require("./prim-departures");
var trafficParser = require("./prim-traffic");
var TRAFFIC_URL = "https://prim.iledefrance-mobilites.fr/marketplace/disruptions_bulk/disruptions/v2";
// Regional traffic is a bulk feed; departures retain the shared smaller response cap.
var MAX_TRAFFIC_RESPONSE_BYTES = 2097152;
var MAX_ACTIVE_REQUESTS = 8;
var MAX_MILLISECONDS = 4294967296000;
var objectTag = Object.prototype.toString;

function invalidResponse() {
  throw new Error("Invalid PRIM response");
}

// PKJS documents ArrayBuffer responses. Decode their exact bytes rather than trusting
// responseText, whose charset conversion can silently replace malformed UTF-8.
function decodeUtf8(buffer, maximumBytes) {
  var bytes;
  var output = "";
  var index = 0;
  var first;
  var code;
  var count;
  var minimum;
  var next;
  if (objectTag.call(buffer) !== "[object ArrayBuffer]"
      || buffer.byteLength > maximumBytes) invalidResponse();
  bytes = new Uint8Array(buffer);
  if (bytes.length >= 3 && bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191) index = 3;
  while (index < bytes.length) {
    first = bytes[index];
    index += 1;
    if (first <= 127) {
      output += String.fromCharCode(first);
      continue;
    }
    if (first >= 194 && first <= 223) {
      count = 1;
      code = first & 31;
      minimum = 128;
    } else if (first >= 224 && first <= 239) {
      count = 2;
      code = first & 15;
      minimum = 2048;
    } else if (first >= 240 && first <= 244) {
      count = 3;
      code = first & 7;
      minimum = 65536;
    } else invalidResponse();
    if (index + count > bytes.length) invalidResponse();
    while (count > 0) {
      next = bytes[index];
      if ((next & 192) !== 128) invalidResponse();
      code = code * 64 + (next & 63);
      index += 1;
      count -= 1;
    }
    if (code < minimum || code > 1114111 || (code >= 55296 && code <= 57343)) invalidResponse();
    if (code <= 65535) output += String.fromCharCode(code);
    else {
      code -= 65536;
      output += String.fromCharCode(55296 + Math.floor(code / 1024), 56320 + code % 1024);
    }
  }
  return output;
}

function containsCredential(value, apiKey) {
  var pass;
  var next;
  for (pass = 0; pass <= 4; pass += 1) {
    if (value.indexOf(apiKey) !== -1) return true;
    if (pass === 4) break;
    next = value.replace(/(?:%[0-9a-f]{2})+/gi, function (part) {
      try { return decodeURIComponent(part); } catch (ignored) { return part; }
    });
    if (next === value) break;
    value = next;
  }
  return false;
}

function createPrimClient(options) {
  var XHR;
  var clock;
  var activeRequests = 0;
  var queued = [];
  var draining = false;
  var drainTimer = null;
  var trafficFlights = [];
  var trafficCache = { fr: null, en: null };
  if (!options || typeof options.XHR !== "function" || !options.clock
      || typeof options.clock.now !== "function") throw new TypeError("XHR and clock adapters are required");
  XHR = options.XHR;
  clock = options.clock;

  function now() {
    var value;
    try { value = clock.now(); } catch (ignored) { value = NaN; }
    return typeof value === "number" && isFinite(value) && value >= 0 && value < MAX_MILLISECONDS
      ? value : Math.max(0, Math.min(MAX_MILLISECONDS - 1, Date.now()));
  }

  function later(callback, delay) {
    return typeof clock.setTimeout === "function" ? clock.setTimeout(callback, delay) : setTimeout(callback, delay);
  }

  function cancelTimer(timer) {
    if (timer === null) return;
    if (typeof clock.clearTimeout === "function") clock.clearTimeout(timer);
    else clearTimeout(timer);
  }

  function unavailable(code, milliseconds, retryAfterSeconds) {
    var error = { code: code, occurredAt: Math.floor(milliseconds / 1000) };
    if (typeof retryAfterSeconds !== "undefined") error.retryAfterSeconds = retryAfterSeconds;
    return { status: "UNAVAILABLE", error: error };
  }

  function subscriber(complete) {
    var event;
    if (typeof complete !== "function") throw new TypeError("PRIM completion callback is required");
    event = { complete: complete, settled: false, scheduled: false, timer: null, outcome: null, onCancel: null };
    event.handle = { abort: function () {
      var onCancel;
      if (event.settled) return;
      event.settled = true;
      cancelTimer(event.timer);
      event.timer = null;
      event.complete = null;
      event.outcome = null;
      onCancel = event.onCancel;
      event.onCancel = null;
      if (onCancel) onCancel();
    } };
    return event;
  }

  function deliver(event, outcome) {
    if (event.settled || event.scheduled) return;
    event.scheduled = true;
    event.onCancel = null;
    event.outcome = outcome;
    event.timer = later(function () {
      var complete;
      var result;
      if (event.settled) return;
      event.settled = true;
      event.timer = null;
      complete = event.complete;
      result = event.outcome;
      event.complete = null;
      event.outcome = null;
      complete(result);
    }, 0);
  }

  function removeQueued(request) {
    var index = queued.indexOf(request);
    if (index >= 0) queued.splice(index, 1);
  }

  function drain() {
    var request;
    if (draining) return;
    cancelTimer(drainTimer);
    drainTimer = null;
    draining = true;
    try {
      while (activeRequests < MAX_ACTIVE_REQUESTS && queued.length > 0) {
        request = queued.shift();
        if (!request.settled) start(request);
      }
    } finally {
      draining = false;
    }
  }

  function finish(request, outcome, abort) {
    var xhr;
    var complete;
    if (request.settled) return;
    request.settled = true;
    cancelTimer(request.timer);
    request.timer = null;
    xhr = request.xhr;
    request.xhr = null;
    complete = request.complete;
    request.complete = null;
    request.normalize = null;
    request.apiKey = null;
    request.url = null;
    if (request.started) activeRequests -= 1;
    else removeQueued(request);
    if (xhr) {
      xhr.onload = null;
      xhr.onerror = null;
      xhr.ontimeout = null;
      xhr.onabort = null;
      xhr.onloadend = null;
      xhr.onreadystatechange = null;
      if (abort && typeof xhr.abort === "function") {
        try { xhr.abort(); } catch (ignored) { /* Cancellation is already final. */ }
      }
    }
    if (outcome !== null) {
      complete(outcome);
      drain();
    } else if (queued.length === 0) {
      cancelTimer(drainTimer);
      drainTimer = null;
    } else if (activeRequests < MAX_ACTIVE_REQUESTS && drainTimer === null) {
      // Let a synchronous lifecycle abort batch remove queued work before starting HTTP.
      drainTimer = later(function () {
        drainTimer = null;
        drain();
      }, 0);
    }
  }

  function receive(request) {
    var xhr;
    var status;
    var receivedAt;
    var outcome;
    var payload;
    var retryAfter;
    if (request.settled) return;
    xhr = request.xhr;
    receivedAt = now();
    try {
      status = xhr.status;
      if (status === 0 || status === null) outcome = unavailable("SOURCE_UNAVAILABLE", receivedAt);
      else if (typeof status !== "number" || !isFinite(status) || Math.floor(status) !== status
          || status < 100 || status > 599) outcome = unavailable("INVALID_RESPONSE", receivedAt);
      // Some phone engines expose the final URL, but XHR cannot prevent redirects.
      else if (typeof xhr.responseURL === "string" && xhr.responseURL !== "" && xhr.responseURL !== request.url) {
        outcome = unavailable("SOURCE_UNAVAILABLE", receivedAt);
      } else if (status === 401 || status === 403) outcome = unavailable("API_KEY_INVALID", receivedAt);
      else if (status === 429) {
        try { retryAfter = xhr.getResponseHeader("Retry-After"); } catch (ignored) { retryAfter = undefined; }
        outcome = unavailable("RATE_LIMITED", receivedAt, departureParser.parseRetryAfterSeconds(retryAfter));
      } else if (status < 200 || status >= 300) outcome = unavailable("SOURCE_UNAVAILABLE", receivedAt);
      else {
        payload = JSON.parse(decodeUtf8(xhr.response, request.maximumResponseBytes));
        outcome = { status: "AVAILABLE", data: request.normalize(payload, receivedAt) };
        payload = null;
      }
    } catch (ignored) {
      outcome = unavailable("INVALID_RESPONSE", receivedAt);
    }
    finish(request, outcome, false);
  }

  function start(request) {
    var xhr;
    request.started = true;
    activeRequests += 1;
    try {
      xhr = new XHR();
      request.xhr = xhr;
      xhr.open("GET", request.url, true);
      xhr.responseType = "arraybuffer";
      xhr.timeout = contracts.LIMITS.httpTimeoutMs;
      xhr.setRequestHeader("Accept", "application/json");
      if (request.language !== null) xhr.setRequestHeader("Accept-Language", request.language);
      xhr.setRequestHeader("apikey", request.apiKey);
      request.apiKey = null;
      xhr.onload = function () { receive(request); };
      xhr.onloadend = xhr.onload;
      xhr.onreadystatechange = function () { if (xhr.readyState === 4) receive(request); };
      xhr.onerror = function () { finish(request, unavailable("SOURCE_UNAVAILABLE", now()), false); };
      xhr.ontimeout = function () { finish(request, unavailable("SOURCE_UNAVAILABLE", now()), true); };
      xhr.onabort = xhr.onerror;
      request.timer = later(function () {
        finish(request, unavailable("SOURCE_UNAVAILABLE", now()), true);
      }, contracts.LIMITS.httpTimeoutMs);
      xhr.send(null);
    } catch (ignored) {
      finish(request, unavailable("SOURCE_UNAVAILABLE", now()), true);
    }
  }

  function requestJson(url, apiKey, language, normalize, complete) {
    var request = {
      url: url, apiKey: apiKey, language: language, normalize: normalize, complete: complete,
      maximumResponseBytes: url === TRAFFIC_URL ? MAX_TRAFFIC_RESPONSE_BYTES : contracts.LIMITS.httpResponseBytes,
      xhr: null, timer: null, started: false, settled: false
    };
    var handle = { abort: function () { finish(request, null, true); } };
    queued.push(request);
    drain();
    return handle;
  }

  function departures(request, complete) {
    var event = subscriber(complete);
    var url;
    var refs;
    var handle;
    if (!request || !contracts.isServiceRouting(request.routing)) {
      deliver(event, unavailable("INVALID_SERVICE", now()));
      return event.handle;
    }
    if (!contracts.isPersonalApiKey(request.apiKey)) {
      deliver(event, unavailable("API_KEY_INVALID", now()));
      return event.handle;
    }
    refs = {
      monitoringRef: request.routing.monitoringRef, lineRef: request.routing.lineRef,
      destinationRef: request.routing.destinationRef
    };
    try { url = departureParser.buildPrimStopMonitoringUrl(refs); } catch (ignored) {
      deliver(event, unavailable("INVALID_SERVICE", now()));
      return event.handle;
    }
    if (containsCredential(url, request.apiKey)) {
      deliver(event, unavailable("INVALID_SERVICE", now()));
      return event.handle;
    }
    handle = requestJson(url, request.apiKey, null, function (payload, receivedAt) {
      return departureParser.normalizePrimDepartureResponse(payload, refs, Math.floor(receivedAt / 1000));
    }, function (outcome) { deliver(event, outcome); });
    if (!event.scheduled) event.onCancel = handle.abort;
    return event.handle;
  }

  function removeFlight(flight) {
    var index = trafficFlights.indexOf(flight);
    if (index >= 0) trafficFlights.splice(index, 1);
  }

  function finishTraffic(flight, outcome) {
    var subscribers = flight.subscribers;
    var receivedAt = now();
    var index;
    var event;
    var result;
    removeFlight(flight);
    flight.subscribers = [];
    flight.handle = null;
    if (outcome.status === "AVAILABLE") {
      receivedAt = outcome.data.storedAt;
      trafficCache[flight.language] = {
        apiKey: flight.apiKey, storedAt: receivedAt, envelope: outcome.data.envelope
      };
    }
    flight.apiKey = null;
    for (index = 0; index < subscribers.length; index += 1) {
      event = subscribers[index];
      if (outcome.status === "AVAILABLE") {
        try {
          result = { status: "AVAILABLE", data: trafficParser.trafficForLine(outcome.data.envelope,
            event.lineId, receivedAt, receivedAt) };
        } catch (ignored) { result = unavailable("INVALID_RESPONSE", receivedAt); }
      } else result = unavailable(outcome.error.code, outcome.error.occurredAt * 1000, outcome.error.retryAfterSeconds);
      deliver(event, result);
    }
  }

  function traffic(request, complete) {
    var event = subscriber(complete);
    var lineId;
    var cached;
    var startedAt = now();
    var age;
    var flight;
    var index;
    if (!request || typeof request.lineRef !== "string") {
      deliver(event, unavailable("INVALID_SERVICE", startedAt));
      return event.handle;
    }
    lineId = trafficParser.canonicalCatalogLineRef(request.lineRef);
    if (typeof lineId === "undefined") {
      deliver(event, unavailable("INVALID_SERVICE", startedAt));
      return event.handle;
    }
    if (request.language !== "fr" && request.language !== "en") {
      deliver(event, unavailable("INVALID_RESPONSE", startedAt));
      return event.handle;
    }
    if (!contracts.isPersonalApiKey(request.apiKey) || containsCredential(TRAFFIC_URL, request.apiKey)) {
      deliver(event, unavailable("API_KEY_INVALID", startedAt));
      return event.handle;
    }
    cached = trafficCache[request.language];
    if (cached !== null) {
      age = startedAt - cached.storedAt;
      if (cached.apiKey === request.apiKey && age >= 0 && age < contracts.CACHE_FRESH_SECONDS * 1000) {
        try {
          deliver(event, { status: "AVAILABLE", data: trafficParser.trafficForLine(cached.envelope, lineId, startedAt, cached.storedAt) });
        } catch (ignored) { deliver(event, unavailable("INVALID_RESPONSE", startedAt)); }
        return event.handle;
      }
      trafficCache[request.language] = null;
    }
    event.lineId = lineId;
    for (index = 0; index < trafficFlights.length; index += 1) {
      if (trafficFlights[index].language === request.language && trafficFlights[index].apiKey === request.apiKey) {
        flight = trafficFlights[index];
        break;
      }
    }
    if (typeof flight === "undefined") {
      flight = { language: request.language, apiKey: request.apiKey, subscribers: [], handle: null };
      trafficFlights.push(flight);
    }
    flight.subscribers.push(event);
    event.onCancel = function () {
      var position = flight.subscribers.indexOf(event);
      if (position >= 0) flight.subscribers.splice(position, 1);
      if (flight.subscribers.length === 0) {
        removeFlight(flight);
        flight.apiKey = null;
        if (flight.handle) flight.handle.abort();
        flight.handle = null;
      }
    };
    if (flight.handle === null) {
      flight.handle = requestJson(TRAFFIC_URL, flight.apiKey, flight.language, function (payload, receivedAt) {
        return { storedAt: receivedAt, envelope: trafficParser.normalizePrimTrafficResponse(payload, flight.apiKey) };
      }, function (outcome) { finishTraffic(flight, outcome); });
    }
    return event.handle;
  }

  return { departures: departures, traffic: traffic };
}

module.exports = { createPrimClient: createPrimClient };
