import { unsigned, textBytes, hex, fixed, field, appearanceValid, departureValid, trafficValid, trafficError, pages, size, messageIdValid } from "./packed.js";
import { load, markPending, persist, createEpochAllocator } from "./storage.js";

function idValid(value, maximum, ascii = false) {
  if (typeof value !== "string" || !value.length || value.length > maximum) return false;
  const bytes = textBytes(value);
  return bytes > 0 && bytes <= maximum && (!ascii || bytes === value.length);
}
function wireValid(message) {
  if (!(message instanceof Map)) return false;
  const type = message.get(1);
  let low = 0, high = 0, valid = true;
  message.forEach((value, raw) => {
    const key = raw === "SCHEMA_VERSION" ? 0 : raw;
    if (!unsigned(key, 43)) { valid = false; return; }
    if (key < 32) low |= 1 << key; else high |= 1 << (key - 32);
    if (key === 0) valid = valid && value === 2;
    else if (key === 2) valid = valid && idValid(value, 24, true);
    else if (key === 3) valid = valid && idValid(value, 64);
    else if (key === 37) valid = valid && (value === "en" || value === "fr");
    else if (key === 38) {
      const bytes = typeof value === "string" ? textBytes(value, 0, size(value), true) : -1;
      valid = valid && bytes >= 0 && bytes <= 640;
    }
    else if (key === 43) valid = valid && typeof value === "string" && value.length === 16 && hex(value, 0, 8) >= 0 && hex(value, 8, 8) >= 0;
    else valid = valid && unsigned(value);
  });
  if (!valid || message.has(0) && message.has("SCHEMA_VERSION") && message.get(0) !== message.get("SCHEMA_VERSION")) return false;
  if (type !== 21) {
    const kind = type === 2 || type === 3 || type === 4 || type === 15 ? "c" : "r";
    if (!messageIdValid(message.get(2), kind) || !message.get(41)
        || kind === "c" && hex(message.get(2), 16, 8) !== message.get(41)) return false;
  }
  switch (type) {
    case 2: return low === 3079 && high === 688;
    case 3: return low === 4103 && high === 576;
    case 4: return low === 7 && high === 512;
    case 15: return low === 4111 && high === 2560;
    case 17: return (low === (message.get(40) === 0 ? 2055 : 2063)) && high === 768;
    case 18: return low === 4103 && high === 832;
    case 19: return low === 7 && high === 768;
    case 21: return low === 7 && high === 0 && message.get(2).charAt(0) === "p";
    default: return false;
  }
}
export function createRuntime(storage, timer, send, redraw, now, profile, hour12) {
  // Validate retained metadata before the closure-construction frame is live.
  const saved = load(storage, profile);
  return constructRuntimeFromSaved(saved, storage, timer, send, redraw, profile, hour12);
}
function constructRuntimeFromSaved(saved, storage, timer, send, redraw, profile, hour12) {
  const r = {
    records: [], slots: [], overview: [], detail: null, detailId: "", traffic: null, trafficId: "",
    language: "en", key: 0, generation: 0, profile, hour12, screen: 0, focus: 0, active: 0, page: 0,
    pending: 0, failed: 0, errors: [0, 0, 0], overviewErrors: [], keyError: 0, syncError: 0, handshakeFailed: false,
    candidate: null, intent: null, requests: [null, null, null], bindings: ["", "", ""],
    sequence: 0, opened: false, activeApp: true, settle: null, lastSync: "", highest: 0,
    epoch: "", activeEpoch: "", pendingEpoch: "", session: ""
  };
  if (saved) {
    r.records = saved.records; r.slots = saved.slots; r.language = saved.language; r.key = saved.key;
    r.generation = saved.generation; r.epoch = saved.epoch;
  }
  const allocateEpoch = createEpochAllocator(storage, r.epoch);
  function invalidate() { redraw(r); }
  function cancelSettle() { if (r.settle !== null) { timer.clear(r.settle); r.settle = null; } }
  function cancelKind(kind) {
    if (r.candidate && r.candidate.kind === kind) r.candidate = null;
    if (r.intent && r.intent.kind === kind) r.intent = null;
    r.requests[kind] = null; r.bindings[kind] = "";
    r.pending &= ~(1 << kind); r.failed &= ~(1 << kind); r.errors[kind] = 0;
  }
  function failKind(kind, token = 7) {
    if (r.candidate && r.candidate.kind === kind) r.candidate = null;
    r.requests[kind] = null; r.bindings[kind] = "";
    r.pending &= ~(1 << kind); r.failed |= 1 << kind; r.errors[kind] = token;
  }
  function discard(failure = false) {
    const c = r.candidate;
    if (!c) return;
    r.candidate = null;
    if (c.kind >= 0) { if (failure) failKind(c.kind); else cancelKind(c.kind); }
    else if (failure) r.syncError = 7;
  }
  function cancelData() {
    cancelSettle();
    for (let i = 0; i < 3; i++) cancelKind(i);
  }
  function clearConfiguration() {
    cancelData(); r.records = []; r.slots = []; r.overview = []; r.overviewErrors = [];
    r.detail = null; r.detailId = ""; r.traffic = null; r.trafficId = "";
    r.focus = 0; r.active = 0; r.page = 0; r.screen = 0; r.key = 0;
  }
  function packet(type, requestId) {
    const message = new Map([[0, 2], [1, type]]);
    if (requestId) { message.set(2, requestId); message.set(41, r.generation); }
    return message;
  }
  function hello(token) {
    if (!r.pendingEpoch) r.pendingEpoch = allocateEpoch() || "";
    if (!r.pendingEpoch) { r.handshakeFailed = true; invalidate(); return false; }
    if (!r.session) r.session = "w" + r.pendingEpoch;
    const message = packet(20);
    message.set(2, token || r.session); message.set(44, r.session); message.set(45, r.pendingEpoch);
    message.set(39, r.profile); message.set(42, r.hour12 ? 1 : 0);
    const sent = send(message);
    r.handshakeFailed = !sent; invalidate();
    return sent;
  }
  function request(kind, trigger) {
    if (!unsigned(kind, 2) || !r.records.length || !r.key || !r.activeApp) return false;
    if (r.candidate && r.candidate.kind === -1
        && (r.candidate.mode === 1 && r.candidate.seam || r.candidate.mode === 0 && r.candidate.need > 0)) return false;
    if (!r.activeEpoch || r.activeEpoch !== r.epoch) {
      if (kind < 2 && trigger === 2 && !r.candidate && (r.syncError || r.handshakeFailed)) {
        r.intent = { kind, trigger, favorite: kind ? field(r.records[r.active], 0) : "" };
        r.pendingEpoch = ""; hello();
      }
      return false;
    }
    if (r.sequence === 0xffffffff) {
      if (trigger === 5) { failKind(kind); invalidate(); return false; }
      r.intent = { kind, trigger, favorite: kind ? field(r.records[r.active], 0) : "" };
      hello(); return false;
    }
    const binding = kind === 0 ? "" : field(r.records[r.active], 0);
    const id = r.epoch + "r" + fixed(++r.sequence, 8);
    const message = packet(kind === 0 ? 9 : kind === 1 ? 1 : 10, id);
    if (kind !== 0) message.set(3, binding);
    if (kind !== 2) message.set(24, trigger);
    cancelKind(kind);
    r.requests[kind] = id; r.bindings[kind] = binding; r.pending |= 1 << kind;
    if (!send(message)) { failKind(kind); invalidate(); return false; }
    invalidate(); return true;
  }
  function promote(c) {
    if (r.activeEpoch !== c.epoch) r.sequence = 0;
    r.activeEpoch = c.epoch; r.highest = c.generation; r.lastSync = c.id;
    if (r.pendingEpoch === c.epoch) r.pendingEpoch = "";
  }
  function need(c) {
    let mask = 0;
    for (let i = 0; i < c.count; i++) {
      let record = null;
      if (!c.mode && c.language === r.language) {
        for (let j = 0; j < r.records.length; j++) {
          if (field(r.records[j], 0) === c.ids[i] && field(r.records[j], 1) === c.hashes[i]) { record = r.records[j]; break; }
        }
      }
      c.records[i] = record;
      if (!record) mask |= 1 << i;
      else { c.ids[i] = null; c.hashes[i] = null; }
    }
    if (c.mode === 1) {
      if (!markPending(storage, c.epoch, c.generation)) { discard(true); invalidate(); return false; }
      c.seam = true; promote(c); clearConfiguration(); invalidate();
    }
    c.need = mask; c.body = 0;
    if (!mask) { c.ids = null; c.hashes = null; }
    if (c.mode === 0 && mask) {
      const intent = r.intent;
      cancelData(); r.intent = intent;
      r.overview = []; r.overviewErrors = []; r.detail = null; r.detailId = "";
      r.traffic = null; r.trafficId = ""; r.page = 0;
      invalidate();
    }
    const message = new Map([[0, 2], [1, 16], [2, c.id], [35, mask], [39, r.profile], [41, c.generation], [42, r.hour12 ? 1 : 0]]);
    if (!send(message)) { discard(true); invalidate(); return false; }
    return true;
  }
  function configCommit(c) {
    for (let i = 0; i < c.count; i++) if (!c.records[i]) { discard(true); invalidate(); return false; }
    const slots = persist(storage, c, r.slots, r.records, r.profile);
    if (!slots) { discard(true); invalidate(); return false; }
    const sentinel = r.records.length > 0 && r.focus === r.records.length;
    const languageChanged = c.language !== r.language;
    const focusId = !sentinel && r.records[r.focus] ? field(r.records[r.focus], 0) : "";
    const activeId = r.records[r.active] ? field(r.records[r.active], 0) : "";
    const intent = r.intent;
    const overview = [];
    let focus = 0, active = 0;
    for (let i = 0; i < c.count; i++) {
      const id = field(c.records[i], 0);
      if (id === focusId) focus = i;
      if (id === activeId) active = i;
      let previous = null;
      for (let j = 0; j < r.overview.length; j++) if (r.overview[j] && field(r.records[j], 0) === id) { previous = r.overview[j]; break; }
      overview.push(previous);
    }
    cancelData(); promote(c);
    r.records = c.records; r.slots = slots; r.overview = overview; r.overviewErrors = [];
    r.language = c.language; r.key = c.key; r.epoch = c.epoch;
    r.generation = c.generation; r.focus = sentinel ? c.count : focus; r.active = active;
    if (!c.count || field(c.records[active], 0) !== r.detailId) { r.detail = null; r.detailId = ""; }
    if (languageChanged || !c.count || field(c.records[active], 0) !== r.trafficId) {
      r.traffic = null; r.trafficId = ""; r.page = 0;
      if (r.screen === 2) r.screen = c.count ? 1 : 0;
    }
    r.candidate = null; r.keyError = 0; r.syncError = 0; invalidate();
    const relevant = intent && (!intent.kind || c.count && intent.favorite === field(c.records[active], 0) && r.screen === intent.kind);
    if (!r.opened) {
      if (request(0, 0)) r.opened = true;
      if (relevant && intent.kind) request(intent.kind, intent.trigger);
    } else if (c.mode === 0 && c.need > 0) {
      const overviewSent = request(0, relevant && intent.kind === 0 ? intent.trigger : 5);
      if (relevant && intent.kind) request(intent.kind, intent.trigger);
      else if (overviewSent && r.screen === 1) request(1, 5);
    } else if (relevant) request(intent.kind, intent.trigger);
    return true;
  }
  function correlated(message, c) {
    if (!(message instanceof Map) || !c || message.get(2) !== c.id || message.get(41) !== c.generation) return false;
    const type = message.get(1), kind = c.kind === -1 ? "c" : "r";
    return messageIdValid(message.get(2), kind) && message.get(2).slice(0, 15) === c.epoch
      && (c.kind === -1 ? (type === 3 || type === 4 || type === 15) && !message.has(40)
        : (type === 17 || type === 18 || type === 19) && message.get(40) === c.kind);
  }
  function receive(message) {
    if (!wireValid(message)) {
      if (correlated(message, r.candidate)) { discard(true); invalidate(); }
      return false;
    }
    const type = message.get(1), id = message.get(2), generation = message.get(41);
    if (type === 21) return hello(id);
    const epoch = id.slice(0, 15);
    let c = r.candidate;
    if (type === 2) {
      const pending = epoch === r.pendingEpoch, active = epoch === r.activeEpoch;
      if (message.get(39) !== r.profile || !unsigned(message.get(10), 2) || !unsigned(message.get(11), 6)
          || !unsigned(message.get(36), 1) || (!pending && !active)
          || active && generation <= r.highest
          || c && c.kind === -1 && c.epoch === epoch && generation <= c.generation) return false;
      const intent = r.intent;
      discard();
      // Retiring old receive authority never removes its still-displayable metadata.
      if (pending && !active) { cancelData(); r.intent = intent; r.activeEpoch = ""; }
      c = { kind: -1, id, epoch, generation, count: message.get(11), mode: message.get(36), language: message.get(37), key: message.get(10), ids: [], hashes: [], records: [], need: -1, body: 0, seam: false };
      r.candidate = c;
      if (!c.count) return need(c);
      return true;
    }
    if (epoch !== r.activeEpoch && (!c || epoch !== c.epoch)) return false;
    if (type === 17) {
      const kind = message.get(40), count = message.get(11);
      if (!unsigned(kind, 2) || epoch !== r.activeEpoch || epoch !== r.epoch || id !== r.requests[kind] || generation !== r.generation
          || kind > 0 && (message.get(3) !== r.bindings[kind] || !r.records[r.active] || message.get(3) !== field(r.records[r.active], 0))
          || kind === 0 && count !== r.records.length || kind === 1 && count !== 1
          || kind === 2 && (count < 1 || count > 2) || c && c.kind === -1) return false;
      if (c && c.kind !== kind) discard();
      r.pending |= 1 << kind;
      r.candidate = { kind, id, epoch, generation, count, records: [], favorite: kind ? message.get(3) : "" };
      return true;
    }
    if (!correlated(message, c)) return false;
    let accepted = false;
    if (c.kind === -1) {
      if (type === 15 && c.need < 0 && message.get(12) === c.ids.length && c.ids.length < c.count && c.ids.indexOf(message.get(3)) < 0) {
        c.ids.push(message.get(3)); c.hashes.push(message.get(43)); accepted = true;
        if (c.ids.length === c.count) return need(c);
      } else if (type === 3 && c.need >= 0) {
        let expected = c.body;
        while (expected < c.count && !(c.need & (1 << expected))) expected++;
        const record = message.get(38);
        if (message.get(12) === expected && expected < c.count && appearanceValid(record, r.profile, c.language, c.ids[expected], c.hashes[expected])) {
          c.records[expected] = record; c.body = expected + 1; accepted = true;
          c.ids[expected] = null; c.hashes[expected] = null;
          if (!(c.need >>> c.body)) { c.ids = null; c.hashes = null; }
        }
      } else if (type === 4 && c.need >= 0) return configCommit(c);
    } else {
      if (type === 18 && message.get(12) === c.records.length && c.records.length < c.count) {
        const record = message.get(38);
        if (c.kind === 2 || departureValid(record, c.kind ? 4 : 1)) { c.records.push(record); accepted = true; }
      } else if (type === 19 && c.records.length === c.count && (c.kind !== 2 || trafficValid(c.records))) {
        let error = c.kind === 2 ? trafficError(c.records) : 0;
        let keyError = error === 1 ? 1 : error === 3 ? 2 : 0, loading = false;
        if (c.kind < 2) for (let i = 0; i < c.records.length; i++) {
          const incoming = c.records[i], token = hex(incoming, 11, 2);
          if (c.kind === 0) r.overviewErrors[i] = token;
          if (token === 2) loading = true;
          keyError |= token === 1 ? 1 : token === 3 ? 2 : 0;
          if (token && (error !== 3 || token === 3)) error = token;
          const old = c.kind === 0 ? r.overview[i] : r.detailId === c.favorite ? r.detail : r.overview[r.active];
          if (!(hex(incoming, 0, 2) & 1) && token && old && (hex(old, 0, 2) & 1)) c.records[i] = old;
        }
        if (c.kind === 0) r.overview = c.records;
        else if (c.kind === 1) { r.detail = c.records[0]; r.detailId = c.favorite; }
        else if (!error) { r.traffic = c.records; r.trafficId = c.favorite; r.page = Math.min(r.page, pages(r.traffic) - 1); }
        r.pending &= ~(1 << c.kind); r.failed &= ~(1 << c.kind); r.errors[c.kind] = error;
        // Two credential bits per dataset survive navigation and unrelated outcomes.
        r.keyError = (loading ? r.keyError : r.keyError & ~(3 << (c.kind * 2))) | (keyError << (c.kind * 2));
        if (error === 2) r.pending |= 1 << c.kind; else if (error) r.failed |= 1 << c.kind;
        r.candidate = null; invalidate(); return true;
      }
    }
    if (!accepted) { discard(true); invalidate(); }
    return accepted;
  }
  function navigation(index) {
    cancelSettle(); cancelKind(1); cancelKind(2);
    r.active = Math.max(0, Math.min(r.records.length - 1, index));
    r.focus = r.active; r.page = 0;
    if (r.detailId !== field(r.records[r.active], 0)) { r.detail = null; r.detailId = ""; }
    if (r.trafficId !== field(r.records[r.active], 0)) { r.traffic = null; r.trafficId = ""; }
    invalidate();
  }
  function button(name) {
    if (!r.activeApp) return;
    if (name === "back") { cancelSettle(); r.screen = r.screen === 2 ? 1 : 0; invalidate(); return; }
    if (!r.records.length || !r.key) return;
    if (name === "up" || name === "down") {
      const step = name === "up" ? -1 : 1;
      if (r.screen === 0) r.focus = Math.max(0, Math.min(r.records.length, r.focus + step));
      else if (r.screen === 2) r.page = Math.max(0, Math.min(pages(r.traffic) - 1, r.page + step));
      else {
        const next = Math.max(0, Math.min(r.records.length - 1, r.active + step));
        if (next === r.active) return;
        navigation(next);
        if (!(r.candidate && r.candidate.kind === -1 && r.candidate.mode === 0 && r.candidate.need > 0))
          r.settle = timer.set(() => { r.settle = null; if (r.screen === 1 && r.activeApp) request(1, 1); }, 500);
      }
    } else if (name === "select" || name === "selectLong") {
      cancelSettle();
      if (r.screen === 0) {
        let usable = false;
        for (let i = 0; i < r.overview.length; i++) if (r.overview[i] && (hex(r.overview[i], 0, 2) & 1)) usable = true;
        if (r.focus === r.records.length || !r.candidate && !usable) request(0, 2);
        else { navigation(r.focus); r.screen = 1; request(1, 5); }
      } else if (r.screen === 1) {
        if (name === "selectLong") request(1, 2);
        else { r.screen = 2; r.page = 0; request(2); }
      }
    }
    invalidate();
  }
  return {
    receive, button, request,
    start() { invalidate(); hello(); },
    suspend() {
      cancelSettle(); discard(true);
      for (let kind = 0; kind < 3; kind++) if (r.requests[kind]) {
        if (r.pending & (1 << kind)) failKind(kind); else { r.requests[kind] = null; r.bindings[kind] = ""; }
      }
      invalidate();
    },
    minute() { if (r.activeApp) invalidate(); },
    active(value) { r.activeApp = value !== false; if (!r.activeApp) cancelSettle(); else invalidate(); },
    clockSetting(value) { if (r.hour12 === value) return; r.hour12 = value; cancelKind(2); r.traffic = null; r.trafficId = ""; r.page = 0; hello(); invalidate(); }
  };
}
