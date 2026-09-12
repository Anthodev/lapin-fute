import assert from "node:assert/strict";
import { watchModule } from "./xs-host.js";

const { createRuntime } = await watchModule("runtime");
const { displayHash, field } = await watchModule("packed");

// Deterministic packed records and fault-injectable storage for state transitions.

export const NOW = 1788610800000;
export const NOW_S = Math.floor(NOW / 1000);

export function scalars(text) {
  let count = 0;
  for (const _ of text) count++;
  return count;
}

export function lp3(text) {
  return scalars(text).toString(16).padStart(3, "0");
}

export function fixed(value, width) {
  let out = value.toString(16);
  while (out.length < width) out = "0" + out;
  return out;
}

// Slots 0-3 lineLabel, 4-8 stopLabel, 9-11 destinationLabel; mask 0 keeps
// every clip end at the full scalar length.
export function appearance({
  id, line = "M1", stop = "Saint-Lazare", destination = "Montfermeil",
  profile = 0, language = "fr", background = "d9ebde", foreground = "174d31",
  ends, mask = 0
} = {}) {
  const labels = [line, line, line, line, stop, stop, stop, stop, stop, destination, destination, destination];
  const lengths = [scalars(line), scalars(stop), scalars(destination)];
  const clipEnds = ends ?? labels.map((_, slot) => lengths[slot < 4 ? 0 : slot < 9 ? 1 : 2]);
  const tail = background + foreground
    + clipEnds.map((end) => end.toString(16).padStart(2, "0")).join("")
    + mask.toString(16).padStart(3, "0");
  const body = (hash) => lp3(id) + id + lp3(hash) + hash + lp3(line) + line
    + lp3(stop) + stop + lp3(destination) + destination + tail;
  const record = body("0".repeat(16));
  return body(displayHash(record, profile, language));
}

export function appearances(count = 6, prefix = "fav", options = {}) {
  return Array.from({ length: count }, (_, index) => appearance({
    id: `${prefix}${index}:station:${index}`,
    line: `L${index}`,
    stop: `Arrêt ${index}`,
    destination: `Vers ${index}`,
    ...options
  }));
}

export function departure({
  fetchedAt = NOW_S, hasData = true, exception = 0,
  expectedAt = fetchedAt + 300, palette = 1, checkedAt = fetchedAt
} = {}) {
  return (hasData ? "01" : "00") + fixed(fetchedAt, 8) + "0" + fixed(exception, 2)
    + palette.toString(16) + fixed(checkedAt, 8)
    + (hasData ? "1" + fixed(expectedAt, 8) + "0" : "0");
}

export function trafficDocument({
  palette = 0, checkedAt = NOW_S, title = "Perturbation",
  validity = "de 10h à 16h", body = "Trafic normal sur l'ensemble de la ligne."
} = {}) {
  const lineCount = (text) => (text ? 1 + [...text].filter((ch) => ch === "\n").length : 0);
  const section = (text) => (text ? lp3(text) + text : "000");
  const count = (value) => value.toString(16).padStart(3, "0");
  return [palette.toString(16) + fixed(checkedAt, 8)
    + count(lineCount(title)) + count(lineCount(validity)) + count(lineCount(body))
    + section(title) + section(validity) + section(body)];
}

export function trafficError(token) {
  return ["e" + fixed(token, 2)];
}

export function store(initial = []) {
  const values = new Map(initial);
  let fault = null;
  function check(op, key) {
    if (fault && fault.op === op && fault.key === key && !--fault.n) {
      fault = null;
      throw Error("injected " + op);
    }
  }
  return {
    values,
    fail(op, key, n = 1) { fault = { op, key, n }; },
    getItem(key) { check("read", key); return values.get(key) ?? null; },
    setItem(key, value) { check("write", key); values.set(key, value); },
    removeItem(key) { check("remove", key); values.delete(key); }
  };
}

export function harness(faultStore = store(), { now = NOW, profile = 0, hour12 = false } = {}) {
  const out = [], timers = new Map();
  let next = 0, failType = -1, state;
  const runtime = createRuntime(faultStore, {
    set(fn, delay) { const id = ++next; timers.set(id, { fn, delay }); return id; },
    clear(id) { timers.delete(id); }
  }, (outgoing) => {
    if (outgoing.get(1) === failType) { failType = -1; return false; }
    out.push(outgoing);
    return true;
  }, (frame) => { state = frame; }, () => now, profile, hour12);
  runtime.start();
  return {
    runtime, r: state, out, timers, store: faultStore,
    failSend(type) { failType = type; }
  };
}

export function message(type, id, generation, extra = {}) {
  return new Map(Object.entries({ 0: 2, 1: type, 2: id, 41: generation, ...extra })
    .map(([key, value]) => [Number(key), value]));
}

export function ready(target, token = "ptoken") {
  return target.runtime.receive(new Map([[0, 2], [1, 21], [2, token]]));
}

export function begin(target, records = appearances(2), options = {}) {
  const epoch = options.epoch || target.r.activeEpoch || target.r.pendingEpoch;
  const generation = options.generation ?? (epoch === target.r.activeEpoch ? target.r.highest + 1 : 1);
  const id = epoch + "c" + fixed(generation, 8);
  assert(target.runtime.receive(message(2, id, generation, {
    10: options.key ?? 1, 11: records.length, 36: options.mode || 0,
    37: options.language || "fr", 39: target.r.profile
  })));
  return { epoch, generation, id, records };
}

export function inventory(target, candidate) {
  candidate.records.forEach((record, index) => assert(target.runtime.receive(message(15,
    candidate.id, candidate.generation,
    { 3: field(record, 0), 12: index, 43: field(record, 1) }))));
  return target.out.findLast((m) => m.get(1) === 16 && m.get(2) === candidate.id)?.get(35);
}

export function finish(target, candidate, mask) {
  for (let index = 0; index < candidate.records.length; index++) {
    if (mask & (1 << index)) {
      assert(target.runtime.receive(message(3, candidate.id, candidate.generation,
        { 12: index, 38: candidate.records[index] })));
    }
  }
  return target.runtime.receive(message(4, candidate.id, candidate.generation));
}

export function configure(target, records, options) {
  const candidate = begin(target, records, options);
  return finish(target, candidate, inventory(target, candidate));
}

export function latest(target, kind) {
  return target.out.findLast((m) => m.get(1) === [9, 1, 10][kind]);
}

export function startData(target, kind, records, request = latest(target, kind)) {
  const id = request.get(2), generation = request.get(41);
  const extra = { 11: records.length, 40: kind };
  if (kind) extra[3] = request.get(3);
  assert(target.runtime.receive(message(17, id, generation, extra)));
  return { id, generation, kind, records };
}

export function finishData(target, candidate) {
  candidate.records.forEach((record, index) => assert(target.runtime.receive(message(18,
    candidate.id, candidate.generation, { 12: index, 38: record, 40: candidate.kind }))));
  return target.runtime.receive(message(19, candidate.id, candidate.generation, { 40: candidate.kind }));
}

export function data(target, kind, records, request) {
  assert(finishData(target, startData(target, kind, records, request)));
}

// Two favorites with warm overview and a committed detail.
export function readyDetail(target) {
  configure(target, appearances(2));
  data(target, 0, [departure(), departure()]);
  target.runtime.button("select");
  data(target, 1, [departure()]);
}

// Six favorites with warm overview, four-row detail and a retained traffic page.
export function warmSix(target = harness()) {
  const records = appearances(6);
  configure(target, records);
  data(target, 0, records.map(() => departure()));
  target.runtime.button("select");
  const rows = departure();
  data(target, 1, [rows.slice(0, 22) + "4" + rows.slice(23).repeat(4)]);
  target.runtime.button("select");
  data(target, 2, trafficDocument({ palette: 1, title: "Perturbation", body: "Traffic\nslowed." }));
  target.runtime.button("down");
  return target;
}

// Changed metadata for the same favorites: identical ids, fresh labels/hash.
export function replacements(count = 6) {
  return Array.from({ length: count }, (_, index) => appearance({
    id: `fav${index}:station:${index}`,
    line: `N${index}`,
    stop: `Nouvel arrêt ${index}`,
    destination: `Vers ${index} (modifié)`
  }));
}
