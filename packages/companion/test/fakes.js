"use strict";

function FakePebble(autoAck) {
  this.autoAck = autoAck !== false;
  this.listeners = Object.create(null);
  this.sent = [];
  this.pending = [];
  this.inFlight = 0;
  this.maxInFlight = 0;
  this.openedUrls = [];
}

FakePebble.prototype.addEventListener = function (name, listener) {
  this.listeners[name] = listener;
};

FakePebble.prototype.removeEventListener = function (name, listener) {
  if (this.listeners[name] === listener) delete this.listeners[name];
};

FakePebble.prototype.emit = function (name, event) {
  if (this.listeners[name]) this.listeners[name](event || {});
};

FakePebble.prototype.openURL = function (url) {
  this.openedUrls.push(url);
};

FakePebble.prototype.sendAppMessage = function (message, success, failure) {
  var pending = { success: success, failure: failure };
  this.sent.push(message);
  this.pending.push(pending);
  this.inFlight += 1;
  this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
  if (this.autoAck) this.ack();
};

FakePebble.prototype.ack = function () {
  var pending = this.pending.shift();
  if (!pending) throw new Error("No pending AppMessage");
  this.inFlight -= 1;
  pending.success();
};

FakePebble.prototype.fail = function () {
  var pending = this.pending.shift();
  if (!pending) throw new Error("No pending AppMessage");
  this.inFlight -= 1;
  pending.failure({ error: "redacted fake failure" });
};

function createDefer(autoRun) {
  var callbacks = [];

  function defer(callback) {
    if (autoRun === true) {
      callback();
      return;
    }
    callbacks.push(callback);
  }

  defer.pending = callbacks;
  defer.runNext = function () {
    var callback = callbacks.shift();
    if (!callback) throw new Error("No deferred callback");
    callback();
  };
  return defer;
}

function FakeStorage() {
  this.values = Object.create(null);
  this.writes = [];
}

FakeStorage.prototype.getItem = function (key) {
  return Object.prototype.hasOwnProperty.call(this.values, key) ? this.values[key] : null;
};

FakeStorage.prototype.setItem = function (key, value) {
  this.values[key] = String(value);
  this.writes.push({ key: key, value: String(value) });
};

FakeStorage.prototype.removeItem = function (key) {
  delete this.values[key];
};

FakeStorage.prototype.keys = function () {
  return Object.keys(this.values);
};

function FakeClock(now) {
  this.time = typeof now === "number" ? now : 1788000000000;
  this.nextId = 1;
  this.timers = [];
  this.delays = [];
}

FakeClock.prototype.now = function () {
  return this.time;
};

FakeClock.prototype.setTimeout = function (callback, delay) {
  var id = this.nextId;
  this.nextId += 1;
  this.delays.push(delay);
  this.timers.push({ id: id, at: this.time + delay, callback: callback, cancelled: false });
  return id;
};

FakeClock.prototype.clearTimeout = function (id) {
  this.timers.forEach(function (timer) {
    if (timer.id === id) timer.cancelled = true;
  });
};

FakeClock.prototype.advance = function (milliseconds) {
  var target = this.time + milliseconds;
  var next;
  while (true) {
    next = null;
    this.timers.forEach(function (timer) {
      if (!timer.cancelled && timer.at <= target && (next === null || timer.at < next.at)) next = timer;
    });
    if (next === null) break;
    next.cancelled = true;
    this.time = next.at;
    next.callback();
  }
  this.time = target;
};

function createXHRFactory() {
  var factory = { instances: [] };

  function FakeXHR() {
    this.method = null;
    this.url = null;
    this.async = null;
    this.timeout = 0;
    this.headers = Object.create(null);
    this.body = null;
    this.status = 0;
    this.responseText = "";
    this.responseHeaders = Object.create(null);
    factory.instances.push(this);
  }

  FakeXHR.prototype.open = function (method, url, async) {
    this.method = method;
    this.url = url;
    this.async = async;
  };

  FakeXHR.prototype.setRequestHeader = function (name, value) {
    this.headers[name] = value;
  };

  FakeXHR.prototype.send = function (body) {
    this.body = body;
  };

  FakeXHR.prototype.getResponseHeader = function (name) {
    return Object.prototype.hasOwnProperty.call(this.responseHeaders, name) ? this.responseHeaders[name] : null;
  };

  FakeXHR.prototype.respond = function (status, body, headers) {
    this.status = status;
    this.responseText = typeof body === "string" ? body : JSON.stringify(body);
    this.responseHeaders = headers || Object.create(null);
    this.onload();
  };

  FakeXHR.prototype.networkError = function () {
    this.onerror();
  };

  factory.XHR = FakeXHR;
  return factory;
}

module.exports = {
  FakePebble: FakePebble,
  FakeStorage: FakeStorage,
  FakeClock: FakeClock,
  createDefer: createDefer,
  createXHRFactory: createXHRFactory
};
