"use strict";

var contracts = require("./contracts");
var codec = require("./codec");
var layout = require("./display-layout");
var display = require("./display");

function createConfigurationSync(options) {
  var queue = options.queue;
  var onSynchronized = options.onSynchronized;
  if (!queue || typeof queue.enqueue !== "function" || typeof onSynchronized !== "function") {
    throw new TypeError("Configuration synchronization adapters are required");
  }
  var phoneToken = "";
  var session = "";
  var epoch = "";
  var lastEpoch = "";
  var profile = -1;
  var clock12 = 0;
  var sequence = 0;
  var active = null;
  var committed = null;
  var previous = null;

  function binding() {
    return { epoch: epoch, session: session, profile: profile, clock12: clock12 };
  }

  function ready() {
    phoneToken = "p" + Date.now().toString(36) + Math.floor(Math.random() * 0xffffffff).toString(36);
    return queue.enqueue(codec.one(codec.encodeReady(phoneToken)));
  }

  function matches(target, request) {
    return target !== null && target.epoch === request.requestId.slice(0, 15)
      && target.generation === request.wireGeneration;
  }

  function resolveDataBinding(request) {
    if (matches(committed, request)) return committed;
    if (matches(previous, request)) return previous;
    return null;
  }

  function pendingDataBinding(request) {
    return active !== null && active.phase === "COMMITTING" && matches(active, request);
  }

  function hello(message) {
    var decoded = codec.decodeHello(message);
    if (decoded === null) return { consumed: false, changed: false };
    if (decoded.token !== decoded.session && decoded.token !== phoneToken) {
      return { consumed: true, changed: false };
    }
    if (lastEpoch && (decoded.epoch < lastEpoch || !epoch && decoded.epoch === lastEpoch)) {
      return { consumed: true, changed: false };
    }
    if (epoch && decoded.session === session && decoded.profile === profile && decoded.clock12 === clock12
        && (decoded.token !== decoded.session || decoded.epoch === epoch)) {
      return { consumed: true, changed: false };
    }
    // Same epoch belongs to one watch session. A different session must issue
    // its own durable epoch rather than resetting our generation counter.
    if (epoch === decoded.epoch && session && session !== decoded.session) {
      return { consumed: true, changed: false };
    }
    if (epoch !== decoded.epoch) {
      sequence = 0;
      committed = null;
      previous = null;
    }
    active = null;
    epoch = decoded.epoch;
    lastEpoch = epoch;
    session = decoded.session;
    profile = decoded.profile;
    clock12 = decoded.clock12;
    return { consumed: true, changed: true };
  }

  function synchronize(target, forceFull) {
    if (!epoch) return null;
    if (!contracts.isPhoneFavoriteList(target.favorites) || target.records.length !== target.favorites.length) {
      throw new TypeError("Invalid display configuration target");
    }
    if (sequence === 0xffffffff) {
      epoch = "";
      active = null;
      committed = null;
      previous = null;
      queue.cancelApplication();
      ready();
      return null;
    }
    if (active) queue.cancelApplication();
    var generation = ++sequence;
    var current = {
      requestId: epoch + "c" + layout.fixed(generation, 8), epoch: epoch, generation: generation,
      mode: forceFull ? contracts.CONFIG_MODE.FULL : contracts.CONFIG_MODE.DIFF,
      keyStatus: target.keyStatus, language: target.language, profile: profile, clock12: clock12,
      lifecycleGeneration: target.lifecycleGeneration,
      favorites: target.favorites.map(contracts.copyPhoneFavorite), records: target.records,
      phase: "NEED"
    };
    active = current;
    var index = -1;
    var accepted = queue.enqueue(function () {
      if (active !== current) return null;
      if (index === -1) {
        index = 0;
        return codec.encodeConfigurationStart({
          requestId: current.requestId, generation: generation, mode: current.mode,
          keyStatus: current.keyStatus, language: current.language, profile: current.profile,
          itemCount: current.favorites.length
        });
      }
      // FULL uses the same complete inventory guard before its destructive
      // seam; omitting it would leave a nonempty watch waiting forever.
      if (index < current.favorites.length) {
        var entryIndex = index++;
        return codec.encodeConfigurationEntry({
          requestId: current.requestId, generation: generation, index: entryIndex,
          favoriteId: current.favorites[entryIndex].id,
          hash: display.recordField(current.records[entryIndex], 1)
        });
      }
      return null;
    });
    if (accepted === false) { active = null; return null; }
    return current.requestId;
  }

  function receive(message) {
    var need = codec.decodeNeed(message);
    if (need === null) return false;
    var current = active;
    if (!current || need.requestId !== current.requestId || need.generation !== current.generation
        || current.phase !== "NEED") return true;
    if (need.profile !== current.profile || need.clock12 !== current.clock12) {
      active = null;
      return true;
    }
    var all = (1 << current.favorites.length) - 1;
    if (need.needMask > all || current.mode === contracts.CONFIG_MODE.FULL && need.needMask !== all) return true;
    current.phase = "BODY";
    if (current.mode === contracts.CONFIG_MODE.FULL) {
      // NEED confirms the watch crossed the guarded durable FULL seam.
      committed = null;
      previous = null;
    }
    var index = 0;
    var commitSent = false;
    var accepted = queue.enqueue(function () {
      if (active !== current) return null;
      while (index < current.records.length && !(need.needMask & (1 << index))) index += 1;
      if (index < current.records.length) {
        var bodyIndex = index++;
        return codec.encodeFavoriteBody({
          requestId: current.requestId, generation: current.generation,
          index: bodyIndex, record: current.records[bodyIndex]
        });
      }
      if (!commitSent) {
        commitSent = true;
        current.phase = "COMMITTING";
        return codec.encodeConfigurationCommit(current);
      }
      return null;
    }, function () {
      if (active !== current) return;
      previous = committed;
      committed = current;
      current.phase = "COMPLETE";
      // Prepared appearance strings are only needed while sending metadata.
      current.records = null;
      active = null;
      onSynchronized(current);
    });
    if (accepted === false) active = null;
    return true;
  }

  function discardTransaction() { active = null; }

  function clear() {
    queue.clear();
    phoneToken = "";
    session = "";
    epoch = "";
    profile = -1;
    sequence = 0;
    active = null;
    committed = null;
    previous = null;
    // Keep the last observed epoch floor across stop/start on this instance.
  }

  return {
    binding: binding, ready: ready, hello: hello, synchronize: synchronize, receive: receive,
    resolveDataBinding: resolveDataBinding, pendingDataBinding: pendingDataBinding,
    discardTransaction: discardTransaction, clear: clear
  };
}

module.exports = { createConfigurationSync: createConfigurationSync };
