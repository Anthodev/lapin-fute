"use strict";

const { createFontMetrics } = require("./display-fonts.js");
const metrics = createFontMetrics(require("./display-font-metrics.json"));

// Phone offsets use UTF-16; lp3 lengths and watch clip endpoints use scalars.
// Reject lone surrogates rather than hashing/transporting replacement glyphs.
function scalarLength(text) {
  if (typeof text !== "string") throw new TypeError("Expected display text");
  let length = 0;
  for (let i = 0; i < text.length; length++) {
    const point = text.codePointAt(i);
    if (point >= 0xd800 && point <= 0xdfff) throw new TypeError("Non-scalar display text");
    i += point > 0xffff ? 2 : 1;
  }
  return length;
}

function utf8Bytes(text) {
  if (typeof text !== "string") throw new TypeError("Expected display text");
  let bytes = 0;
  for (let i = 0; i < text.length;) {
    const point = text.codePointAt(i);
    if (point >= 0xd800 && point <= 0xdfff) throw new TypeError("Non-scalar display text");
    bytes += point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
    i += point > 0xffff ? 2 : 1;
  }
  return bytes;
}

function fixed(value, width) {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isInteger(width) || width < 1) {
    throw new TypeError("Invalid fixed-width hex value");
  }
  let result = value.toString(16);
  if (result.length > width) throw new RangeError("Fixed-width hex overflow");
  while (result.length < width) result = "0" + result;
  return result;
}

function sourceBytes(text, maximum, multiline = false) {
  const bytes = utf8Bytes(text);
  const controls = multiline ? /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/ : /[\u0000-\u001f\u007f-\u009f]/;
  if (bytes > maximum || controls.test(text)) throw new TypeError("Invalid display text or source cap");
  return bytes;
}

// Roles follow the pinned table: regular14, bold14, bold18, bold36.
function measured(text, role) {
  if (!Number.isInteger(role) || role < 0 || role > 3) throw new RangeError("Unknown font role");
  sourceBytes(text, 387);
  const width = metrics.measure(text, role).width;
  if (width >= 10000) throw new RangeError("Native measurement envelope reached");
  return width;
}

function endpoints(text, start, end) {
  const result = [start];
  for (let i = start; i < end;) {
    i += text.codePointAt(i) > 0xffff ? 2 : 1;
    result.push(i);
  }
  return result;
}

// Same binary prefix search as the native-calibrated preparation algorithm.
function prefix(text, start, end, role, width, suffix = "") {
  const ends = endpoints(text, start, end);
  let low = suffix ? 0 : 1, high = ends.length - 1, fitted = start;
  while (low <= high) {
    const middle = low + Math.floor((high - low) / 2), position = ends[middle];
    if (measured(text.slice(start, position) + suffix, role) <= width) {
      fitted = position;
      low = middle + 1;
    } else high = middle - 1;
  }
  return fitted;
}

function clip(text, role, width) {
  sourceBytes(text, 384);
  if (!Number.isFinite(width) || width < 0) throw new RangeError("Invalid clip width");
  if (measured(text, role) <= width) return { end: text.length, ellipsis: false };
  if (measured("…", role) > width) throw new RangeError("Role cannot display ellipsis");
  return { end: prefix(text, 0, text.length, role, width, "…"), ellipsis: true };
}

function wrap(text, role, width) {
  sourceBytes(text, 384, true);
  if (!Number.isInteger(role) || role < 0 || role > 3 || !Number.isFinite(width) || width <= 0) {
    throw new RangeError("Invalid wrapping role or width");
  }
  // Domain traffic permits horizontal tabs; packed text permits LF only.
  if (text.indexOf("\t") >= 0) text = text.replace(/\t/g, " ");
  const lines = [];
  let start = 0;
  while (start < text.length) {
    let hardEnd = text.indexOf("\n", start);
    if (hardEnd < 0) hardEnd = text.length;
    if (start === hardEnd) { lines.push(""); start++; continue; }
    let end = hardEnd;
    if (measured(text.slice(start, hardEnd), role) > width) {
      end = prefix(text, start, hardEnd, role, width);
      if (end < hardEnd) {
        let word = end;
        while (word > start && text.charCodeAt(word - 1) !== 32 && text.charCodeAt(word - 1) !== 9) word--;
        if (word > start) end = word - 1;
        else if (end === start) end = start + (text.codePointAt(start) > 0xffff ? 2 : 1);
      }
    }
    lines.push(text.slice(start, end));
    start = end;
    while (start < hardEnd && (text.charCodeAt(start) === 32 || text.charCodeAt(start) === 9)) start++;
    if (start === hardEnd && hardEnd < text.length) start++;
  }
  if (text.endsWith("\n")) lines.push("");
  return lines.join("\n");
}

function lp3(text) {
  return fixed(scalarLength(text), 3) + text;
}

function hashByte(hash, byte) {
  hash ^= byte;
  return (hash + (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24)) >>> 0;
}

// Reverse lane reverses BYTES, not codepoints. Each lane scans UTF-16 once.
function hashLane(text, reverse) {
  let hash = reverse ? 3335557771 : 2166136261;
  let i = reverse ? text.length : 0;
  while (reverse ? i > 0 : i < text.length) {
    if (reverse) {
      i--;
      const unit = text.charCodeAt(i);
      if (unit >= 0xdc00 && unit <= 0xdfff) i--;
    }
    const point = text.codePointAt(i);
    if (point < 128) hash = hashByte(hash, point);
    else if (reverse) {
      hash = hashByte(hash, 0x80 | (point & 63));
      if (point >= 2048) hash = hashByte(hash, 0x80 | ((point >> 6) & 63));
      if (point >= 65536) hash = hashByte(hash, 0x80 | ((point >> 12) & 63));
      hash = hashByte(hash, point < 2048 ? 0xc0 | (point >> 6) : point < 65536 ? 0xe0 | (point >> 12) : 0xf0 | (point >> 18));
    } else {
      hash = hashByte(hash, point < 2048 ? 0xc0 | (point >> 6) : point < 65536 ? 0xe0 | (point >> 12) : 0xf0 | (point >> 18));
      if (point >= 65536) hash = hashByte(hash, 0x80 | ((point >> 12) & 63));
      if (point >= 2048) hash = hashByte(hash, 0x80 | ((point >> 6) & 63));
      hash = hashByte(hash, 0x80 | (point & 63));
    }
    if (!reverse) i += point > 0xffff ? 2 : 1;
  }
  return fixed(hash, 8);
}

// Domain routing, displayName and sortOrder are deliberately not hash inputs.
function prepareAppearance(favorite, profile, language) {
  if ((profile !== 0 && profile !== 1) || (language !== "en" && language !== "fr")) {
    throw new TypeError("Invalid appearance profile or language");
  }
  for (const key of ["id", "lineLabel", "stopLabel", "destinationLabel"]) {
    if (sourceBytes(favorite[key], key === "id" ? 64 : 96) === 0) throw new TypeError("Empty appearance label");
  }
  const hasBackground = favorite.lineColor !== undefined, hasForeground = favorite.lineTextColor !== undefined;
  if (hasBackground !== hasForeground || (hasBackground && (!/^#[0-9a-f]{6}$/.test(favorite.lineColor)
      || !/^#[0-9a-f]{6}$/.test(favorite.lineTextColor)))) throw new TypeError("Invalid appearance colors");
  const widths = [28, 36, 38, profile ? 73 : 72, profile ? 96 : 84, profile ? 83 : 71,
    profile ? 67 : 84, profile ? 54 : 71, profile ? 116 : 132, profile ? 86 : 74, profile ? 73 : 61, profile ? 106 : 122];
  let ends = "", mask = 0;
  for (let slot = 0; slot < 12; slot++) {
    const label = slot < 4 ? favorite.lineLabel : slot < 9 ? favorite.stopLabel : favorite.destinationLabel;
    const fit = clip(label, slot === 3 || slot >= 9 ? 0 : 1, widths[slot]);
    ends += fixed(scalarLength(label.slice(0, fit.end)), 2);
    if (fit.ellipsis) mask |= 1 << slot;
  }
  const id = lp3(favorite.id);
  const content = lp3(favorite.lineLabel) + lp3(favorite.stopLabel) + lp3(favorite.destinationLabel)
    + (hasBackground ? favorite.lineColor.slice(1) : "52616f")
    + (hasForeground ? favorite.lineTextColor.slice(1) : "ffffff") + ends + fixed(mask, 3);
  const hashInput = "D2" + profile + language + id + content;
  const record = id + lp3(hashLane(hashInput, false) + hashLane(hashInput, true)) + content;
  if (utf8Bytes(record) > 448) throw new RangeError("Appearance record cap");
  return record;
}

function linesCount(text) {
  let lines = text ? 1 : 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return lines;
}

function prepareTraffic(palette, checkedAt, title, validity, body, profile) {
  if (!Number.isInteger(palette) || palette < 0 || palette > 3
      || !Number.isInteger(checkedAt) || checkedAt < 0 || checkedAt > 0xffffffff
      || (profile !== 0 && profile !== 1)) throw new TypeError("Invalid traffic header");
  sourceBytes(title, 96, true);
  sourceBytes(validity, 64, true);
  sourceBytes(body, 384, true);
  const width = profile ? 176 : 180;
  const sections = [wrap(title, 1, width), wrap(validity, 0, width), wrap(body, 0, width)];
  const caps = [192, 128, 768], counts = sections.map(linesCount);
  for (let i = 0; i < 3; i++) if (utf8Bytes(sections[i]) > caps[i]) throw new RangeError("Wrapped section cap");
  if (counts[0] + counts[1] + counts[2] > 544) throw new RangeError("Traffic line count cap");
  const document = fixed(palette, 1) + fixed(checkedAt, 8)
    + counts.map(count => fixed(count, 3)).join("") + sections.map(lp3).join("");
  if (utf8Bytes(document) > 1280) throw new RangeError("Traffic document cap");
  const fragments = [];
  let start = 0, bytes = 0;
  for (let i = 0; i < document.length;) {
    const point = document.codePointAt(i), count = point < 128 ? 1 : point < 2048 ? 2 : point < 65536 ? 3 : 4;
    if (bytes + count > 640) { fragments.push(document.slice(start, i)); start = i; bytes = 0; }
    bytes += count;
    i += point > 0xffff ? 2 : 1;
  }
  fragments.push(document.slice(start));
  if (fragments.length > 2) throw new RangeError("Traffic fragment count cap");
  return fragments;
}

module.exports = { measured, clip, wrap, prepareAppearance, prepareTraffic, fixed, scalarLength, utf8Bytes };
