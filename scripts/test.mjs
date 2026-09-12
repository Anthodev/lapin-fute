import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateDisplayCopy } from "./generate-display-copy.mjs";

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const root = fileURLToPath(new URL("..", import.meta.url));
generateDisplayCopy();
const suites = [];
for (const entry of readdirSync(join(root, "packages"), { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const testDirectory = join(root, "packages", entry.name, "test");
  if (!existsSync(testDirectory)) continue;
  for (const file of readdirSync(testDirectory, { withFileTypes: true })) {
    if (file.isFile() && /\.test\.(js|ts)$/u.test(file.name)) {
      suites.push(join("packages", entry.name, "test", file.name));
    }
  }
}

run(process.execPath, ["--test", ...suites.sort()]);
