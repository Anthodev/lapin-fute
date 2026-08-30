import test from "node:test";
import assert from "node:assert/strict";
import MessageQueue, { QUEUE_STATE } from "../src/embeddedjs/message-queue.js";

class FakeMessage {
  constructor() {
    this.writes = [];
    this.throwNext = false;
    this.closed = 0;
  }

  write(message) {
    if (this.throwNext) {
      this.throwNext = false;
      throw new Error("fake write failure");
    }
    this.writes.push(message);
  }

  close() {
    this.closed += 1;
  }
}

function payload(id) {
  return new Map([["REQUEST_ID", id]]);
}

test("queue starts suspended and consumes at most one write credit", () => {
  const message = new FakeMessage();
  const queue = new MessageQueue(message);
  queue.enqueue(payload("one"));
  queue.enqueue(payload("two"));
  assert.equal(message.writes.length, 0);

  assert.equal(queue.writable(), true);
  assert.equal(message.writes.length, 1);
  assert.equal(message.writes[0].get("REQUEST_ID"), "one");
  assert.equal(queue.items.length, 1);

  assert.equal(queue.writable(), true);
  assert.equal(message.writes.length, 2);
  assert.equal(message.writes[1].get("REQUEST_ID"), "two");
  assert.equal(queue.items.length, 0);
});

test("unused writable credit sends one future item and suspend revokes it", () => {
  const message = new FakeMessage();
  const queue = new MessageQueue(message);
  assert.equal(queue.writable(), false);
  queue.enqueue(payload("ready-later"));
  assert.equal(message.writes.length, 1);

  queue.writable();
  queue.suspend();
  queue.enqueue(payload("paused"));
  assert.equal(message.writes.length, 1);
  queue.writable();
  assert.equal(message.writes.length, 2);
  assert.equal(message.writes[1].get("REQUEST_ID"), "paused");
});

test("successful writes leave the queue immediately and are never replayed", () => {
  const message = new FakeMessage();
  const queue = new MessageQueue(message);
  const first = payload("at-most-once");
  queue.enqueue(first);
  queue.writable();
  assert.equal(queue.items.length, 0);
  queue.suspend();
  queue.writable();
  assert.deepEqual(message.writes, [first]);
});

test("capacity four overflow clears unsent work and reports one failure", () => {
  const message = new FakeMessage();
  const states = [];
  const queue = new MessageQueue(message, { onState: (state) => states.push(state) });
  for (let index = 0; index < 4; index += 1) queue.enqueue(payload(String(index)));
  assert.equal(queue.items.length, 4);
  assert.equal(queue.enqueue(payload("overflow")), false);
  assert.equal(queue.items.length, 0);
  assert.deepEqual(states.at(-1), {
    type: QUEUE_STATE.FAILED,
    reason: "QUEUE_OVERFLOW",
    generation: 1
  });
});

test("write throws clear every unsent item without retry", () => {
  const message = new FakeMessage();
  const states = [];
  const queue = new MessageQueue(message, { onState: (state) => states.push(state) });
  message.throwNext = true;
  queue.enqueue(payload("failed"));
  queue.enqueue(payload("also-cleared"));
  assert.equal(queue.writable(), false);
  assert.equal(message.writes.length, 0);
  assert.equal(queue.items.length, 0);
  assert.deepEqual(states.at(-1), {
    type: QUEUE_STATE.FAILED,
    reason: "MESSAGE_WRITE_FAILED",
    generation: 1
  });
});

test("clear revokes stale credit and close disposes the Message exactly once", () => {
  const message = new FakeMessage();
  const queue = new MessageQueue(message);
  queue.writable();
  queue.clear();
  queue.enqueue(payload("after-clear"));
  assert.equal(message.writes.length, 0);
  queue.close();
  queue.close();
  assert.equal(message.closed, 1);
  assert.equal(queue.enqueue(payload("closed")), false);
});
