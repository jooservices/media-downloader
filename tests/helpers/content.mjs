import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
export const CONTENT_FILES = manifest.content_scripts.find(entry => entry.js.includes("src/content/index.js")).js;

// Loads the content scripts, in the manifest's order, into a minimal fake page.
// Timers fire on the next tick so a whole scan finishes in milliseconds.
export function loadContent({ url = "https://x.com/NASA/", storage = {}, onSend = () => ({ ok: true }) } = {}) {
  const location = new URL(url);
  const listeners = [];
  const sent = [];
  const sandbox = {
    URL,
    Promise,
    console,
    location,
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
      documentElement: { scrollHeight: 0 },
      body: { scrollHeight: 0 },
      scrollingElement: { scrollTop: 0 },
      querySelectorAll: () => [],
      querySelector: () => null,
      dispatchEvent: () => true
    },
    setTimeout: fn => setImmediate(fn),
    clearTimeout() {},
    KeyboardEvent: class {},
    crypto: webcrypto,
    Image: class {}
  };
  sandbox.window = sandbox;
  sandbox.window.innerHeight = 800;
  sandbox.window.scrollY = 0;
  sandbox.window.scrollBy = () => {};
  sandbox.window.setInterval = () => 0;
  sandbox.history = { back() {} };
  const context = vm.createContext(sandbox);

  const runAll = () => {
    for (const file of CONTENT_FILES) {
      const full = path.join(ROOT, file);
      new vm.Script(fs.readFileSync(full, "utf8"), { filename: full }).runInContext(context);
    }
  };
  runAll();

  return {
    context,
    sent,
    storage,
    listeners,
    reload: runAll,
    request: message =>
      new Promise(resolve => {
        const asynchronous = listeners[0](message, {}, resolve);
        if (asynchronous !== true) {
          resolve(undefined);
        }
      }),
    settle: () => new Promise(resolve => setTimeout(resolve, 60))
  };
}
