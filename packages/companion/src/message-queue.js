"use strict";

function MessageQueue(Pebble, defer, onFailure) {
  if (!Pebble || typeof Pebble.sendAppMessage !== "function") {
    throw new TypeError("Pebble.sendAppMessage is required");
  }
  if (typeof defer !== "function") throw new TypeError("defer adapter is required");
  this._Pebble = Pebble;
  this._defer = defer;
  this._onFailure = typeof onFailure === "function" ? onFailure : function () {};
  this._batches = [];
  this._active = null;
  this._sending = false;
  this._completing = false;
  this._deferredGeneration = null;
  this._generation = 0;
  this._nextBatchId = 1;
}

MessageQueue.prototype.enqueue = function (messages, onComplete) {
  var batch;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError("A non-empty message sequence is required");
  }
  if (typeof onComplete !== "undefined" && typeof onComplete !== "function") {
    throw new TypeError("onComplete must be a function");
  }
  batch = {
    id: this._nextBatchId,
    messages: messages.slice(),
    onComplete: typeof onComplete === "function" ? onComplete : null
  };
  this._nextBatchId += 1;
  this._batches.push(batch);
  this._advance();
  return batch.id;
};

MessageQueue.prototype.replacePending = function (batchId, messages) {
  var index;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new TypeError("A non-empty message sequence is required");
  }
  for (index = 0; index < this._batches.length; index += 1) {
    if (this._batches[index].id !== batchId) continue;
    this._batches[index].messages = messages.slice();
    return true;
  }
  return false;
};

MessageQueue.prototype.clear = function () {
  this._generation += 1;
  this._batches = [];
  this._active = null;
  this._deferredGeneration = null;
};

MessageQueue.prototype.isSending = function () {
  return this._sending;
};

MessageQueue.prototype._scheduleAdvance = function (generation) {
  var self = this;
  if (this._deferredGeneration !== null) return;
  this._deferredGeneration = generation;
  try {
    this._defer(function () {
      if (self._deferredGeneration !== generation) return;
      self._deferredGeneration = null;
      if (generation !== self._generation) return;
      self._advance();
    });
  } catch (ignored) {
    this._deferredGeneration = null;
    this.clear();
    this._onFailure("APP_MESSAGE_FAILED");
  }
};

MessageQueue.prototype._advance = function () {
  var self = this;
  var completed;
  var message;
  var generation;
  if (this._sending || this._completing || this._deferredGeneration !== null) return;
  if (!this._active || this._active.messages.length === 0) {
    this._active = this._batches.shift() || null;
  }
  if (!this._active) return;

  message = this._active.messages[0];
  this._sending = true;
  generation = this._generation;
  try {
    this._Pebble.sendAppMessage(message, function () {
      self._sending = false;
      if (generation !== self._generation) {
        if (self._active !== null || self._batches.length > 0) {
          self._scheduleAdvance(self._generation);
        }
        return;
      }
      self._active.messages.shift();
      if (self._active.messages.length === 0) {
        completed = self._active;
        self._active = null;
        if (completed.onComplete !== null) {
          self._completing = true;
          try {
            completed.onComplete();
          } catch (ignored) {
            // Completion metadata must not change acknowledged transport state.
          }
          self._completing = false;
          if (generation !== self._generation) {
            if (self._active !== null || self._batches.length > 0) {
              self._scheduleAdvance(self._generation);
            }
            return;
          }
        }
      }
      if (self._active !== null || self._batches.length > 0) {
        self._scheduleAdvance(generation);
      }
    }, function () {
      self._sending = false;
      if (generation !== self._generation) {
        if (self._active !== null || self._batches.length > 0) {
          self._scheduleAdvance(self._generation);
        }
        return;
      }
      self.clear();
      self._onFailure("APP_MESSAGE_FAILED");
    });
  } catch (ignored) {
    self._sending = false;
    self.clear();
    self._onFailure("APP_MESSAGE_FAILED");
  }
};

module.exports = MessageQueue;
