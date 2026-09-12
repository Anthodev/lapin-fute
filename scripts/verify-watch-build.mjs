import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { APP_MESSAGE_KEYS } from "../packages/contracts/src/index.ts";

const packagePath = new URL("../packages/watch/package.json", import.meta.url);
const generatedPath = new URL(
  "../packages/watch/build/js/message_keys.json",
  import.meta.url
);

function assertExactMap(actual, source) {
  const expected = Object.entries(APP_MESSAGE_KEYS);
  if (actual === null || typeof actual !== "object" || Array.isArray(actual)
      || Object.keys(actual).length !== expected.length) {
    throw new Error(`${source} must contain exactly ${expected.length} AppMessage aliases`);
  }
  for (const [name, value] of expected) {
    if (!Object.hasOwn(actual, name) || actual[name] !== value) {
      throw new Error(`${source} AppMessage mismatch: expected ${name}=${value}`);
    }
  }
}

export function verifyWatchBuild() {
  const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));
  const generated = JSON.parse(readFileSync(generatedPath, "utf8"));
  assertExactMap(packageMetadata.pebble.messageKeys, "packages/watch/package.json");
  assertExactMap(generated, "packages/watch/build/js/message_keys.json");
  const aliases = Object.entries(APP_MESSAGE_KEYS).sort((left, right) => left[1] - right[1]);
  return {
    aliases: aliases.length,
    first: aliases[0][0],
    last: aliases[aliases.length - 1][0]
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(verifyWatchBuild()));
}
