import Message from "pebble/message";
import { APP_MESSAGE_KEY_MAP } from "./contracts.js";
import { createController } from "./controller.js";
import MessageQueue from "./message-queue.js";
import WatchModel from "./model.js";
import { createWatchView } from "./ui.js";

function screenInfo() {
  return {
    width: screen.width,
    height: screen.height,
    round: screen.round === true
  };
}

let queue = null;
let controller = null;
let pendingChannel = null;
const pendingMessages = [];
const view = createWatchView(screenInfo());
const message = new Message({
  keys: APP_MESSAGE_KEY_MAP,
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
  clock: { now: Date.now },
  queue,
  model: new WatchModel(),
  view
});
controller.start();
if (pendingChannel === "writable") queue.writable();
else if (pendingChannel === "suspended") queue.suspend();
pendingMessages.forEach(function (incoming) {
  controller.onReadable(incoming);
});

watch.addEventListener("resize", function () {
  view.resize(screenInfo());
  controller.redraw();
});

export default view.application;
