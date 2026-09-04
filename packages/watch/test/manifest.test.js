import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  APP_MESSAGE_INBOX_BYTES as WATCH_MESSAGE_INBOX_BYTES,
  APP_MESSAGE_KEY_MAP as WATCH_MESSAGE_KEY_MAP,
  APP_MESSAGE_OUTBOX_BYTES as WATCH_MESSAGE_OUTBOX_BYTES,
  LANGUAGE as WATCH_LANGUAGE
} from "../src/embeddedjs/contracts.js";
import {
  APP_MESSAGE_KEY as CANONICAL_MESSAGE_KEY,
  APP_MESSAGE_KEY_ORDER as CANONICAL_MESSAGE_KEY_ORDER,
  WIRE_LANGUAGE as CANONICAL_LANGUAGE
} from "../../contracts/src/index.ts";

const require = createRequire(import.meta.url);
const companionContracts = require("../../companion/src/contracts.js");
const watchRoot = fileURLToPath(new URL("..", import.meta.url));
const packageMetadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const embeddedPackageMetadata = JSON.parse(
  readFileSync(new URL("../src/embeddedjs/package.json", import.meta.url), "utf8")
);
const testPackageMetadata = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const manifest = JSON.parse(readFileSync(new URL("../src/embeddedjs/manifest.json", import.meta.url), "utf8"));
const wscript = readFileSync(new URL("../wscript", import.meta.url), "utf8");
const mdblSource = readFileSync(new URL("../src/c/mdbl.c", import.meta.url), "utf8");
const expectedModules = [
  "./main",
  "./controller",
  "./model",
  "./protocol",
  "./message-queue",
  "./localization",
  "./presentation",
  "./storage",
  "./ui",
  "./contracts"
];

function moduleSource(name) {
  return readFileSync(new URL("../src/embeddedjs/" + name.slice(2) + ".js", import.meta.url), "utf8");
}

function xsArenaBytes(field) {
  const constant = `XS_${field.toUpperCase()}_BYTES`;
  const match = mdblSource.match(
    new RegExp(`^#define ${constant} \\((\\d+)U \\* (512|1024)U\\)$`, "mu")
  );
  assert.notEqual(match, null, `${constant} must be an explicit allocation`);
  return Number(match[1]) * Number(match[2]);
}

test("watch package is one multi-module Alloy app for emery and gabbro", () => {
  assert.equal(packageMetadata.pebble.projectType, "moddable");
  assert.equal(packageMetadata.pebble.enableMultiJS, true);
  assert.deepEqual(packageMetadata.pebble.targetPlatforms, ["emery", "gabbro"]);
  assert.deepEqual(packageMetadata.pebble.resources, { media: [] });
  assert.deepEqual(packageMetadata.pebble.capabilities, ["configurable"]);
  assert.equal(existsSync(new URL("../appinfo.json", import.meta.url)), false);
  assert.deepEqual(readdirSync(watchRoot + "/src/c").sort(), ["mdbl.c"]);
});

test("Alloy bootstrap uses one bounded explicit XS creation record", () => {
  const arenas = {
    stack: xsArenaBytes("stack"),
    slot: xsArenaBytes("slot"),
    chunk: xsArenaBytes("chunk")
  };
  const arenaValues = Object.values(arenas);
  const arenaTotal = arenaValues.reduce((total, bytes) => total + bytes, 0);

  assert.equal(arenaValues.every((bytes) => bytes > 0), true);
  assert.equal(arenaTotal, 56 * 1024);
  assert.equal(arenaTotal > 32 * 1024, true, "record must exceed the firmware static default");
  assert.equal(arenaTotal <= 56 * 1024, true, "record must fit the frozen RAM budget");

  const records = [
    ...mdblSource.matchAll(/ModdableCreationRecord\s+creation\s*=\s*\{([\s\S]*?)\};/gu)
  ];
  assert.equal(records.length, 1);
  const record = records[0][1];
  assert.match(record, /\.recordSize\s*=\s*sizeof\(creation\)\s*,/u);
  for (const field of Object.keys(arenas)) {
    const constant = `XS_${field.toUpperCase()}_BYTES`;
    assert.match(record, new RegExp(`\\.${field}\\s*=\\s*${constant}\\s*,`, "u"));
  }
  assert.match(record, /\.flags\s*=\s*XS_CREATION_FLAGS\s*,/u);
  assert.match(
    mdblSource,
    /\(kModdableCreationFlagDebug \| kModdableCreationFlagLogInstrumentation\)/u
  );
  assert.match(mdblSource, /#else\s+#define XS_CREATION_FLAGS 0U\s+#endif/u);
  assert.equal((mdblSource.match(/\bmoddable_createMachine\s*\(/gu) ?? []).length, 1);
  assert.match(mdblSource, /\bmoddable_createMachine\s*\(\s*&creation\s*\)\s*;/u);
  assert.doesNotMatch(mdblSource, /\bmoddable_createMachine\s*\(\s*(?:NULL|0)\s*\)/u);
});

test("Node package boundaries keep generated webpack CommonJS and embedded/test JS ESM", () => {
  assert.equal(packageMetadata.type, "commonjs");
  assert.equal(embeddedPackageMetadata.type, "module");
  assert.equal(testPackageMetadata.type, "module");
});

test("Waf builds every target before bundling generated PKJS into one package", () => {
  assert.match(wscript, /for platform in ctx\.env\.TARGET_PLATFORMS:/u);
  assert.match(wscript, /ctx\.pbl_build\(source=ctx\.path\.ant_glob\('src\/c\/\*\*\/\*\.c'\)/u);
  assert.match(wscript, /ctx\.pbl_bundle\(binaries=binaries,/u);
  assert.match(wscript, /'src\/pkjs\/\*\*\/\*\.js'/u);
  assert.match(wscript, /js_entry_file='src\/pkjs\/index\.js'/u);
});

test("Alloy Message receives frozen keys and shared buffer bounds", () => {
  const source = moduleSource("./main");
  const expectedEntries = CANONICAL_MESSAGE_KEY_ORDER.map((alias) => [
    alias,
    CANONICAL_MESSAGE_KEY[alias]
  ]);

  assert.equal(WATCH_MESSAGE_KEY_MAP instanceof Map, true);
  assert.equal(Array.isArray(WATCH_MESSAGE_KEY_MAP), false);
  assert.deepEqual([...WATCH_MESSAGE_KEY_MAP], expectedEntries);
  assert.equal(WATCH_MESSAGE_INBOX_BYTES, 768);
  assert.equal(WATCH_MESSAGE_OUTBOX_BYTES, 192);
  assert.match(source, /keys:\s*APP_MESSAGE_KEY_MAP/u);
  assert.match(source, /input:\s*APP_MESSAGE_INBOX_BYTES/u);
  assert.match(source, /output:\s*APP_MESSAGE_OUTBOX_BYTES/u);
  assert.doesNotMatch(source, /keys:\s*APP_MESSAGE_KEY_ORDER/u);
  assert.doesNotMatch(source, /\bformat\s*:/u);
});

test("package, canonical, companion, and embedded numeric maps are identical", () => {
  assert.deepEqual(packageMetadata.pebble.messageKeys, CANONICAL_MESSAGE_KEY);
  assert.deepEqual(
    Object.fromEntries(WATCH_MESSAGE_KEY_MAP),
    CANONICAL_MESSAGE_KEY
  );
  assert.deepEqual(companionContracts.APP_MESSAGE_KEY, CANONICAL_MESSAGE_KEY);
  assert.deepEqual([...WATCH_MESSAGE_KEY_MAP.keys()], CANONICAL_MESSAGE_KEY_ORDER);
  assert.deepEqual(companionContracts.APP_MESSAGE_KEY_ORDER, CANONICAL_MESSAGE_KEY_ORDER);
  assert.deepEqual(WATCH_LANGUAGE, CANONICAL_LANGUAGE);
  assert.deepEqual(companionContracts.WIRE_LANGUAGE, CANONICAL_LANGUAGE);
  assert.deepEqual(
    Object.entries(packageMetadata.pebble.messageKeys)
      .sort((left, right) => left[1] - right[1])
      .map((entry) => entry[0]),
    CANONICAL_MESSAGE_KEY_ORDER
  );
  assert.deepEqual(
    Object.values(packageMetadata.pebble.messageKeys).sort((left, right) => left - right),
    Array.from({ length: 25 }, (_, index) => index)
  );
});

test("manifest declares every embedded module and no FFI or watch network module", () => {
  assert.deepEqual(manifest.include, [
    "$(MODDABLE)/examples/manifest_mod.json",
    "$(MODDABLE)/examples/manifest_typings.json"
  ]);
  assert.deepEqual(manifest.modules["*"], expectedModules);
  assert.equal(Object.prototype.hasOwnProperty.call(manifest, "ffi"), false);

  const declared = new Set(expectedModules);
  const bareImports = new Set();
  expectedModules.forEach((name) => {
    const source = moduleSource(name);
    const imports = source.matchAll(/from\s+["']([^"']+)["']/gu);
    for (const match of imports) {
      if (match[1].startsWith(".")) {
        assert.equal(declared.has(match[1].replace(/\.js$/u, "")), true, match[1]);
      } else {
        bareImports.add(match[1]);
      }
    }
  });
  assert.deepEqual(
    [...bareImports].sort(),
    ["pebble/button", "pebble/message", "piu/MC", "timer"]
  );
});
