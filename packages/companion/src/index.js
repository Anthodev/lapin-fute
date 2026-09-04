"use strict";

var contracts = require("./contracts");
var codec = require("./codec");
var configuration = require("./configuration");
var MessageQueue = require("./message-queue");
var hasOwn = Object.prototype.hasOwnProperty;
var APP_MESSAGE_ALIAS_BY_NUMERIC_KEY = Object.create(null);

contracts.APP_MESSAGE_KEY_ORDER.forEach(function (alias) {
  APP_MESSAGE_ALIAS_BY_NUMERIC_KEY[String(contracts.APP_MESSAGE_KEY[alias])] = alias;
});

function requiredAdapter(condition, message) {
  if (!condition) throw new TypeError(message);
}

function normalizeIncomingPayload(payload) {
  var keys;
  var normalized = {};
  var aliasCount = 0;
  var index;
  var key;
  var alias;
  if (!contracts.isObject(payload)) return null;
  keys = Object.keys(payload);
  for (index = 0; index < keys.length; index += 1) {
    key = keys[index];
    if (hasOwn.call(contracts.APP_MESSAGE_KEY, key)) {
      normalized[key] = payload[key];
      aliasCount += 1;
      continue;
    }
    alias = APP_MESSAGE_ALIAS_BY_NUMERIC_KEY[key];
    if (typeof alias === "undefined"
        || !hasOwn.call(payload, alias)
        || payload[key] !== payload[alias]) return null;
  }
  return aliasCount > 0 ? normalized : null;
}
function visibleResultSignature(result) {
  return JSON.stringify({
    favoriteId: result.favoriteId,
    fetchedAt: result.fetchedAt,
    freshness: result.freshness,
    departures: result.departures.slice(0, 3).map(function (departure) {
      var visible = {
        expectedAt: departure.expectedAt,
        status: departure.status
      };
      if (hasOwn.call(departure, "nextIntervalMinutes")) {
        visible.nextIntervalMinutes = departure.nextIntervalMinutes;
      }
      return visible;
    })
  });
}



function Companion(options) {
  var self = this;
  options = options || {};
  requiredAdapter(options.Pebble && typeof options.Pebble.addEventListener === "function", "Pebble adapter is required");
  requiredAdapter(options.storage
    && typeof options.storage.getItem === "function"
    && typeof options.storage.setItem === "function"
    && typeof options.storage.removeItem === "function", "storage adapter is required");
  requiredAdapter(typeof options.XHR === "function", "XHR adapter is required");
  requiredAdapter(options.clock
    && typeof options.clock.now === "function", "clock adapter is required");
  requiredAdapter(typeof options.defer === "function", "defer adapter is required");
  requiredAdapter(typeof options.readyDefer === "function", "readyDefer adapter is required");

  this._Pebble = options.Pebble;
  this._storage = options.storage;
  this._XHR = options.XHR;
  this._clock = options.clock;
  this._readyDefer = options.readyDefer;
  this._backendUrl = typeof options.backendUrl === "string" ? options.backendUrl : "";
  this._configurationUrl = typeof options.configurationUrl === "string" ? options.configurationUrl : "";
  this._configuration = configuration.loadConfiguration(this._storage);
  this._configurationValid = this._configuration !== null;
  this._credentialBlocked = this._configurationValid
    && this._configuration.keyStatus === contracts.KEY_STATUS.INVALID;
  if (!this._configurationValid) this._configuration = configuration.emptyConfiguration();
  this._watchFavorites = [];
  this._results = configuration.emptyResults();
  this._metrics = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    successes: 0,
    failures: 0,
    totalLatencyMs: 0,
    lastLatencyMs: 0
  };
  this._lifecycleGeneration = 0;
  this._inFlightByFavorite = Object.create(null);
  this._latestWatchFavoriteId = null;
  this._latestWatchRequestId = null;
  this._presentationGeneration = 0;
  this._pendingResultBatches = [];
  this._visibleResultSignature = null;
  this._sequence = 0;
  this._started = false;
  this._queue = new MessageQueue(this._Pebble, options.defer, function () {
    self._failPendingResultBatches();
  });
  this._handlers = null;
  this._refreshWatchState();
}

Companion.prototype.start = function () {
  var self = this;
  if (this._started) return this;
  this._handlers = {
    ready: function () { self._onReady(); },
    showConfiguration: function () { self._onShowConfiguration(); },
    webviewclosed: function (event) { self._onWebviewClosed(event); },
    appmessage: function (event) { self._onAppMessage(event); }
  };
  Object.keys(this._handlers).forEach(function (eventName) {
    self._Pebble.addEventListener(eventName, self._handlers[eventName]);
  });
  this._started = true;
  return this;
};

Companion.prototype.stop = function () {
  var self = this;
  if (!this._started) return;
  if (typeof this._Pebble.removeEventListener === "function") {
    Object.keys(this._handlers).forEach(function (eventName) {
      self._Pebble.removeEventListener(eventName, self._handlers[eventName]);
    });
  }
  this._started = false;
  this._invalidateLifecycle();
};

Companion.prototype._refreshWatchState = function () {
  this._watchFavorites = this._configuration.favorites.map(contracts.copyFavorite);
};
Companion.prototype._resetPresentation = function () {
  this._presentationGeneration += 1;
  this._pendingResultBatches.forEach(function (batch) {
    batch.superseded = true;
  });
  this._visibleResultSignature = null;
};

Companion.prototype._setLatestWatchRequest = function (request) {
  var sameFavorite = this._latestWatchFavoriteId === request.favoriteId;
  if (sameFavorite && this._latestWatchRequestId === request.requestId) return;
  this._latestWatchFavoriteId = request.favoriteId;
  this._latestWatchRequestId = request.requestId;
  if (!sameFavorite) {
    this._resetPresentation();
    return;
  }
  this._pendingResultBatches.forEach(function (batch) {
    if (batch.favoriteId === request.favoriteId
        && batch.requestId !== request.requestId) {
      batch.superseded = true;
    }
  });
};

Companion.prototype._removePendingResultBatch = function (batch) {
  var index = this._pendingResultBatches.indexOf(batch);
  if (index !== -1) this._pendingResultBatches.splice(index, 1);
};

Companion.prototype._completePendingResultBatch = function (batch) {
  this._removePendingResultBatch(batch);
  if (batch.failed
      || batch.superseded
      || batch.generation !== this._presentationGeneration
      || !this._isCurrentWatchRequest(batch.request)) return;
  this._visibleResultSignature = batch.signature;
};

Companion.prototype._failPendingResultBatches = function () {
  var batches = this._pendingResultBatches;
  this._pendingResultBatches = [];
  batches.forEach(function (batch) {
    batch.failed = true;
    if (batch.mirrored) batch.request.transportEligible = false;
  });
};

Companion.prototype._invalidateLifecycle = function () {
  var inFlight = this._inFlightByFavorite;
  this._lifecycleGeneration += 1;
  this._inFlightByFavorite = Object.create(null);
  this._latestWatchFavoriteId = null;
  this._latestWatchRequestId = null;
  this._queue.clear();
  this._pendingResultBatches = [];
  this._resetPresentation();
  Object.keys(inFlight).forEach(function (favoriteId) {
    var flight = inFlight[favoriteId];
    if (!flight.xhr || typeof flight.xhr.abort !== "function") return;
    try {
      flight.xhr.abort();
    } catch (ignored) {
      // Lifecycle invalidation remains authoritative if abort is unsupported or races.
    }
  });
};


Companion.prototype._nextSequenceId = function () {
  this._sequence += 1;
  if (this._sequence > 1679615) this._sequence = 1;
  return "config-" + Math.floor(this._clock.now()).toString(36) + "-" + this._sequence.toString(36);
};

Companion.prototype._sendConfiguration = function () {
  var keyStatus = this._credentialBlocked
    ? contracts.KEY_STATUS.INVALID
    : this._configuration.keyStatus;
  if (!this._configurationValid
      || !configuration.areFavoritesSecretFree(
        this._watchFavorites,
        this._configuration.primApiKey,
        null
      )) return;
  this._resetPresentation();
  this._queue.enqueue(codec.encodeConfiguration(
    this._nextSequenceId(),
    this._watchFavorites,
    keyStatus,
    configuration.activeWatchLanguage(this._Pebble)
  ));
};

Companion.prototype._onReady = function () {
  var self = this;
  var generation = this._lifecycleGeneration;
  this._readyDefer(function () {
    if (!self._started || self._lifecycleGeneration !== generation) return;
    self._synchronizeReady();
  });
};

Companion.prototype._synchronizeReady = function () {
  var wasBlocked = this._credentialBlocked;
  var loaded = configuration.loadConfiguration(this._storage);
  if (loaded === null) {
    this._configurationValid = false;
    return;
  }
  if (wasBlocked && loaded.primApiKey !== null) {
    loaded.keyStatus = contracts.KEY_STATUS.INVALID;
  }
  this._configuration = loaded;
  this._configurationValid = true;
  this._credentialBlocked = loaded.keyStatus === contracts.KEY_STATUS.INVALID;
  this._results = configuration.loadResults(this._storage, loaded.favorites);
  this._refreshWatchState();
  this._sendConfiguration();
};

Companion.prototype._onShowConfiguration = function () {
  var language;
  var url;
  if (!this._configurationValid) return;
  language = configuration.activeWatchLanguage(this._Pebble);
  url = configuration.configurationUrl(this._configurationUrl, this._configuration, language);
  if (url !== null && typeof this._Pebble.openURL === "function") this._Pebble.openURL(url);
};

Companion.prototype._onWebviewClosed = function (event) {
  var update;
  var next;
  var pending;
  var pruned;
  if (!this._configurationValid) return;
  update = configuration.parseCloseFragment(event && event.response);
  if (update === null) return;
  next = configuration.applyConfigurationUpdate(this._configuration, update);
  if (next === null) return;
  if (update.apiKeyUpdate.action === "REPLACE") {
    if (this._credentialBlocked
        || this._configuration.keyStatus === contracts.KEY_STATUS.INVALID) {
      pending = {
        schemaVersion: contracts.SCHEMA_VERSION,
        favorites: next.favorites.map(contracts.copyFavorite),
        primApiKey: next.primApiKey,
        keyStatus: contracts.KEY_STATUS.INVALID
      };
      if (!configuration.saveConfiguration(this._storage, pending)) return;
      if (!configuration.clearInvalidKeyStatus(this._storage)
          || !configuration.saveConfiguration(this._storage, next)) {
        next = pending;
      }
    } else if (!configuration.clearInvalidKeyStatus(this._storage)
        || !configuration.saveConfiguration(this._storage, next)) {
      return;
    }
  } else {
    if (!configuration.saveConfiguration(this._storage, next)) return;
    if (update.apiKeyUpdate.action === "REMOVE") {
      configuration.clearInvalidKeyStatus(this._storage);
    }
  }
  pruned = configuration.pruneResults(this._results, next.favorites);
  if (JSON.stringify(pruned) !== JSON.stringify(this._results)) {
    configuration.saveResults(this._storage, pruned);
  }
  this._invalidateLifecycle();
  this._configuration = next;
  this._results = pruned;
  this._credentialBlocked = next.primApiKey !== null
    && next.keyStatus === contracts.KEY_STATUS.INVALID;
  this._refreshWatchState();
  this._sendConfiguration();
};

Companion.prototype._onAppMessage = function (event) {
  var favorite;
  var decoded;
  var request;
  if (!this._configurationValid) return;
  decoded = codec.decodeRequest(normalizeIncomingPayload(event && event.payload));
  if (decoded === null) return;
  request = {
    requestId: decoded.requestId,
    favoriteId: decoded.favoriteId,
    trigger: decoded.trigger,
    transportEligible: true
  };
  this._setLatestWatchRequest(request);
  favorite = this._findFavorite(request.favoriteId);
  if (favorite === null) {
    this._sendError(request, "INVALID_SERVICE");
    return;
  }
  this._dispatchRequest(request, favorite);
};

Companion.prototype._findFavorite = function (favoriteId) {
  var index;
  for (index = 0; index < this._watchFavorites.length; index += 1) {
    if (this._watchFavorites[index].id === favoriteId) return this._watchFavorites[index];
  }
  return null;
};

Companion.prototype._cacheResult = function (result) {
  var next = configuration.putResult(
    this._results,
    this._configuration.favorites,
    result,
    Math.floor(this._clock.now())
  );
  if (next === null) return false;
  if (!configuration.saveResults(this._storage, next)) return false;
  this._results = next;
  return true;
};

Companion.prototype._cachedResult = function (request) {
  return configuration.findResult(this._results, request.favoriteId, request.requestId);
};

Companion.prototype._isCurrentWatchRequest = function (request) {
  return this._latestWatchFavoriteId === request.favoriteId
    && this._latestWatchRequestId === request.requestId;
};

Companion.prototype._enqueueVisibleResult = function (result, mirroredRequest, request) {
  var self = this;
  var generation = this._presentationGeneration;
  var signature = visibleResultSignature(result);
  var mirrored = mirroredRequest !== null;
  var visible = this._visibleResultSignature;
  var messages;
  var batch;
  var index;
  for (index = 0; index < this._pendingResultBatches.length; index += 1) {
    batch = this._pendingResultBatches[index];
    if (!batch.failed
        && !batch.superseded
        && batch.generation === generation
        && batch.favoriteId === result.favoriteId
        && batch.requestId === result.requestId
        && batch.signature === signature
        && batch.mirrored === mirrored) {
      batch.request = request;
      return null;
    }
  }
  if (visible === signature) return null;

  messages = codec.encodeResult(result);
  if (mirrored) messages.push(codec.encodeRequest(mirroredRequest));
  for (index = this._pendingResultBatches.length - 1; index >= 0; index -= 1) {
    batch = this._pendingResultBatches[index];
    if (batch.failed
        || batch.generation !== generation
        || batch.favoriteId !== result.favoriteId
        || batch.signature !== signature
        || !this._queue.replacePending(batch.queueBatchId, messages)) continue;
    batch.requestId = result.requestId;
    batch.request = request;
    batch.mirrored = mirrored;
    batch.superseded = false;
    return batch;
  }

  batch = {
    generation: generation,
    signature: signature,
    requestId: result.requestId,
    favoriteId: result.favoriteId,
    request: request,
    mirrored: mirrored,
    failed: false,
    superseded: false,
    queueBatchId: null
  };
  this._pendingResultBatches.push(batch);
  batch.queueBatchId = this._queue.enqueue(messages, function () {
    self._completePendingResultBatch(batch);
  });
  return batch;
};

Companion.prototype._dispatchRequest = function (request, favorite) {
  var cached = this._cachedResult(request);
  var flight;
  var age;
  var refreshRequired;
  if (cached !== null) {
    this._metrics.cacheHits += 1;
    age = this._clock.now() - Math.min(cached.result.fetchedAt * 1000, cached.storedAt);
    refreshRequired = !(age >= 0 && age < contracts.CACHE_FRESH_SECONDS * 1000);
    this._enqueueVisibleResult(cached.result, refreshRequired ? request : null, request);
    if (!refreshRequired) return;
  } else {
    this._metrics.cacheMisses += 1;
  }
  if (this._configuration.primApiKey === null) {
    this._sendError(request, "API_KEY_REQUIRED");
    return;
  }
  if (this._credentialBlocked
      || this._configuration.keyStatus === contracts.KEY_STATUS.INVALID) {
    this._sendError(request, "API_KEY_INVALID");
    return;
  }
  flight = this._inFlightByFavorite[request.favoriteId];
  if (flight && flight.generation === this._lifecycleGeneration) {
    flight.latestRequest = request;
    return;
  }
  if (flight) delete this._inFlightByFavorite[request.favoriteId];
  this._fetch(request, favorite);
};

Companion.prototype._fetch = function (request, favorite) {
  var self = this;
  var generation = this._lifecycleGeneration;
  var launchRequest = Object.freeze({
    requestId: request.requestId,
    favoriteId: request.favoriteId,
    serviceId: favorite.serviceId,
    trigger: request.trigger
  });
  var xhr;
  var flight;
  var failedRequest;
  var settled = false;
  var key = null;
  var startedAt = this._clock.now();
  if (this._backendUrl.indexOf("https://") !== 0) {
    if (request.transportEligible !== false
        && this._isCurrentWatchRequest(request)) {
      this._sendError(request, "SOURCE_UNAVAILABLE");
    }
    return;
  }
  key = this._configuration.primApiKey;
  if (!contracts.isPersonalApiKey(key)) {
    key = null;
    if (request.transportEligible !== false
        && this._isCurrentWatchRequest(request)) {
      this._sendError(request, "API_KEY_REQUIRED");
    }
    return;
  }

  function once(callback) {
    return function () {
      var latency;
      if (settled) return;
      settled = true;
      if (generation !== self._lifecycleGeneration
          || self._inFlightByFavorite[launchRequest.favoriteId] !== flight) return;
      delete self._inFlightByFavorite[launchRequest.favoriteId];
      latency = Math.max(0, self._clock.now() - startedAt);
      self._metrics.lastLatencyMs = latency;
      self._metrics.totalLatencyMs += latency;
      callback();
    };
  }

  try {
    xhr = new this._XHR();
    flight = {
      generation: generation,
      xhr: xhr,
      launchRequest: launchRequest,
      latestRequest: request
    };
    this._inFlightByFavorite[launchRequest.favoriteId] = flight;
    xhr.open("POST", this._backendUrl, true);
    xhr.timeout = contracts.LIMITS.httpTimeoutMs;
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.onload = once(function () { self._handleResponse(flight, xhr); });
    xhr.onerror = once(function () {
      self._metrics.failures += 1;
      if (flight.latestRequest.transportEligible !== false
          && self._isCurrentWatchRequest(flight.latestRequest)) {
        self._sendError(flight.latestRequest, "SOURCE_UNAVAILABLE");
      }
    });
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = xhr.onerror;
    xhr.setRequestHeader("Authorization", "Bearer " + key);
    this._metrics.requests += 1;
    xhr.send(JSON.stringify({
      schemaVersion: contracts.SCHEMA_VERSION,
      requestId: launchRequest.requestId,
      favoriteId: launchRequest.favoriteId,
      serviceId: launchRequest.serviceId
    }));
    key = null;
  } catch (ignored) {
    failedRequest = request;
    key = null;
    if (settled || generation !== this._lifecycleGeneration) return;
    if (flight) {
      if (this._inFlightByFavorite[launchRequest.favoriteId] !== flight) return;
      delete this._inFlightByFavorite[launchRequest.favoriteId];
      failedRequest = flight.latestRequest;
    }
    settled = true;
    this._metrics.failures += 1;
    if (failedRequest.transportEligible !== false
        && this._isCurrentWatchRequest(failedRequest)) {
      this._sendError(failedRequest, "SOURCE_UNAVAILABLE");
    }
  }
};

Companion.prototype._responseJson = function (xhr) {
  var text = xhr.responseText;
  if (typeof text !== "string" || text.length === 0 || text.length > contracts.LIMITS.httpResponseBytes) return null;
  if (contracts.utf8Bytes(text) > contracts.LIMITS.httpResponseBytes) return null;
  try {
    return JSON.parse(text);
  } catch (ignored) {
    return null;
  }
};

Companion.prototype._handleResponse = function (flight, xhr) {
  var launchRequest = flight.launchRequest;
  var latestRequest = flight.latestRequest;
  var current = latestRequest.transportEligible !== false
    && this._isCurrentWatchRequest(latestRequest);
  var body = this._responseJson(xhr);
  var status = Number(xhr.status);
  var result;
  var error;
  if (status >= 200 && status < 300) {
    if (!contracts.isDepartureResult(body)
        || body.requestId !== launchRequest.requestId
        || body.favoriteId !== launchRequest.favoriteId) {
      this._metrics.failures += 1;
      if (current) this._sendError(latestRequest, "INVALID_RESPONSE");
      return;
    }
    this._metrics.successes += 1;
    this._cacheResult(body);
    if (!current) return;
    result = contracts.copyDepartureResult(body, latestRequest.requestId);
    this._enqueueVisibleResult(result, null, latestRequest);
    return;
  }

  this._metrics.failures += 1;
  if (!current) return;
  if (status === 401 || status === 403) {
    this._sendError(latestRequest, "API_KEY_INVALID");
    return;
  }
  if (body !== null && contracts.isErrorResult(body)) {
    if (body.requestId !== launchRequest.requestId
        || (typeof body.favoriteId !== "undefined"
          && body.favoriteId !== launchRequest.favoriteId)) {
      this._sendError(latestRequest, "INVALID_RESPONSE");
      return;
    }
    error = {
      schemaVersion: contracts.SCHEMA_VERSION,
      requestId: latestRequest.requestId,
      favoriteId: latestRequest.favoriteId,
      code: body.code,
      occurredAt: body.occurredAt
    };
    if (typeof body.retryAfterSeconds !== "undefined") {
      error.retryAfterSeconds = body.retryAfterSeconds;
    }
    this._sendErrorResult(error);
    return;
  }

  this._sendError(
    latestRequest,
    this._httpErrorCode(status),
    this._retryAfter(xhr)
  );
};

Companion.prototype._httpErrorCode = function (status) {
  if (status === 401 || status === 403) return "API_KEY_INVALID";
  if (status === 400 || status === 404 || status === 422) return "INVALID_SERVICE";
  if (status === 429) return "RATE_LIMITED";
  if (status === 0 || status >= 500) return "SOURCE_UNAVAILABLE";
  return "INVALID_RESPONSE";
};

Companion.prototype._retryAfter = function (xhr) {
  var raw;
  var value;
  if (typeof xhr.getResponseHeader !== "function") return undefined;
  try {
    raw = xhr.getResponseHeader("Retry-After");
  } catch (ignored) {
    return undefined;
  }
  if (typeof raw !== "string" || !/^[0-9]+$/.test(raw)) return undefined;
  value = Number(raw);
  return contracts.uint32(value) ? value : undefined;
};

Companion.prototype._sendError = function (request, code, retryAfterSeconds) {
  var error = {
    schemaVersion: contracts.SCHEMA_VERSION,
    requestId: request.requestId,
    favoriteId: request.favoriteId,
    code: code,
    occurredAt: Math.floor(this._clock.now() / 1000)
  };
  if (typeof retryAfterSeconds !== "undefined") error.retryAfterSeconds = retryAfterSeconds;
  this._sendErrorResult(error);
};

Companion.prototype._sendErrorResult = function (error) {
  var invalid;
  this._queue.enqueue([codec.encodeError(error)]);
  if (error.code !== "API_KEY_INVALID"
      || this._configuration.primApiKey === null
      || this._configuration.keyStatus === contracts.KEY_STATUS.INVALID) return;
  invalid = {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: this._configuration.favorites.map(contracts.copyFavorite),
    primApiKey: this._configuration.primApiKey,
    keyStatus: contracts.KEY_STATUS.INVALID
  };
  configuration.saveInvalidConfiguration(this._storage, invalid);
  this._configuration = invalid;
  this._credentialBlocked = true;
  this._sendConfiguration();
};

Companion.prototype.metrics = function () {
  return {
    requests: this._metrics.requests,
    cacheHits: this._metrics.cacheHits,
    cacheMisses: this._metrics.cacheMisses,
    successes: this._metrics.successes,
    failures: this._metrics.failures,
    totalLatencyMs: this._metrics.totalLatencyMs,
    lastLatencyMs: this._metrics.lastLatencyMs
  };
};

function createCompanion(options) {
  return new Companion(options).start();
}

module.exports = {
  Companion: Companion,
  createCompanion: createCompanion,
  contracts: contracts,
  codec: codec,
  configuration: configuration,
  MessageQueue: MessageQueue
};
