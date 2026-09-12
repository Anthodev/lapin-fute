import test from "node:test";
import assert from "node:assert/strict";
import { watchModule } from "./xs-host.js";

const { field, hex } = await watchModule("packed");
const { load } = await watchModule("storage");
import {
  NOW, NOW_S, appearance, appearances, begin, configure, data, departure,
  finish, finishData, harness, inventory, latest, message,
  ready, readyDetail, replacements, startData, store, trafficDocument,
  trafficError, warmSix
} from "./d2-records.js";

test("traffic outcome union keeps prior documents on scoped errors", () => {
  for (const token of [1, 3, 4, 5, 6, 7]) {
    const h = harness();
    readyDetail(h);
    h.runtime.button("select");
    data(h, 2, trafficDocument({ palette: 1 }));
    h.runtime.button("back");
    const old = h.r.traffic, page = h.r.page;
    h.runtime.request(2);
    data(h, 2, trafficError(token));
    assert.equal(h.r.traffic, old, "final error never replaces committed traffic");
    assert.equal(h.r.page, page);
    assert.equal(hex(h.r.traffic, 1, 8), NOW_S);
    assert.equal(hex(h.r.traffic, 0, 1), 1);
    assert.equal(h.r.pending & 4, 0);
    assert.equal(h.r.errors[2], token);
    h.runtime.request(2);
    data(h, 2, trafficDocument({ palette: 3 }));
    assert.notEqual(h.r.traffic, old);
    assert.equal(hex(h.r.traffic, 0, 1), 3, "UNKNOWN is a successful observed outcome");
    assert.equal(h.r.errors[2], 0);
    assert.equal(h.r.failed & 4, 0);

    const empty = harness();
    readyDetail(empty);
    empty.runtime.button("select");
    data(empty, 2, trafficError(token));
    assert.equal(empty.r.traffic, null);
    assert.equal(empty.r.pending & 4, 0);
    assert.equal(empty.r.errors[2], token);
    assert(empty.r.failed & 4);
  }
});

test("credential errors survive data retention and outrank other loading", () => {
  for (const token of [1, 3]) {
    const h = harness();
    readyDetail(h);
    const old = h.r.detail;
    h.runtime.request(1, 2);
    data(h, 1, [departure({ exception: token, hasData: false })]);
    assert.equal(h.r.detail, old, "key failure retains packed detail");
    assert.equal((h.r.keyError >> 2) & 3, token === 1 ? 1 : 2);
    h.runtime.request(1, 2);
    data(h, 1, [departure({ exception: 2 })]);
    assert(h.r.pending & 2, "loading token keeps the request pending");
    h.runtime.button("select");
    assert(h.r.pending & 4);
    data(h, 2, trafficDocument({ palette: 0 }));
    assert.equal((h.r.keyError >> 4) & 3, 0, "traffic success cannot clear detail credential bits");
    h.runtime.button("back");
    assert.equal((h.r.keyError >> 2) & 3, token === 1 ? 1 : 2);
    h.runtime.request(0, 2);
    data(h, 0, [departure(), departure()]);
    assert.equal(h.r.keyError & 3, 0);
    assert.equal((h.r.keyError >> 2) & 3, token === 1 ? 1 : 2, "overview success cannot clear detail bits");
    h.runtime.request(1, 2);
    data(h, 1, [departure()]);
    assert.equal(h.r.keyError & 60, 0, "matching success clears the scoped failure");
  }
});

test("epoch guards publish only on complete validated commits", () => {
  const f4 = harness();
  configure(f4, appearances(2));
  configure(f4, appearances(2), { generation: 50 });
  const oldSync = f4.r.lastSync;

  // UINT32_MAX tentative reservation dies with malformed inventory.
  const bad = begin(f4, appearances(2), { generation: 0xffffffff });
  assert(f4.runtime.receive(message(15, bad.id, bad.generation, { 3: field(bad.records[0], 0), 12: 0, 43: field(bad.records[0], 1) })));
  assert(!f4.runtime.receive(message(15, bad.id, bad.generation, { 3: field(bad.records[0], 0), 12: 1, 43: field(bad.records[0], 1) })));
  assert.equal(f4.r.highest, 50);
  assert.equal(f4.r.lastSync, oldSync);
  configure(f4, appearances(2), { generation: 51 });

  // Pending-epoch BEGIN never publishes; duplicate inventory aborts the candidate.
  const oldEpoch = f4.r.epoch;
  assert(ready(f4, "prekey"));
  const pending = f4.r.pendingEpoch;
  const c = begin(f4, appearances(2), { epoch: pending, generation: 1 });
  assert.equal(f4.r.epoch, oldEpoch);
  assert.equal(f4.r.highest, 51);
  assert.equal(f4.r.activeEpoch, "");
  assert.equal(f4.r.pendingEpoch, pending);
  assert(!f4.runtime.receive(message(15, c.id, 1, { 3: field(c.records[0], 0), 12: 1, 43: field(c.records[0], 1) })));
  assert.equal(f4.r.highest, 51);
  assert.equal(f4.r.pendingEpoch, pending);
  assert(!f4.runtime.request(1, 5), "retired metadata cache navigation cannot automatically rekey");

  // Storage failure during DIFF commit preserves generation 51.
  const retry = begin(f4, appearances(2), { epoch: pending, generation: 1 });
  const mask = inventory(f4, retry);
  f4.store.fail("read", "D2m");
  assert(!finish(f4, retry, mask));
  assert.equal(f4.r.epoch, oldEpoch);
  assert.equal(load(f4.store, 0).generation, 51);

  // F4-S1 accepts any positive generation under the pending epoch, not only one.
  configure(f4, appearances(2), { epoch: pending, generation: 2 });
  assert.equal(f4.r.epoch, pending);
  assert.equal(f4.r.highest, 2);
  assert.equal(f4.r.pendingEpoch, "");
});

test("restored metadata rejects unsolicited old epochs and recovers via READY", () => {
  const seed = harness();
  configure(seed, appearances(2));
  configure(seed, appearances(2), { generation: 50 });
  const durable50 = [...seed.store.values];
  const restored = harness(store(durable50));
  assert.equal(restored.r.generation, 50);
  assert.equal(restored.r.records.length, 2);
  assert.equal(restored.r.activeEpoch, "");
  assert(!restored.runtime.receive(message(2, seed.r.epoch + "c00000033", 51,
    { 10: 1, 11: 0, 36: 0, 37: "fr", 39: 0 })));
  configure(restored, [], { epoch: restored.r.pendingEpoch, generation: 1, key: 0 });
  assert.equal(restored.r.records.length, 0);
  assert.equal(load(restored.store, 0).generation, 1);

  // Issuance read/write/readback failures expose no HELLO and keep metadata.
  for (const [op, n] of [["read", 1], ["write", 1], ["read", 2]]) {
    const broken = store(durable50);
    broken.fail(op, "D2e", n);
    const h = harness(broken);
    assert.equal(h.out.length, 0);
    assert.equal(h.r.handshakeFailed, true);
    assert.equal(h.r.generation, 50);
    assert.equal(h.r.records.length, 2);
    assert(ready(h, "precover"));
    assert(h.r.pendingEpoch > seed.r.epoch);
    assert.equal(h.out.length, 1);
  }

  // 60-bit exhaustion preserves the local display.
  const exhausted = store([...durable50.filter(([key]) => key !== "D2e"), ["D2e", "fffffffffffffff"]]);
  const noHello = harness(exhausted);
  assert.equal(noHello.out.length, 0);
  assert.equal(noHello.r.handshakeFailed, true);
  assert.equal(noHello.r.generation, 50);
  assert.equal(noHello.r.records.length, 2);
});

test("FULL clears metadata only after a durable marker and cannot restore interrupted data", () => {
  const h = warmSix(), next = replacements();
  const records = h.r.records, overview = h.r.overview, detail = h.r.detail, traffic = h.r.traffic;
  const watermark = h.store.getItem("D2e");
  const rejected = begin(h, next, { mode: 1 });
  for (let index = 0; index < next.length - 1; index++) {
    assert(h.runtime.receive(message(15, rejected.id, rejected.generation,
      { 3: field(next[index], 0), 12: index, 43: field(next[index], 1) })));
  }
  assert.equal(h.r.records, records);
  assert.equal(h.r.traffic, traffic);
  assert.equal(h.store.getItem("D2p"), null);
  h.store.fail("write", "D2p");
  assert(!h.runtime.receive(message(15, rejected.id, rejected.generation,
    { 3: field(next[5], 0), 12: 5, 43: field(next[5], 1) })));
  assert.equal(h.r.records, records);
  assert.equal(h.r.overview, overview);
  assert.equal(h.r.detail, detail);
  assert.equal(h.r.traffic, traffic);
  assert.deepEqual(load(h.store, 0).records, records);

  const admitted = begin(h, next, { mode: 1 });
  assert.equal(inventory(h, admitted), 63);
  assert.equal(h.r.records.length, 0);
  assert.equal(h.r.overview.length, 0);
  assert.equal(h.r.detail, null);
  assert.equal(h.r.traffic, null);
  assert.equal(h.r.screen, 0);
  assert.equal(h.r.key, 0);
  assert.equal(load(h.store, 0), null);
  assert.equal(h.store.getItem("D2e"), watermark);
  assert(h.runtime.receive(message(3, admitted.id, admitted.generation, { 12: 0, 38: next[0] })));
  h.runtime.suspend();
  assert.equal(load(h.store, 0), null);

  const reopened = harness(h.store);
  assert.equal(reopened.r.records.length, 0);
  assert(reopened.r.pendingEpoch > watermark);
  assert(configure(reopened, next, { mode: 1 }));
  assert.deepEqual(load(h.store, 0).records, next);
  assert.equal(h.store.getItem("D2p"), null);
  assert.equal(h.store.getItem("D2e"), reopened.r.epoch);
  assert.equal(reopened.out.filter((frame) => frame.get(1) === 9 && frame.get(24) === 0).length, 1);
});

test("obsolete work is cancelled without becoming the new favorite's failure", () => {
  const f6 = harness();
  readyDetail(f6);
  f6.runtime.request(1, 2);
  startData(f6, 1, [departure()]);
  f6.runtime.button("down");
  assert.equal(f6.r.candidate, null);
  assert.equal(f6.r.failed & 6, 0);
  assert.equal(f6.r.pending & 6, 0);
  assert.equal(f6.timers.size, 1, "the settled-selection timer arms for the new favorite");
  f6.runtime.button("select");
  const oldTrafficRequest = latest(f6, 2);
  assert(f6.r.pending & 4);
  f6.runtime.clockSetting(true);
  assert.equal(f6.r.pending & 4, 0);
  assert.equal(f6.r.failed & 4, 0);
  assert.equal(f6.r.requests[2], null);
  assert(!f6.runtime.receive(message(17, oldTrafficRequest.get(2), oldTrafficRequest.get(41),
    { 11: 1, 40: 2, 3: oldTrafficRequest.get(3) })));
  assert.equal(f6.timers.size, 0, "clock change cancels pre-BEGIN traffic expectations");
});

test("rapid detail navigation settles once on the final favorite after 500 ms", () => {
  const target = harness();
  const records = appearances(6);
  configure(target, records);
  data(target, 0, records.map(() => departure()));
  target.runtime.button("select");
  data(target, 1, [departure()]);
  const before = target.out.filter((message) => message.get(1) === 1).length;
  target.runtime.button("down");
  target.runtime.button("down");
  target.runtime.button("up");
  target.runtime.button("down");
  assert.equal(target.r.active, 2);
  assert.equal(target.timers.size, 1);
  assert.equal(target.out.filter((message) => message.get(1) === 1).length, before);
  const [timer] = target.timers.values();
  assert.equal(timer.delay, 500);
  target.timers.clear();
  timer.fn();
  const requests = target.out.filter((message) => message.get(1) === 1);
  assert.equal(requests.length, before + 1);
  assert.equal(requests.at(-1).get(3), field(records[2], 0));
  assert.equal(requests.at(-1).get(24), 1);
});

test("fifty refresh and rapid-navigation cycles keep durable and timer state bounded", () => {
  const target = harness();
  const records = appearances(6);
  configure(target, records);
  data(target, 0, records.map(() => departure()));
  target.runtime.button("select");
  data(target, 1, [departure()]);
  const durableKeys = [...target.store.values.keys()].sort();
  const committedRecords = target.r.records;
  for (let cycle = 0; cycle < 50; cycle++) {
    target.runtime.button("selectLong");
    data(target, 1, [departure()]);
    target.runtime.button(cycle % 2 ? "up" : "down");
    target.runtime.button(cycle % 2 ? "down" : "up");
    assert.equal(target.timers.size, 1);
    const [timer] = target.timers.values();
    target.timers.clear();
    timer.fn();
    data(target, 1, [departure()]);
    assert.equal(target.r.pending, 0);
    assert.equal(target.r.candidate, null);
  }
  assert.equal(target.r.records, committedRecords);
  assert.deepEqual([...target.store.values.keys()].sort(), durableKeys);
  assert.equal(target.timers.size, 0);
  assert.equal(target.r.requests.length, 3);
  assert.equal(target.r.requests.filter(Boolean).length, 2);
});

test("enqueue failures belong to the attempted request, never unrelated sync", () => {
  const f7 = harness();
  readyDetail(f7);
  const detail = f7.r.detail;
  f7.failSend(1);
  assert(!f7.runtime.request(1, 2));
  assert.equal(f7.r.detail, detail);
  assert.equal(f7.r.pending & 2, 0);
  const staged = begin(f7);
  const candidate = f7.r.candidate;
  f7.failSend(20);
  assert(!ready(f7, "pfail"));
  assert.equal(f7.r.candidate, candidate);
  assert.equal(f7.r.handshakeFailed, true);
  assert(finish(f7, staged, inventory(f7, staged)), "failed HELLO leaves configuration completable");
});

test("fresh traffic renders fresh despite missing or older departures", () => {
  for (const mode of ["missing", "old"]) {
    const h = harness();
    configure(h, appearances(2));
    const age = mode === "old" ? 120 : 0;
    data(h, 0, [departure({ fetchedAt: NOW_S - age }), departure({ fetchedAt: NOW_S - age })]);
    h.runtime.button("select");
    if (mode === "missing") configure(h, appearances(2, "new"));
    h.runtime.button("select");
    data(h, 2, trafficDocument({ palette: 0 }));
    assert.equal(h.r.trafficId, field(h.r.records[h.r.active], 0));
    assert.equal(hex(h.r.traffic, 1, 8), NOW_S);
    assert.equal(h.r.errors[2], 0);
  }
});

test("deleting the active traffic favorite falls back to the first detail", () => {
  const f9 = harness();
  readyDetail(f9);
  f9.runtime.button("down");
  f9.runtime.button("select");
  data(f9, 2, trafficDocument({ palette: 1 }));
  f9.runtime.button("down");
  const first = f9.r.records[0];
  configure(f9, [first]);
  assert.equal(field(f9.r.records[f9.r.active], 0), field(first, 0));
  assert.equal(f9.r.screen, 1);
  assert.equal(f9.r.page, 0);
  assert.equal(f9.r.traffic, null);
  const before = f9.out.length;
  f9.runtime.button("back");
  assert.equal(f9.r.screen, 0);
  assert.equal(f9.out.length, before, "Back stays local");
});

test("malformed cancellation needs full id, generation, kind and epoch", () => {
  const f10 = harness();
  readyDetail(f10);
  f10.runtime.request(1, 2);
  const incoming = startData(f10, 1, [departure()]);
  const activeCandidate = f10.r.candidate;
  const frames = [
    message(18, incoming.id, incoming.generation - 1, { 12: 0, 38: departure(), 40: 1, 99: 0 }),
    message(18, incoming.id, incoming.generation, { 12: 0, 38: departure(), 40: 2, 99: 0 }),
    message(18, "000000000000002" + incoming.id.slice(15), incoming.generation, { 12: 0, 38: departure(), 40: 1, 99: 0 })
  ];
  for (const frame of frames) {
    assert(!f10.runtime.receive(frame));
    assert.equal(f10.r.candidate, activeCandidate);
    assert(f10.r.pending & 2);
  }
  assert(finishData(f10, incoming));
  f10.runtime.request(1, 2);
  const matching = startData(f10, 1, [departure()]);
  assert(!f10.runtime.receive(message(18, matching.id, matching.generation,
    { 12: 0, 38: departure(), 40: 1, 99: 0 })));
  assert.equal(f10.r.candidate, null);
  assert.equal(f10.r.pending & 2, 0);
});

test("changed DIFF releases result owners only at the complete inventory boundary", () => {
  const h = warmSix();
  const swap = replacements();
  const oldMetadata = h.r.records, oldManifest = h.store.getItem("D2m");
  const oldOverview = h.r.overview, oldDetail = h.r.detail, oldTraffic = h.r.traffic;
  const lateTraffic = latest(h, 2);
  const candidate = begin(h, swap);
  for (let i = 0; i < 5; i++) {
    assert(h.runtime.receive(message(15, candidate.id, candidate.generation,
      { 3: field(swap[i], 0), 12: i, 43: field(swap[i], 1) })));
    assert.equal(h.r.records, oldMetadata);
    assert.equal(h.r.overview, oldOverview);
    assert.equal(h.r.detail, oldDetail);
    assert.equal(h.r.traffic, oldTraffic);
  }
  assert(h.runtime.receive(message(15, candidate.id, candidate.generation,
    { 3: field(swap[5], 0), 12: 5, 43: field(swap[5], 1) })));
  assert.equal(h.out.at(-1).get(1), 16);
  assert.equal(h.out.at(-1).get(35), 63);
  assert.equal(h.store.getItem("D2m"), oldManifest);
  assert.equal(h.r.records, oldMetadata);
  assert.deepEqual(h.r.overview, []);
  assert.deepEqual(h.r.overviewErrors, []);
  assert.equal(h.r.detail, null);
  assert.equal(h.r.detailId, "");
  assert.equal(h.r.traffic, null);
  assert.equal(h.r.trafficId, "");
  assert.equal(h.r.page, 0);
  assert.deepEqual(h.r.requests, [null, null, null]);
  assert.deepEqual(h.r.bindings, ["", "", ""]);
  assert.equal(h.r.pending, 0);
  assert.equal(h.r.failed, 0);

  const releaseOut = h.out.length, currentConfig = h.r.candidate;
  for (const [kind, trigger] of [[0, 2], [1, 1], [1, 2], [1, 5], [2, undefined]]) {
    assert.equal(h.runtime.request(kind, trigger), false);
  }
  assert(!h.runtime.receive(message(17, lateTraffic.get(2), lateTraffic.get(41),
    { 11: 1, 40: 2, 3: lateTraffic.get(3) })));
  h.runtime.button("back");
  h.runtime.button("down");
  h.runtime.button("selectLong");
  assert.equal(h.r.candidate, currentConfig);
  assert.equal(h.out.length, releaseOut);
  assert.equal(h.timers.size, 0);
  assert(finish(h, candidate, 63));
  assert.equal(h.r.screen, 1);
  assert.equal(h.r.active, 1);
  assert.deepEqual(h.out.slice(releaseOut)
    .filter((m) => [1, 9, 10].includes(m.get(1)))
    .map((m) => [m.get(1), m.get(24)]), [[9, 5], [1, 5]],
    "visible detail commit reacquires overview and detail cache-only, never traffic");
});

test("malformed guards, no-ops and reorders keep warm results", () => {
  const guard = warmSix();
  const swap = replacements();
  const guardMetadata = guard.r.records;
  const guardResults = [guard.r.overview, guard.r.detail, guard.r.traffic];
  const partial = begin(guard, swap);
  assert(!guard.runtime.receive(message(15, partial.id, partial.generation,
    { 3: field(swap[0], 0), 12: 1, 43: field(swap[0], 1) })));
  assert.equal(guard.r.records, guardMetadata);
  assert.deepEqual([guard.r.overview, guard.r.detail, guard.r.traffic], guardResults);

  const unchanged = warmSix();
  const records = appearances(6);
  const unchangedDetail = unchanged.r.detail, unchangedTraffic = unchanged.r.traffic;
  const unchangedPage = unchanged.r.page, unchangedRows = unchanged.r.overview.slice();
  const unchangedOut = unchanged.out.length;
  configure(unchanged, records);
  configure(unchanged, records.slice().reverse());
  assert.deepEqual(unchanged.r.overview, unchangedRows.slice().reverse());
  assert.equal(unchanged.r.detail, unchangedDetail);
  assert.equal(unchanged.r.traffic, unchangedTraffic);
  assert.equal(unchanged.r.page, unchangedPage);
  assert.equal(unchanged.out.slice(unchangedOut).filter((m) => [1, 9, 10].includes(m.get(1))).length, 0);

  const ordinary = harness();
  readyDetail(ordinary);
  const warmDetail = ordinary.r.detail;
  ordinary.runtime.request(1, 2);
  const normal = startData(ordinary, 1, [departure()]);
  assert.equal(ordinary.r.detail, warmDetail);
  assert(finishData(ordinary, normal));

  const settling = harness();
  readyDetail(settling);
  settling.runtime.button("down");
  assert.equal(settling.timers.size, 1);
  const settlingConfig = begin(settling, replacements(2));
  inventory(settling, settlingConfig);
  assert.equal(settling.timers.size, 0, "an existing settle timer is cancelled at release");
});

test("released DIFF aborts end the loader and keep manual recovery", () => {
  const swap = replacements();
  for (const failure of ["malformed-body", "need-enqueue", "persist", "suspend"]) {
    const h = warmSix();
    const metadata = h.r.records, manifest = h.store.getItem("D2m");
    const c = begin(h, swap);
    if (failure === "need-enqueue") {
      h.failSend(16);
      for (let i = 0; i < 6; i++) {
        assert.equal(h.runtime.receive(message(15, c.id, c.generation,
          { 3: field(swap[i], 0), 12: i, 43: field(swap[i], 1) })), i !== 5);
      }
    } else {
      inventory(h, c);
      if (failure === "malformed-body") {
        assert(!h.runtime.receive(message(3, c.id, c.generation, { 12: 0, 38: "bad" })));
      } else if (failure === "persist") {
        h.store.fail("write", "D2m");
        assert(!finish(h, c, 63));
      } else {
        h.runtime.suspend();
      }
    }
    assert.equal(h.r.candidate, null);
    assert.deepEqual(h.r.overview, []);
    assert.equal(h.r.detail, null);
    assert.equal(h.r.traffic, null);
    assert.equal(h.r.records, metadata, "old metadata survives the abort");
    assert.equal(h.store.getItem("D2m"), manifest);
    const outBeforeRecovery = h.out.length;
    h.runtime.minute();
    assert.equal(h.out.length, outBeforeRecovery, "no automatic recovery after abort");
    h.runtime.button("back");
    h.runtime.button("back");
    h.runtime.button("select");
    assert.equal(h.r.screen, 0);
    assert.equal(h.out.at(-1).get(1), 9);
    assert.equal(h.out.at(-1).get(24), 2, "existing overview Select retries manually");
  }
});

test("explicit manual retry rekeys after an aborted released sync", () => {
  const h = warmSix();
  const swap = replacements();
  assert(ready(h));
  const failedEpoch = h.r.pendingEpoch;
  const c = begin(h, swap, { epoch: failedEpoch, generation: 1 });
  inventory(h, c);
  h.store.fail("write", "D2m");
  assert(!finish(h, c, 63));
  assert.equal(h.r.activeEpoch, "");
  assert.equal(h.r.syncError, 7);

  // Cache-only navigation never rekeys.
  const before = h.out.length;
  assert(!h.runtime.request(0, 5));
  assert(!h.runtime.request(1, 5));
  assert.equal(h.out.length, before);
  assert.equal(h.r.pendingEpoch, failedEpoch);

  // Explicit manual overview retries with one durable fresh epoch.
  h.runtime.button("back");
  h.runtime.button("back");
  h.runtime.button("select");
  assert(h.r.pendingEpoch > failedEpoch);
  assert.equal(h.out.at(-1).get(1), 20);
  assert.equal(h.out.at(-1).get(45), h.r.pendingEpoch);

  // A validated in-progress candidate is protected from manual requests.
  const protectedCandidate = warmSix();
  const config = begin(protectedCandidate, swap);
  inventory(protectedCandidate, config);
  const protectedEpoch = protectedCandidate.r.pendingEpoch;
  const protectedOut = protectedCandidate.out.length;
  assert.equal(protectedCandidate.r.candidate.id, config.id);
  assert.equal(protectedCandidate.r.pendingEpoch, protectedEpoch);
  assert.equal(protectedCandidate.runtime.request(0, 2), false);
  assert.equal(protectedCandidate.out.length, protectedOut);
});

test("changed-DIFF recovery respects the final request ids without automatic rekeys", () => {
  for (const sequence of [0xffffffff, 0xfffffffe]) {
    const h = warmSix();
    h.runtime.button("back");
    h.r.sequence = sequence;
    const epoch = h.r.epoch, before = h.out.length;
    assert(configure(h, replacements()));
    const frames = h.out.slice(before);
    const requests = frames.filter((frame) => [9, 1, 10].includes(frame.get(1)));
    assert.equal(frames.filter((frame) => frame.get(1) === 20).length, 0, "automatic recovery never rekeys");
    assert.equal(h.r.epoch, epoch);
    assert.equal(h.r.pendingEpoch, "");
    assert.equal(h.r.intent, null);
    if (sequence === 0xffffffff) {
      assert.deepEqual(requests, []);
      assert.equal(h.r.errors[0], 7);
      assert.equal(h.r.errors[1], 0, "detail is not attempted after a failed automatic overview");
    } else {
      assert.deepEqual(requests.map((frame) => [frame.get(1), frame.get(24), frame.get(2)]),
        [[9, 5, epoch + "rffffffff"]]);
      assert.equal(h.r.errors[1], 7);
      data(h, 0, h.r.records.map(() => departure()));
      assert.equal(h.r.pending, 0);
    }

    const manual = h.out.length;
    assert(!h.runtime.request(1, 2));
    assert.equal(h.out.length, manual + 1);
    assert.equal(h.out.at(-1).get(1), 20);
    assert(h.r.pendingEpoch > epoch);
  }
});

test("unrelated failed overview enqueue keeps a relevant manual detail intent", () => {
  const h = warmSix();
  h.runtime.button("back");
  h.r.sequence = 0xffffffff;
  assert(!h.runtime.request(1, 2));
  assert(ready(h));
  const swap = replacements(2);
  const c = begin(h, swap, { epoch: h.r.pendingEpoch, generation: 1 });
  const mask = inventory(h, c);
  h.failSend(9);
  assert(finish(h, c, mask));
  assert.equal(h.out.at(-1).get(1), 1, "the manual detail intent is sent after commit");
  assert.equal(h.out.at(-1).get(24), 2);
  assert.equal(h.r.errors[0], 7, "the unrelated automatic overview failure stays scoped");
  data(h, 1, [departure()]);
  assert.equal(h.r.keyError & 12, 0);
});

test("inventory entries release exactly when last used", () => {
  const sparse = warmSix();
  sparse.runtime.button("back");
  for (let i = 0; i < 4; i++) sparse.runtime.button("down");
  const records = appearances(6);
  const swap = replacements();
  const sparseRecords = records.map((record, i) => (i === 1 || i === 4 ? swap[i] : record));
  const c = begin(sparse, sparseRecords);
  assert.equal(inventory(sparse, c), 18);
  for (const i of [0, 2, 3, 5]) {
    assert(!sparse.r.candidate.ids[i]);
    assert(!sparse.r.candidate.hashes[i]);
  }
  assert.equal(sparse.r.candidate.ids[1], field(swap[1], 0));
  assert.equal(sparse.r.candidate.hashes[4], field(swap[4], 1));
  assert(sparse.runtime.receive(message(3, c.id, c.generation, { 12: 1, 38: swap[1] })));
  assert(!sparse.r.candidate.ids[1]);
  assert(!sparse.r.candidate.hashes[1]);
  assert.equal(sparse.r.candidate.ids[4], field(swap[4], 0));
  assert(sparse.runtime.receive(message(3, c.id, c.generation, { 12: 4, 38: swap[4] })));
  assert(!sparse.r.candidate.ids, "final required body releases both arrays before commit");
  assert(!sparse.r.candidate.hashes);
  assert(sparse.runtime.receive(message(4, c.id, c.generation)));
  assert.equal(sparse.r.active, 4);
  assert.equal(sparse.r.records[4], swap[4]);
  assert.deepEqual(load(sparse.store, 0).records, sparseRecords);
});

test("zero-need commits release inventory arrays and preserve identity", () => {
  const h = warmSix();
  const records = appearances(6);
  for (const next of [records, records.slice().reverse(), []]) {
    const c = begin(h, next);
    assert.equal(inventory(h, c), 0);
    assert(!h.r.candidate.ids);
    assert(!h.r.candidate.hashes);
    assert(h.runtime.receive(message(4, c.id, c.generation)));
    assert.deepEqual(h.r.records, next);
  }
  assert.equal(h.r.records.length, 0);
  assert.equal(h.r.screen, 0);
});

test("inventory body guards reject duplicate, late and unrequested bodies", () => {
  const swap = replacements();
  for (const attack of ["duplicate-needed", "out-of-order-needed", "wrong-hash-needed",
    "late-body", "late-entry", "unsolicited-unchanged-body", "body-after-commit"]) {
    const h = warmSix();
    const metadata = h.r.records;
    const c = begin(h, attack === "unsolicited-unchanged-body" ? appearances(6) : swap);
    inventory(h, c);
    let invalid;
    if (attack === "unsolicited-unchanged-body") {
      invalid = message(3, c.id, c.generation, { 12: 0, 38: appearances(1)[0] });
    } else {
      assert(h.runtime.receive(message(3, c.id, c.generation, { 12: 0, 38: swap[0] })));
      if (attack === "duplicate-needed") {
        invalid = message(3, c.id, c.generation, { 12: 0, 38: swap[0] });
      } else if (attack === "out-of-order-needed") {
        invalid = message(3, c.id, c.generation, { 12: 2, 38: swap[2] });
      } else if (attack === "wrong-hash-needed") {
        invalid = message(3, c.id, c.generation, { 12: 1, 38: appearances(2)[1] });
      } else {
        for (let i = 1; i < 6; i++) {
          assert(h.runtime.receive(message(3, c.id, c.generation, { 12: i, 38: swap[i] })));
        }
        assert(!h.r.candidate.ids);
        assert(!h.r.candidate.hashes);
        if (attack === "body-after-commit") assert(h.runtime.receive(message(4, c.id, c.generation)));
        invalid = attack === "late-entry"
          ? message(15, c.id, c.generation, { 3: field(swap[0], 0), 12: 0, 43: field(swap[0], 1) })
          : message(3, c.id, c.generation, { 12: 5, 38: swap[5] });
      }
    }
    assert(!h.runtime.receive(invalid), attack);
    assert.equal(h.r.candidate, null, attack);
    if (attack === "body-after-commit") {
      assert.deepEqual(h.r.records, swap);
    } else {
      assert.equal(h.r.records, metadata, attack);
      assert.deepEqual(load(h.store, 0).records, appearances(6), attack);
    }
  }
});

test("wire validation rejects malformed frames before any state changes", () => {
  const h = harness();
  const baseline = h.out.length;
  assert(!h.runtime.receive(new Map([[0, 1], [1, 20], [2, "p000000000000001"]])), "schema version one is not D2");
  assert(!h.runtime.receive(new Map([[0, 2], [1, 99]])), "unknown message types reject");
  assert(!h.runtime.receive(new Map([[0, 2], [1, 21], [2, "too-short"]])), "malformed p-tokens reject");
  assert(!h.runtime.receive(new Map([[0, 2], [1, 21], [2, "x00000000000001"]])), "non p-prefix tokens reject");
  assert(!h.runtime.receive(message(2, "000000000000001c0000000g", 1,
    { 10: 1, 11: 0, 36: 0, 37: "fr", 39: 0 })), "non-hex request ids reject");
  assert(!h.runtime.receive(message(2, "000000000000001c00000001", 2,
    { 10: 1, 11: 0, 36: 0, 37: "fr", 39: 0 })), "id generation must match the generation field");
  assert(!h.runtime.receive(message(2, "000000000000001r00000001", 1,
    { 10: 1, 11: 0, 36: 0, 37: "fr", 39: 0 })), "config begin needs a c-kind id");
  assert.equal(h.out.length, baseline);
});
