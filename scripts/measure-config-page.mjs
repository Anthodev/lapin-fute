import { gzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BUDGET_BYTES = 200 * 1024;
const assets = [
  "../packages/config-page/src/config-core.js",
  "../packages/config-page/src/catalog-client.js",
  "../packages/config-page/src/preview-fixture.js",
  "../packages/config-page/src/line-badge-assets.js",
  "../packages/config-page/src/config-page.js",
  "../packages/config-page/styles/config-page.css",
];

const measurements = assets.map((relativePath) => {
  const path = fileURLToPath(new URL(relativePath, import.meta.url));
  return { relativePath, bytes: gzipSync(readFileSync(path), { level: 9 }).byteLength };
});
const totalBytes = measurements.reduce((total, entry) => total + entry.bytes, 0);

for (const entry of measurements) {
  process.stdout.write(`${entry.relativePath}: ${entry.bytes} gzip bytes\n`);
}
process.stdout.write(`config page JS+CSS: ${totalBytes} / ${BUDGET_BYTES} gzip bytes\n`);
if (totalBytes > BUDGET_BYTES) process.exitCode = 1;
