import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
    backendUrl: optionalHttpsUrl(environment, "LAPIN_FUTE_BACKEND_URL"),
    configurationUrl: optionalHttpsUrl(environment, "LAPIN_FUTE_CONFIG_URL"),
  };
}

export function createBootstrap(configuration) {
  return `"use strict";\n\nvar createCompanion = require("./companion").createCompanion;\n\ncreateCompanion({\n  Pebble: Pebble,\n  storage: localStorage,\n  XHR: XMLHttpRequest,\n  clock: { now: Date.now },\n  defer: function (callback) { setTimeout(callback, 0); },\n  readyDefer: function (callback) { setTimeout(callback, 250); },\n  backendUrl: ${JSON.stringify(configuration.backendUrl)},\n  configurationUrl: ${JSON.stringify(configuration.configurationUrl)}\n});\n`;
}

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error?.code === "ENOENT") {
    console.error(`${command} is required but not installed. See docs/toolchain.md; installation is intentionally user-managed.`);
    process.exit(127);
  }
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

function build() {
  const configuration = readBuildConfiguration(process.env);

  run(process.execPath, ["scripts/test.mjs"]);
  run(process.execPath, ["scripts/measure-radio.mjs"]);

  rmSync(pkjsTarget, { recursive: true, force: true });
  mkdirSync(pkjsTarget, { recursive: true });
  for (const source of ["contracts.js", "codec.js", "configuration.js", "message-queue.js"]) {
    cpSync(join(companionSource, source), join(pkjsTarget, basename(source)));
  }
  cpSync(join(companionSource, "index.js"), join(pkjsTarget, "companion.js"));
  writeFileSync(join(pkjsTarget, "index.js"), createBootstrap(configuration));

  const watch = join(root, "packages/watch");
  run("pebble", ["clean"], watch);
  run("pebble", ["build"], watch);
  run(process.execPath, ["scripts/verify-watch-build.mjs"]);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) build();
