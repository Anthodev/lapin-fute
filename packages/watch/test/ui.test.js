import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nativeHost } from "./native-host.js";
import { watchModule } from "./xs-host.js";
import { copy } from "../src/generated/display-copy.js";
import {
  NOW, NOW_S, appearances, begin, configure, data, departure, harness, latest,
  message, readyDetail, store, trafficDocument, trafficError
} from "./d2-records.js";

const { field } = await watchModule("packed");
const supportedFonts = new Set(JSON.parse(readFileSync(
  new URL("../../companion/src/display-font-metrics.json", import.meta.url)
)).roles);

async function renderHarness(t, profile = 0) {
  nativeHost(t, profile);
  t.mock.method(Date, "now", () => NOW);
  const { createView } = await watchModule("ui");
  const { copy } = await import("../src/generated/display-copy.js");
  const h = harness(store(), { profile });
  let view;
  view = createView(() => { h.runtime.button("back"); view.render(h.r); });
  function show() {
    view.render(h.r);
    return view.application.first.drawn;
  }
  function title(token) {
    const actual = show().filter((row) => row.font === "bold 18px Gothic").map((row) => row.text);
    assert.deepEqual(actual, copy(profile, h.r.language, token, 2).split("\n").filter(Boolean));
  }
  function header(token) {
    const text = copy(profile, h.r.language, token, 1);
    assert(show().some((row) => row.text === text));
  }
  return { ...h, view, show, title, header };
}

for (const profile of [0, 1]) for (const language of ["en", "fr"]) {
  test(`profile ${profile} ${language}: changed DIFF loading ends on abort and final cache miss`, async (t) => {
    const h = await renderHarness(t, profile);
    const old = appearances(2, "fav", { profile, language });
    configure(h, old, { language });
    data(h, 0, [departure(), departure()]);
    assert(h.show().some((row) => row.text === field(old[0], 2)));
    const changed = appearances(2, "fav", { profile, language, line: "N", stop: "New stop" });
    const c = begin(h, changed, { language });
    h.runtime.receive(message(15, c.id, c.generation, { 3: field(changed[0], 0), 12: 0, 43: field(changed[0], 1) }));
    assert(h.show().some((row) => row.text === field(old[0], 2)), "partial inventory keeps the committed view");
    h.runtime.receive(message(15, c.id, c.generation, { 3: field(changed[1], 0), 12: 1, 43: field(changed[1], 1) }));
    h.title(28);
    h.runtime.suspend();
    h.title(40);
    assert.deepEqual(h.r.records, old);
    h.runtime.button("select");
    assert.equal(latest(h, 0).get(24), 2);
    data(h, 0, [departure({ hasData: false, exception: 6 }), departure({ hasData: false, exception: 6 })]);
    h.title(42);
    const radio = h.out.length;
    h.runtime.minute();
    h.show();
    assert.equal(h.out.length, radio);
  });
}

for (const profile of [0, 1]) {
  test(`profile ${profile}: traffic pages preserve sections and scoped errors`, async (t) => {
    const h = await renderHarness(t, profile);
    configure(h, appearances(2, "fav", { profile }));
    const oldDepartures = departure({ fetchedAt: NOW_S - 120 });
    data(h, 0, [oldDepartures, oldDepartures]);
    h.runtime.button("select");
    data(h, 1, [oldDepartures]);
    h.runtime.button("select");
    const body = "Corps0\n\nCorps2\nCorps3\nCorps4\nCorps5\nCorps6\nCorps7\nCorps8";
    const doc = trafficDocument({ palette: 1, title: "Titre A\nTitre B", validity: "Validite", body })[0];
    const split = doc.indexOf("Corps2") + 3;
    data(h, 2, [doc.slice(0, split), doc.slice(split)]);
    h.header(1); // Departure age must not stale a successful traffic document.
    let rows = h.show();
    const content = (items) => items.filter((row) => /^(Titre|Validite|Corps)/u.test(row.text));
    assert.deepEqual(content(rows).map((row) => row.text), ["Titre A", "Titre B", "Validite", "Corps0", "Corps2", "Corps3", "Corps4"]);
    assert.equal(content(rows)[0].font, "bold 14px Gothic");
    assert.equal(content(rows)[2].font, "14px Gothic");
    assert.notEqual(content(rows)[2].color, content(rows)[3].color);
    const radio = h.out.length;
    h.runtime.button("down");
    rows = h.show();
    assert.deepEqual(content(rows).map((row) => row.text), ["Corps5", "Corps6", "Corps7", "Corps8"]);
    assert.equal(h.out.length, radio, "paging is local");
    h.runtime.request(2);
    data(h, 2, trafficError(5));
    h.header(4);
    assert.deepEqual(content(h.show()).map((row) => row.text), content(rows).map((row) => row.text));
    h.runtime.request(2);
    data(h, 2, trafficDocument({ palette: 3, body: "Unknown observation" }));
    h.header(1);
    assert(h.show().some((row) => row.text === "Unknown observation"));
    assert(!h.show().some((row) => row.text === "Corps5"));

    const beforeBack = h.out.length;
    h.show();
    assert.equal(h.view.application.behavior.onPressBack(h.view.application), true);
    assert.equal(h.r.screen, 1);
    assert.equal(h.view.application.behavior.onPressBack(h.view.application), true);
    assert.equal(h.r.screen, 0);
    assert.equal(h.view.application.behavior.onPressBack(h.view.application), false);
    assert.equal(h.out.length, beforeBack, "Back neither sends requests nor double-consumes a press");
  });
}

for (const profile of [0, 1]) {
  test(`profile ${profile}: detail emphasizes the destination and aligns the primary countdown`, async (t) => {
    const h = await renderHarness(t, profile);
    configure(h, appearances(2, "fav", { profile }));
    data(h, 0, [departure(), departure()]);
    h.runtime.button("select");
    data(h, 1, [departure()]);
    const rows = h.show();
    const destination = rows.find((row) => row.text === "Vers 0");
    const value = rows.find((row) => row.text === "5");
    const unit = rows.find((row) => row.text === "min");
    assert(rows.every((row) => supportedFonts.has(row.font)));
    assert.equal(destination.font, "bold 14px Gothic");
    assert.equal(value.font, "bold 36px Gothic");
    assert.equal(unit.font, "bold 18px Gothic");
    assert.equal(value.y, unit.y);
  });
}

test("rectangular overview fills the first three rows", async (t) => {
  const h = await renderHarness(t);
  configure(h, appearances(2));
  data(h, 0, [departure(), departure()]);
  const firstRows = h.show();
  assert(firstRows.some((row) => row.text === "Tout actualiser"), JSON.stringify(firstRows));

  configure(h, appearances(3, "next"));
  data(h, 0, [departure(), departure(), departure()]);
  assert(h.show().some((row) => row.text === "Arrêt 2"));
});

test("retained credential failures outrank traffic loading until matching success", async (t) => {
  const h = await renderHarness(t);
  readyDetail(h);
  h.runtime.request(1, 2);
  data(h, 1, [departure({ hasData: false, exception: 1 })]);
  h.title(31);
  h.runtime.button("select");
  h.title(31);
  data(h, 2, trafficDocument());
  h.runtime.button("back");
  h.title(31);
  h.runtime.request(1, 2);
  data(h, 1, [departure()]);
  h.header(5);
});

function journeyDepartures(statuses, minutes = statuses.map((_, i) => 10 + i * 10)) {
  return departure({ palette: 0 }).slice(0, 22) + statuses.length.toString(16)
    + statuses.map((status, i) => (NOW_S + minutes[i] * 60).toString(16).padStart(8, "0") + status.toString(16)).join("");
}

for (const profile of [0, 1]) for (const language of ["en", "fr"]) {
  test(`profile ${profile} ${language}: uncertain detail keeps times, statuses and overview fallback`, async (t) => {
    const h = await renderHarness(t, profile);
    configure(h, appearances(1, "fav", { profile, language }), { language });
    const record = journeyDepartures([4, 5, 6, 7]);
    data(h, 0, [journeyDepartures([4])]);
    assert.equal(h.show().filter(row => row.text === "?").length, 1);
    h.runtime.button("select");
    // The overview fallback must retain the same uncertainty before detail arrives.
    let rows = h.show();
    const legend = language === "fr" ? "? : trajet incertain" : "? : journey uncertain";
    assert(rows.some(row => row.text === legend));
    assert(rows.some(row => row.text === "10 min" && row.font === "bold 18px Gothic"));
    data(h, 1, [record]);
    rows = h.show();
    assert.equal(rows.filter(row => row.text === "?").length, profile ? 3 : 4);
    assert(rows.some(row => row.text === "20 min"));
    assert(rows.some(row => row.text === "-"));
    assert(!rows.some(row => row.text === (language === "fr" ? "Puis" : "Then")));
    assert(rows.some(row => row.text === copy(profile, language, 14, 7) && row.font === "14px Gothic"));
    assert(rows.some(row => row.text === copy(profile, language, 15, 7) && row.font === "14px Gothic"));
    assert(!rows.some(row => row.text === copy(profile, language, 48, 7)));
    assert.equal(rows.some(row => row.text === "40 min"), !profile);
    h.runtime.button("back");
    h.runtime.request(0);
    data(h, 0, [journeyDepartures([6])]);
    rows = h.show();
    assert(rows.some(row => row.text === "-"));
    assert(!rows.some(row => row.text === "?"));
  });

  test(`profile ${profile} ${language}: mixed groups label uncertainty once without sorting times`, async (t) => {
    const h = await renderHarness(t, profile);
    configure(h, appearances(1, "fav", { profile, language }), { language });
    data(h, 0, [journeyDepartures([0])]);
    h.runtime.button("select");
    data(h, 1, [journeyDepartures([0, 4, 4, 4], [10, 30, 20, 40])]);
    const fills = [];
    t.mock.method(h.view.application.first, "fillColor", (...args) => fills.push(args));
    const rows = h.show();
    assert(rows.some(row => row.text === "10 min" && row.font === "bold 18px Gothic"));
    assert.equal(rows.filter(row => row.text === (language === "fr" ? "Trajet incertain" : "Uncertain trip")).length, 1);
    assert.equal(rows.filter(row => row.text === "?").length, profile ? 2 : 3);
    assert.deepEqual(rows.filter(row => /^\d+ min$/u.test(row.text)).map(row => row.text),
      profile ? ["10 min", "30 min", "20 min"] : ["10 min", "30 min", "20 min", "40 min"]);
    assert(!rows.some(row => row.text === (language === "fr" ? "Puis" : "Then")));
    assert(fills.some(([, x, y, width, height]) => x === (profile ? 48 : 8)
      && y === (profile ? 162 : 137) && width === (profile ? 164 : 184) && height === 1),
    "the uncertain group starts with a separator even on the first following row");
  });
}

test("Gabbro ignores an uncertain fourth departure outside the visible detail", async (t) => {
  const h = await renderHarness(t, 1);
  configure(h, appearances(1, "fav", { profile: 1 }));
  data(h, 0, [journeyDepartures([0])]);
  h.runtime.button("select");
  data(h, 1, [journeyDepartures([0, 0, 0, 4])]);
  const rows = h.show();
  assert(rows.some(row => row.text === "10" && row.font === "bold 36px Gothic"));
  assert(rows.some(row => row.text === "Puis"));
  assert.deepEqual(rows.filter(row => /^\d+ min$/u.test(row.text)).map(row => row.text), ["20 min", "30 min"]);
  assert(!rows.some(row => row.text.includes("?") || row.text.includes("incertain")));
});
