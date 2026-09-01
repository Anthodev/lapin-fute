import { QUEUE_STATE } from "./message-queue.js";
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
      || !options.model
      || typeof options.model.snapshot !== "function"
      || !options.view
      || typeof options.view.render !== "function") {
    throw new TypeError("controller adapters are required");
  }

  const clock = options.clock;
  const queue = options.queue;
  const model = options.model;
  const storage = options.storage || null;
  const view = options.view;
  const receiver = new ProtocolReceiver();
  let committedConfiguration = null;
  let sequence = 0;
  let restoredRequestPending = false;
  let started = false;
  let closed = false;

  function render() {
    view.render(model.snapshot());
  }

  function nextRequestId() {
    sequence += 1;
    if (sequence > 1679615) sequence = 1;
    const seconds = Math.max(0, Math.floor(clock.now() / 1000));
    return "foundation-" + seconds.toString(36) + "-" + sequence.toString(36);
  }

  function requestFixture() {
    if (closed) return false;
    const request = model.beginFixtureRequest(nextRequestId());
    if (!request) return false;
    if (!receiver.expectResponse(request.requestId, request.favoriteId)
        || !queue.enqueue(encodeRequest(request))) {
      receiver.cancelExpectedResponse();
      model.markSendFailure();
      render();
      return false;
    }
    render();
    return true;
  }

  const controller = {
    start() {
      if (closed || started) return controller;
      started = true;
      const configuration = storage ? loadWatchConfiguration(storage) : null;
      if (configuration) {
        committedConfiguration = configuration;
        receiver.restoreConfiguration(configuration);
        model.commitProtocol(receiver.snapshot(), "CONFIG_RESTORED");
        restoredRequestPending = true;
        render();
      } else {
        render();
      }
      return controller;
    },

    onReadable(message) {
      if (closed) return RECEIVE_RESULT.REJECTED;
      const received = receiver.receive(message);
      const event = eventName(received);
      if (event === "CONFIG_COMMITTED") restoredRequestPending = false;
      if (event !== null) {
        let snapshot = receiver.snapshot();
        if (event === "CONFIG_COMMITTED" && storage) {
          if (!saveWatchConfiguration(storage, snapshot.configuration)) {
            receiver.restoreConfiguration(committedConfiguration);
            snapshot = receiver.snapshot();
            const effect = model.commitProtocol(snapshot, "CONFIG_COMMITTED");
            render();
            if (effect.requestFixture) requestFixture();
            return RECEIVE_RESULT.REJECTED;
          }
          committedConfiguration = snapshot.configuration;
        }
        const effect = model.commitProtocol(snapshot, event);
        render();
        if (effect.requestFixture) requestFixture();
      }
      return received;
    },

    onQueueState(state) {
      if (closed || !state) return;
      if (state.type === QUEUE_STATE.WRITABLE && restoredRequestPending) {
        restoredRequestPending = false;
        requestFixture();
        return;
      }
      if (state.type !== QUEUE_STATE.FAILED) return;
      receiver.cancelExpectedResponse();
      model.markSendFailure();
      render();
    },

    redraw() {
      if (!closed) render();
    },

    close() {
      if (closed) return;
      closed = true;
      receiver.cancelExpectedResponse();
      receiver.discardStaging();
      queue.close();
      if (typeof view.close === "function") view.close();
    }
  };

  return controller;
}
