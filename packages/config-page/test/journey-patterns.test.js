import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as browser from "../src/generated/journey-patterns.js";

const canonical = createRequire(import.meta.url)("../../companion/src/journey-patterns.js");
const id = (prefix, name) => prefix + name.padEnd(43, "_");
const placeId = name => id("plc_", name);
const terminalId = name => id("term_", name);
const ref = name => `STIF:StopPoint:Q:${name}:`;
const stop = (name, pickupType = 0, dropOffType = 0, stopRef = ref(name)) => ({
  stopRef, placeId: placeId(name), pickupType, dropOffType,
});
const pattern = (name, terminal, stops) => ({
  kind: "pattern", patternId: id("pat_", name), terminalId: terminalId(terminal), stops,
});
const evidence = (refs = [], labels = []) => ({ refs, labels });
const clone = value => JSON.parse(JSON.stringify(value));
function fixture(patterns = [pattern("full", "C", [stop("A"), stop("B"), stop("C")]),
  pattern("partial", "B", [stop("A"), stop("B")])]) {
  const places = ["A", "B", "C"].map(name => ({ kind: "place", placeId: placeId(name), label: name }));
  const terminals = ["B", "C"].map(name => ({ kind: "terminal", terminalId: terminalId(name),
    terminalPlaceId: placeId(name), refs: [ref(name)], labels: [name] }));
  const rows = [...places, ...terminals, ...patterns];
  const common = { schemaVersion: 1, revision: "a".repeat(64), groupId: id("grp_", "line") };
  return {
    index: { ...common, lineMode: "BUS", lineRef: "STIF:Line::C01246:", pageCount: 1,
      rowCount: rows.length, patternCount: patterns.length },
    pages: [{ ...common, page: 0, nextPage: null, rows }],
  };
}
function group(api, source = fixture()) {
  const result = api.validateJourneyGroup(source.index, source.pages);
  assert.notEqual(result, null);
  return result;
}

for (const [name, api] of [["CJS", canonical], ["browser ESM", browser]]) {
  test(`${name}: full and short services prove the common arrival, not the full arrival`, () => {
    const value = group(api);
    assert.deepEqual(api.reachableArrivals(value, ref("A")).map(place => place.placeId), [placeId("B"), placeId("C")]);
    const common = api.createJourneyClassifier(value, ref("A"), placeId("B"));
    const beyond = api.createJourneyClassifier(value, ref("A"), placeId("C"));
    assert.equal(common(evidence([ref("B"), ref("C")])), "COMPATIBLE");
    assert.equal(beyond(evidence([ref("B")])), "INCOMPATIBLE");
    assert.equal(beyond(evidence([ref("C")])), "COMPATIBLE");
    assert.equal(beyond(evidence([ref("B"), ref("C")])), "UNCERTAIN");
  });

  test(`${name}: unknown or absent hints use every exact-boarding candidate`, () => {
    const value = group(api);
    const common = api.createJourneyClassifier(value, ref("A"), placeId("B"));
    const beyond = api.createJourneyClassifier(value, ref("A"), placeId("C"));
    const before = api.createJourneyClassifier(value, ref("A"), placeId("A"));
    const unavailable = api.createJourneyClassifier(null, ref("A"), placeId("B"));
    const empty = api.createJourneyClassifier(value, ref("other-quay"), placeId("B"));
    for (const hints of [evidence([ref("C")], ["unknown"]), evidence([ref("C"), ref("unknown")]), evidence()]) {
      assert.equal(common(hints), "COMPATIBLE");
      assert.equal(beyond(hints), "UNCERTAIN");
      assert.equal(before(hints), "INCOMPATIBLE");
      assert.equal(unavailable(hints), "UNCERTAIN");
      assert.equal(empty(hints), "UNCERTAIN");
    }
  });

  test(`${name}: terminal aliases do not prove intermediate express stops or loop occurrences`, () => {
    const express = group(api, fixture([
      pattern("omnibus", "C", [stop("A"), stop("B"), stop("C")]),
      pattern("express", "C", [stop("A"), stop("C")]),
    ]));
    assert.equal(api.createJourneyClassifier(express, ref("A"), placeId("B"))(evidence([ref("C")])), "UNCERTAIN");
    const loop = group(api, fixture([pattern("loop", "C", [stop("A"), stop("B"), stop("A"), stop("C")])]));
    assert.equal(api.createJourneyClassifier(loop, ref("A"), placeId("B"))(evidence([ref("C")])), "UNCERTAIN");
    assert.equal(api.createJourneyClassifier(loop, ref("A"), placeId("B"))(evidence()), "UNCERTAIN");
    assert.equal(api.createJourneyClassifier(loop, ref("A"), placeId("A"))(evidence([ref("C")])), "UNCERTAIN");
    assert.ok(api.reachableArrivals(loop, ref("A")).some(place => place.placeId === placeId("A")));
    const before = group(api, fixture([pattern("reverse", "C", [stop("B"), stop("A"), stop("C")])]));
    assert.equal(api.createJourneyClassifier(before, ref("A"), placeId("B"))(evidence([ref("C")])), "INCOMPATIBLE");
  });

  test(`${name}: pickup and drop-off restrictions remain conditional or impossible`, () => {
    for (const [pickup, dropOff, expected] of [[1, 0, "INCOMPATIBLE"], [0, 1, "INCOMPATIBLE"],
      [2, 0, "UNCERTAIN"], [3, 0, "UNCERTAIN"], [0, 2, "UNCERTAIN"], [0, 3, "UNCERTAIN"], [2, 1, "INCOMPATIBLE"]]) {
      const value = group(api, fixture([pattern("restricted", "C", [stop("A", pickup), stop("B", 0, dropOff), stop("C")])]));
      const classify = api.createJourneyClassifier(value, ref("A"), placeId("B"));
      assert.equal(classify(evidence([ref("C")])), expected);
      assert.equal(classify(evidence()), expected);
      assert.equal(api.reachableArrivals(value, ref("A")).some(place => place.placeId === placeId("B")), false);
    }
    const sp = "STIF:StopArea:SP:shared:";
    const value = group(api, fixture([
      pattern("out", "C", [stop("A", 0, 0, sp), stop("B"), stop("C")]),
      pattern("back", "B", [stop("C"), stop("A", 0, 0, sp), stop("B")]),
    ]));
    assert.equal(api.createJourneyClassifier(value, sp, placeId("C"))(evidence([ref("B"), ref("C")])), "UNCERTAIN");
  });

  test(`${name}: proven equivalents and whole normalized labels preserve ambiguous evidence`, () => {
    const source = fixture();
    const partial = source.pages[0].rows.find(row => row.terminalId === terminalId("B") && row.kind === "terminal");
    partial.refs = [ref("493344"), ref("7969")].sort();
    partial.labels = ["Mairie de Stains"];
    const value = group(api, source);
    const classify = api.createJourneyClassifier(value, ref("A"), placeId("C"));
    assert.equal(classify(evidence([ref("7969")])), "INCOMPATIBLE");
    assert.equal(classify(evidence([], ["MAIRIE  DE  STAINS"])), "INCOMPATIBLE");
    assert.equal(classify(evidence([], ["Mairie"])), "UNCERTAIN");
    assert.equal(classify(evidence([ref("C")], ["Mairie de Stains"])), "UNCERTAIN");
    assert.equal(api.normalizeDestinationLabel(" L’Haÿ—les–Roses, CŒUR Æ àéîöùç e\u0301 "), "hay roses coeur ae aeiouc e");
    assert.notEqual(api.normalizeDestinationLabel("Stains Mairie"), api.normalizeDestinationLabel("Mairie Stains"));
  });

  test(`${name}: group admission rejects missing pages, foreign links and ambiguous structure`, () => {
    const source = fixture();
    const split = clone(source);
    split.index.pageCount = 2;
    split.pages[0].nextPage = 1;
    split.pages.push({ ...split.pages[0], page: 1, nextPage: null, rows: split.pages[0].rows.splice(3) });
    assert.notEqual(api.validateJourneyGroup(split.index, split.pages), null);
    assert.equal(api.validateJourneyGroup(split.index, [split.pages[0]]), null);
    const mutations = [
      value => { value.index.rowCount += 1; },
      value => { value.index.patternCount += 1; },
      value => { value.pages[0].revision = "b".repeat(64); },
      value => { value.pages[0].groupId = id("grp_", "other"); },
      value => { value.pages[0].nextPage = 1; },
      value => { value.pages[0].rows.push(value.pages[0].rows[0]); value.index.rowCount += 1; },
      value => { value.pages[0].rows[5].stops[0].placeId = placeId("missing"); },
      value => { value.pages[0].rows[5].terminalId = terminalId("missing"); },
      value => { value.pages[0].rows[5].stops[2].placeId = placeId("B"); },
      value => { value.pages[0].rows[3].refs = [ref("B"), ref("B")]; },
      value => { value.pages[0].rows[3].labels = ["Z", "A"]; },
      value => { value.pages[0].rows[0].extra = true; },
      value => { value.pages[0].rows[0].label = "de la"; },
      value => { value.pages[0].rows[0].label = "A\u0000"; },
      value => { value.pages[0].rows[5].stops[0].stopRef = ref("bad:name"); },
      value => { value.pages[0].rows[5].stops[0].dropOffType = 4; },
    ];
    for (const mutate of mutations) {
      const value = clone(source); mutate(value);
      assert.equal(api.validateJourneyGroup(value.index, value.pages), null);
    }
  });

  test(`${name}: exact budgets and IDs admit boundaries without truncation`, () => {
    const source = fixture();
    const page = source.pages[0];
    page.rows[0].label = "é".repeat(128);
    assert.equal(api.isJourneyGroupPage(page), true);
    page.rows[0].label += "a";
    assert.equal(api.isJourneyGroupPage(page), false);
    page.rows[0].label = "A";
    page.rows[5].stops = Array.from({ length: 1024 }, () => stop("C"));
    assert.equal(api.isJourneyGroupPage(page), true);
    page.rows[5].stops.push(stop("C"));
    assert.equal(api.isJourneyGroupPage(page), false);
    const large = fixture();
    large.pages[0].rows[3].refs = Array.from({ length: 128 }, (_, i) => ref(String(i).padStart(3, "0")));
    assert.equal(api.isJourneyGroupPage(large.pages[0]), true);
    large.pages[0].rows[3].refs.push(ref("999"));
    assert.equal(api.isJourneyGroupPage(large.pages[0]), false);
    const oversized = fixture();
    oversized.pages[0].rows = Array.from({ length: 2000 }, (_, i) => ({ kind: "place", placeId: id("plc_", String(i)), label: "x".repeat(256) }));
    assert.equal(api.isJourneyGroupPage(oversized.pages[0]), false);
    assert.equal(api.isJourneyGroupIndex({ ...source.index, pageCount: 32, patternCount: 4096, rowCount: 4098 }), true);
    assert.equal(api.isJourneyGroupIndex({ ...source.index, pageCount: 33 }), false);
    assert.equal(api.isJourneyGroupIndex({ ...source.index, patternCount: 4097, rowCount: 4099 }), false);
    assert.equal(api.isJourneyGroupIndex({ ...source.index, groupId: id("grp_", "x") + "a" }), false);
    const service = { schemaVersion: 1, revision: source.index.revision, serviceId: id("svc_", "anchor"),
      groupId: source.index.groupId, lineMode: "BUS", terminalPlaceId: null,
      routing: { monitoringRef: ref("ART-BUS-1"), lineRef: source.index.lineRef, destinationRef: ref("C") } };
    assert.equal(api.isServiceJourneyDocument(service), true);
    assert.equal(api.isServiceJourneyDocument({ ...service, terminalPlaceId: "plc_short" }), false);
    assert.equal(api.isServiceJourneyDocument({ ...service, extra: 1 }), false);
  });

  test(`${name}: overlapping terminal aliases remain ambiguous and unmapped arrivals stay selectable`, () => {
    const source = fixture();
    source.pages[0].rows[3].labels = ["Shared name"];
    source.pages[0].rows[4].labels = ["Shared name"];
    source.pages[0].rows[5].stops[1].stopRef = null;
    const value = group(api, source);
    assert.equal(api.createJourneyClassifier(value, ref("A"), placeId("C"))(evidence([], ["shared name"])), "UNCERTAIN");
    assert.equal(api.createJourneyClassifier(value, ref("A"), placeId("B"))(evidence([], ["shared name"])), "COMPATIBLE");
    assert.ok(api.reachableArrivals(value, ref("A")).some(place => place.placeId === placeId("B")));
  });

  test(`${name}: arrival display truncates scalars and journey identity keeps arrivals distinct`, () => {
    assert.equal(api.arrivalLabel("é".repeat(48)), "é".repeat(48));
    assert.equal(api.arrivalLabel("😀".repeat(25)), "😀".repeat(23) + "…");
    assert.equal(api.arrivalLabel("a".repeat(93) + "😀"), "a".repeat(93) + "…");
    assert.equal(api.journeyKey({ serviceId: "a", arrivalPlaceId: null }), '["a",null]');
    assert.notEqual(api.journeyKey({ serviceId: "a", arrivalPlaceId: "b" }), api.journeyKey({ serviceId: "a", arrivalPlaceId: "c" }));
  });
}

test("browser and canonical helpers produce identical admitted groups and decisions", () => {
  const source = fixture();
  const phone = group(canonical, source), page = group(browser, source);
  assert.deepEqual(page, phone);
  assert.deepEqual(browser.reachableArrivals(page, ref("A")), canonical.reachableArrivals(phone, ref("A")));
  for (const arrival of ["A", "B", "C"]) {
    const left = canonical.createJourneyClassifier(phone, ref("A"), placeId(arrival));
    const right = browser.createJourneyClassifier(page, ref("A"), placeId(arrival));
    for (const hints of [evidence(), evidence([ref("B")]), evidence([ref("C")]), evidence([ref("B"), ref("C")]),
      evidence([ref("C"), ref("unknown")]), evidence([ref("C")], ["unknown"]), evidence([], ["unknown"])]) {
      assert.equal(right(hints), left(hints));
    }
  }
});
