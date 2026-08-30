import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  APP_MESSAGE_KEY,
  APP_MESSAGE_KEY_ORDER
} from "../packages/contracts/src/index.ts";

const packagePath = new URL("../packages/watch/package.json", import.meta.url);
const generatedPath = new URL(
  "../packages/watch/build/js/message_keys.json",
  import.meta.url
);

function assertExactMap(actual, source) {
  const entries = Object.entries(actual).sort((left, right) => left[1] - right[1]);
  if (entries.length !== APP_MESSAGE_KEY_ORDER.length) {
    throw new Error(`${source} must contain exactly 25 AppMessage aliases`);
  }
  entries.forEach(([name, value], index) => {
    if (name !== APP_MESSAGE_KEY_ORDER[index] || value !== APP_MESSAGE_KEY[name]) {
      throw new Error(
        `${source} AppMessage mismatch at ${index}: expected ${APP_MESSAGE_KEY_ORDER[index]}=${index}`
      );
    }
  });
}

export function verifyWatchBuild() {
  const packageMetadata = JSON.parse(readFileSync(packagePath, "utf8"));
  const generated = JSON.parse(readFileSync(generatedPath, "utf8"));
  assertExactMap(packageMetadata.pebble.messageKeys, "packages/watch/package.json");
  assertExactMap(generated, "packages/watch/build/js/message_keys.json");
  return {
    aliases: APP_MESSAGE_KEY_ORDER.length,
    first: APP_MESSAGE_KEY_ORDER[0],
    last: APP_MESSAGE_KEY_ORDER[APP_MESSAGE_KEY_ORDER.length - 1]
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(verifyWatchBuild()));
}
