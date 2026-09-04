import test from "node:test";
import assert from "node:assert/strict";
import { watchModule } from "./xs-host.js";
const {
  unsigned, code, size, part, hex, fixed, textBytes, fieldOffset, field,
  displayHash, appearanceValid, clipped, departureValid, trafficValid,
  trafficError, pages, stale
} = await watchModule("packed");
import { NOW, appearance, departure, trafficDocument, scalars } from "./d2-records.js";

test("appearance records round trip and validate", () => {
  const record = appearance({ id: "home:rer:a" });
  assert(appearanceValid(record, 0, "fr"));
  assert.equal(field(record, 0), "home:rer:a");
  assert.equal(field(record, 1), displayHash(record, 0, "fr"));
  // The embedded hash binds profile, language and body; anything else rejects.
  assert(!appearanceValid(record, 1, "fr"));
  assert(!appearanceValid(record, 0, "en"));
  assert(!appearanceValid(record, 0, "fr", "other:id"));
  assert(!appearanceValid(record, 0, "fr", undefined, "0".repeat(16)));
  // Corrupting the hash field or dropping the mask breaks validation.
  const start = 3 + field(record, 0).length;
  assert(!appearanceValid(record.slice(0, start + 3) + "0".repeat(16) + record.slice(start + 19), 0, "fr"));
  assert(!appearanceValid(record + "0", 0, "fr"));
});

test("displayHash pins scalar semantics across profiles and languages", () => {
  const flag = appearance({ id: "flag:😀:id", line: "🇫🇷", stop: "Gare 😀", destination: "Pré-Saint-Gervais" });
  assert(appearanceValid(flag, 0, "fr"));
  assert.equal(scalars("🇫🇷"), 2);
  assert.equal(textBytes("🇫🇷"), 8);
  assert.equal(textBytes("😀"), 4);
  const points = Array.from(flag), omitted = 3 + parseInt(flag.slice(0, 3), 16);
  const bytes = Buffer.from("D20fr" + points.slice(0, omitted).join("") + points.slice(omitted + 19).join(""), "utf8");
  const lane = (input, seed) => input.reduce((hash, byte) => Math.imul(hash ^ byte, 16777619) >>> 0, seed)
    .toString(16).padStart(8, "0");
  const expected = lane(bytes, 2166136261) + lane(bytes.reverse(), 3335557771);
  assert.equal(displayHash(flag, 0, "fr"), expected);
  assert.equal(field(flag, 1), expected);
  // Same content under a different profile or language hashes differently.
  assert.notEqual(displayHash(flag, 1, "fr"), field(flag, 1));
  assert.notEqual(displayHash(flag, 0, "en"), field(flag, 1));
});

test("clipped honours scalar endpoints and the ellipsis mask", () => {
  const line = "L😀igne 13";
  const stop = "Saint-Lazare", destination = "Montfermeil";
  const full = scalars(line);
  const ends = [2, full, full, 2,
    scalars(stop), scalars(stop), scalars(stop), scalars(stop), scalars(stop),
    scalars(destination), scalars(destination), scalars(destination)];
  const mask = (1 << 0) | (1 << 3);
  const record = appearance({ id: "clip:id", line, stop, ends, mask });
  assert(appearanceValid(record, 0, "fr"));
  assert.equal(clipped(record, 0), "L😀…");
  assert.equal(clipped(record, 3), "L😀…");
  // Unmasked slots must keep the full label.
  assert.equal(clipped(record, 1), line);
  assert.equal(clipped(record, 4), stop);
  const shortened = appearance({ id: "clip:id", line, stop, ends, mask: 0 });
  assert(!appearanceValid(shortened, 0, "fr"), "shortened ends without mask bits reject");
});

test("departure records validate bounds and pairing", () => {
  const good = departure({});
  assert(departureValid(good, 1));
  assert(!departureValid(good, 0), "count above the dataset maximum rejects");
  const empty = departure({ hasData: false });
  assert(departureValid(empty, 1));
  const staleForced = "03" + good.slice(2);
  assert(departureValid(staleForced, 1));
  assert(!departureValid("04" + good.slice(2), 1), "unknown flag bits reject");
  assert(stale(staleForced, NOW));
  assert(!stale(good, NOW));
  assert(!stale(good, NOW + 59999));
  assert(stale(good, NOW + 60000), "the exact sixty-second boundary is stale");
  assert(stale(good, NOW - 1), "a future fetchedAt is stale");
  assert(stale(null, NOW));
  assert(!departureValid("01" + good.slice(2, 22) + "2" + good.slice(23), 4), "declared count must match the pair count");
  assert(!departureValid(good + "0", 1));
});

test("traffic documents validate section counts and bounds", () => {
  const document = trafficDocument({});
  assert(trafficValid(document));
  assert.equal(pages(document), 1);
  const long = trafficDocument({ body: Array.from({ length: 30 }, (_, i) => `Ligne ${i}`).join("\n") });
  assert(trafficValid(long));
  assert.equal(pages(long), Math.ceil((1 + 1 + 30) / 8));
  // Line counts must match LF structure exactly.
  const mismatched = trafficDocument({ title: "a\nb" });
  const broken = mismatched[0];
  const titleCount = parseInt(broken.slice(9, 12), 16);
  assert.equal(titleCount, 2);
  const offByOne = broken.slice(0, 9) + "001" + broken.slice(12);
  assert(!trafficValid([offByOne]));
  // Error union accepts only the exact legal tokens.
  for (const token of [1, 3, 4, 5, 6, 7]) assert(trafficValid(["e" + fixed(token, 2)]));
  for (const value of ["e00", "e02", "e08", "E05", "e0A", "e5", "e005", "e05x"]) assert(!trafficValid([value]));
  assert(!trafficValid(["e05", "x"]));
  assert.equal(trafficError(["e05"]), 5);
  assert.equal(trafficError(["e02"]), 0);
  assert.equal(trafficError([document[0]]), 0);
  // A valid document can cross the fragment seam, but neither fragment may exceed 640 bytes.
  const split = trafficDocument({ title: "A", validity: "B", body: Array(27).fill("b".repeat(25)).join("\n") })[0];
  assert(trafficValid([split.slice(0, 640), split.slice(640)]));
  assert(!trafficValid([split.slice(0, 641), split.slice(641)]));
  assert(!trafficValid([split]));
  const oversizedBody = trafficDocument({ title: "A", validity: "B", body: "b".repeat(769) })[0];
  assert(!trafficValid([oversizedBody.slice(0, 640), oversizedBody.slice(640)]));
  assert(!trafficValid([]));
  assert(!trafficValid(["e05", "e05"]));
});

test("packed primitives count scalars, not UTF-16 units", () => {
  assert.equal(unsigned(5), true);
  assert.equal(unsigned(-1), false);
  assert.equal(unsigned(1.5), false);
  assert.equal(unsigned(0xffffffff), true);
  assert.equal(unsigned(0x100000000), false);
  const text = "a😀b";
  assert.equal(size(text), 3);
  assert.equal(code(text, 1), 0x1f600);
  assert.equal(code(text, 3), NaN);
  assert.equal(part(text, 0, 2), "a😀");
  assert.equal(fixed(0xab, 4), "00ab");
  assert.equal(hex("0a0f", 0, 4), 0x0a0f);
  assert.equal(hex("0g", 0, 2), -1);
  const record = appearance({ id: "prim:id" });
  assert.equal(fieldOffset(record, 1), 3 + field(record, 0).length);
  assert.equal(textBytes("a\nd", 0, 3), -1, "controls reject without multiline");
  assert.equal(textBytes("a\nd", 0, 3, true), 3);
  assert.equal(textBytes("\ud800"), -1, "lone surrogates reject");
});

