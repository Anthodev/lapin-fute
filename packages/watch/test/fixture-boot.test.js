import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { watchModule } from "./xs-host.js";
import { store } from "./d2-records.js";

const { createRuntime } = await watchModule("runtime");
const { field, hex, stale } = await watchModule("packed");
const { load } = await watchModule("storage");
const require = createRequire(import.meta.url);
const companion = require("../../companion/src/index.js");
const fakes = require("../../companion/test/fakes.js");
const fixture = require("../../../fixtures/departures/foundation.json");
const siriFixture = require("../../../fixtures/departures/prim/metro.json");
const trafficFixture = require("../../../fixtures/traffic/global.json");
const contracts = companion.contracts;
const configuration = companion.configuration;
const NOW = Date.parse("2026-01-15T09:00:00Z");
const KEY = "test-personal-prim-key";
const ROUTING = { monitoringRef: "IDFM:SP:2001", lineRef: "IDFM:C200", destinationRef: "IDFM:2001DST" };

function snapshot(fetchedAt) {
  return {
    fetchedAt, freshness: "REALTIME", sourceUpdatedAt: fetchedAt - 10,
    departures: [120, 360].map((offset) => ({ expectedAt: fetchedAt + offset, minutes: offset / 60, status: "ON_TIME" }))
  };
}

function coupled(t, { count = 2, age = 0, cached = count, profile = 0 } = {}) {
  const clock = new fakes.FakeClock(NOW);
  const storage = new fakes.FakeStorage();
  const watchStorage = store();
  const favorites = Array.from({ length: count }, (_, index) => ({
    ...contracts.copyFavorite(fixture.favorite),
    id: "favorite-" + index,
    serviceId: "opaque:fixture:service:" + index,
    sortOrder: index,
    routing: { ...ROUTING }
  }));
  assert(configuration.saveConfiguration(storage, {
    schemaVersion: 1, favorites, keyStatus: contracts.KEY_STATUS.CONFIGURED, primApiKey: KEY
  }));
  let cache = configuration.emptyCache();
  if (cached) {
    cache = configuration.mergeOverview(cache, favorites, {
      schemaVersion: 1, requestId: "cached-overview",
      items: favorites.slice(0, cached).map((favorite) => ({
        favoriteId: favorite.id,
        departures: { status: "AVAILABLE", data: snapshot(NOW / 1000 - age) },
        traffic: { state: "NORMAL", checkedAt: NOW / 1000 - age }
      }))
    }, NOW - age * 1000);
  }
  assert(configuration.saveCache(storage, cache, KEY));
  const Pebble = new fakes.FakePebble(false);
  Pebble.getActiveWatchInfo = () => ({ language: "fr-FR" });
  const defer = fakes.createDefer(false);
  const xhr = fakes.createXHRFactory();
  const watchPackets = [], phonePackets = [], received = [], events = [];
  let phone, runtime, state, cursor = 0;
  const createPhone = () => companion.createCompanion({
    Pebble, storage, XHR: xhr.XHR, clock, defer,
    configurationUrl: "https://config.example.test/index.html"
  });
  function createWatch() {
    runtime = createRuntime(watchStorage, {
      set(callback, delay) { return clock.setTimeout(callback, delay); },
      clear(id) { clock.clearTimeout(id); }
    }, (packet) => {
      watchPackets.push(new Map(packet));
      events.push(Object.fromEntries(packet));
      return true;
    }, (frame) => { state = frame; }, () => clock.now(), profile, false);
    runtime.start();
  }
  function pump() {
    let steps = 0;
    while (events.length || Pebble.pending.length || defer.pending.length) {
      assert(++steps < 1000, "event-only transfer must settle without retry/polling");
      if (events.length) {
        Pebble.emit("appmessage", { payload: events.shift() });
      } else if (Pebble.pending.length) {
        const dictionary = Pebble.sent[cursor++];
        const packet = new Map(Object.entries(dictionary).map(([key, value]) => [contracts.APP_MESSAGE_KEYS[key] ?? Number(key), value]));
        phonePackets.push(packet);
        if (!packet.has(15025)) received.push(runtime.receive(packet));
        // The watch may have sent APP_OPEN or recovery requests while consuming
        // COMMIT. They reach the companion before its next ACK-yield callback.
        Pebble.ack();
      } else {
        defer.runNext();
      }
    }
  }
  function update(next, forceFullSync = false) {
    Pebble.emit("webviewclosed", { response: encodeURIComponent(JSON.stringify({
      schemaVersion: 1, favorites: next,
      apiKeyUpdate: { schemaVersion: 1, action: "KEEP" }, forceFullSync
    })) });
    pump();
  }
  function restartPhone() {
    phone.stop();
    phone = createPhone();
    Pebble.emit("ready");
    pump();
  }
  function restartWatch() {
    runtime.suspend();
    createWatch();
    pump();
  }
  phone = createPhone();
  createWatch();
  Pebble.emit("appmessage", { payload: { 15025: 1 } });
  Pebble.emit("ready");
  pump();
  t.after(() => { phone.stop(); runtime.suspend(); });
  return {
    clock, storage, watchStorage, favorites, xhr, Pebble, watchPackets, phonePackets, received,
    pump, update, restartPhone, restartWatch,
    get runtime() { return runtime; }, get state() { return state; }
  };
}

function completePrim(h) {
  const now = Math.floor(h.clock.now() / 1000);
  for (const request of h.xhr.instances) {
    if (request.responded || request.aborted) continue;
    request.responded = true;
    assert(request.url.startsWith("https://prim.iledefrance-mobilites.fr/"));
    if (request.url.includes("stop-monitoring")) {
      const response = structuredClone(siriFixture);
      const delivery = response.Siri.ServiceDelivery.StopMonitoringDelivery[0];
      delivery.ResponseTimestamp = new Date(now * 1000).toISOString();
      const original = delivery.MonitoredStopVisit[0];
      delivery.MonitoredStopVisit = [120, 360].map((offset) => {
        const visit = structuredClone(original);
        visit.RecordedAtTime = delivery.ResponseTimestamp;
        visit.MonitoredVehicleJourney.LineRef.value = ROUTING.lineRef;
        visit.MonitoredVehicleJourney.MonitoredCall.ExpectedDepartureTime = new Date((now + offset) * 1000).toISOString();
        visit.MonitoredVehicleJourney.MonitoredCall.AimedDepartureTime = new Date((now + offset) * 1000).toISOString();
        return visit;
      });
      request.respond(200, response);
    } else {
      assert(request.url.includes("disruptions"));
      request.respond(200, trafficFixture);
    }
  }
  h.clock.advance(0);
  h.pump();
}

const dataRequests = (packets) => packets.filter((packet) => [1, 9, 10].includes(packet.get(1)));
const opens = (packets) => packets.filter((packet) => packet.get(1) === 9 && packet.get(24) === 0);

test("real PRIM normalization crosses D2 warm overview, detail and traffic boundaries", (t) => {
  const h = coupled(t, { age: 60 });
  assert.equal(h.received.includes(false), false);
  assert.equal(h.state.records.length, 2);
  assert.equal(field(h.state.records[0], 0), h.favorites[0].id);
  assert.equal(opens(h.watchPackets).length, 1);
  const cachedExpected = hex(h.state.overview[0], 23, 8);
  assert(stale(h.state.overview[0], h.clock.now()));
  assert(h.xhr.instances.some((request) => request.url.includes("stop-monitoring")));
  completePrim(h);
  assert.equal(hex(h.state.overview[0], 23, 8), cachedExpected + 60);
  assert.equal(stale(h.state.overview[0], h.clock.now()), false);
  const calls = h.xhr.instances.length;
  h.runtime.button("select"); h.pump();
  assert.equal(h.state.detailId, h.favorites[0].id);
  assert.equal(hex(h.state.detail, 22, 1), 2);
  assert.equal(h.state.pending & 2, 0);
  h.runtime.button("select"); h.pump();
  assert.equal(h.state.trafficId, h.favorites[0].id);
  assert.equal(hex(h.state.traffic, 0, 1), 1);
  assert.equal(h.xhr.instances.length, calls);
  const packets = h.watchPackets.length;
  h.clock.advance(5 * 60000);
  h.runtime.minute(); h.pump();
  assert.equal(h.watchPackets.length, packets);
  assert.equal(h.xhr.instances.length, calls);
});

test("changed six-favorite metadata finishes overview5 and detail5 without PRIM", (t) => {
  const h = coupled(t, { count: 6 });
  assert.equal(h.state.pending, 0);
  assert.equal(h.xhr.instances.length, 0);
  h.runtime.button("select"); h.pump();
  const oldDetail = h.state.detail;
  const oldRows = h.state.overview.slice();
  const before = h.watchPackets.length;
  const replies = h.phonePackets.length;
  const changed = h.favorites.map((favorite) => ({ ...favorite, stopLabel: "Nouveau " + favorite.stopLabel }));
  h.update(changed);
  assert.deepEqual(dataRequests(h.watchPackets.slice(before)).map((packet) => [packet.get(1), packet.get(24)]), [[9, 5], [1, 5]]);
  assert.equal(h.state.pending, 0, "both accepted recovery tokens receive terminal outcomes");
  assert.equal(h.state.detail, oldDetail);
  assert.deepEqual(h.state.overview, oldRows);
  assert.equal(h.state.screen, 1);
  assert.equal(h.xhr.instances.length, 0);
  assert.equal(h.phonePackets.slice(replies).filter((packet) => [17, 18, 19].includes(packet.get(1))).length, 11);
  assert.equal(configuration.loadConfiguration(h.storage).primApiKey, KEY);

  // Equal cached bytes must still finish a new request token.
  const tokens = [];
  for (let repeat = 0; repeat < 2; repeat++) {
    h.runtime.button("selectLong"); h.pump();
    tokens.push(dataRequests(h.watchPackets).at(-1).get(2));
    assert.equal(h.state.pending & 2, 0);
    assert.equal(h.state.detail, oldDetail);
  }
  assert.notEqual(tokens[0], tokens[1]);
  assert.equal(h.xhr.instances.length, 0);
});

test("phone restart and reorder retain six metadata records without another APP_OPEN", (t) => {
  const h = coupled(t, { count: 6, profile: 1 });
  assert.equal(h.received.includes(false), false);
  const firstEpoch = h.state.epoch;
  const records = h.state.records.slice();
  const before = h.watchPackets.length;
  h.restartPhone();
  assert(h.state.epoch > firstEpoch);
  assert.deepEqual(h.state.records, records);
  assert.equal(opens(h.watchPackets).length, 1);
  assert.equal(dataRequests(h.watchPackets.slice(before)).length, 0);
  const ordering = h.favorites.slice().reverse().map((favorite, index) => ({ ...favorite, sortOrder: index }));
  const beforeReorder = h.watchPackets.length;
  h.update(ordering);
  assert.deepEqual(h.state.records.map((record) => field(record, 0)), ordering.map((favorite) => favorite.id));
  assert.equal(dataRequests(h.watchPackets.slice(beforeReorder)).length, 0);
  assert.equal(configuration.loadConfiguration(h.storage).primApiKey, KEY);
  assert.deepEqual(load(h.watchStorage, 1).records, h.state.records);
  h.restartWatch();
  assert.equal(opens(h.watchPackets).length, 2, "a new watch runtime owns its own APP_OPEN");
  assert.equal(h.state.records.length, 6);
  assert.equal(h.state.pending, 0);
  assert.equal(h.xhr.instances.length, 0);
});

test("cache-only miss stays terminal while an independent overview flight completes", (t) => {
  const h = coupled(t, { count: 2, cached: 1 });
  const calls = h.xhr.instances.length;
  assert(calls > 0, "APP_OPEN legitimately fetches the missing favorite");
  h.runtime.button("down");
  h.runtime.button("select"); h.pump();
  assert.equal(dataRequests(h.watchPackets).at(-1).get(24), 5);
  assert.equal(h.state.pending & 2, 0);
  assert.equal(h.state.errors[1], 6);
  assert.equal(h.xhr.instances.length, calls);
  h.runtime.button("back");
  completePrim(h);
  assert.equal(h.state.screen, 0);
  assert.equal(h.state.focus, 1);
  h.runtime.button("select"); h.pump();
  assert.equal(h.state.detailId, h.favorites[1].id);
  assert.equal(h.state.pending & 2, 0);
  assert.equal(h.xhr.instances.length, calls);
});
