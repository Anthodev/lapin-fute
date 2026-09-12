import { fileURLToPath } from "node:url";
import { generateDisplayCopy } from "./generate-display-copy.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
generateDisplayCopy();
const result = await Bun.build({
  root,
  entrypoints: [root + "/packages/watch/src/embeddedjs/main.js"],
  outdir: root + "/packages/watch/src/generated",
  naming: "main.js",
  target: "browser",
  format: "esm",
  external: ["pebble/*", "piu/*", "timer"],
  minify: { identifiers: true, syntax: true, whitespace: false }
});

if (!result.success) {
  for (const message of result.logs) console.error(message);
  process.exit(1);
}
