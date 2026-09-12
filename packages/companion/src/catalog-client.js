"use strict";

var contracts = require("./contracts");
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

  function lookupService(serviceId, complete) {
    var active = null;
    var settled = false;
    var timer = null;
    var revision;
    var handle = { abort: function () {
      var xhr = active;
      if (settled) return;
      settled = true;
      active = null;
      cancelDeadline();
      if (xhr) {
        detach(xhr);
        if (typeof xhr.abort === "function") {
          try { xhr.abort(); } catch (ignored) { /* No callback survives cancellation. */ }
        }
      }
    } };

    function detach(xhr) {
      xhr.onload = null;
      xhr.onerror = null;
      xhr.ontimeout = null;
      xhr.onabort = null;
      xhr.onloadend = null;
      xhr.onreadystatechange = null;
      cancelDeadline();
    }

    function cancelDeadline() {
      if (timer === null) return;
      if (clock && typeof clock.clearTimeout === "function") clock.clearTimeout(timer);
      else clearTimeout(timer);
      timer = null;
    }

    function finish(service) {
      if (settled) return;
      settled = true;
      cancelDeadline();
      active = null;
      complete(service);
    }

    function fetchJson(path, consume) {
      var xhr;
      try {
        xhr = new XHR();
        active = xhr;
        xhr.open("GET", base + path, true);
        xhr.timeout = contracts.LIMITS.httpTimeoutMs;
        xhr.setRequestHeader("Accept", "application/json");
        xhr.onload = function () {
          var text;
          var body;
          if (settled || active !== xhr) return;
          detach(xhr);
          active = null;
          text = xhr.responseText;
          if (xhr.status !== 200 || typeof text !== "string" || text.length === 0
              || text.length > contracts.LIMITS.httpResponseBytes
              || contracts.utf8Bytes(text) > contracts.LIMITS.httpResponseBytes) {
            finish(null);
            return;
          }
          try { body = JSON.parse(text); } catch (ignored) { finish(null); return; }
          consume(body);
        };
        xhr.onloadend = xhr.onload;
        xhr.onreadystatechange = function () { if (xhr.readyState === 4 && xhr.onload) xhr.onload(); };
        xhr.onerror = function () {
          if (settled || active !== xhr) return;
          detach(xhr);
          finish(null);
        };
        xhr.ontimeout = xhr.onerror;
        xhr.onabort = xhr.onerror;
        timer = clock && typeof clock.setTimeout === "function"
          ? clock.setTimeout(function () { expire(xhr); }, contracts.LIMITS.httpTimeoutMs)
          : setTimeout(function () { expire(xhr); }, contracts.LIMITS.httpTimeoutMs);
        xhr.send(null);
      } catch (ignored) {
        if (xhr) detach(xhr);
        finish(null);
      }
    }

    function expire(xhr) {
      if (settled || active !== xhr) return;
      detach(xhr);
      active = null;
      if (typeof xhr.abort === "function") {
        try { xhr.abort(); } catch (ignored) { /* The deadline remains final. */ }
      }
      finish(null);
    }

    if (base === "" || typeof serviceId !== "string" || serviceId.length !== 47 || !SERVICE_ID.test(serviceId)) {
      finish(null);
      return handle;
    }
    fetchJson("manifest.json", function (manifest) {
      if (!contracts.isObject(manifest) || manifest.schemaVersion !== contracts.SCHEMA_VERSION
          || typeof manifest.revision !== "string" || manifest.revision.length !== 64 || !REVISION.test(manifest.revision)) {
        finish(null);
        return;
      }
      revision = manifest.revision;
      fetchJson(revision + "/services/" + serviceId + ".json", function (body) {
        if (!contracts.isObject(body) || !contracts.hasOnlyKeys(body, ["schemaVersion", "revision", "service"])
            || Object.keys(body).length !== 3 || body.schemaVersion !== contracts.SCHEMA_VERSION
            || body.revision !== revision || !isService(body.service, serviceId)) {
          finish(null);
          return;
        }
        finish(body.service);
      });
    });
    return handle;
  }

  return { lookupService: lookupService };
}

module.exports = { createCatalogClient: createCatalogClient };
