import test from "node:test";
import assert from "node:assert/strict";
import { nativeHost } from "./native-host.js";
import { watchModule } from "./xs-host.js";
import {
  NOW, NOW_S, appearances, begin, configure, data, departure, harness, latest,
  message, readyDetail, store, trafficDocument, trafficError
} from "./d2-records.js";

const { field } = await watchModule("packed");

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
