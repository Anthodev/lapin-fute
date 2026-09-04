import { registerHooks } from "node:module";

// Recording Port and event adapters exercise production UI/entry behavior.
// They do not model native font rasterization, XS allocation or SDK durability.
let current;
const self = import.meta.url;
const modules = {
  "piu/MC": "export {};",
  "pebble/button": `export { HostButton as default } from ${JSON.stringify(self)};`,
  "pebble/message": `export { HostMessage as default } from ${JSON.stringify(self)};`,
  "timer": `export { HostTimer as default } from ${JSON.stringify(self)};`
};
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (Object.hasOwn(modules, specifier)) {
      return { url: "data:text/javascript," + encodeURIComponent(modules[specifier]), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  }
});

export class HostButton {
  constructor(options) {
    this.options = options;
    current.buttons.push(this);
  }
}

export class HostMessage {
  constructor(options) {
    this.options = options;
    this.host = current;
    current.message = this;
  }
  read() { return this.incoming; }
  write(message) {
    if (this.failWrite) {
      this.failWrite = false;
      throw new Error("injected native write failure");
    }
    this.host.outgoing.push(new Map(message));
  }
  writable() { this.options.onWritable.call(this); }
  suspend() { this.options.onSuspend.call(this); }
  deliver(message) {
    this.incoming = new Map(message);
    // Message.read renames only the key configured by the actual entry.
    for (const [alias, key] of this.options.keys) {
      if (this.incoming.has(key)) {
        this.incoming.set(alias, this.incoming.get(key));
        this.incoming.delete(key);
      }
    }
    this.options.onReadable.call(this);
    this.incoming = null;
  }
}

export const HostTimer = {
  set(callback, delay) {
    const id = ++current.nextTimer;
    current.timers.set(id, { callback, delay });
    return id;
  },
  clear(id) { current.timers.delete(id); }
};

export function nativeHost(t, profile = 0, storage) {
  const screen = profile === 0 ? { width: 200, height: 228, round: false }
    : { width: 260, height: 260, round: true };
  const host = {
    screen, buttons: [], outgoing: [], timers: new Map(), nextTimer: 0,
    application: null, message: null, listeners: new Map(),
    start() {
      const initial = [...this.timers].find(([, timer]) => timer.delay === 0);
      if (!initial) throw new Error("bootstrap timer not scheduled");
      this.timers.delete(initial[0]);
      initial[1].callback();
    },
    press(type, long = false) {
      const button = this.buttons.find((item) => item.options.types.includes(type));
      if (!button) throw new Error("unregistered button: " + type);
      button.options.onPush.call(button, true, type, long ? "long" : "single");
    }
  };
  const previous = new Map();
  function install(key, value) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
  }
  install("screen", screen);
  install("localStorage", storage);
  install("watch", { hour12: false, addEventListener(name, callback) { host.listeners.set(name, callback); } });
  install("Behavior", class {});
  install("Style", class { constructor(options) { Object.assign(this, options); } });
  install("Port", class {
    constructor(_, options) {
      this.width = screen.width;
      this.height = screen.height;
      this.behavior = new options.Behavior();
      this.drawn = [];
    }
    invalidate() { this.drawn = []; this.behavior.onDraw(this); }
    measureString(text) { return { width: Array.from(text).length * 6, height: 14 }; }
    drawString(text, style, color, x, y) { this.drawn.push({ text, font: style.font, color, x, y }); }
    fillColor() {}
  });
  install("Application", class {
    constructor(_, options) {
      this.first = options.contents[0];
      this.behavior = new options.Behavior();
      host.application = this;
    }
  });
  current = host;
  t.after(() => {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    current = null;
  });
  return host;
}
