import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const companionSource = join(root, "packages/companion/src");
const pkjsTarget = join(root, "packages/watch/src/pkjs");
function optionalHttpsUrl(environment, name) {
  let parsed;
  const message = `${name} must be an absolute HTTPS URL`;
  if (!Object.prototype.hasOwnProperty.call(environment, name)) return "";
  if (typeof environment[name] !== "string" || environment[name].length === 0) {
    throw new TypeError(message);
  }
  try {
    parsed = new URL(environment[name]);
  } catch {
    throw new TypeError(message);
  }
  if (parsed.protocol !== "https:"
      || parsed.hostname.length === 0
      || parsed.username.length > 0
      || parsed.password.length > 0) throw new TypeError(message);
  return parsed.href;
}

export function readBuildConfiguration(environment) {
  return {
    configurationUrl: optionalHttpsUrl(environment, "LAPIN_FUTE_CONFIG_URL"),
  };
}

export function createBootstrap(configuration) {
  return `"use strict";\n\nvar createCompanion = require("./companion").createCompanion;\n\ncreateCompanion({\n  Pebble: Pebble,\n  storage: localStorage,\n  XHR: XMLHttpRequest,\n  clock: { now: Date.now },\n  defer: function (callback) { setTimeout(callback, 0); },\n  configurationUrl: ${JSON.stringify(configuration.configurationUrl)}\n});\n`;
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error?.code === "ENOENT") {
    console.error(command === "bun"
      ? "Bun is required to bundle the watch application. Make bun available on PATH, then rerun npm run build. Installation is intentionally user-managed."
      : `${command} is required but not installed. See docs/toolchain.md; installation is intentionally user-managed.`);
    process.exit(127);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function build() {
  const configuration = readBuildConfiguration(process.env);

  // test.mjs prepares canonical display copy before loading any watch modules.
  run(process.execPath, ["scripts/test.mjs"]);
  run(process.execPath, ["scripts/measure-radio.mjs"]);
  run("bun", ["scripts/bundle-watch.mjs"]);

  rmSync(pkjsTarget, { recursive: true, force: true });
  mkdirSync(pkjsTarget, { recursive: true });
  for (const source of readdirSync(companionSource)) {
    if (!source.endsWith(".js") && !source.endsWith(".json")) continue;
    cpSync(join(companionSource, source), join(pkjsTarget, source === "index.js" ? "companion.js" : source));
  }
  writeFileSync(join(pkjsTarget, "index.js"), createBootstrap(configuration));

  const watch = join(root, "packages/watch");
  run("pebble", ["clean"], watch);
  run("pebble", ["build"], watch);
  run(process.execPath, ["scripts/verify-watch-build.mjs"]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) build();
