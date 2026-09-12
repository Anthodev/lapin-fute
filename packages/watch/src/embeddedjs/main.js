import Button from "pebble/button";
import Message from "pebble/message";
import Timer from "timer";
import { createRuntime } from "./runtime.js";
import { createView } from "./ui.js";

Timer.set(() => {
  const profile = screen.width === 200 && screen.height === 228 && screen.round !== true ? 0
    : screen.width === 260 && screen.height === 260 && screen.round === true ? 1 : -1;
  if (profile < 0) throw Error("Unsupported display profile");
  let runtime = null, writable = false, message = null;
  const view = createView(() => runtime.button("back"));
  const queue = [];
  function flush() {
    if (!message || !writable || !queue.length) return;
    const next = queue.shift();
    writable = false;
    try { message.write(next); }
    catch (_) { queue.length = 0; if (runtime) runtime.suspend(); }
  }
  message = new Message({
    keys: new Map([["SCHEMA_VERSION", 0]]), input: 768, output: 192,
    onReadable() { const incoming = this.read(); if (runtime) runtime.receive(incoming); },
    onWritable() { writable = true; flush(); },
    onSuspend() { writable = false; queue.length = 0; if (runtime) runtime.suspend(); }
  });
  runtime = createRuntime(localStorage, Timer, outgoing => {
    if (queue.length >= 4) return false;
    queue.push(outgoing);
    flush();
    return true;
  }, state => view.render(state), Date.now, profile, watch.hour12 === true);
  new Button({ types: ["up", "down"], single: true, onPush(active, type) { if (active) runtime.button(type); } });
  new Button({ types: ["select"], single: true, long: true, onPush(active, type, recognizer) { if (active) runtime.button(recognizer === "long" ? "selectLong" : type); } });
  watch.addEventListener("minutechange", () => { runtime.clockSetting(watch.hour12 === true); runtime.minute(); });
  watch.addEventListener("willFocus", active => runtime.active(active));
  runtime.start();
}, 0);
