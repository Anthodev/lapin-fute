import Button from "pebble/button";
import Message from "pebble/message";
import Timer from "timer";
import {
  APP_MESSAGE_INBOX_BYTES,
  APP_MESSAGE_KEY_MAP,
  APP_MESSAGE_OUTBOX_BYTES
} from "./contracts.js";
import { createController } from "./controller.js";
import MessageQueue from "./message-queue.js";
import WatchModel from "./model.js";
import { createWatchView } from "./ui.js";

function screenInfo() {
  return {
    width: screen.width,
    height: screen.height,
    round: screen.round === true,
    hour12: watch.hour12 === true
  };
}

let queue = null;
let controller = null;
let pendingChannel = null;
const pendingMessages = [];
const view = createWatchView(screenInfo());
const message = new Message({
  keys: APP_MESSAGE_KEY_MAP,
  input: APP_MESSAGE_INBOX_BYTES,
  output: APP_MESSAGE_OUTBOX_BYTES,
  onReadable() {
    const incoming = this.read();
    if (controller) controller.onReadable(incoming);
    else pendingMessages.push(incoming);
  },
  onWritable() {
    if (queue) queue.writable();
    else pendingChannel = "writable";
  },
  onSuspend() {
    if (queue) queue.suspend();
    else pendingChannel = "suspended";
  }
});

queue = new MessageQueue(message, {
  onState(state) {
    if (controller) controller.onQueueState(state);
  }
});

controller = createController({
  clock: Date,
  scheduler: Timer,
  queue,
  model: new WatchModel(),
  storage: localStorage,
  view
});
controller.start();
if (pendingChannel === "writable") queue.writable();
else if (pendingChannel === "suspended") queue.suspend();
for (let index = 0; index < pendingMessages.length; index += 1) {
  controller.onReadable(pendingMessages[index]);
}
const button = new Button({
  types: ["select", "up", "down"],
  single: true,
  onPush(active, type) {
    if (active) controller.onButton(type);
  }
});

watch.addEventListener("minutechange", controller.onMinuteChange);

watch.addEventListener("willFocus", controller.setActive);

watch.addEventListener("resize", function () {
  view.resize(screenInfo());
  controller.redraw();
});

export default view.application;
