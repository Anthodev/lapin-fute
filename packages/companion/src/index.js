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

function isFixture(value) {
  return contracts.isObject(value)
    && contracts.hasOnlyKeys(value, ["favorite", "result"])
    && contracts.isFavorite(value.favorite)
    && contracts.isDepartureResult(value.result)
    && value.favorite.id === value.result.favoriteId;
}

function Companion(options) {
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
  if (typeof options.fixture !== "undefined" && !isFixture(options.fixture)) {
    throw new TypeError("fixture does not match the frozen contracts");
  }

  this._Pebble = options.Pebble;
  this._storage = options.storage;
  this._XHR = options.XHR;
  this._clock = options.clock;
  this._backendUrl = typeof options.backendUrl === "string" ? options.backendUrl : "";
  this._configurationUrl = typeof options.configurationUrl === "string" ? options.configurationUrl : "";
  this._fixture = options.fixture || null;
  this._fixtureEnabled = false;
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
  this._requestGenerations = Object.create(null);
  this._inFlightRequests = Object.create(null);
  this._requestGeneration = 0;
  this._sequence = 0;
  this._started = false;
  this._queue = new MessageQueue(this._Pebble, options.defer);
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
  var inFlightRequests;
  if (!this._started) return;
  if (typeof this._Pebble.removeEventListener === "function") {
    Object.keys(this._handlers).forEach(function (eventName) {
      self._Pebble.removeEventListener(eventName, self._handlers[eventName]);
    });
  }
  this._started = false;
  this._requestGenerations = Object.create(null);
  inFlightRequests = this._inFlightRequests;
  this._inFlightRequests = Object.create(null);
  this._queue.clear();
  Object.keys(inFlightRequests).forEach(function (generation) {
    var xhr = inFlightRequests[generation];
    if (!xhr || typeof xhr.abort !== "function") return;
    try {
      xhr.abort();
    } catch (ignored) {
      // Generation invalidation remains authoritative if abort is unsupported or races.
    }
  });
};

Companion.prototype._refreshWatchState = function () {
  var configured = this._configuration.favorites.map(contracts.copyFavorite);
  this._fixtureEnabled = this._fixture !== null && configured.length === 0;
  this._watchFavorites = this._fixtureEnabled ? [contracts.copyFavorite(this._fixture.favorite)] : configured;
};

Companion.prototype._nextSequenceId = function () {
  this._sequence += 1;
  if (this._sequence > 1679615) this._sequence = 1;
  return "config-" + Math.floor(this._clock.now()).toString(36) + "-" + this._sequence.toString(36);
};

Companion.prototype._sendConfiguration = function () {
  var keyStatus = this._fixtureEnabled
    ? contracts.KEY_STATUS.CONFIGURED
    : (this._credentialBlocked
      ? contracts.KEY_STATUS.INVALID
      : this._configuration.keyStatus);
  if (!this._configurationValid
      || !configuration.areFavoritesSecretFree(
        this._watchFavorites,
        this._configuration.primApiKey,
        null
      )) return;
  this._queue.enqueue(codec.encodeConfiguration(
    this._nextSequenceId(),
    this._watchFavorites,
    keyStatus,
    configuration.activeWatchLanguage(this._Pebble)
  ));
};

Companion.prototype._onReady = function () {
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
  this._configuration = next;
  this._results = pruned;
  this._requestGenerations = Object.create(null);
  this._credentialBlocked = next.primApiKey !== null
    && next.keyStatus === contracts.KEY_STATUS.INVALID;
  this._refreshWatchState();
  this._sendConfiguration();
};

Companion.prototype._onAppMessage = function (event) {
  var request;
  if (!this._configurationValid) return;
  request = codec.decodeRequest(normalizeIncomingPayload(event && event.payload));
  if (request === null) return;
  if (this._findFavorite(request.favoriteId) === null) {
    this._sendError(request, "INVALID_SERVICE");
    return;
  }
  this._dispatchRequest(request);
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

Companion.prototype._beginRequest = function (favoriteId) {
  this._requestGeneration += 1;
  this._requestGenerations[favoriteId] = this._requestGeneration;
  return this._requestGeneration;
};

Companion.prototype._isLatestRequest = function (favoriteId, generation) {
  return this._requestGenerations[favoriteId] === generation;
};

Companion.prototype._dispatchRequest = function (request) {
  var cached = this._cachedResult(request);
  var cachedMessages;
  var fixtureResult;
  var favorite;
  var generation;
  var age;
  var refreshRequired;
  if (cached !== null) {
    this._metrics.cacheHits += 1;
    age = this._clock.now() - Math.min(cached.result.fetchedAt * 1000, cached.storedAt);
    refreshRequired = !(age >= 0 && age < contracts.CACHE_FRESH_SECONDS * 1000);
    cachedMessages = codec.encodeResult(cached.result);
    if (refreshRequired) cachedMessages.push(codec.encodeRequest(request));
    this._queue.enqueue(cachedMessages);
    if (!refreshRequired) return;
  } else {
    this._metrics.cacheMisses += 1;
  }
  if (this._fixtureEnabled && this._fixture.favorite.id === request.favoriteId) {
    fixtureResult = contracts.copyDepartureResult(this._fixture.result, request.requestId);
    this._queue.enqueue(codec.encodeResult(fixtureResult));
    return;
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
  favorite = this._findFavorite(request.favoriteId);
  if (favorite === null) {
    this._sendError(request, "INVALID_SERVICE");
    return;
  }
  generation = this._beginRequest(request.favoriteId);
  this._fetch(request, favorite, generation);
};

Companion.prototype._fetch = function (request, favorite, generation) {
  var self = this;
  var xhr;
  var settled = false;
  var key = null;
  var startedAt = this._clock.now();
  if (this._backendUrl.indexOf("https://") !== 0) {
    this._sendError(request, "SOURCE_UNAVAILABLE");
    return;
  }

  function once(callback) {
    return function () {
      var latency;
      if (settled) return;
      settled = true;
      latency = Math.max(0, self._clock.now() - startedAt);
      self._metrics.lastLatencyMs = latency;
      self._metrics.totalLatencyMs += latency;
      if (self._inFlightRequests[generation] === xhr) {
        delete self._inFlightRequests[generation];
      }
      if (!self._isLatestRequest(request.favoriteId, generation)) return;
      callback();
    };
  }

  try {
    xhr = new this._XHR();
    xhr.open("POST", this._backendUrl, true);
    xhr.timeout = contracts.LIMITS.httpTimeoutMs;
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.onload = once(function () { self._handleResponse(request, xhr); });
    xhr.onerror = once(function () {
      self._metrics.failures += 1;
      self._sendError(request, "SOURCE_UNAVAILABLE");
    });
    xhr.ontimeout = xhr.onerror;
    xhr.onabort = xhr.onerror;
    if (!this._isLatestRequest(request.favoriteId, generation)) return;
    key = this._configuration.primApiKey;
    if (!contracts.isPersonalApiKey(key)) {
      key = null;
      this._sendError(request, "API_KEY_REQUIRED");
      return;
    }
    xhr.setRequestHeader("Authorization", "Bearer " + key);
    this._metrics.requests += 1;
    this._inFlightRequests[generation] = xhr;
    xhr.send(JSON.stringify({
      schemaVersion: contracts.SCHEMA_VERSION,
      requestId: request.requestId,
      favoriteId: request.favoriteId,
      serviceId: favorite.serviceId
    }));
    key = null;
  } catch (ignored) {
    key = null;
    if (this._inFlightRequests[generation] === xhr) {
      delete this._inFlightRequests[generation];
    }
    if (!settled) {
      settled = true;
      this._metrics.failures += 1;
      if (this._isLatestRequest(request.favoriteId, generation)) {
        this._sendError(request, "SOURCE_UNAVAILABLE");
      }
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

Companion.prototype._handleResponse = function (request, xhr) {
  var body = this._responseJson(xhr);
  var status = Number(xhr.status);
  var error;
  if (status >= 200 && status < 300) {
    if (!contracts.isDepartureResult(body)
        || body.requestId !== request.requestId
        || body.favoriteId !== request.favoriteId) {
      this._metrics.failures += 1;
      this._sendError(request, "INVALID_RESPONSE");
      return;
    }
    this._metrics.successes += 1;
    this._cacheResult(body);
    this._queue.enqueue(codec.encodeResult(body));
    return;
  }

  this._metrics.failures += 1;
  if (status === 401 || status === 403) {
    this._sendError(request, "API_KEY_INVALID");
    return;
  }
  if (body !== null && contracts.isErrorResult(body)) {
    if (body.requestId !== request.requestId
        || (typeof body.favoriteId !== "undefined" && body.favoriteId !== request.favoriteId)) {
      this._sendError(request, "INVALID_RESPONSE");
      return;
    }
    error = {
      schemaVersion: contracts.SCHEMA_VERSION,
      requestId: request.requestId,
      favoriteId: request.favoriteId,
      code: body.code,
      occurredAt: body.occurredAt
    };
    if (typeof body.retryAfterSeconds !== "undefined") error.retryAfterSeconds = body.retryAfterSeconds;
    this._sendErrorResult(error);
    return;
  }

  this._sendError(request, this._httpErrorCode(status), this._retryAfter(xhr));
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
