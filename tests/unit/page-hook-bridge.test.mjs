import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { runScript } from "../helpers/run-script.mjs";

const plain = value => JSON.parse(JSON.stringify(value));
const tick = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

const IG = "https://scontent.cdninstagram.com/v/";
const igPost = code => ({
  code,
  taken_at: 1,
  user: { username: "someone" },
  image_versions2: { candidates: [{ url: `${IG}${code}.jpg`, width: 800, height: 800 }] }
});

// ---- the page-world hook -----------------------------------------------------------------

function loadHook({ hostname = "www.instagram.com", fetchImpl, parser, document = null, extraXhr } = {}) {
  const posted = [];
  const timers = [];
  const page = {
    URL,
    location: { hostname, origin: `https://${hostname}` },
    fetch: fetchImpl,
    postMessage: (message, origin) => posted.push({ message, origin }),
    XMLHttpRequest: class {
      constructor() {
        this.listeners = {};
      }
      addEventListener(name, listener) {
        this.listeners[name] = listener;
      }
    },
    setTimeout: fn => timers.push(fn) && timers.length,
    MutationObserver: class {
      constructor(callback) {
        page.observed = callback;
      }
      observe(node, options) {
        page.observedWith = { node, options };
      }
    },
    document
  };
  page.XMLHttpRequest.prototype.open = function open(...args) {
    this.opened = args;
    return "native-open";
  };
  extraXhr?.(page);
  page.globalThis = page;
  runScript("lib/sites.js", page);
  runScript("lib/platforms.js", page);
  for (const file of [
    "src/page/x-media-parser.js",
    "src/page/instagram-media-parser.js",
    "src/page/facebook-media-parser.js",
    "src/page/tiktok-media-parser.js"
  ]) {
    runScript(file, page);
  }
  if (parser) {
    page.PageMediaParsers[page.PageMediaLib.sites.forHost(hostname).name] = parser;
  }
  runScript("src/page/media-network-hook.js", page);
  return { page, posted, timers };
}

const textResponse = text => ({ clone: () => ({ text: async () => text }) });

test("hook: reports only a safe rate-limit status for platform data responses", async () => {
  const response = { ...textResponse("{}"), status: 429 };
  const { page, posted } = loadHook({ fetchImpl: async () => response });
  assert.equal(await page.fetch("https://www.instagram.com/api/v1/feed/"), response);
  await tick();
  assert.deepEqual(plain(posted.map(item => item.message)), [{ channel: CHANNEL, rateLimitStatus: 429 }]);
});

test("hook: a host with no parser leaves fetch and XHR alone", () => {
  const nativeFetch = async () => ({});
  const { page } = loadHook({ hostname: "example.com", fetchImpl: nativeFetch });
  assert.equal(page.fetch, nativeFetch);
  assert.equal(page.__pageMediaSaverMediaHook, undefined);
});

test("hook: loading it twice wraps fetch once", () => {
  const { page } = loadHook({ fetchImpl: async () => textResponse("{}") });
  const wrapped = page.fetch;
  runScript("src/page/media-network-hook.js", page);
  assert.equal(page.fetch, wrapped);
});

test("hook: fetch accepts a Request-like object, passes the real response back, and ignores other URLs", async () => {
  const body = JSON.stringify({ items: [igPost("Dfetch0001")] });
  const response = textResponse(body);
  const { page, posted } = loadHook({ fetchImpl: async () => response });
  assert.equal(await page.fetch({ url: "https://www.instagram.com/api/v1/feed/" }), response);
  await page.fetch({ toString: () => "https://www.instagram.com/api/v1/other/" });
  await page.fetch({ url: "https://www.instagram.com/static/app.js" });
  await tick();
  assert.equal(posted.length, 1, "the same photo is announced once");
  assert.equal(posted[0].message.media[0].id, "Dfetch0001");
  assert.equal(posted[0].message.media[0].kind, "photo");
});

test("hook: a response that cannot be read never breaks the page's own request", async () => {
  const unreadable = { clone: () => ({ text: () => Promise.reject(new Error("body used")) }) };
  const { page, posted } = loadHook({ fetchImpl: async () => unreadable });
  assert.equal(await page.fetch("https://www.instagram.com/api/v1/feed/"), unreadable);
  const cloneThrows = {
    clone() {
      throw new Error("locked");
    }
  };
  const second = loadHook({ fetchImpl: async () => cloneThrows });
  assert.equal(await second.page.fetch("https://www.instagram.com/api/v1/feed/"), cloneThrows);
  await tick();
  assert.deepEqual(posted, []);
});

test("hook: a failing request still fails for the page", async () => {
  const { page } = loadHook({
    fetchImpl: async () => {
      throw new Error("offline");
    }
  });
  await assert.rejects(page.fetch("https://www.instagram.com/api/v1/feed/"), /offline/);
});

test("hook: bodies that are not JSON, or hold only bad lines, announce nothing", async () => {
  const bodies = ["<html>", "", "for (;;);not json\n\n   \nstill not json"];
  for (const body of bodies) {
    const { page, posted } = loadHook({ fetchImpl: async () => textResponse(body) });
    await page.fetch("https://www.instagram.com/api/v1/feed/");
    await tick();
    assert.deepEqual(posted, [], JSON.stringify(body));
  }
});

test("hook: a parser that throws on an unexpected shape is contained", async () => {
  const parser = {
    extractMedia(document) {
      if (document.boom) {
        throw new Error("bad shape");
      }
      return [{ platform: "Instagram", kind: "photo", id: "Dok0000001", index: 1, url: `${IG}ok.jpg` }];
    }
  };
  const { page, posted } = loadHook({
    parser,
    fetchImpl: async () => textResponse(`${JSON.stringify({ boom: true })}\n${JSON.stringify({ fine: true })}`)
  });
  await page.fetch("https://www.instagram.com/api/v1/feed/");
  await tick();
  assert.equal(posted.length, 1);
  assert.equal(posted[0].message.media[0].id, "Dok0000001");
});

test("hook: XHR responses from a data endpoint are parsed once they load", () => {
  const { page, posted } = loadHook({ fetchImpl: async () => textResponse("{}") });
  const xhr = new page.XMLHttpRequest();
  assert.equal(xhr.open("GET", "https://www.instagram.com/api/v1/feed/", true), "native-open");
  assert.deepEqual(plain(xhr.opened), ["GET", "https://www.instagram.com/api/v1/feed/", true]);
  xhr.responseType = "";
  xhr.responseText = JSON.stringify({ items: [igPost("Dxhr000001")] });
  xhr.listeners.load();
  assert.equal(posted[0].message.media[0].id, "Dxhr000001");

  const typed = new page.XMLHttpRequest();
  typed.open("GET", "https://www.instagram.com/api/v1/feed/");
  typed.responseType = "text";
  typed.responseText = JSON.stringify({ items: [igPost("Dxhr000002")] });
  typed.listeners.load();
  assert.equal(posted.length, 2);
});

test("hook: XHR data responses report a safe rate-limit status", () => {
  const { page, posted } = loadHook({ fetchImpl: async () => textResponse("{}") });
  const xhr = new page.XMLHttpRequest();
  xhr.open("GET", "https://www.instagram.com/api/v1/feed/");
  xhr.status = 429;
  xhr.responseType = "blob";
  xhr.listeners.load();
  assert.deepEqual(plain(posted.map(item => item.message)), [{ channel: CHANNEL, rateLimitStatus: 429 }]);
});

test("hook: XHR to other URLs, binary response types and unreadable bodies are left alone", () => {
  const { page, posted } = loadHook({ fetchImpl: async () => textResponse("{}") });
  const other = new page.XMLHttpRequest();
  other.open("GET", "https://www.instagram.com/static/app.js");
  assert.equal(other.listeners.load, undefined, "no listener is attached to unrelated requests");

  const blob = new page.XMLHttpRequest();
  blob.open("GET", "https://www.instagram.com/api/v1/feed/");
  blob.responseType = "blob";
  blob.responseText = JSON.stringify({ items: [igPost("Dblob00001")] });
  blob.listeners.load();

  const broken = new page.XMLHttpRequest();
  broken.open("GET", "https://www.instagram.com/api/v1/feed/");
  broken.responseType = "";
  Object.defineProperty(broken, "responseText", {
    get() {
      throw new Error("InvalidStateError");
    }
  });
  assert.doesNotThrow(() => broken.listeners.load());
  assert.deepEqual(posted, []);
});

function embeddedScript(text) {
  return { textContent: text };
}

function embeddedDocument(scripts, readyState = "complete") {
  const doc = {
    readyState,
    documentElement: {},
    queried: [],
    listeners: {},
    querySelectorAll(selector) {
      doc.queried.push(selector);
      return scripts;
    },
    addEventListener(name, listener, options) {
      doc.listeners[name] = { listener, options };
    }
  };
  return doc;
}

test("hook: JSON embedded in the page is read once, and only blocks that hint at media", async () => {
  const withMedia = embeddedScript(JSON.stringify({ items: [igPost("Demb000001")] }));
  const noHint = embeddedScript(JSON.stringify({ unrelated: true }));
  const invalid = embeddedScript('{"image_versions2": not json');
  const doc = embeddedDocument([withMedia, noHint, invalid]);
  const { page, posted, timers } = loadHook({ fetchImpl: async () => textResponse("{}"), document: doc });
  assert.equal(doc.queried[0], 'script[type="application/json"]');
  assert.equal(posted.length, 1);
  assert.equal(posted[0].message.media[0].id, "Demb000001");
  assert.deepEqual(plain(page.observedWith.options), { childList: true, subtree: true });

  // Scripts added while scrolling are picked up on a debounced scan; known ones are not read again.
  const late = embeddedScript(JSON.stringify({ items: [igPost("Demb000002")] }));
  doc.querySelectorAll = () => [withMedia, late];
  page.observed();
  page.observed();
  assert.equal(timers.length, 1, "bursts of mutations schedule one scan");
  timers[0]();
  assert.deepEqual(
    posted.map(entry => entry.message.media[0].id),
    ["Demb000001", "Demb000002"]
  );
  page.observed();
  assert.equal(timers.length, 2, "a finished scan allows the next one");
  doc.querySelectorAll = () => [];
  timers[1]();
  assert.equal(posted.length, 2);
});

test("hook: a loading page waits for DOMContentLoaded before scanning embedded data", () => {
  const doc = embeddedDocument([embeddedScript(JSON.stringify({ items: [igPost("Dlate00001")] }))], "loading");
  const { posted } = loadHook({ fetchImpl: async () => textResponse("{}"), document: doc });
  assert.equal(posted.length, 0);
  assert.deepEqual(plain(doc.listeners.DOMContentLoaded.options), { once: true });
  doc.listeners.DOMContentLoaded.listener();
  assert.equal(posted.length, 1);
});

test("hook: TikTok reads its own embedded selector and hint", () => {
  const item = {
    id: "7123456789012345678",
    author: { uniqueId: "someone" },
    video: { playAddr: "https://v16-webapp.tiktokcdn.com/a.mp4" }
  };
  const doc = embeddedDocument([embeddedScript(JSON.stringify({ item }))]);
  const { posted } = loadHook({ hostname: "www.tiktok.com", fetchImpl: async () => textResponse("{}"), document: doc });
  assert.equal(doc.queried[0], 'script[type="application/json"], script#__UNIVERSAL_DATA_FOR_REHYDRATION__');
  assert.equal(posted[0].message.media[0].kind, "video");
});

test("hook: X has no embedded bootstrap, so the document is never queried", () => {
  const doc = embeddedDocument([]);
  loadHook({ hostname: "x.com", fetchImpl: async () => textResponse("{}"), document: doc });
  assert.deepEqual(doc.queried, []);
});

test("hook: a page with embedded data but no document object is fine", () => {
  assert.doesNotThrow(() => loadHook({ fetchImpl: async () => textResponse("{}"), document: null }));
});

// ---- the isolated-world bridge -----------------------------------------------------------

function loadBridge() {
  const sent = [];
  const listeners = [];
  const context = {
    URL,
    location: { origin: "https://www.instagram.com" },
    chrome: {
      runtime: {
        sendMessage: message => {
          sent.push(message);
          return context.reject ? Promise.reject(new Error("no receiver")) : Promise.resolve({ ok: true });
        }
      }
    },
    addEventListener: (type, listener) => listeners.push({ type, listener })
  };
  context.window = context;
  context.globalThis = context;
  // Nothing else is loaded first: the bridge has to work on its own.
  runScript("src/page/media-bridge.js", context);
  const deliver = event =>
    listeners[0].listener({ source: vm.runInContext("window", context), origin: context.location.origin, ...event });
  return { context, sent, listeners, deliver };
}

const CHANNEL = "page-media-saver:media";

test("bridge: installs one message listener, even when loaded twice", () => {
  const { context, listeners } = loadBridge();
  assert.equal(listeners.length, 1);
  assert.equal(listeners[0].type, "message");
  runScript("src/page/media-bridge.js", context);
  assert.equal(listeners.length, 1);
});

test("bridge: well-formed media from the page is forwarded with every field normalised", () => {
  const { sent, deliver } = loadBridge();
  deliver({
    data: {
      channel: CHANNEL,
      media: [
        {
          platform: "Instagram",
          kind: "photo",
          id: 123,
          index: "2",
          owner: "someone",
          durationMs: "x",
          width: "1080",
          height: 720,
          url: `${IG}a.jpg`
        },
        { platform: "Facebook", id: "9", index: 0 }
      ]
    }
  });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, "MEDIA_FOUND");
  assert.deepEqual(plain(sent[0].media), [
    {
      platform: "Instagram",
      kind: "photo",
      id: "123",
      index: 2,
      owner: "someone",
      durationMs: 0,
      width: 1080,
      height: 720,
      url: `${IG}a.jpg`
    },
    { platform: "Facebook", kind: "video", id: "9", index: 1, owner: null, durationMs: 0, width: 0, height: 0, url: "" }
  ]);
});

test("bridge: forwards a rate-limit status without response content", () => {
  const { sent, deliver } = loadBridge();
  deliver({ data: { channel: CHANNEL, rateLimitStatus: 429, body: "private response" } });
  assert.deepEqual(plain(sent), [{ type: "PLATFORM_RATE_LIMIT", status: 429 }]);
});

test("bridge: messages from another frame or origin, or another channel, are ignored", () => {
  const { context, sent, deliver } = loadBridge();
  const media = [{ platform: "Instagram", id: "1" }];
  deliver({ source: {}, data: { channel: CHANNEL, media } });
  deliver({ origin: "https://evil.example", data: { channel: CHANNEL, media } });
  deliver({ data: { channel: "something-else", media } });
  deliver({ data: { channel: CHANNEL, media: "not a list" } });
  deliver({ data: null });
  deliver({ data: undefined });
  assert.equal(context.window, context);
  assert.deepEqual(sent, []);
});

test("bridge: entries without a platform or an id and junk entries are dropped", () => {
  const { sent, deliver } = loadBridge();
  deliver({
    data: {
      channel: CHANNEL,
      media: [{ platform: "", id: "1" }, { platform: "Instagram", id: "" }, { platform: "Instagram" }, null, undefined]
    }
  });
  assert.deepEqual(sent, [], "nothing valid, nothing sent");
});

test("bridge: at most 100 entries are forwarded, and a rejected send is swallowed", async () => {
  const { context, sent, deliver } = loadBridge();
  context.reject = true;
  const media = Array.from({ length: 150 }, (_, i) => ({ platform: "TikTok", kind: "photo", id: String(i + 1) }));
  deliver({ data: { channel: CHANNEL, media } });
  await tick();
  assert.equal(sent[0].media.length, 100);
  assert.ok(sent[0].media.every(entry => entry.kind === "photo"));
});

test("hook: its counters are left on the root element for the scan to read", async () => {
  const attributes = {};
  const root = {
    setAttribute: (name, value) => {
      attributes[name] = value;
    }
  };
  const fetchImpl = async () => textResponse(JSON.stringify({ data: { node: igPost("ABCDEFGHIJK") } }));
  const { page } = loadHook({
    fetchImpl,
    document: { documentElement: root, querySelectorAll: () => [], readyState: "complete" }
  });
  assert.deepEqual(JSON.parse(attributes["data-pms-hook"]), { documents: 0, found: 0 }, "it reports in when it starts");
  await page.fetch("https://www.instagram.com/api/graphql");
  await tick();
  assert.deepEqual(JSON.parse(attributes["data-pms-hook"]), { documents: 1, found: 1 });
});

test("hook: a page without a root element yet does not break it", () => {
  const { page } = loadHook({
    document: { documentElement: null, querySelectorAll: () => [], readyState: "complete" }
  });
  assert.equal(page.__pageMediaSaverMediaHook, true);
});
