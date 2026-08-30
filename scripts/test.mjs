import { spawnSync } from "node:child_process";

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(process.execPath, [
  "--test",
  "packages/contracts/test/contracts.test.ts",
  "packages/backend/test/backend.test.ts",
  "packages/backend/test/catalog.test.ts",
  "packages/backend/test/catalog-import.test.ts",
  "packages/backend/test/catalog-http.test.ts",
  "packages/config-page/test/config-page.test.ts",
  "packages/companion/test/protocol.test.js",
  "packages/companion/test/companion.test.js",
  "packages/watch/test/manifest.test.js",
  "packages/watch/test/protocol.test.js",
  "packages/watch/test/message-queue.test.js",
  "packages/watch/test/model.test.js",
  "packages/watch/test/localization.test.js",
  "packages/watch/test/fixture-boot.test.js",
]);
