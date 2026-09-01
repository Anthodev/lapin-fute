import test from "node:test";
import assert from "node:assert/strict";
import { KEY_STATUS, LIMITS, SCHEMA_VERSION } from "../src/embeddedjs/contracts.js";
import {
  WATCH_CONFIGURATION_KEY,
  WATCH_CONFIGURATION_MAX_BYTES,
  deserializeWatchConfiguration,
  loadWatchConfiguration,
  saveWatchConfiguration,
  serializeWatchConfiguration
} from "../src/embeddedjs/storage.js";

const FAVORITE = {
  id: "home",
  serviceId: "opaque:service:1",
  displayName: "Maison",
  stopLabel: "Châtelet",
  lineLabel: "Métro 1",
  destinationLabel: "La Défense",
  sortOrder: 0
};

const CONFIGURATION = {
  keyStatus: KEY_STATUS.CONFIGURED,
  language: "fr",
  favorites: [FAVORITE]
};

class StringStorage {
  constructor(serialized = null) {
    this.value = serialized;
    this.corruptNextWrite = false;
  }

  getItem(key) {
    return key === WATCH_CONFIGURATION_KEY ? this.value : null;
  }

  setItem(key, value) {
    if (key !== WATCH_CONFIGURATION_KEY) return;
    if (this.corruptNextWrite) {
      this.corruptNextWrite = false;
      this.value = value + "corrupt";
      return;
    }
    this.value = value;
  }

  removeItem(key) {
    if (key === WATCH_CONFIGURATION_KEY) this.value = null;
  }
}

function stored(configuration = CONFIGURATION) {
  return serializeWatchConfiguration(configuration);
}

test("watch configuration round-trips the exact compact durable projection", () => {
  const storage = new StringStorage();
  assert.equal(saveWatchConfiguration(storage, CONFIGURATION), true);
  assert.equal(storage.value, stored());
  assert.deepEqual(deserializeWatchConfiguration(storage.value), CONFIGURATION);
  assert.deepEqual(loadWatchConfiguration(storage), CONFIGURATION);
  assert.equal(storage.value.includes("primApiKey"), false);
  assert.equal(storage.value.includes("result"), false);
  assert.equal(storage.value.includes("request"), false);
});

test("maximum contract configuration stays below the 8192-byte Alloy limit", () => {
  const configuration = {
    keyStatus: KEY_STATUS.CONFIGURED,
    language: "fr",
    favorites: Array.from({ length: 8 }, (_, index) => ({
      id: "i".repeat(LIMITS.idUtf8Bytes - 1) + index,
      serviceId: "s".repeat(LIMITS.idUtf8Bytes - 1) + index,
      displayName: "n".repeat(LIMITS.labelUtf8Bytes),
      stopLabel: "p".repeat(LIMITS.labelUtf8Bytes),
      lineLabel: "l".repeat(LIMITS.labelUtf8Bytes),
      destinationLabel: "d".repeat(LIMITS.labelUtf8Bytes),
      sortOrder: index
    }))
  };
  const serialized = serializeWatchConfiguration(configuration);
  assert.notEqual(serialized, null);
  assert.ok(new TextEncoder().encode(serialized).byteLength <= WATCH_CONFIGURATION_MAX_BYTES);
  assert.deepEqual(deserializeWatchConfiguration(serialized), configuration);
});

test("corrupt, unsupported, over-bound, and secret-bearing values are rejected", () => {
  const serialized = stored();
  const invalid = [
    "not-compact",
    serialized.replace("LFW1\u001f1\u001f", "LFW1\u001f2\u001f"),
    serialized + "trailing",
    serialized.slice(0, -1)
  ];
  invalid.forEach((value) => {
    assert.equal(loadWatchConfiguration(new StringStorage(value)), null);
  });

  const storage = new StringStorage(serialized);
  assert.equal(saveWatchConfiguration(storage, { ...CONFIGURATION, result: {} }), false);
  assert.equal(storage.value, serialized);
  assert.equal(serializeWatchConfiguration({
    ...CONFIGURATION,
    favorites: [{ ...FAVORITE, primApiKey: "must-not-persist" }]
  }), null);
  assert.equal(serializeWatchConfiguration({
    ...CONFIGURATION,
    favorites: [{ ...FAVORITE, stopLabel: "x".repeat(193) }]
  }), null);
});

test("failed read-back restores the previous valid bytes", () => {
  const previous = stored({
    keyStatus: KEY_STATUS.MISSING,
    language: "en",
    favorites: []
  });
  const storage = new StringStorage(previous);
  storage.corruptNextWrite = true;
  assert.equal(saveWatchConfiguration(storage, CONFIGURATION), false);
  assert.equal(storage.value, previous);
});
