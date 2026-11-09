import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Runs src/background/index.js the way the browser does: its importScripts calls
// load the other files into one shared global scope.
// The part of IndexedDB the ledger uses: one object store with a key path, get/put/count,
// and transactions that complete after their requests. Pass the same instance to two
// loadBackground calls to simulate a service worker restart.
export function createFakeIndexedDB() {
  const databases = new Map();
  const request = work => {
    const req = {};
    setImmediate(() => {
      try {
        req.result = work();
        req.onsuccess?.({ target: req });
      } catch (error) {
        req.error = error;
        req.onerror?.({ target: req });
      }
    });
    return req;
  };
  return {
    databases,
    open(name) {
      const opening = {};
      setImmediate(() => {
        let db = databases.get(name);
        const created = !db;
        if (created) {
          const stores = new Map();
          db = {
            stores,
            createObjectStore(storeName, { keyPath }) {
              stores.set(storeName, { keyPath, rows: new Map() });
            },
            transaction(storeName) {
              const store = stores.get(storeName);
              const transaction = {
                objectStore: () => ({
                  get: key => request(() => store.rows.get(key)),
                  put: value =>
                    request(() => {
                      store.rows.set(value[store.keyPath], structuredClone(value));
                    }),
                  count: () => request(() => store.rows.size)
                })
              };
              setImmediate(() => setImmediate(() => transaction.oncomplete?.({ target: transaction })));
              return transaction;
            }
          };
          databases.set(name, db);
        }
        opening.result = db;
        if (created) {
          opening.onupgradeneeded?.({ target: opening });
        }
        opening.onsuccess?.({ target: opening });
      });
      return opening;
    }
  };
}

export function loadBackground({
  storage: initialStorage = {},
  fetchImpl = fetch,
  now = () => Date.now(),
  failStorageGet = false,
  indexedDB = createFakeIndexedDB(),
  // Cookie names the browser holds, by registrable domain (for the sign-in check).
  cookies = {},
  // Answers a message sent to a tab; the default answers nothing, as before.
  tabResponder = () => undefined
} = {}) {
  const listeners = {
    message: [],
    changed: [],
    determining: [],
    tabRemoved: [],
    tabUpdated: [],
    alarm: [],
    startup: [],
    installed: []
  };
  const alarms = [];
  const optionsOpened = { count: 0 };
  const runtimeReloads = { count: 0 };
  const tabsCreated = [];
  let nextTabId = 100;
  const storage = structuredClone(initialStorage);
  const downloads = new Map();
  const started = [];
  const tabMessages = [];
  const tabRemoves = [];
  const FakeDate = class extends Date {
    static now() {
      return now();
    }
  };

  const chrome = {
    runtime: {
      id: "test-extension-id",
      getManifest: () => ({ version: "9.9.9" }),
      reload: () => {
        runtimeReloads.count++;
      },
      onMessage: { addListener: listener => listeners.message.push(listener) },
      onStartup: { addListener: listener => listeners.startup.push(listener) },
      onInstalled: { addListener: listener => listeners.installed.push(listener) },
      openOptionsPage: async () => {
        optionsOpened.count++;
      }
    },
    alarms: {
      create: (name, info) => alarms.push({ name, info }),
      onAlarm: { addListener: listener => listeners.alarm.push(listener) }
    },
    cookies: { getAll: async ({ domain }) => (cookies[domain] || []).map(name => ({ name })) },
    downloads: {
      onChanged: { addListener: listener => listeners.changed.push(listener) },
      onDeterminingFilename: { addListener: listener => listeners.determining.push(listener) },
      search: async query => (downloads.has(query.id) ? [downloads.get(query.id)] : []),
      download: async options => {
        started.push(options);
        return started.length;
      }
    },
    storage: {
      local: {
        get: async defaults => {
          if (failStorageGet) {
            throw new Error("storage unavailable");
          }
          return { ...structuredClone(defaults || {}), ...structuredClone(storage) };
        },
        set: async values => Object.assign(storage, structuredClone(values)),
        remove: async keys => {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete storage[key];
          }
        }
      }
    },
    tabs: {
      onRemoved: { addListener: listener => listeners.tabRemoved.push(listener) },
      onUpdated: { addListener: listener => listeners.tabUpdated.push(listener) },
      sendMessage: async (id, message) => {
        tabMessages.push({ id, message });
        return tabResponder(id, message);
      },
      remove: async id => {
        tabRemoves.push(id);
      },
      create: async options => {
        tabsCreated.push(options);
        return { id: nextTabId++, url: options.url };
      }
    }
  };

  const entryDir = path.join(ROOT, "src", "background");
  const sandbox = {
    chrome,
    URL,
    Date: FakeDate,
    setTimeout,
    clearTimeout,
    fetch: fetchImpl,
    indexedDB,
    crypto: webcrypto,
    console
  };
  const context = vm.createContext(sandbox);
  sandbox.importScripts = (...files) => {
    for (const file of files) {
      const full = path.resolve(entryDir, file);
      new vm.Script(fs.readFileSync(full, "utf8"), { filename: full }).runInContext(context);
    }
  };
  const entry = path.join(entryDir, "index.js");
  new vm.Script(fs.readFileSync(entry, "utf8"), { filename: entry }).runInContext(context);

  const inContext = code => vm.runInContext(code, context);
  const ledger = {
    has: key => inContext(`ledgerHas(${JSON.stringify(key)})`),
    add: key => inContext(`ledgerAdd(${JSON.stringify(key)})`),
    count: () => inContext("ledgerCount()")
  };

  return {
    listeners,
    storage,
    indexedDB,
    ledger,
    downloads,
    started,
    tabMessages,
    tabRemoves,
    tabsCreated,
    alarms,
    optionsOpened,
    runtimeReloads,
    inContext,
    // Hands a value to the worker's global scope without building code from it.
    setGlobal: (name, value) => {
      context[name] = value;
    },
    send: (message, sender = {}) => new Promise(resolve => listeners.message[0](message, sender, resolve)),
    determine: item =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Filename callback did not respond.")), 1000);
        const asynchronous = listeners.determining[0](item, (...args) => {
          clearTimeout(timer);
          resolve(args);
        });
        if (asynchronous !== true) {
          reject(new Error("The filename listener must answer asynchronously."));
        }
      })
  };
}

export const plain = value => JSON.parse(JSON.stringify(value));
