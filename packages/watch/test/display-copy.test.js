import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { copy } from "../src/generated/display-copy.js";

const { measured } = createRequire(import.meta.url)("../../companion/src/display-layout.js");

test("prepared updating headers fit both fresh and stale native fonts", () => {
  for (const profile of [0, 1]) for (const language of ["en", "fr"]) {
    const text = copy(profile, language, 3, 1);
    const width = profile ? 73 : 72;
    for (const role of [0, 1]) {
      const actual = measured(text, role);
      assert.ok(actual <= width, `${language} profile ${profile} role ${role}: ${actual}px exceeds ${width}px`);
    }
  }
});

test("overview countdown terminal labels fit full and compact native slots without shortening detail copy", () => {
  for (const profile of [0, 1]) for (const language of ["en", "fr"]) for (const token of [12, 13]) {
    const raw = copy(profile, language, token);
    assert.ok(measured(raw, 3) <= (profile ? 140 : 148));
    assert.ok(measured(raw, 1) <= (profile ? 56 : 63));
    for (const [role, width] of [[1, 42], [2, 36]]) {
      const text = copy(profile, language, token, role);
      if (measured(raw, 1) <= width) assert.equal(text, raw);
      else {
        assert.ok(text.endsWith("…"));
        assert.ok(raw.startsWith(text.slice(0, -1)));
      }
      assert.ok(measured(text, 1) <= width, `${language} profile ${profile} token ${token}: ${text} exceeds ${width}px`);
    }
  }
});

test("secondary departure status labels fit native detail columns while primary copy stays complete", () => {
  for (const profile of [0, 1]) for (const language of ["en", "fr"]) for (const token of [14, 15, 16]) {
    const raw = copy(profile, language, token);
    const text = copy(profile, language, token, 1);
    const width = profile ? 106 : 119;
    assert.ok(measured(raw, 1) <= (profile ? 176 : 184));
    if (measured(raw, 1) <= width) assert.equal(text, raw);
    else {
      assert.ok(text.endsWith("…"));
      assert.ok(raw.startsWith(text.slice(0, -1)));
    }
    assert.ok(measured(text, 1) <= width, `${language} profile ${profile} token ${token}: ${text} exceeds ${width}px`);
  }
});
