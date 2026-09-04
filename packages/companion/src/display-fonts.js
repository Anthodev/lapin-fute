"use strict";

// Pebble SDK 4.33.1, Emery/Gabbro firmware Gothic 14, 14 Bold, 18 Bold, 36 Bold.
// Advances are shared across both firmware images. Logical layout follows
// toolchain/moddable/modules/piu/Pebble/piuFont.c and sdk-core/pebble/common/tools/font/fontgen.py.
// Canonical display-font-metrics.json: 9057 bytes; SHA-256
// 271229905bd286b822454c4aac7c4a90be6edba33e0551bf10d59d3db26a3ea9.
// The helper models native formatting, spacing, fallback and Arabic lam-alef
// consumption. No font data or iterative text fitting runs on the watch.
function createFontMetrics(data) {
  const widths = new Map();
  for (const [vector, characters] of data.groups) {
    for (const character of characters) widths.set(character.codePointAt(0), vector);
  }
  const formatting = new Set([0x7f, 0x200c, 0x200d, 0x200e, 0x200f,
    0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x20e3, 0xfe0e, 0xfe0f, 0xfeff, 0xfffc]);
  function skip(c) {
    return formatting.has(c) || (c < 32 && c !== 10) || (c >= 128 && c <= 159) ||
      (c >= 0x2061 && c <= 0x206f) || (c >= 0xfff9 && c <= 0xfffb) ||
      (c >= 0xe0000 && c <= 0xe007f) || (c >= 0xf0000 && c <= 0x10fffd) ||
      (c >= 0x1f3fb && c <= 0x1f3ff);
  }
  function transparent(c) {
    return (c >= 0x610 && c <= 0x61a) || (c >= 0x64b && c <= 0x65f) || c === 0x670 ||
      (c >= 0x6d6 && c <= 0x6ed && ((0xf67e7f >>> (c - 0x6d6)) & 1) !== 0);
  }
  function glyphWidth(c, role) { return (widths.get(c) || data.fallback)[role]; }
  function measure(text, role) {
    const height = data.heights[role];
    // XS stores NUL as modified UTF-8; firmware rejects that complete string.
    if (text.includes('\0')) return { width: 0, height };
    const points = [];
    for (const character of text) {
      const c = character.codePointAt(0);
      if (!skip(c)) points.push(c);
    }
    let cursor = 0, extent = 0, maximum = 0;
    for (let i = 0; i < points.length; i++) {
      const c = points[i];
      if (c === -1) continue;
      if (c === 10) {
        maximum = Math.max(maximum, extent);
        cursor = extent = 0;
        continue;
      }
      // Relevant fonts contain no Arabic or Arabic presentation-form glyphs.
      // Their shaped forms all share the wildcard advance. Only consumed
      // lam-alef pairs change width; transparent marks keep their own advance.
      if (c === 0x644) {
        let j = i + 1;
        while (j < points.length && transparent(points[j])) j++;
        if ([0x622, 0x623, 0x625, 0x627].includes(points[j])) points[j] = -1;
      }
      let width = glyphWidth(c, role), advance = width;
      switch (c) {
        case 0x00a0: width = advance = glyphWidth(32, role); break;
        case 0x200b: case 0x2060: advance = 0; break;
        case 0x2000: case 0x2002: width = advance = Math.floor(height / 2); break;
        case 0x2001: case 0x2003: case 0x3000: width = advance = height; break;
        case 0x2004: width = advance = Math.floor(height / 3); break;
        case 0x2005: width = advance = Math.floor(height / 4); break;
        case 0x2006: width = advance = Math.floor(height / 6); break;
        case 0x2007: width = advance = glyphWidth(48, role); break;
        case 0x2008: width = advance = glyphWidth(46, role); break;
        case 0x2009: case 0x202f: width = advance = Math.floor(height / 5); break;
        case 0x200a: width = advance = Math.max(1, Math.floor(height / 12)); break;
        case 0x205f: width = advance = Math.floor(4 * height / 18); break;
      }
      extent = cursor + width;
      cursor += advance;
    }
    return { width: Math.max(maximum, extent), height };
  }
  return { measure, glyphWidth };
}

module.exports = { createFontMetrics };
