// Alloy XS indexes strings by Unicode scalar, not UTF-16 code unit.
function stringSize(value) { return value.length; }
function stringCode(value, index) { return value.charCodeAt(index); }
function stringPart(value, start, end) { return value.slice(start, end); }
export function unsigned(value, max = 0xffffffff) {
  return typeof value === "number" && value >= 0 && value <= max && Math.floor(value) === value;
}
export function code(source, index) {
  if (typeof source === "string") return stringCode(source, index);
  const length = stringSize(source[0]);
  return index < length ? stringCode(source[0], index) : source[1] ? stringCode(source[1], index - length) : NaN;
}
export function size(source) {
  return typeof source === "string" ? stringSize(source) : stringSize(source[0]) + (source[1] ? stringSize(source[1]) : 0);
}
export function part(source, start, end) {
  if (typeof source === "string") return stringPart(source, start, end);
  const boundary = stringSize(source[0]);
  if (end <= boundary) return stringPart(source[0], start, end);
  if (start >= boundary) return stringPart(source[1], start - boundary, end - boundary);
  // Only a bounded field or displayed line crosses this seam. Never join a document.
  return stringPart(source[0], start) + stringPart(source[1], 0, end - boundary);
}
export function hex(source, start, length) {
  let value = 0;
  for (let i = start; i < start + length; i++) {
    const c = code(source, i);
    const digit = c >= 48 && c <= 57 ? c - 48 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (digit < 0) return -1;
    value = value * 16 + digit;
  }
  return value;
}
export function fixed(value, width) {
  let result = value.toString(16);
  while (result.length < width) result = "0" + result;
  return result;
}
export function textBytes(source, start = 0, end = size(source), multiline = false) {
  let bytes = 0;
  for (let i = start; i < end; i++) {
    const c = code(source, i);
    if (!Number.isFinite(c) || c < 32 && !(multiline && c === 10) || c >= 127 && c <= 159
        || c >= 0xd800 && c <= 0xdfff || c > 0x10ffff) return -1;
    bytes += c < 128 ? 1 : c < 2048 ? 2 : c < 65536 ? 3 : 4;
  }
  return bytes;
}
export function fieldOffset(source, field, start = 0) {
  for (let i = 0; i < field; i++) {
    const length = hex(source, start, 3);
    if (length < 0) return -1;
    start += 3 + length;
    if (start > size(source)) return -1;
  }
  return start;
}
export function field(source, index, start = 0) {
  const offset = fieldOffset(source, index, start);
  return part(source, offset + 3, offset + 3 + hex(source, offset, 3));
}
function fnv(hash, byte) {
  hash ^= byte;
  return (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
}
function hashRange(source, start, end, hash, reverse) {
  for (let i = reverse ? end - 1 : start; reverse ? i >= start : i < end; i += reverse ? -1 : 1) {
    const c = code(source, i);
    if (c >= 0xd800 && c <= 0xdfff || c > 0x10ffff || c < 0) throw Error("non-scalar hash input");
    if (c < 128) hash = fnv(hash, c);
    else if (reverse) {
      hash = fnv(hash, 0x80 | (c & 63));
      if (c >= 2048) hash = fnv(hash, 0x80 | ((c >> 6) & 63));
      if (c >= 65536) hash = fnv(hash, 0x80 | ((c >> 12) & 63));
      hash = fnv(hash, c < 2048 ? 0xc0 | (c >> 6) : c < 65536 ? 0xe0 | (c >> 12) : 0xf0 | (c >> 18));
    } else {
      hash = fnv(hash, c < 2048 ? 0xc0 | (c >> 6) : c < 65536 ? 0xe0 | (c >> 12) : 0xf0 | (c >> 18));
      if (c >= 65536) hash = fnv(hash, 0x80 | ((c >> 12) & 63));
      if (c >= 2048) hash = fnv(hash, 0x80 | ((c >> 6) & 63));
      hash = fnv(hash, 0x80 | (c & 63));
    }
  }
  return hash;
}
export function displayHash(record, profile, language) {
  const prefix = "D2" + profile + language, omitted = 3 + hex(record, 0, 3), length = size(record);
  let forward = hashRange(prefix, 0, prefix.length, 2166136261, false);
  forward = hashRange(record, 0, omitted, forward, false);
  forward = hashRange(record, omitted + 19, length, forward, false);
  let reverse = hashRange(record, omitted + 19, length, 3335557771, true);
  reverse = hashRange(record, 0, omitted, reverse, true);
  reverse = hashRange(prefix, 0, prefix.length, reverse, true);
  return fixed(forward, 8) + fixed(reverse, 8);
}
export function appearanceValid(record, profile, language, id, hashValue) {
  if (typeof record !== "string" || size(record) > 448 || textBytes(record) > 448) return false;
  let offset = 0;
  for (let i = 0; i < 5; i++) {
    const length = hex(record, offset, 3);
    if (length < 1 || offset + 3 + length > size(record)) return false;
    const bytes = textBytes(record, offset + 3, offset + 3 + length);
    if (bytes < 1 || bytes > (i === 0 ? 64 : i === 1 ? 16 : 96)) return false;
    if (i === 1 && (length !== 16 || hex(record, offset + 3, 8) < 0 || hex(record, offset + 11, 8) < 0)) return false;
    offset += 3 + length;
  }
  if (offset + 39 !== size(record) || hex(record, offset, 6) < 0 || hex(record, offset + 6, 6) < 0) return false;
  const mask = hex(record, offset + 36, 3);
  if (mask < 0) return false;
  for (let i = 0; i < 12; i++) {
    const label = fieldOffset(record, i < 4 ? 2 : i < 9 ? 3 : 4);
    const length = hex(record, label, 3), end = hex(record, offset + 12 + i * 2, 2);
    if (end < 0 || end > length || !(mask & (1 << i)) && end !== length) return false;
  }
  const embedded = field(record, 1);
  return (id === undefined || field(record, 0) === id) && (hashValue === undefined || embedded === hashValue)
    && embedded === displayHash(record, profile, language);
}
export function clipped(record, slot) {
  const offset = fieldOffset(record, slot < 4 ? 2 : slot < 9 ? 3 : 4), length = size(record);
  const end = hex(record, length - 27 + slot * 2, 2);
  return part(record, offset + 3, offset + 3 + end) + (hex(record, length - 3, 3) & (1 << slot) ? "…" : "");
}
export function departureValid(record, maximum) {
  if (typeof record !== "string" || record.length < 23 || record.length > 64) return false;
  const flags = hex(record, 0, 2), count = hex(record, 22, 1);
  if (flags < 0 || flags > 3 || count < 0 || count > maximum || !(flags & 1) && count !== 0
      || record.length !== 23 + count * 9 || hex(record, 2, 8) < 0
      || hex(record, 10, 1) < 0 || hex(record, 10, 1) > 3
      || hex(record, 11, 2) < 0 || hex(record, 11, 2) > 7
      || hex(record, 13, 1) < 0 || hex(record, 13, 1) > 3 || hex(record, 14, 8) < 0) return false;
  for (let i = 0; i < count; i++) {
    if (hex(record, 23 + i * 9, 8) < 0 || hex(record, 31 + i * 9, 1) < 0 || hex(record, 31 + i * 9, 1) > 3) return false;
  }
  return true;
}
export function trafficValid(fragments) {
  if (!Array.isArray(fragments) || fragments.length < 1 || fragments.length > 2) return false;
  if (trafficError(fragments)) return true;
  let totalBytes = 0;
  for (let i = 0; i < fragments.length; i++) {
    if (typeof fragments[i] !== "string") return false;
    const bytes = textBytes(fragments[i], 0, stringSize(fragments[i]), true);
    if (bytes < 1 || bytes > 640) return false;
    totalBytes += bytes;
  }
  if (totalBytes > 1280 || size(fragments) < 27 || hex(fragments, 0, 1) < 0
      || hex(fragments, 0, 1) > 3 || hex(fragments, 1, 8) < 0) return false;
  let offset = 18, totalLines = 0;
  for (let section = 0; section < 3; section++) {
    const expected = hex(fragments, 9 + section * 3, 3), length = hex(fragments, offset, 3);
    if (length < 0 || expected < 0 || expected > 544 || offset + 3 + length > size(fragments)) return false;
    const bytes = textBytes(fragments, offset + 3, offset + 3 + length, true);
    if (bytes < 0 || bytes > (section === 0 ? 192 : section === 1 ? 128 : 768)) return false;
    let lines = length ? 1 : 0;
    for (let i = offset + 3; i < offset + 3 + length; i++) if (code(fragments, i) === 10) lines++;
    if (lines !== expected) return false;
    totalLines += lines;
    offset += 3 + length;
  }
  return totalLines <= 544 && offset === size(fragments);
}
export function pages(fragments) {
  return fragments ? Math.max(1, Math.ceil((hex(fragments, 9, 3) + hex(fragments, 12, 3) + hex(fragments, 15, 3)) / 8)) : 1;
}
export function stale(record, now) {
  return !record || !(hex(record, 0, 2) & 1) || (hex(record, 0, 2) & 2) !== 0
    || now < hex(record, 2, 8) * 1000 || now - hex(record, 2, 8) * 1000 >= 60000;
}

export function epochValid(value, allowZero = false) {
  return typeof value === "string" && value.length === 15 && hex(value, 0, 7) >= 0 && hex(value, 7, 8) >= 0
    && (allowZero || value !== "000000000000000");
}
export function nextEpoch(value) {
  if (!epochValid(value, true)) return null;
  let high = hex(value, 0, 7), low = hex(value, 7, 8);
  if (low === 0xffffffff) {
    if (high === 0xfffffff) return null;
    high++; low = 0;
  } else low++;
  return fixed(high, 7) + fixed(low, 8);
}
export function messageIdValid(id, kind) {
  return typeof id === "string" && id.length === 24 && epochValid(id.slice(0, 15))
    && id.charAt(15) === kind && hex(id, 16, 8) > 0;
}
export function trafficError(fragments) {
  if (fragments.length !== 1 || typeof fragments[0] !== "string" || fragments[0].length !== 3
      || fragments[0].charAt(0) !== "e") return 0;
  const token = hex(fragments[0], 1, 2);
  return token >= 1 && token <= 7 && token !== 2 ? token : 0;
}
