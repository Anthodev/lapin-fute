"use strict";

var contracts = require("./contracts");
var journeys = require("./journey-patterns");
var SERVICE_ID = /^svc_[A-Za-z0-9_-]{43}$/;
var REVISION = /^[a-f0-9]{64}$/;
var SERVICE_KEYS = ["serviceId", "stopLabel", "lineLabel", "destinationLabel", "lineMode", "lineColor", "lineTextColor", "routing"];

function catalogBase(configurationUrl) {
  var clean = configurationUrl.split(/[?#]/)[0];
  return clean.lastIndexOf("/") < 8
    ? clean + "/catalog/"
    : clean.slice(0, clean.lastIndexOf("/") + 1) + "catalog/";
}

function isService(value, serviceId) {
  return contracts.isObject(value) && contracts.hasOnlyKeys(value, SERVICE_KEYS)
    && Object.keys(value).length === SERVICE_KEYS.length && value.serviceId === serviceId
    && contracts.boundedString(value.stopLabel, contracts.LIMITS.labelUtf8Bytes)
    && contracts.boundedString(value.lineLabel, contracts.LIMITS.labelUtf8Bytes)
    && contracts.boundedString(value.destinationLabel, contracts.LIMITS.labelUtf8Bytes)
    && contracts.TRANSPORT_MODE.indexOf(value.lineMode) !== -1
    && contracts.isLineColor(value.lineColor) && contracts.isLineColor(value.lineTextColor)
    && contracts.isServiceRouting(value.routing);
}

function createCatalogClient(options) {
  var XHR = options.XHR;
  var clock = options.clock;
  var base = options.configurationUrl === "" ? "" : catalogBase(options.configurationUrl);
  var groupFlights = Object.create(null);

  // A sequence owns at most one request. Shared groups use their own sequence,
  // so cancelling one subscriber cannot abort another subscriber's request.
  function sequence(byteLimit) {
    var active = null;
    var timer = null;
    var cancelled = false;
    function detach(xhr) {
      xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
      xhr.onloadend = xhr.onreadystatechange = null;
      if (timer !== null) {
        if (clock && typeof clock.clearTimeout === "function") clock.clearTimeout(timer);
        else clearTimeout(timer);
        timer = null;
      }
      active = null;
    }
    function abortRequest(xhr) {
      if (typeof xhr.abort === "function") {
        try { xhr.abort(); } catch (ignored) { /* No callback survives cancellation. */ }
      }
    }
    return {
      abort: function () {
        cancelled = true;
        if (active) {
          var xhr = active;
          detach(xhr);
          abortRequest(xhr);
        }
      },
      fetch: function (path, consume) {
        var xhr;
        if (cancelled) return;
        function fail(abort) {
          if (cancelled || active !== xhr) return;
          detach(xhr);
          if (abort) abortRequest(xhr);
          consume(null, 0);
        }
        try {
          xhr = new XHR();
          active = xhr;
          xhr.open("GET", base + path, true);
          xhr.timeout = contracts.LIMITS.httpTimeoutMs;
          xhr.setRequestHeader("Accept", "application/json");
          xhr.onload = function () {
            var text, bytes, body;
            if (cancelled || active !== xhr) return;
            detach(xhr);
            text = xhr.responseText;
            if (xhr.status !== 200 || typeof text !== "string" || text.length === 0 || text.length > byteLimit) {
              consume(null, 0);
              return;
            }
            bytes = contracts.utf8Bytes(text);
            if (bytes > byteLimit) { consume(null, 0); return; }
            try { body = JSON.parse(text); } catch (ignored) { consume(null, 0); return; }
            consume(body, bytes);
          };
          xhr.onloadend = xhr.onload;
          xhr.onreadystatechange = function () { if (xhr.readyState === 4 && xhr.onload) xhr.onload(); };
          xhr.onerror = function () { fail(false); };
          xhr.ontimeout = xhr.onerror;
          xhr.onabort = xhr.onerror;
          timer = clock && typeof clock.setTimeout === "function"
            ? clock.setTimeout(function () { fail(true); }, contracts.LIMITS.httpTimeoutMs)
            : setTimeout(function () { fail(true); }, contracts.LIMITS.httpTimeoutMs);
          xhr.send(null);
        } catch (ignored) {
          if (!xhr || active === xhr) {
            if (xhr) detach(xhr);
            consume(null, 0);
          }
        }
      }
    };
  }

  function lookup(serviceId, routing, complete, journey) {
    var request = sequence(journey ? journeys.JOURNEY_LIMITS.documentBytes : contracts.LIMITS.httpResponseBytes);
    var subscription = null;
    var settled = false;
    var handle = { abort: function () {
      if (settled) return;
      settled = true;
      request.abort();
      if (subscription) subscription.abort();
    } };
    function finish(value) {
      if (settled) return;
      settled = true;
      complete(value);
    }
    if (base === "" || typeof serviceId !== "string" || serviceId.length !== 47 || !SERVICE_ID.test(serviceId)
        || (journey && !contracts.isServiceRouting(routing))) {
      finish(null);
      return handle;
    }
    request.fetch("manifest.json", function (manifest) {
      if (!contracts.isObject(manifest) || manifest.schemaVersion !== contracts.SCHEMA_VERSION
          || typeof manifest.revision !== "string" || manifest.revision.length !== 64 || !REVISION.test(manifest.revision)) {
        finish(null);
        return;
      }
      var revision = manifest.revision;
      request.fetch(revision + (journey ? "/journeys/services/" : "/services/") + serviceId + ".json", function (body) {
        if (!journey) {
          finish(contracts.isObject(body) && contracts.hasOnlyKeys(body, ["schemaVersion", "revision", "service"])
            && Object.keys(body).length === 3 && body.schemaVersion === contracts.SCHEMA_VERSION
            && body.revision === revision && isService(body.service, serviceId) ? body.service : null);
          return;
        }
        if (!journeys.isServiceJourneyDocument(body) || body.revision !== revision || body.serviceId !== serviceId
            || body.routing.monitoringRef !== routing.monitoringRef || body.routing.lineRef !== routing.lineRef
            || body.routing.destinationRef !== routing.destinationRef) {
          finish(null);
          return;
        }
        subscription = subscribeGroup(body, function (group) {
          finish({ service: body, group: group && group.lineMode === body.lineMode
            && group.lineRef === body.routing.lineRef ? group : null });
        });
      });
    });
    return handle;
  }

  function subscribeGroup(service, complete) {
    var key = service.revision + "/" + service.groupId;
    var flight = groupFlights[key];
    var subscriber = { complete: complete, cancelled: false };
    var handle = { abort: function () {
      if (subscriber.cancelled) return;
      subscriber.cancelled = true;
      if (flight.done) return;
      if (flight.subscribers.every(function (item) { return item.cancelled; })) {
        flight.done = true;
        flight.request.abort();
        flight.pages = [];
        flight.subscribers = [];
        delete groupFlights[key];
      }
    } };
    if (flight) {
      flight.subscribers.push(subscriber);
      return handle;
    }
    flight = { request: sequence(journeys.JOURNEY_LIMITS.documentBytes), subscribers: [subscriber], pages: [], done: false };
    groupFlights[key] = flight;
    function finish(group) {
      if (flight.done) return;
      flight.done = true;
      delete groupFlights[key];
      flight.pages = [];
      var subscribers = flight.subscribers;
      flight.subscribers = [];
      subscribers.forEach(function (item) { if (!item.cancelled) item.complete(group); });
    }
    flight.request.fetch(service.revision + "/journeys/groups/" + service.groupId + "/index.json", function (index, bytes) {
      if (!journeys.isJourneyGroupIndex(index) || index.revision !== service.revision || index.groupId !== service.groupId) {
        finish(null);
        return;
      }
      var totalBytes = bytes;
      function page(number) {
        flight.request.fetch(service.revision + "/journeys/groups/" + service.groupId + "/" + number + ".json", function (body, size) {
          totalBytes += size;
          if (!journeys.isJourneyGroupPage(body) || totalBytes > journeys.JOURNEY_LIMITS.groupBytes
              || body.revision !== index.revision || body.groupId !== index.groupId || body.page !== number
              || body.nextPage !== (number + 1 < index.pageCount ? number + 1 : null)) {
            finish(null);
            return;
          }
          flight.pages.push(body);
          if (number + 1 < index.pageCount) page(number + 1);
          else finish(journeys.validateJourneyGroup(index, flight.pages));
        });
      }
      page(0);
    });
    return handle;
  }

  function lookupService(serviceId, complete) { return lookup(serviceId, null, complete, false); }
  function lookupJourney(serviceId, routing, complete) { return lookup(serviceId, routing, complete, true); }
  return { lookupService: lookupService, lookupJourney: lookupJourney };
}

module.exports = { createCatalogClient: createCatalogClient };
