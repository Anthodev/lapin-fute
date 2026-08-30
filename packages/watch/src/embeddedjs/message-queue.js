import { LIMITS } from "./contracts.js";

export const QUEUE_STATE = Object.freeze({
  WRITABLE: "writable",
  SUSPENDED: "suspended",
  CLEARED: "cleared",
  FAILED: "failed",
  CLOSED: "closed"
});

export class MessageQueue {
  constructor(message, options = {}) {
    if (!message || typeof message.write !== "function") {
      throw new TypeError("Message.write is required");
    }
    const capacity = options.capacity === undefined ? LIMITS.requestQueue : options.capacity;
    if (!Number.isInteger(capacity) || capacity !== LIMITS.requestQueue) {
      throw new RangeError("watch message queue capacity must be 4");
    }
    this.message = message;
    this.capacity = capacity;
    this.onState = typeof options.onState === "function" ? options.onState : function () {};
    this.items = [];
    this.credit = false;
    this.closed = false;
    this.generation = 0;
  }

  enqueue(message) {
    if (this.closed || !(message instanceof Map)) return false;
    if (this.items.length >= this.capacity) {
      this.fail("QUEUE_OVERFLOW");
      return false;
    }
    this.items.push(message);
    this.flushOne();
    return true;
  }

  writable() {
    if (this.closed) return false;
    this.credit = true;
    this.onState({ type: QUEUE_STATE.WRITABLE });
    return this.flushOne();
  }

  suspend() {
    if (this.closed) return;
    this.credit = false;
    this.onState({ type: QUEUE_STATE.SUSPENDED });
  }

  clear() {
    this.generation += 1;
    this.items.length = 0;
    this.credit = false;
    if (!this.closed) this.onState({ type: QUEUE_STATE.CLEARED, generation: this.generation });
  }

  close() {
    if (this.closed) return;
    this.items.length = 0;
    this.credit = false;
    this.closed = true;
    this.generation += 1;
    if (typeof this.message.close === "function") this.message.close();
    this.onState({ type: QUEUE_STATE.CLOSED, generation: this.generation });
  }

  flushOne() {
    if (this.closed || !this.credit || this.items.length === 0) return false;
    const pending = this.items[0];
    try {
      this.message.write(pending);
    } catch (ignored) {
      this.fail("MESSAGE_WRITE_FAILED");
      return false;
    }
    this.items.shift();
    this.credit = false;
    return true;
  }

  fail(reason) {
    this.generation += 1;
    this.items.length = 0;
    this.credit = false;
    this.onState({
      type: QUEUE_STATE.FAILED,
      reason,
      generation: this.generation
    });
  }
}

export default MessageQueue;
