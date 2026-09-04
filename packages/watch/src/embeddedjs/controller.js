import { QUEUE_STATE } from "./message-queue.js";
import { LIMITS, REQUEST_TRIGGER } from "./contracts.js";
import { ProtocolReceiver, RECEIVE_RESULT, encodeRequest } from "./protocol.js";
import { loadWatchConfiguration, saveWatchConfiguration } from "./storage.js";

function eventName(received) {
  if (received === RECEIVE_RESULT.CONFIG_COMMITTED) return "CONFIG_COMMITTED";
  if (received === RECEIVE_RESULT.RESULT_COMMITTED) return "RESULT_COMMITTED";
  if (received === RECEIVE_RESULT.ERROR_COMMITTED) return "ERROR_COMMITTED";
  return null;
}

export function createController(options) {
  if (!options
      || !options.clock
      || typeof options.clock.now !== "function"
      || !options.queue
      || typeof options.queue.enqueue !== "function"
      || !options.scheduler
      || typeof options.scheduler.set !== "function"
      || typeof options.scheduler.clear !== "function"
      || !options.model
      || typeof options.model.snapshot !== "function"
      || !options.view
      || typeof options.view.render !== "function") {
    throw new TypeError("controller adapters are required");
  }

  const clock = options.clock;
  const queue = options.queue;
  const scheduler = options.scheduler;
  const model = options.model;
  const storage = options.storage || null;
  const view = options.view;
  const receiver = new ProtocolReceiver();
  const requestPrefix = "consult-"
    + Math.max(0, Math.floor(clock.now() / 1000)).toString(36)
    + "-";
  let committedProtocolState = null;
  let sequence = 0;
  let selectionGeneration = 0;
  let selectionTimer = null;
  let transportFailureGeneration = 0;
  let configurationGeneration = 0;
  let configurationTimer = null;
  let appOpenRequested = false;
  let started = false;
  let closed = false;
  let active = true;

  function render() {
    const snapshot = model.snapshot(clock.now(), false);
    view.render(snapshot);
    return snapshot;
  }

  function invalidateSelectionTimer() {
    selectionGeneration += 1;
    if (selectionTimer !== null) scheduler.clear(selectionTimer);
    selectionTimer = null;
  }

  function invalidateConfigurationTimer() {
    configurationGeneration += 1;
    if (configurationTimer !== null) scheduler.clear(configurationTimer);
    configurationTimer = null;
  }

  function failRequest() {
    receiver.cancelExpectedResponse();
    model.cancelRequest();
    model.markSendFailure();
    render();
  }

  function requestActiveFavorite(trigger) {
    if (closed) return false;
    sequence += 1;
    const request = model.beginRequest(requestPrefix + sequence, trigger);
    if (!request) {
      sequence -= 1;
      return false;
    }
    if (trigger === REQUEST_TRIGGER.APP_OPEN) appOpenRequested = true;

    if (!receiver.expectResponse(
      request.requestId,
      request.favoriteId,
      requestPrefix,
      sequence
    )) {
      failRequest();
      return false;
    }

    const failureGeneration = transportFailureGeneration;
    const enqueued = queue.enqueue(encodeRequest(request));
    if (transportFailureGeneration !== failureGeneration) return false;
    if (!enqueued) {
      failRequest();
      return false;
    }
    render();
    return true;
  }

  function armSelectionRequest(favoriteId) {
    invalidateSelectionTimer();
    const generation = selectionGeneration;
    selectionTimer = scheduler.set(function () {
      if (generation !== selectionGeneration) return;
      selectionTimer = null;
      selectionGeneration += 1;
      if (closed || !active) return;
      const favorite = model.snapshot(clock.now()).activeFavorite;
      if (!favorite || favorite.id !== favoriteId) return;
      requestActiveFavorite(REQUEST_TRIGGER.FAVORITE_SELECTION);
    }, LIMITS.favoriteSettleMs);
  }

  function applyConfiguration(snapshot) {
    if (storage && !saveWatchConfiguration(storage, snapshot.configuration)) {
      receiver.restoreState(committedProtocolState, false);
      model.commitProtocol(receiver.borrowState(), "CONFIG_COMMITTED");
      render();
      return false;
    }
    model.commitProtocol(snapshot, "CONFIG_COMMITTED");
    committedProtocolState = snapshot;
    render();
    if (!appOpenRequested) requestActiveFavorite(REQUEST_TRIGGER.APP_OPEN);
    return true;
  }

  function deferConfiguration(snapshot) {
    invalidateConfigurationTimer();
    const generation = configurationGeneration;
    configurationTimer = scheduler.set(function () {
      if (closed || generation !== configurationGeneration) return;
      configurationTimer = null;
      configurationGeneration += 1;
      applyConfiguration(snapshot);
    }, 0);
  }

  const controller = {
    start() {
      if (closed || started) return controller;
      started = true;
      const configuration = storage ? loadWatchConfiguration(storage) : null;
      if (configuration) {
        receiver.restoreConfiguration(configuration, false);
        committedProtocolState = receiver.borrowState();
        model.commitProtocol(committedProtocolState, "CONFIG_RESTORED");
      }
      render();
      return controller;
    },

    onReadable(message) {
      if (closed) return RECEIVE_RESULT.REJECTED;
      const received = receiver.receive(message);
      if (received === RECEIVE_RESULT.STAGED
          && receiver.configStage
          && receiver.configStage.favorites.length === 0
          && storage
          && typeof view.releasePresentation === "function") {
        view.releasePresentation();
      }
      const event = eventName(received);
      if (event === null) return received;

      const snapshot = receiver.borrowState();
      if (event === "CONFIG_COMMITTED") {
        if (storage) deferConfiguration(snapshot);
        else applyConfiguration(snapshot);
        return received;
      }

      model.commitProtocol(snapshot, event);
      committedProtocolState = snapshot;
      render();
      return received;
    },

    onQueueState(state) {
      if (closed || !state || state.type !== QUEUE_STATE.FAILED) return;
      transportFailureGeneration += 1;
      failRequest();
    },

    onButton(type) {
      if (closed || !active) return;
      if (type === "select") {
        invalidateSelectionTimer();
        requestActiveFavorite(REQUEST_TRIGGER.MANUAL_SELECT);
        return;
      }

      const delta = type === "up" ? -1 : type === "down" ? 1 : 0;
      if (delta === 0 || !model.moveSelection(delta)) return;
      receiver.cancelExpectedResponse();
      model.cancelRequest();
      const snapshot = render();
      if (snapshot.activeFavorite) armSelectionRequest(snapshot.activeFavorite.id);
    },

    onMinuteChange() {
      if (!closed && active) render();
    },

    setActive(nextActive) {
      if (closed) return;
      active = nextActive === true;
      if (!active) invalidateSelectionTimer();
    },

    redraw() {
      if (!closed) render();
    },

    close() {
      if (closed) return;
      closed = true;
      invalidateSelectionTimer();
      invalidateConfigurationTimer();
      receiver.cancelExpectedResponse();
      model.cancelRequest();
      receiver.discardStaging();
      queue.close();
      if (typeof view.close === "function") view.close();
    }
  };

  return controller;
}
