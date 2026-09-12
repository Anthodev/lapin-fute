import test from "node:test";
import assert from "node:assert/strict";
import { nativeHost } from "./native-host.js";
import { watchModule } from "./xs-host.js";
import { NOW, appearances, departure, message, store, trafficDocument } from "./d2-records.js";

const { field } = await watchModule("packed");
let instance = 0;

async function entry(t, profile) {
  const host = nativeHost(t, profile, store());
  t.mock.method(Date, "now", () => NOW);
  await import(new URL(`../src/embeddedjs/main.js?entry=${++instance}`, import.meta.url).href);
  host.start();
  return host;
}

function answer(host, kind, records) {
  const request = host.outgoing.findLast((item) => item.get(1) === [9, 1, 10][kind]);
  const id = request.get(2), generation = request.get(41);
  const extra = { 11: records.length, 40: kind };
  if (kind) extra[3] = request.get(3);
  host.message.deliver(message(17, id, generation, extra));
  records.forEach((record, index) => host.message.deliver(message(18, id, generation,
    { 12: index, 38: record, 40: kind })));
  host.message.deliver(message(19, id, generation, { 40: kind }));
}

for (const profile of [0, 1]) {
  test(`production entry profile ${profile}: writable handshake, consultation and sole Back owner`, async (t) => {
    const host = await entry(t, profile);
    assert.equal(host.outgoing.length, 0, "opening Message is not writable readiness");
    host.message.writable();
    const hello = host.outgoing[0];
    assert.equal(hello.get(1), 20);
    assert.equal(hello.get(39), profile);
    const epoch = hello.get(45);
    const id = epoch + "c00000001";
    const records = appearances(2, "fav", { profile });
    host.message.deliver(message(2, id, 1, { 10: 1, 11: 2, 36: 0, 37: "fr", 39: profile }));
    records.forEach((record, index) => host.message.deliver(message(15, id, 1,
      { 3: field(record, 0), 12: index, 43: field(record, 1) })));
    host.message.writable();
    assert.equal(host.outgoing.at(-1).get(35), 3);
    records.forEach((record, index) => host.message.deliver(message(3, id, 1, { 12: index, 38: record })));
    host.message.deliver(message(4, id, 1));
    host.message.writable();
    assert.equal(host.outgoing.at(-1).get(1), 9);
    assert.equal(host.outgoing.at(-1).get(24), 0);
    answer(host, 0, [departure(), departure()]);
    host.press("select");
    host.message.writable();
    assert.equal(host.outgoing.at(-1).get(24), 5);
    answer(host, 1, [departure()]);
    host.press("select");
    host.message.writable();
    assert.equal(host.outgoing.at(-1).get(1), 10);
    answer(host, 2, trafficDocument());

    const state = host.application.first.behavior.state;
    const sent = host.outgoing.length;
    assert.equal(state.screen, 2);
    assert.equal(host.application.behavior.onPressBack(host.application), true);
    assert.equal(state.screen, 1);
    assert.equal(host.application.behavior.onPressBack(host.application), true);
    assert.equal(state.screen, 0);
    assert.equal(host.application.behavior.onPressBack(host.application), false);
    assert.equal(host.outgoing.length, sent);
    assert.equal(host.buttons.some((button) => button.options.types.includes("back")), false);
    host.listeners.get("minutechange")();
    assert.equal(host.outgoing.length, sent, "minute aging is local");

    // A full native outbox leaves exactly four queued responses. The fifth is
    // an explicit failure, not a fifth retained dictionary or retry timer.
    for (let index = 0; index < 5; index++) {
      host.message.deliver(new Map([[0, 2], [1, 21], [2, "pqueue" + index]]));
    }
    assert.equal(state.handshakeFailed, true);
    for (let index = 0; index < 5; index++) host.message.writable();
    assert.deepEqual(host.outgoing.slice(sent).map((item) => item.get(2)), ["pqueue0", "pqueue1", "pqueue2", "pqueue3"]);
    assert.equal(host.outgoing.filter((item) => item.get(1) === 9 && item.get(24) === 0).length, 1);
    assert.equal(host.timers.size, 0);
  });
}

test("production entry rejects an unknown profile before opening transport", async (t) => {
  const host = nativeHost(t, 0, store());
  host.screen.width = 201;
  await import(new URL(`../src/embeddedjs/main.js?entry=${++instance}`, import.meta.url).href);
  assert.throws(() => host.start(), /Unsupported display profile/u);
  assert.equal(host.message, null);
});
