import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { CONTENT_FILES } from "./content.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const plain = value => JSON.parse(JSON.stringify(value));

// A DOM node that matches nothing unless a test gives it children.
export function node(properties = {}) {
  return {
    isConnected: true,
    getClientRects: () => [{}],
    getAttribute: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    closest: () => null,
    matches: () => false,
    click() {
      this.clicked = (this.clicked || 0) + 1;
    },
    ...properties
  };
}

// An <img> as the page reports it. `srcset` and `picture` are optional.
export function image({ width = 400, height = 400, src = "", srcset = null, picture = null, ...rest } = {}) {
  return node({
    naturalWidth: width,
    naturalHeight: height,
    width,
    height,
    src,
    currentSrc: src,
    getAttribute: name => (name === "srcset" ? srcset : null),
    closest: selector => (selector === "picture" ? picture : null),
    ...rest
  });
}

// Loads the content scripts into a fake page with a virtual clock: every timer fires on the next
// tick but advances `clock.now`, so waits of many seconds cost nothing and Date.now() moves on.
// `tweak(sandbox)` runs before the scripts so a test can replace what they read at load time.
export function loadPage({ url = "https://x.com/NASA/", storage = {}, onSend = () => ({ ok: true }), tweak } = {}) {
  const location = new URL(url);
  const listeners = [];
  const sent = [];
  const intervals = [];
  const clock = { now: 1_000_000 };
  const dom = { scrollHeight: 800, scrollTop: 0, onScroll: null };
  const sandbox = {
    URL,
    Promise,
    console,
    location,
    Date: { now: () => clock.now },
    chrome: {
      runtime: {
        sendMessage: async message => {
          sent.push(message);
          return onSend(message);
        },
        onMessage: { addListener: listener => listeners.push(listener) }
      },
      storage: {
        local: {
          get: async defaults => ({ ...defaults, ...structuredClone(storage) }),
          set: async values => {
            Object.assign(storage, structuredClone(values));
          }
        }
      }
    },
    document: {
      readyState: "complete",
      get documentElement() {
        return { scrollHeight: dom.scrollHeight };
      },
      get body() {
        return { scrollHeight: dom.scrollHeight };
      },
      get scrollingElement() {
        return { scrollTop: dom.scrollTop };
      },
      querySelectorAll: () => [],
      querySelector: () => null,
      dispatched: [],
      dispatchEvent(event) {
        this.dispatched.push(event);
        return true;
      }
    },
    setTimeout: (fn, ms = 0) => {
      clock.now += ms;
      return setImmediate(fn);
    },
    clearTimeout() {},
    KeyboardEvent: class {
      constructor(type, init) {
        this.type = type;
        Object.assign(this, init);
      }
    },
    crypto: webcrypto,
    Image: class {}
  };
  sandbox.window = sandbox;
  sandbox.window.innerHeight = 800;
  sandbox.window.scrollBy = ({ top }) => dom.onScroll?.(top);
  sandbox.window.setInterval = (fn, ms) => intervals.push({ fn, ms });
  sandbox.history = {
    backed: 0,
    back() {
      this.backed++;
    }
  };
  tweak?.(sandbox);
  const context = vm.createContext(sandbox);
  for (const file of CONTENT_FILES) {
    const full = path.join(ROOT, file);
    new vm.Script(fs.readFileSync(full, "utf8"), { filename: full }).runInContext(context);
  }
  const ns = context.PageMediaSaver;
  return {
    context,
    ns,
    sent,
    storage,
    listeners,
    intervals,
    clock,
    dom,
    document: sandbox.document,
    history: sandbox.history,
    location,
    request: message =>
      new Promise(resolve => {
        const asynchronous = listeners[0](message, {}, resolve);
        if (asynchronous !== true) {
          resolve(undefined);
        }
      }),
    // Runs until the scan ends (or `limit` turns of the event loop pass).
    finish: async (limit = 2000) => {
      for (let i = 0; i < limit && ns.scan.state.running; i++) {
        await new Promise(resolve => setImmediate(resolve));
      }
      return ns.scan.state;
    }
  };
}

// What the background answers while downloads settle; override fields per test.
export const settled =
  (overrides = {}) =>
  message => {
    switch (message.type) {
      case "DRAIN_DOWNLOADS":
      case "DOWNLOAD_STATUS":
        return { ok: true, pending: 0, failed: 0, retryable: 0, ...overrides[message.type] };
      case "DOWNLOAD_ITEMS":
        return (
          overrides.DOWNLOAD_ITEMS?.(message) ?? {
            ok: true,
            started: message.items.length,
            skipped: 0,
            failed: 0,
            pending: 0
          }
        );
      default:
        return (
          overrides[message.type]?.(message) ?? { ok: true, started: 0, skipped: 0, failed: 0, pending: 0, cached: 0 }
        );
    }
  };

export const MEDIA = "https://pbs.twimg.com/media/";

// An X post with the given status path and pictures.
export function xArticle({ status = "/NASA/status/100", images = [] } = {}) {
  const link = status ? { href: `https://x.com${status}` } : null;
  return node({
    querySelector: selector => (selector.includes("/status/") ? link : null),
    querySelectorAll: () => images
  });
}

// An Image that "loads" the moment it gets a source, as a 640x480 picture.
export const SyncImage = class {
  set src(value) {
    this.naturalWidth = 640;
    this.naturalHeight = 480;
    this.requested = value;
    this.onload();
  }
};

// Shows `articles` on an X page.
export function showArticles(page, articles) {
  page.document.querySelectorAll = selector => (selector === "article" ? articles : []);
}
