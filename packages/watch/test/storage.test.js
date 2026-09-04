import test from "node:test";
import assert from "node:assert/strict";
import { watchModule } from "./xs-host.js";

const { load, persist, markPending, createEpochAllocator } = await watchModule("storage");
const { epochValid, nextEpoch, messageIdValid } = await watchModule("packed");
import { appearances, fixed, store } from "./d2-records.js";

const records = appearances(6);
const EPOCH = "000000000000001";

function manifest(epoch, profile, language, key, generation, count, slots) {
  return "D2E" + epoch + profile + language + key + fixed(generation, 8) + count
    + slots.map((slot) => fixed(slot, 1)).join("");
}

test("epoch allocation is durable, monotonic and fails closed", () => {
  const values = store();
  const allocate = createEpochAllocator(values);
  assert.equal(allocate(), "000000000000001");
  const candidate = { epoch: EPOCH, generation: 50, records, language: "fr", key: 1, mode: 0 };
  persist(values, candidate, [], [], 0);
  assert.equal(load(values, 0).records.length, 6);

  // 60-bit exact carry, including values above 2^53.
  for (const [start, expected] of [
    ["0000000ffffffff", "000000100000000"],
    ["01fffffffffffff", "020000000000000"],
    ["fffffff00000000", "fffffff00000001"],
    ["ffffffffffffffe", "fffffffffffffff"]
  ]) {
    assert.equal(nextEpoch(start), expected);
    const boundary = store([["D2e", start]]);
    assert.equal(createEpochAllocator(boundary)(), expected);
    assert.equal(boundary.values.get("D2e"), expected);
  }
  assert.equal(nextEpoch("fffffffffffffff"), null);

  // Namespace exhaustion preserves the display and performs no writes.
  const exhausted = store([["D2e", "fffffffffffffff"], ...[...values.values].filter(([key]) => key !== "D2e")]);
  assert.equal(createEpochAllocator(exhausted)(), null);
  assert.equal(load(exhausted, 0).generation, 50);

  // Uncertain issuance attempts are never reused.
  for (const [op, n] of [["read", 1], ["write", 1], ["read", 2]]) {
    const broken = store([...values.values]);
    const issue = createEpochAllocator(broken);
    broken.fail(op, "D2e", n);
    assert.equal(issue(), null);
    assert.equal(load(broken, 0).generation, 50);
    assert.equal(issue(), op === "read" && n === 1 ? "000000000000002" : "000000000000003");
  }

  // Missing watermark with epoch-aware evidence cannot initialize zero.
  const corrupt = store([...values.values].filter(([key]) => key !== "D2e"));
  assert.equal(createEpochAllocator(corrupt)(), null);
  for (const evidence of [["D2m", "D2E"], ["D2p", "E"]]) {
    const truncated = store([evidence]);
    assert.equal(createEpochAllocator(truncated)(), null);
  }

  // The allocator survives FULL marker cleanup.
  assert(markPending(values, EPOCH, 51));
  assert.equal(load(values, 0), null);
  assert.equal(values.values.get("D2e"), EPOCH);
  assert.equal(createEpochAllocator(values)(), "000000000000002");
  assert(persist(values, { ...candidate, generation: 51, mode: 1 }, [], [], 0));
  assert.equal(load(values, 0).epoch, EPOCH);
  assert.equal(values.values.get("D2e"), "000000000000002");
});

test("DIFF persistence faults preserve the committed configuration", () => {
  const values = store();
  const candidate = { epoch: EPOCH, generation: 50, records, language: "fr", key: 1, mode: 0 };
  const replacement = appearances(6, "new");
  const slots = persist(values, candidate, [], [], 0);
  const before = [...values.values];

  values.fail("read", "D2m");
  assert.equal(persist(values, { ...candidate, generation: 51, records: replacement }, slots, records, 0), null);
  assert.deepEqual([...values.values], before);
  assert.equal(load(values, 0).generation, 50, "restart keeps the old committed configuration");

  for (const [op, key, n] of [
    ["write", "D2r6", 1], ["read", "D2r6", 1], ["write", "D2m", 1],
    ["read", "D2m", 2], ["remove", "D2p", 1], ["read", "D2p", 1]
  ]) {
    const broken = store(before);
    broken.fail(op, key, n);
    assert.equal(persist(broken, { ...candidate, generation: 51, records: replacement }, slots, records, 0), null);
    assert.equal(load(broken, 0).generation, 50, `DIFF ${op} ${key} preserves durable generation 50`);
    assert.deepEqual(load(broken, 0).records, records);
  }
});


test("pending marker faults stay before the destructive seam", () => {
  const values = store();
  const candidate = { epoch: EPOCH, generation: 50, records, language: "fr", key: 1, mode: 0 };
  persist(values, candidate, [], [], 0);
  const before = [...values.values];
  for (const prior of [null, "E" + EPOCH + "00000032"]) {
    for (const [op, n] of [["read", 1], ["write", 1], ["read", 2]]) {
      const broken = store(before);
      if (prior) broken.values.set("D2p", prior);
      broken.fail(op, "D2p", n);
      assert.equal(markPending(broken, EPOCH, 51), false);
      assert.equal(broken.values.get("D2p") ?? null, prior, "pre-seam failure preserves the previous marker or absence");
      assert.equal(broken.values.get("D2m"), values.values.get("D2m"));
      if (!prior) assert.equal(load(broken, 0).generation, 50);
      else assert.equal(load(broken, 0), null, "an earlier destructive seam cannot be undone");
    }
  }
});

test("load rejects foreign, epochless and corrupt storage as unconfigured", () => {
  // A pending marker means unrenderable state.
  const pending = store();
  persist(pending, { epoch: EPOCH, generation: 7, records: [records[0]], language: "fr", key: 1, mode: 0 }, [], [], 0);
  markPending(pending, EPOCH, 8);
  assert.equal(load(pending, 0), null);

  // Old-format and foreign manifests are unconfigured, never migrated.
  assert.equal(load(store([["lapinFuteWatchConfig", "whatever"]]), 0), null);
  assert.equal(load(store([["D2x", "junk"]]), 0), null);
  assert.equal(load(store([["D2m", "garbage"]]), 0), null);

  const committed = store();
  const slots = persist(committed, { epoch: EPOCH, generation: 7, records, language: "fr", key: 1, mode: 0 }, [], [], 0);

  const invalid = [
    manifest(EPOCH, 1, "fr", 1, 7, 6, slots), // wrong profile
    manifest(EPOCH, 0, "xx", 1, 7, 6, slots), // bad language
    manifest(EPOCH, 0, "fr", 3, 7, 6, slots), // key out of range
    manifest(EPOCH, 0, "fr", 1, 0, 6, slots), // generation zero
    manifest(EPOCH, 0, "fr", 1, 7, 7, slots), // count over six
    manifest("00000000000000g", 0, "fr", 1, 7, 6, slots), // non-hex epoch
    manifest(EPOCH, 0, "fr", 1, 7, 6, slots.slice(0, 2)), // record list shorter than count
    "D2" + manifest(EPOCH, 0, "fr", 1, 7, 6, slots).slice(18) // former epochless format
  ];
  for (const replacement of invalid) {
    const broken = store(committed.values);
    broken.values.set("D2m", replacement);
    assert.equal(load(broken, 0), null);
  }

  // Duplicate favorite ids are rejected.
  const duplicate = store([["D2e", EPOCH], ["D2m", manifest(EPOCH, 0, "fr", 1, 7, 2, [0, 1])],
    ["D2r0", records[0]], ["D2r1", records[0]]]);
  assert.equal(load(duplicate, 0), null);
  const invalidRecord = store([["D2e", EPOCH], ["D2m", manifest(EPOCH, 0, "fr", 1, 7, 1, [3])], ["D2r3", "bad"]]);
  assert.equal(load(invalidRecord, 0), null);
});

test("foreign manifests cannot reset epochs or create epochless pending writes", () => {
  const foreign = "D2" + manifest(EPOCH, 0, "fr", 1, 7, 0, []).slice(18);
  const values = store([["D2m", foreign], ["D2e", "00000000000000a"]]);
  assert.equal(load(values, 0), null);
  assert.equal(markPending(values), false);
  assert.equal(values.getItem("D2p"), null);
  const epoch = createEpochAllocator(values)();
  assert.equal(epoch, "00000000000000b");
  assert(markPending(values, epoch, 1));
  assert(persist(values, { epoch, generation: 1, records, language: "fr", key: 1, mode: 1 }, [], [], 0));
  assert.equal(load(values, 0).epoch, epoch);
  assert.deepEqual(load(values, 0).records, records);
});

test("epoch grammar and request ids", () => {
  assert.equal(epochValid("000000000000000"), false);
  assert.equal(epochValid("000000000000000", true), true);
  assert.equal(epochValid("0000000ffffffff"), true);
  assert.equal(epochValid("00000000000000"), false);
  assert.equal(epochValid("00000000000000g"), false);
  const id = EPOCH + "r00000001";
  assert.equal(id.length, 24);
  assert(messageIdValid(id, "r"));
  assert(!messageIdValid(id, "c"));
  assert(!messageIdValid(EPOCH + "r00000000", "r"));
  assert(!messageIdValid("r1", "r"));
});
