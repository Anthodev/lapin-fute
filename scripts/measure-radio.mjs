import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const codec = require("../packages/companion/src/codec.js");
const contracts = require("../packages/companion/src/contracts.js");
const fixture = JSON.parse(readFileSync(
  new URL("../fixtures/departures/foundation.json", import.meta.url),
  "utf8"
));

function dictionarySize(dictionary) {
  const sizes = Object.values(dictionary).map((value) => (
    typeof value === "string" ? Buffer.byteLength(value, "utf8") + 1 : 4
  ));
  return 1 + (7 * sizes.length) + sizes.reduce((total, size) => total + size, 0);
}

const request = codec.encodeRequest({
  requestId: fixture.result.requestId,
  favoriteId: fixture.favorite.id,
  trigger: contracts.REQUEST_TRIGGER.APP_OPEN,
});
const response = codec.encodeResult(fixture.result);
const messages = [request, ...response];
const sizes = messages.map(dictionarySize);
const bytes = sizes.reduce((total, size) => total + size, 0);
const largestPhoneDictionaryBytes = Math.max(...sizes.slice(1));
const report = {
  fixture: "fixtures/departures/foundation.json",
  messages: messages.length,
  encodedBytes: bytes,
  requestBytes: sizes[0],
  largestPhoneDictionaryBytes,
  scenario: "steady-state APP_OPEN request plus two-departure result",
  budget: {
    messages: 7,
    encodedBytes: 2048,
    requestBytes: 192,
    phoneDictionaryBytes: 768,
  },
  pass: messages.length <= 7
    && bytes <= 2048
    && sizes[0] <= 192
    && largestPhoneDictionaryBytes <= 768,
};
console.log(JSON.stringify(report, null, 2));
if (!report.pass) process.exit(1);
