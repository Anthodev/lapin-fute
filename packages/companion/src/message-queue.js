"use strict";

var CAPACITY = 4;

function MessageQueue(Pebble, defer, onFailure) {
  if (!Pebble || typeof Pebble.sendAppMessage !== "function" || typeof defer !== "function") {
    throw new TypeError("Pebble.sendAppMessage and defer adapters are required");
  }
  this._Pebble = Pebble;
  this._defer = defer;
  this._onFailure = typeof onFailure === "function" ? onFailure : function () {};
  this._jobs = [];
  this._active = null;
  this._flight = null;
  this._deferred = null;
  this._advancing = false;
  this._generation = 0;
  this._nextId = 1;
}

// A producer returns one dictionary per invocation, then null. Its entire
// transfer owns the FIFO until the final ACK and the following event turn.
MessageQueue.prototype.enqueue = function (next, onComplete, control) {
  if (typeof next !== "function" || onComplete !== undefined && typeof onComplete !== "function") {
    throw new TypeError("A message producer and optional completion callback are required");
  }
  if (this._jobs.length + (this._active ? 1 : 0) >= CAPACITY) return false;
  var job = { id: this._nextId++, next: next, complete: onComplete, control: control === true };
  this._jobs.push(job);
  this._advance();
  return job.id;
};

MessageQueue.prototype.replacePending = function (id, next) {
  if (typeof next !== "function") throw new TypeError("A message producer is required");
  for (var i = 0; i < this._jobs.length; i += 1) {
    if (this._jobs[i].id === id) { this._jobs[i].next = next; return true; }
  }
  return false;
};

MessageQueue.prototype.removePending = function (id) {
  for (var i = 0; i < this._jobs.length; i += 1) {
    if (this._jobs[i].id === id) { this._jobs.splice(i, 1); return true; }
  }
  return false;
};

MessageQueue.prototype.clear = function () {
  this._generation += 1;
  this._active = null;
  this._jobs = [];
  this._deferred = null;
  // Do not release _flight before its callback: clear cannot cancel a native
  // send, and a new generation must not put a second dictionary in flight.
};

MessageQueue.prototype.cancelApplication = function () {
  this._generation += 1;
  this._active = null;
  this._deferred = null;
  this._jobs = this._jobs.filter(function (job) { return job.control; });
};

MessageQueue.prototype.isSending = function () { return this._flight !== null; };

MessageQueue.prototype._scheduleAdvance = function () {
  var self = this;
  if (this._deferred !== null) return;
  var ticket = { generation: this._generation };
  this._deferred = ticket;
  try {
    this._defer(function () {
      if (self._deferred !== ticket || ticket.generation !== self._generation) return;
      self._deferred = null;
      self._advance();
    });
  } catch (error) {
    this.clear();
    this._onFailure("APP_MESSAGE_FAILED");
  }
};

MessageQueue.prototype._advance = function () {
  var self = this;
  if (this._flight || this._deferred || this._advancing) return;
  this._advancing = true;
  try {
    while (!this._flight && !this._deferred) {
      if (!this._active) this._active = this._jobs.shift() || null;
      if (!this._active) break;
      var job = this._active;
      var message;
      try { message = job.next(); }
      catch (error) {
        this.cancelApplication();
        this._onFailure("APP_MESSAGE_FAILED");
        continue;
      }
      if (message === null) {
        this._active = null;
        if (job.complete) job.complete();
        continue;
      }
      var flight = { generation: this._generation };
      this._flight = flight;
      this._send(message, flight);
    }
  } finally { this._advancing = false; }
};

MessageQueue.prototype._send = function (message, flight) {
  var self = this;
  function settled(success) {
    if (self._flight !== flight) return;
    self._flight = null;
    if (flight.generation !== self._generation) {
      self._scheduleAdvance();
      return;
    }
    if (!success) {
      // Only queued, unattempted SDK controls survive. Never retry the failed
      // job, including a failed SDK echo, and never retry application data.
      self.cancelApplication();
      self._onFailure("APP_MESSAGE_FAILED");
    }
    // Also defer when the FIFO is temporarily empty: reentrant enqueue from
    // another callback must not run in the ACK's event turn.
    self._scheduleAdvance();
  }
  try {
    this._Pebble.sendAppMessage(message, function () { settled(true); }, function () { settled(false); });
  } catch (error) { settled(false); }
};

module.exports = MessageQueue;
