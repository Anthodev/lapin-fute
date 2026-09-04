import { appearanceValid, field, fixed, hex, epochValid, nextEpoch, unsigned } from "./packed.js";

const MANIFEST = "D2m", PENDING = "D2p", WATERMARK = "D2e";
function recordKey(slot) { return "D2r" + fixed(slot, 1); }
function put(storage, key, value) {
  storage.setItem(key, value);
  if (storage.getItem(key) !== value) throw Error("durability");
}
export function markPending(storage, epoch, generation) {
  if (!epochValid(epoch) || !unsigned(generation) || !generation) return false;
  const value = "E" + epoch + fixed(generation, 8);
  let previous;
  try { previous = storage.getItem(PENDING); } catch (_) { return false; }
  try { put(storage, PENDING, value); return true; } catch (_) {
    // A failed marker readback is still before the destructive seam.
    try {
      if (previous === null) storage.removeItem(PENDING);
      else put(storage, PENDING, previous);
    } catch (_) {}
    return false;
  }
}
export function createEpochAllocator(storage, knownEpoch = "") {
  let attempted = "";
  return function allocate() {
    try {
      let value = storage.getItem(WATERMARK);
      const manifest = storage.getItem(MANIFEST), pending = storage.getItem(PENDING);
      const hasCommitted = typeof manifest === "string" && manifest.slice(0, 3) === "D2E";
      const hasAdmitted = typeof pending === "string" && pending.charAt(0) === "E";
      const committed = hasCommitted ? manifest.slice(3, 18) : "", admitted = hasAdmitted ? pending.slice(1, 16) : "";
      if (value === null) {
        if (knownEpoch || hasCommitted || hasAdmitted) return null;
        value = "000000000000000";
      }
      if (!epochValid(value, true) || knownEpoch && value < knownEpoch
          || hasCommitted && (!epochValid(committed) || value < committed)
          || hasAdmitted && (!epochValid(admitted) || value < admitted)) return null;
      if (attempted && value < attempted) value = attempted;
      const next = nextEpoch(value);
      if (!next) return null;
      // A failed readback may still have written. Never reuse that attempt.
      attempted = next;
      put(storage, WATERMARK, next);
      return next;
    } catch (_) { return null; }
  };
}
export function load(storage, profile) {
  try {
    if (storage.getItem(PENDING) !== null) return null;
    const manifest = storage.getItem(MANIFEST);
    if (typeof manifest !== "string" || manifest.slice(0, 3) !== "D2E") return null;
    const epoch = manifest.slice(3, 18), start = 18;
    if (!epochValid(epoch) || hex(manifest, start, 1) !== profile) return null;
    const language = manifest.slice(start + 1, start + 3), key = hex(manifest, start + 3, 1);
    const generation = hex(manifest, start + 4, 8), count = hex(manifest, start + 12, 1);
    if ((language !== "en" && language !== "fr") || key < 0 || key > 2 || generation < 1 || count < 0 || count > 6 || manifest.length !== start + 13 + count) return null;
    const records = [], slots = [];
    for (let i = 0; i < count; i++) {
      const slot = hex(manifest, start + 13 + i, 1);
      if (slot < 0 || slot > 11 || slots.indexOf(slot) >= 0) return null;
      const record = storage.getItem(recordKey(slot));
      if (!appearanceValid(record, profile, language)) return null;
      for (let j = 0; j < i; j++) if (field(records[j], 0) === field(record, 0)) return null;
      records.push(record); slots.push(slot);
    }
    return { records, slots, language, key, generation, epoch };
  } catch (_) { return null; }
}
export function persist(storage, candidate, oldSlots, oldRecords, profile) {
  let oldManifest;
  try { oldManifest = storage.getItem(MANIFEST); } catch (_) { return null; }
  if (!epochValid(candidate.epoch)) return null;
  const slots = [];
  try {
    for (let i = 0; i < candidate.records.length; i++) {
      const existing = oldRecords.indexOf(candidate.records[i]);
      let slot = existing < 0 ? -1 : oldSlots[existing];
      if (slot === undefined) slot = -1;
      if (slot < 0) {
        for (let free = 0; free < 12; free++) {
          if (oldSlots.indexOf(free) < 0 && slots.indexOf(free) < 0) { slot = free; break; }
        }
        if (slot < 0) throw Error("record slots");
        put(storage, recordKey(slot), candidate.records[i]);
      }
      slots.push(slot);
    }
    let manifest = "D2E" + candidate.epoch + profile + candidate.language + candidate.key + fixed(candidate.generation, 8) + candidate.records.length;
    for (let i = 0; i < slots.length; i++) manifest += fixed(slots[i], 1);
    if (manifest !== oldManifest) put(storage, MANIFEST, manifest);
    storage.removeItem(PENDING);
    if (storage.getItem(PENDING) !== null) throw Error("pending removal");
  } catch (_) {
    if (candidate.mode === 1) markPending(storage, candidate.epoch, candidate.generation);
    else {
      // Only the small manifest is rollback metadata, never a serialized dataset.
      try {
        if (oldManifest === null) storage.removeItem(MANIFEST);
        else put(storage, MANIFEST, oldManifest);
      } catch (_) { markPending(storage, candidate.epoch, candidate.generation); }
    }
    return null;
  }
  // Unreachable per-record cleanup cannot invalidate the published manifest.
  for (let i = 0; i < 12; i++) {
    if (slots.indexOf(i) < 0) { try { storage.removeItem(recordKey(i)); } catch (_) {} }
  }
  return slots;
}
