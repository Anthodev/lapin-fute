"use strict";

// Lapin Futé phone companion. Owns PRIM HTTP, normalization, the phone-local
// cache and the D2 display-wire synchronization with the watch. The watch
// stays thin: every wire dictionary is either D2 display protocol or the
// reserved SDK 15025 transport echo. No hosted routes, no fixtures.

var contracts = require("./contracts");
var codec = require("./codec");
var configuration = require("./configuration");
var display = require("./display");
var layout = require("./display-layout");
var MessageQueue = require("./message-queue");
var createConfigurationSync = require("./configuration-sync").createConfigurationSync;
var createCatalogClient = require("./catalog-client").createCatalogClient;
var createPrimClient = require("./prim-client").createPrimClient;
var hasOwn = Object.prototype.hasOwnProperty;

var SDK_READY_KEY = "15025";
var APP_MESSAGE_ALIAS_BY_NUMERIC_KEY = Object.create(null);
Object.keys(contracts.APP_MESSAGE_KEYS).forEach(function (alias) {
  APP_MESSAGE_ALIAS_BY_NUMERIC_KEY[String(contracts.APP_MESSAGE_KEYS[alias])] = alias;
});

function requiredAdapter(condition, message) {
  if (!condition) throw new TypeError(message);
}

function endpointUrl(value, name) {
  var authority;
  if (typeof value !== "string") throw new TypeError(name + " must be an absolute HTTPS URL");
  if (value === "") return value;
  if (value.indexOf("https://") !== 0
      || /[\u0000-\u0020\\]/.test(value)) {
    throw new TypeError(name + " must be an absolute HTTPS URL");
  }
  authority = value.slice(8).split(/[/?#]/)[0];
  if (authority.length === 0 || authority.indexOf("@") !== -1) {
    throw new TypeError(name + " must be an absolute HTTPS URL");
  }
  return value;
}

// PKJS delivers alias and numeric keys for the same tuple; recognized
// duplicates must agree, and an unambiguous numeric key is adopted.
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
    if (hasOwn.call(contracts.APP_MESSAGE_KEYS, key)) {
      normalized[key] = payload[key];
      aliasCount += 1;
      continue;
    }
    alias = APP_MESSAGE_ALIAS_BY_NUMERIC_KEY[key];
    if (typeof alias === "undefined") return null;
    if (hasOwn.call(payload, alias)) {
      if (payload[key] !== payload[alias]) return null;
      continue;
    }
    normalized[alias] = payload[key];
    aliasCount += 1;
  }
  return aliasCount > 0 ? normalized : null;
}

function cacheAge(timestamp, storedAt, now) {
  return now - Math.min(timestamp * 1000, storedAt);
}

function cacheFresh(timestamp, storedAt, now) {
  var age = cacheAge(timestamp, storedAt, now);
  return age >= 0 && age < contracts.CACHE_FRESH_SECONDS * 1000;
}

function cacheUseful(timestamp, storedAt, now) {
  var age = cacheAge(timestamp, storedAt, now);
  return age >= 0 && age < contracts.USEFUL_STALE_SECONDS * 1000;
}

function sameFavoriteContentSet(left, right) {
  if (left.length !== right.length) return false;
  return left.every(function (favorite) {
    return right.some(function (other) {
      var keys;
      if (other.id !== favorite.id) return false;
      keys = Object.keys(favorite);
      return keys.length === Object.keys(other).length && keys.every(function (key) {
        return key === "sortOrder" || favorite[key] === other[key];
      });
    });
  });
}

function copyTrafficSummary(traffic) {
  var copy = { state: traffic.state, checkedAt: traffic.checkedAt };
  if (typeof traffic.sourceUpdatedAt !== "undefined") {
    copy.sourceUpdatedAt = traffic.sourceUpdatedAt;
  }
  return copy;
}

function snapshotFromResult(result) {
  var snapshot = {
    fetchedAt: result.fetchedAt,
    freshness: result.freshness,
    departures: result.departures.map(function (departure) {
      var copy = {
        expectedAt: departure.expectedAt,
        minutes: departure.minutes,
        status: departure.status
      };
      if (typeof departure.aimedAt !== "undefined") copy.aimedAt = departure.aimedAt;
      if (typeof departure.nextIntervalMinutes !== "undefined") {
        copy.nextIntervalMinutes = departure.nextIntervalMinutes;
      }
      return copy;
    })
  };
  if (typeof result.sourceUpdatedAt !== "undefined") {
    snapshot.sourceUpdatedAt = result.sourceUpdatedAt;
  }
  return snapshot;
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
  requiredAdapter(options.clock && typeof options.clock.now === "function", "clock adapter is required");
  requiredAdapter(typeof options.defer === "function", "defer adapter is required");

  this._Pebble = options.Pebble;
  this._storage = options.storage;
  this._XHR = options.XHR;
  this._clock = options.clock;
  this._configurationUrl = endpointUrl(
    typeof options.configurationUrl === "undefined" ? "" : options.configurationUrl,
    "configurationUrl"
  );
  this._catalog = createCatalogClient({
    XHR: this._XHR, configurationUrl: this._configurationUrl, clock: this._clock
  });
  this._configuration = configuration.loadConfiguration(this._storage);
  this._configurationValid = this._configuration !== null;
  this._credentialBlocked = this._configurationValid
    && this._configuration.keyStatus === contracts.KEY_STATUS.INVALID;
  if (!this._configurationValid) this._configuration = configuration.emptyConfiguration();
  this._watchFavorites = [];
  this._watchLanguage = null;
  this._forceFullSync = false;
  this._cache = configuration.loadCache(this._storage, this._configuration.favorites);
  this._metrics = {
    requests: 0,
    cacheHits: 0,
    cacheMisses: 0,
    successes: 0,
    failures: 0,
    rateLimitedResponses: 0,
    totalLatencyMs: 0,
    lastLatencyMs: 0
  };
  this._lifecycleGeneration = 0;
  this._activeRequest = null;
  this._overviewDemand = null;
  this._requests = [];
  this._overviewFlight = null;
  this._trafficFlights = Object.create(null);
  this._readyPending = false;
  this._readyLoaded = false;
  this._pendingMessages = [];
  this._drainingRequests = false;
  this._lastRequestSequence = 0;
  this._started = false;
  this._queue = new MessageQueue(this._Pebble, options.defer, function () {
    self._activeRequest = null;
    self._overviewDemand = null;
    self._sync.discardTransaction();
    self._requests = [];
    self._pendingMessages = [];
  });
  this._handlers = null;
  this._sync = createConfigurationSync({
    queue: this._queue,
    onSynchronized: function () { self._onSynchronized(); }
  });
  this._resetPrimClient();
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
  this._sync.clear();
  this._readyPending = false;
  this._readyLoaded = false;
};

Companion.prototype._refreshWatchState = function () {
  this._watchFavorites = this._configuration.favorites.map(contracts.copyFavorite);
};

Companion.prototype._resetPrimClient = function () {
  var self = this;
  this._prim = createPrimClient({
    XHR: function () {
      var xhr = new self._XHR();
      self._metrics.requests += 1;
      return xhr;
    },
    clock: this._clock
  });
};

// Cancels in-flight application work after a configuration or credential
// change. Queued unattempted SDK control echoes survive; the watch binding
// and committed display metadata stay intact so the next transaction rebinds.
Companion.prototype._invalidateLifecycle = function () {
  var overview = this._overviewFlight;
  var traffic = this._trafficFlights;
  this._lifecycleGeneration += 1;
  this._activeRequest = null;
  this._overviewDemand = null;
  this._overviewFlight = null;
  this._trafficFlights = Object.create(null);
  this._sync.discardTransaction();
  this._queue.cancelApplication();
  this._requests = [];
  this._pendingMessages = [];
  if (overview) this._abortFlight(overview);
  Object.keys(traffic).forEach(function (key) {
    if (traffic[key]) this._abortFlight(traffic[key]);
  }, this);
  this._resetPrimClient();
};

Companion.prototype._abortFlight = function (flight) {
  flight.handles.forEach(function (handle) {
    try { handle.abort(); } catch (ignored) { /* Generation invalidates late callbacks. */ }
  });
  flight.handles = [];
};

Companion.prototype._onReady = function () {
  if (this._readyPending) return;
  this._readyPending = true;
  this._synchronizeReady();
};

Companion.prototype._synchronizeReady = function () {
  if (!this._readyLoaded) {
    var loaded = configuration.loadConfiguration(this._storage);
    if (loaded === null) {
      this._configurationValid = false;
    } else {
      if (this._credentialBlocked && loaded.primApiKey !== null) loaded.keyStatus = contracts.KEY_STATUS.INVALID;
      this._configuration = loaded;
      this._configurationValid = true;
      this._credentialBlocked = loaded.keyStatus === contracts.KEY_STATUS.INVALID;
      this._cache = configuration.loadCache(this._storage, loaded.favorites);
      this._refreshWatchState();
    }
    this._readyLoaded = true;
  }
  this._sync.ready();
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
  var nextWatch;
  var wireChanged;
  var invalidate;
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
        favorites: next.favorites.map(contracts.copyPhoneFavorite),
        primApiKey: next.primApiKey,
        keyStatus: contracts.KEY_STATUS.INVALID
      };
      if (!configuration.saveInvalidConfiguration(this._storage, pending)) return;
      if (!configuration.clearInvalidKeyStatus(this._storage)
          || !configuration.saveConfiguration(this._storage, next)) next = pending;
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
  nextWatch = next.favorites.map(contracts.copyFavorite);
  wireChanged = JSON.stringify(nextWatch) !== JSON.stringify(this._watchFavorites)
    || next.keyStatus !== this._configuration.keyStatus
    || configuration.activeWatchLanguage(this._Pebble) !== this._watchLanguage;
  invalidate = update.apiKeyUpdate.action !== "KEEP"
    || !sameFavoriteContentSet(this._watchFavorites, nextWatch)
    || update.forceFullSync;
  if (invalidate) {
    pruned = configuration.pruneCache(this._cache, next.favorites);
    if (JSON.stringify(pruned) !== JSON.stringify(this._cache)) {
      configuration.saveCache(this._storage, pruned, next.primApiKey);
    }
    this._invalidateLifecycle();
    this._cache = pruned;
  }
  this._configuration = next;
  this._credentialBlocked = next.primApiKey !== null
    && next.keyStatus === contracts.KEY_STATUS.INVALID;
  this._watchFavorites = nextWatch;
  if (wireChanged || invalidate) this._sendConfiguration(update.forceFullSync);
};

// Prepares the display target for the watch binding and starts a D2
// configuration transaction. Preparation happens only after a valid HELLO
// fixed the watch profile; before that a forced full sync is remembered.
Companion.prototype._sendConfiguration = function (forceFull) {
  if (forceFull === true) this._forceFullSync = true;
  var binding = this._sync.binding();
  if (!this._configurationValid || !binding.epoch
      || !configuration.areFavoritesSecretFree(this._watchFavorites, this._configuration.primApiKey, null)) return;
  var language = configuration.activeWatchLanguage(this._Pebble);
  var records;
  try {
    records = this._configuration.favorites.map(function (favorite) {
      return layout.prepareAppearance(favorite, binding.profile, language);
    });
  } catch (error) {
    this._metrics.failures += 1;
    return;
  }
  var token = this._sync.synchronize({
    favorites: this._configuration.favorites, records: records, language: language,
    keyStatus: this._credentialBlocked ? contracts.KEY_STATUS.INVALID : this._configuration.keyStatus,
    lifecycleGeneration: this._lifecycleGeneration
  }, this._forceFullSync);
  if (token !== null) {
    this._watchLanguage = language;
    this._forceFullSync = false;
  }
};

Companion.prototype._onSynchronized = function () {
  this._flushResponses();
};

Companion.prototype._onAppMessage = function (event) {
  var payload = event && event.payload;
  var normalized;
  var hello;
  var decoded;
  if (contracts.isObject(payload)
      && Object.keys(payload).length === 1
      && payload[SDK_READY_KEY] === 1) {
    // Reserved SDK transport control. The native Message module waits for
    // this echo before granting the first writable callback; it is queued as
    // a control batch so a later failed D2 transfer cannot strand it.
    var self = this;
    this._queue.enqueue(codec.one({ "15025": 1 }), function () { self._flushResponses(); }, true);
    return;
  }
  if (!this._configurationValid) return;
  normalized = normalizeIncomingPayload(payload);
  if (normalized === null) return;
  hello = this._sync.hello(normalized);
  if (hello.consumed) {
    if (hello.changed) {
      this._invalidateLifecycle();
      this._lastRequestSequence = 0;
      this._sendConfiguration(this._forceFullSync);
    }
    return;
  }
  if (this._sync.receive(normalized)) return;
  decoded = codec.decodeDataRequest(normalized);
  if (decoded === null) return;
  this._dispatchDataRequest(decoded);
};

Companion.prototype._dispatchDataRequest = function (request) {
  var binding = this._sync.resolveDataBinding(request);
  if (binding === null) {
    if (!this._sync.pendingDataBinding(request)) return;
  } else {
    if (binding.lifecycleGeneration !== this._lifecycleGeneration) return;
    if (request.kind !== "overview" && this._bindingFavorite(binding, request.favoriteId) === null) return;
  }
  var sequence = parseInt(request.requestId.slice(16), 16);
  if (sequence <= this._lastRequestSequence) return;
  this._lastRequestSequence = sequence;
  // Four admitted tokens keep their completion ownership. The watch has one
  // latest expectation per kind, so overload retains only that not-yet-
  // admitted demand (at most three), rather than stranding the newest screen.
  for (var index = 0; index < this._pendingMessages.length; index += 1) {
    if (this._pendingMessages[index].kind === request.kind) {
      this._pendingMessages.splice(index, 1);
      break;
    }
  }
  this._pendingMessages.push(request);
  this._flushPendingRequests();
};

Companion.prototype._flushPendingRequests = function () {
  if (this._drainingRequests) return;
  this._drainingRequests = true;
  try {
    while (this._requests.length < 4 && this._pendingMessages.length) {
      var request = this._pendingMessages[0];
      var binding = this._sync.resolveDataBinding(request);
      if (binding === null && this._sync.pendingDataBinding(request)) break;
      this._pendingMessages.shift();
      if (binding === null || binding.lifecycleGeneration !== this._lifecycleGeneration) continue;
      var favorite = request.kind === "overview" ? null : this._bindingFavorite(binding, request.favoriteId);
      if (request.kind !== "overview" && favorite === null) continue;
      request.binding = binding;
      this._activate(request);
      if (request.kind === "overview") this._dispatchOverview(request, binding);
      else if (request.kind === "detail") this._dispatchDetail(request, binding);
      else this._dispatchTraffic(request, binding, favorite);
    }
  } finally {
    this._drainingRequests = false;
  }
};

Companion.prototype._activate = function (request) {
  request.generation = this._lifecycleGeneration;
  request.awaitingOverview = false;
  request.awaitingTraffic = false;
  request.terminal = false;
  request.outgoing = null;
  request.queued = false;
  this._requests.push(request);
  if (request.kind === "overview") this._overviewDemand = request;
  this._activeRequest = request;
  return request;
};

Companion.prototype._enqueueResult = function (records, request, terminal) {
  if (request.generation !== this._lifecycleGeneration) return;
  request.outgoing = records;
  request.terminal = terminal !== false;
  this._queueResponse(request);
};

Companion.prototype._queueResponse = function (request) {
  if (request.queued || request.outgoing === null) return;
  var self = this;
  var current = null;
  request.queued = true;
  var accepted = this._queue.enqueue(function () {
    if (request.generation !== self._lifecycleGeneration) return null;
    for (;;) {
      if (current === null) {
        if (request.outgoing === null) return null;
        current = codec.createDisplayTransfer(request, request.outgoing);
        request.outgoing = null;
      }
      var message = current();
      if (message !== null) return message;
      current = null;
    }
  }, function () {
    request.queued = false;
    if (request.terminal && request.outgoing === null) {
      var index = self._requests.indexOf(request);
      if (index !== -1) self._requests.splice(index, 1);
    }
    self._flushResponses();
  });
  if (accepted === false) request.queued = false;
};

Companion.prototype._flushResponses = function () {
  this._requests.slice().forEach(function (request) { this._queueResponse(request); }, this);
  this._flushPendingRequests();
};

Companion.prototype._isActive = function (request) {
  return this._activeRequest === request;
};

Companion.prototype._findFavorite = function (favoriteId) {
  var index;
  for (index = 0; index < this._configuration.favorites.length; index += 1) {
    if (this._configuration.favorites[index].id === favoriteId) return this._configuration.favorites[index];
  }
  return null;
};

// ---------------------------------------------------------------------------
// D2 transfer composition
// ---------------------------------------------------------------------------

Companion.prototype._sendDisplayTransfer = function (request, kind, records, favoriteId, terminal) {
  this._enqueueResult(records, request, terminal);
};

// favorite: a committed binding entry carrying id and serviceId. Flight
// errors are keyed by service because one service may serve several favorites.
Companion.prototype._favoriteView = function (favorite, flightErrors, aggregateError, cacheOnly) {
  var entry = configuration.findOverview(this._cache, favorite.id, "cache");
  // A favorite ID cannot retarget a cached service during an in-flight DIFF.
  if (entry !== null && entry.serviceId !== favorite.serviceId) entry = null;
  var code = aggregateError || (flightErrors && flightErrors[favorite.serviceId]) || null;
  if (!code && entry && entry.refreshError) code = entry.refreshError.code;
  var hasData = entry !== null && hasOwn.call(entry, "result")
    && cacheUseful(entry.result.fetchedAt, entry.resultStoredAt, this._clock.now());
  if (!hasData && cacheOnly && code !== "API_KEY_REQUIRED" && code !== "API_KEY_INVALID") code = "NO_CACHED_DATA";
  return {
    hasData: hasData,
    forcedStale: hasData && (code !== null || !cacheFresh(entry.result.fetchedAt, entry.resultStoredAt, this._clock.now())),
    snapshot: hasData ? entry.result : null,
    traffic: entry ? entry.traffic : { state: "UNKNOWN", checkedAt: 0 },
    exception: code || (hasData ? null : "NO_CACHED_DATA")
  };
};

Companion.prototype._viewRecord = function (view, maximumDepartures, refreshing) {
  return display.departureRecord({
    hasData: view.hasData,
    forcedStale: view.forcedStale,
    fetchedAt: view.hasData ? view.snapshot.fetchedAt : 0,
    freshness: view.hasData ? view.snapshot.freshness : "STALE",
    exceptionToken: view.exception,
    refreshing: refreshing,
    trafficPalette: view.traffic.state,
    trafficCheckedAt: view.traffic.checkedAt,
    departures: view.hasData
      ? view.snapshot.departures.slice(0, maximumDepartures).map(function (departure) {
        return { expectedAt: departure.expectedAt, status: departure.status };
      })
      : []
  });
};

Companion.prototype._overviewRows = function (binding, flightErrors, aggregateError, cacheOnly, refreshing) {
  return binding.favorites.map(function (favorite) {
    return this._viewRecord(this._favoriteView(favorite, flightErrors, aggregateError, cacheOnly), 1, refreshing);
  }, this);
};

Companion.prototype._sendErrorTransfer = function (request, code) {
  if (request.kind === "traffic") {
    this._sendDisplayTransfer(request, 2, [display.trafficErrorRecord(code)], request.favoriteId);
  } else if (request.kind === "overview") {
    this._sendDisplayTransfer(request, 0, this._overviewRows(request.binding, null, code));
  } else {
    var favorite = this._bindingFavorite(request.binding, request.favoriteId);
    this._sendDetailTransfer(request, this._favoriteView(favorite, null, code));
  }
};

// ---------------------------------------------------------------------------
// Overview dispatch
// ---------------------------------------------------------------------------

Companion.prototype._staleOverviewFavorites = function (request, binding) {
  var now = this._clock.now();
  return binding.favorites.filter(function (favorite) {
    if (request.kind === "detail" && favorite.id !== request.favoriteId) return false;
    var entry = configuration.findOverview(this._cache, favorite.id, request.requestId);
    return entry === null
      || !hasOwn.call(entry, "result")
      || !cacheFresh(entry.result.fetchedAt, entry.resultStoredAt, now);
  }, this);
};

Companion.prototype._bindingFavorite = function (binding, favoriteId) {
  var found = null;
  binding.favorites.forEach(function (favorite) {
    if (favorite.id === favoriteId) found = favorite;
  });
  return found;
};

Companion.prototype._recordCacheMetrics = function (binding) {
  var anyCached = binding.favorites.some(function (favorite) {
    var entry = configuration.findOverview(this._cache, favorite.id, "cache");
    return entry !== null && hasOwn.call(entry, "result");
  }, this);
  if (anyCached) this._metrics.cacheHits += 1;
  else this._metrics.cacheMisses += 1;
};

Companion.prototype._dispatchOverview = function (request, binding) {
  this._recordCacheMetrics(binding);
  var keyError = this._credentialError();
  if (request.trigger === contracts.REQUEST_TRIGGER.CACHE_ONLY) {
    // Final cached/missing projection. This branch never consults flights,
    // calls _canFetch, waits for PRIM, or emits a refreshing echo.
    this._sendDisplayTransfer(request, 0, this._overviewRows(binding, null, keyError, true));
    return;
  }
  if (keyError) { this._sendErrorTransfer(request, keyError); return; }
  var stale = this._staleOverviewFavorites(request, binding);
  if (!stale.length) {
    this._sendDisplayTransfer(request, 0, this._overviewRows(binding, null, null));
    return;
  }
  var warm = this._overviewRows(binding, null, null, false, true);
  if (warm.some(function (record) { return parseInt(record.slice(0, 2), 16) & 1; })) {
    this._sendDisplayTransfer(request, 0, warm, undefined, false);
  }
  this._ensureOverviewFlight(request, binding, stale);
};

Companion.prototype._ensureOverviewFlight = function (request, binding, stale) {
  request.overviewFavorites = stale || this._staleOverviewFavorites(request, binding);
  if (request.overviewFavorites.length === 0 || !this._canFetch(request)) return;
  request.awaitingOverview = true;
  if (this._overviewFlight
      && this._overviewFlight.generation === this._lifecycleGeneration) return;
  this._startOverviewFlight(request);
};

// ---------------------------------------------------------------------------
// Detail dispatch
// ---------------------------------------------------------------------------

Companion.prototype._dispatchDetail = function (request, binding) {
  var keyError = this._credentialError();
  if (keyError) { this._sendErrorTransfer(request, keyError); return; }
  var favorite = this._bindingFavorite(binding, request.favoriteId);
  var cached = configuration.findOverview(this._cache, request.favoriteId, request.requestId);
  var cacheOnly = request.trigger === contracts.REQUEST_TRIGGER.CACHE_ONLY;
  if (cached !== null && hasOwn.call(cached, "result")) {
    this._metrics.cacheHits += 1;
    var fresh = cacheFresh(cached.result.fetchedAt, cached.resultStoredAt, this._clock.now());
    var view = this._favoriteView(favorite, null, null, cacheOnly);
    this._sendDisplayTransfer(request, 1, [this._viewRecord(view, contracts.LIMITS.departures, !fresh && !cacheOnly)],
      request.favoriteId, fresh || cacheOnly);
    if (fresh || cacheOnly) return;
  } else {
    this._metrics.cacheMisses += 1;
    if (cacheOnly) { this._sendErrorTransfer(request, "NO_CACHED_DATA"); return; }
  }
  this._ensureOverviewFlight(request, binding);
};

Companion.prototype._sendDetailTransfer = function (request, view) {
  this._sendDisplayTransfer(request, 1, [this._viewRecord(view, contracts.LIMITS.departures)], request.favoriteId);
};

// ---------------------------------------------------------------------------
// Traffic dispatch
// ---------------------------------------------------------------------------

Companion.prototype._displayContext = function (binding) {
  return { language: binding.language, profile: binding.profile, hour12: binding.clock12 === 1 };
};

Companion.prototype._sendTrafficTransfer = function (request, data) {
  var fragments = display.trafficFragments(data, this._displayContext(request.binding));
  this._sendDisplayTransfer(request, 2, fragments, request.favoriteId);
};

Companion.prototype._dispatchTraffic = function (request, binding, favorite) {
  var keyError = this._credentialError();
  if (keyError) { this._sendErrorTransfer(request, keyError); return; }
  var language = binding.language;
  var cached = this._freshLineTraffic(favorite, language, true);
  request.serviceId = favorite.serviceId;
  request.trafficKey = (favorite.routing ? favorite.routing.lineRef : favorite.serviceId) + "\n" + language;
  if (cached !== null) {
    this._metrics.cacheHits += 1;
    this._sendTrafficTransfer(request, cached);
    return;
  }
  this._metrics.cacheMisses += 1;
  if (!this._canFetch(request)) return;
  request.awaitingTraffic = true;
  if (this._trafficFlights[request.trafficKey]
      && this._trafficFlights[request.trafficKey].generation === this._lifecycleGeneration) return;
  this._startTrafficFlight(request);
};

Companion.prototype._credentialError = function () {
  if (this._configuration.primApiKey === null) return "API_KEY_REQUIRED";
  if (this._credentialBlocked || this._configuration.keyStatus === contracts.KEY_STATUS.INVALID) return "API_KEY_INVALID";
  return null;
};

Companion.prototype._canFetch = function (request) {
  var code = this._credentialError();
  if (!code) return true;
  this._sendErrorTransfer(request, code);
  return false;
};

// ---------------------------------------------------------------------------
// PRIM flights (real network work; unchanged domain behavior)
// ---------------------------------------------------------------------------

Companion.prototype._hydrateRouting = function (flight, favorites, complete) {
  var self = this;
  var missing = [];
  var recovered = Object.create(null);
  var remaining;
  favorites.forEach(function (favorite) {
    if (favorite.routing) return;
    // Hydration can update phone-only routing without another metadata commit.
    // Reuse it only for the same bound favorite/service, never a retargeted ID.
    var current = self._findFavorite(favorite.id);
    if (current && current.serviceId === favorite.serviceId && current.routing) {
      recovered[favorite.serviceId] = current.routing;
    } else if (missing.indexOf(favorite.serviceId) === -1) missing.push(favorite.serviceId);
  });
  remaining = missing.length;
  if (remaining === 0) { complete(recovered); return; }
  missing.forEach(function (serviceId) {
    flight.handles.push(self._catalog.lookupService(serviceId, function (service) {
      var hydrated;
      var changed = false;
      if (flight.generation !== self._lifecycleGeneration) return;
      if (service !== null) recovered[serviceId] = service.routing;
      remaining -= 1;
      if (remaining !== 0) return;
      if (Object.keys(recovered).length === 0) { complete(recovered); return; }
      hydrated = {
        schemaVersion: contracts.SCHEMA_VERSION,
        favorites: self._configuration.favorites.map(contracts.copyPhoneFavorite),
        primApiKey: self._configuration.primApiKey,
        keyStatus: self._configuration.keyStatus
      };
      hydrated.favorites.forEach(function (favorite) {
        if (!favorite.routing && recovered[favorite.serviceId]) {
          favorite.routing = recovered[favorite.serviceId];
          changed = true;
        }
      });
      if (!configuration.areFavoritesSecretFree(hydrated.favorites, hydrated.primApiKey, null)) {
        complete(Object.create(null));
        return;
      }
      if (changed && configuration.configurationUrl(
        self._configurationUrl, hydrated, configuration.activeWatchLanguage(self._Pebble)
      ) !== null) {
        configuration.saveConfiguration(self._storage, hydrated);
        self._configuration = hydrated;
      }
      complete(recovered);
    }));
  });
};

Companion.prototype._freshServiceEntry = function (favorite) {
  var index;
  var candidate;
  var entry;
  for (index = 0; index < this._configuration.favorites.length; index += 1) {
    candidate = this._configuration.favorites[index];
    if (candidate.serviceId !== favorite.serviceId) continue;
    entry = configuration.findOverview(this._cache, candidate.id, "cache");
    if (entry !== null && hasOwn.call(entry, "result")
        && cacheFresh(entry.result.fetchedAt, entry.resultStoredAt, this._clock.now())) return entry;
  }
  return null;
};

Companion.prototype._freshLineTraffic = function (favorite, language, detail) {
  var index;
  var candidate;
  var entry;
  for (index = 0; index < this._configuration.favorites.length; index += 1) {
    candidate = this._configuration.favorites[index];
    if (candidate.serviceId !== favorite.serviceId && (!favorite.routing || !candidate.routing
        || candidate.routing.lineRef !== favorite.routing.lineRef)) continue;
    entry = configuration.findTrafficDetail(this._cache, candidate.serviceId, language, "cache", favorite.id);
    if (entry !== null && cacheFresh(entry.result.checkedAt, entry.storedAt, this._clock.now())) return entry.result;
    if (detail) continue;
    entry = configuration.findOverview(this._cache, candidate.id, "cache");
    if (entry !== null && cacheFresh(entry.traffic.checkedAt, entry.trafficStoredAt, this._clock.now())) {
      return entry.traffic;
    }
  }
  return null;
};

Companion.prototype._bindTraffic = function (data, requestId, favoriteId) {
  var result = {
    schemaVersion: contracts.SCHEMA_VERSION,
    requestId: requestId,
    favoriteId: favoriteId,
    state: data.state,
    checkedAt: data.checkedAt
  };
  ["sourceUpdatedAt", "title", "text", "validFrom", "validUntil"].forEach(function (field) {
    if (hasOwn.call(data, field)) result[field] = data[field];
  });
  return result;
};

Companion.prototype._storeTraffic = function (favorite, language, data, requestId) {
  var result = this._bindTraffic(data, requestId, favorite.id);
  var next = configuration.putTrafficDetail(this._cache, this._configuration.favorites, {
    schemaVersion: contracts.SCHEMA_VERSION,
    requestId: requestId,
    favoriteId: favorite.id,
    serviceId: favorite.serviceId,
    language: language
  }, result, Math.floor(this._clock.now()));
  if (next === null || !configuration.cacheIsSecretFree(next, this._configuration.primApiKey)) return false;
  this._cache = next;
  configuration.saveCache(this._storage, next, this._configuration.primApiKey);
  return true;
};

Companion.prototype._acceptOutcome = function (flight, outcome) {
  if (flight.generation !== this._lifecycleGeneration) return false;
  if (outcome.status === "UNAVAILABLE" && outcome.error.code === "RATE_LIMITED") {
    this._metrics.rateLimitedResponses += 1;
  }
  if (outcome.status !== "UNAVAILABLE" || outcome.error.code !== "API_KEY_INVALID") return true;
  var requests = this._requests.slice();
  this._metrics.failures += 1;
  this._invalidateCredential();
  requests.forEach(function (request) {
    this._activate(request);
    this._sendErrorTransfer(request, "API_KEY_INVALID");
  }, this);
  return false;
};

Companion.prototype._startOverviewFlight = function (request) {
  var self = this;
  var favorites = request.overviewFavorites;
  var language = request.binding.language;
  var services = Object.create(null);
  var serviceIds = [];
  var remaining;
  var flight = {
    kind: "overview",
    generation: this._lifecycleGeneration,
    startedAt: this._clock.now(),
    handles: [],
    serviceErrors: Object.create(null),
    launchRequest: {
      schemaVersion: contracts.SCHEMA_VERSION,
      requestId: request.requestId,
      language: language,
      favorites: favorites.map(function (favorite) {
        return { favoriteId: favorite.id, serviceId: favorite.serviceId };
      })
    }
  };
  this._overviewFlight = flight;
  favorites.forEach(function (favorite) {
    if (!hasOwn.call(services, favorite.serviceId)) {
      serviceIds.push(favorite.serviceId);
      services[favorite.serviceId] = { favoriteId: favorite.id, departures: null, traffic: null };
    }
  });
  remaining = serviceIds.length * 2;

  function completed() {
    var items = [];
    var error = null;
    var next;
    var body;
    remaining -= 1;
    if (remaining !== 0 || flight.generation !== self._lifecycleGeneration) return;
    self._overviewFlight = null;
    favorites.forEach(function (favorite) {
      var service = services[favorite.serviceId];
      var previous = configuration.findOverview(self._cache, favorite.id, request.requestId);
      var traffic = service.traffic;
      if (service.trafficError) {
        traffic = {
          state: "UNKNOWN",
          checkedAt: previous === null ? 0 : previous.traffic.checkedAt
        };
      }
      items.push({
        favoriteId: favorite.id,
        departures: service.departures,
        traffic: copyTrafficSummary(traffic)
      });
    });
    body = { schemaVersion: contracts.SCHEMA_VERSION, requestId: request.requestId, items: items };
    next = !contracts.isOverviewResult(body, flight.launchRequest) ? null : configuration.mergeOverview(
      self._cache, self._configuration.favorites, body, Math.floor(self._clock.now())
    );
    if (next !== null && configuration.cacheIsSecretFree(next, self._configuration.primApiKey)) {
      self._cache = next;
      configuration.saveCache(self._storage, next, self._configuration.primApiKey);
      self._metrics.successes += 1;
    } else {
      error = "INVALID_RESPONSE";
      self._metrics.failures += 1;
    }
    self._completeOverviewFlight(flight, error);
  }

  this._hydrateRouting(flight, favorites, function (recovered) {
    serviceIds.forEach(function (serviceId) {
      var service = services[serviceId];
      var favorite = self._bindingFavorite(request.binding, service.favoriteId);
      var routing = favorite.routing || recovered[serviceId];
      var entry = self._freshServiceEntry(favorite);
      var traffic = self._freshLineTraffic(favorite, language, false);
      var unavailable = { status: "UNAVAILABLE", error: {
        code: "INVALID_SERVICE", occurredAt: Math.floor(self._clock.now() / 1000)
      } };
      if (entry !== null) {
        service.departures = { status: "AVAILABLE", data: snapshotFromResult(entry.result) };
        completed();
      } else if (!routing) {
        service.departures = unavailable;
        flight.serviceErrors[serviceId] = "INVALID_SERVICE";
        completed();
      } else {
        flight.handles.push(self._prim.departures({
          routing: routing, apiKey: self._configuration.primApiKey
        }, function (outcome) {
          if (!self._acceptOutcome(flight, outcome)) return;
          service.departures = outcome;
          if (outcome.status === "UNAVAILABLE") {
            flight.serviceErrors[serviceId] = outcome.error.code;
          }
          completed();
        }));
      }
      if (traffic !== null) {
        service.traffic = traffic;
        completed();
      } else if (!routing) {
        service.trafficError = unavailable.error;
        completed();
      } else {
        flight.handles.push(self._prim.traffic({
          lineRef: routing.lineRef, language: language, apiKey: self._configuration.primApiKey
        }, function (outcome) {
          if (!self._acceptOutcome(flight, outcome)) return;
          if (outcome.status === "AVAILABLE") {
            service.traffic = outcome.data;
            self._storeTraffic(favorite, language, outcome.data, request.requestId);
          } else service.trafficError = outcome.error;
          completed();
        }));
      }
    });
  });
};

Companion.prototype._startTrafficFlight = function (request) {
  var self = this;
  var favorite = this._bindingFavorite(request.binding, request.favoriteId);
  var flight = {
    kind: "traffic", key: request.trafficKey, generation: this._lifecycleGeneration,
    handles: [], launchRequest: request, startedAt: this._clock.now()
  };
  this._trafficFlights[flight.key] = flight;
  this._hydrateRouting(flight, [favorite], function (recovered) {
    var routing;
    favorite = self._bindingFavorite(request.binding, request.favoriteId);
    routing = favorite.routing || recovered[favorite.serviceId];
    if (!routing) {
      self._completeTrafficFlight(flight, { status: "UNAVAILABLE", error: {
        code: "INVALID_SERVICE", occurredAt: Math.floor(self._clock.now() / 1000)
      } });
      return;
    }
    flight.handles.push(self._prim.traffic({
      lineRef: routing.lineRef, language: request.binding.language, apiKey: self._configuration.primApiKey
    }, function (outcome) { self._completeTrafficFlight(flight, outcome); }));
  });
};

Companion.prototype._completeOverviewFlight = function (flight, error) {
  this._metrics.lastLatencyMs = Math.max(0, this._clock.now() - flight.startedAt);
  this._metrics.totalLatencyMs += this._metrics.lastLatencyMs;
  if (flight.generation !== this._lifecycleGeneration) return;
  this._requests.slice().forEach(function (request) { this._completeDemand(request, flight, error); }, this);
  var active = this._activeRequest;
  var overview = this._overviewDemand;
  if (active !== null && active.kind === "detail" && active.awaitingOverview) this._startOverviewFlight(active);
  else if (overview !== null && overview.awaitingOverview) this._startOverviewFlight(overview);
};

// A joined demand receives exactly one final transfer bound to its own
// accepted request token, whether it paints fresh rows or error tokens.
// Favorites this flight never attempted stay pending for the follow-up
// flight instead of being answered with a premature no-cache token.
Companion.prototype._completeDemand = function (request, flight, error) {
  if (request.generation !== this._lifecycleGeneration || !request.awaitingOverview) return;
  var uncovered = request.overviewFavorites.filter(function (favorite) {
    return !flight.launchRequest.favorites.some(function (sent) { return sent.favoriteId === favorite.id; });
  });
  var errors = request.overviewErrors || Object.create(null);
  Object.keys(flight.serviceErrors).forEach(function (service) { errors[service] = flight.serviceErrors[service]; });
  request.overviewErrors = errors;
  if (error) request.overviewError = error;
  if (uncovered.length > 0 && !this._credentialError()
      && (request === this._overviewDemand || request === this._activeRequest)) {
    request.overviewFavorites = this._staleOverviewFavorites(request, { favorites: uncovered });
    if (request.overviewFavorites.length) return;
  }
  // Superseded settled selections do not launch new service fetches, but
  // their already accepted tokens still get a final cached/error projection.
  request.awaitingOverview = false;
  if (request.kind === "detail") {
    var favorite = this._bindingFavorite(request.binding, request.favoriteId);
    this._sendDetailTransfer(request, this._favoriteView(favorite, errors, request.overviewError));
  } else this._sendDisplayTransfer(request, 0, this._overviewRows(request.binding, errors, request.overviewError));
};

Companion.prototype._completeTrafficFlight = function (flight, outcome) {
  if (!this._acceptOutcome(flight, outcome) || this._trafficFlights[flight.key] !== flight) return;
  this._metrics.lastLatencyMs = Math.max(0, this._clock.now() - flight.startedAt);
  this._metrics.totalLatencyMs += this._metrics.lastLatencyMs;
  delete this._trafficFlights[flight.key];
  var origin = flight.launchRequest;
  if (outcome.status === "AVAILABLE") {
    var favorite = this._bindingFavorite(origin.binding, origin.favoriteId);
    if (!this._storeTraffic(favorite, origin.binding.language, outcome.data, origin.requestId)) {
      outcome = { status: "UNAVAILABLE", error: { code: "INVALID_RESPONSE" } };
    }
  }
  if (outcome.status === "AVAILABLE") this._metrics.successes += 1;
  else this._metrics.failures += 1;
  this._requests.slice().forEach(function (request) {
    if (request.generation !== flight.generation || !request.awaitingTraffic || request.trafficKey !== flight.key) return;
    request.awaitingTraffic = false;
    if (outcome.status === "AVAILABLE") this._sendTrafficTransfer(request, outcome.data);
    else this._sendErrorTransfer(request, outcome.error.code);
  }, this);
};

Companion.prototype._invalidateCredential = function () {
  var invalid;
  if (this._configuration.primApiKey === null
      || this._configuration.keyStatus === contracts.KEY_STATUS.INVALID) return;
  invalid = {
    schemaVersion: contracts.SCHEMA_VERSION,
    favorites: this._configuration.favorites.map(contracts.copyPhoneFavorite),
    primApiKey: this._configuration.primApiKey,
    keyStatus: contracts.KEY_STATUS.INVALID
  };
  configuration.saveInvalidConfiguration(this._storage, invalid);
  this._invalidateLifecycle();
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
    rateLimitedResponses: this._metrics.rateLimitedResponses,
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
  display: display,
  MessageQueue: MessageQueue
};
