import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { CONTENT_FILES, loadContent } from "../helpers/content.mjs";

const plain = value => JSON.parse(JSON.stringify(value));

test("the content scripts load in the manifest's order and wire the modules together", () => {
  const { context } = loadContent();
  const ns = context.PageMediaSaver;
  assert.deepEqual(plain(Object.keys(ns).sort()), ["collectors", "core", "imageSize", "page", "scan", "videoSources"]);
  for (const name of ["platformForPage", "isProfileGrid", "isMediaPostPage", "getAccount", "clean"]) {
    assert.equal(typeof ns.page[name], "function", `page.${name}`);
  }
  assert.equal(typeof ns.collectors.collectX, "function");
  assert.equal(ns.collectors.collectInstagram, undefined, "Instagram photos never come from page thumbnails");
  assert.equal(ns.collectors.collectFacebook, undefined, "Facebook photos never come from page thumbnails");
  assert.equal(typeof ns.videoSources.collectPageMedia, "function");
  assert.equal(typeof ns.scan.startAutoScan, "function");
  assert.equal(typeof ns.scan.collect, "function");
  assert.ok(context.PageMediaDetection, "media detection is loaded with the content scripts");
  assert.ok(CONTENT_FILES.indexOf("lib/platforms.js") < CONTENT_FILES.indexOf("src/content/page-info.js"));
});

test("loading the scripts twice (a popup re-injection) registers one listener and keeps the state", () => {
  const page = loadContent();
  page.reload();
  assert.equal(page.listeners.length, 1);
});

test("a profile page announces itself to the CLI bridge on load", () => {
  const { sent } = loadContent({ url: "https://x.com/NASA/" });
  const ready = sent.find(message => message.type === "CLI_PAGE_READY");
  assert.equal(ready.platform, "Twitter");
  assert.equal(ready.account, "NASA");
  assert.equal(
    sent.some(message => message.type === "CLI_PAGE_READY") && loadContent({ url: "https://x.com/home" }).sent.length,
    0,
    "a non-profile page stays silent"
  );
});

for (const [url, platform] of [
  ["https://x.com/NASA/", "Twitter"],
  ["https://www.instagram.com/jasondchen/", "Instagram"],
  ["https://www.facebook.com/yunie.nguyen.1911/reels/", "Facebook"]
]) {
  test(`reading an empty ${platform} page returns no items and no error`, async () => {
    const page = loadContent({
      url,
      onSend: () => ({ ok: true, started: 0, skipped: 0, failed: 0, pending: 0, cached: 0 })
    });
    const result = await page.request({ type: "COLLECT_VISIBLE_MEDIA" });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.platform, platform);
    assert.deepEqual(plain(result.items), []);
  });
}

test("a scan started from the popup uses the saved limit, or none when Unlimited is checked", async () => {
  const limited = loadContent({ storage: { scanLimit: { limit: 7, unlimited: false } } });
  const first = await limited.request({ type: "AUTO_START" });
  assert.equal(first.ok, true, first.error);
  assert.equal(first.state.limit, 7);

  const unlimited = loadContent({ storage: { scanLimit: { limit: 7, unlimited: true } } });
  assert.equal((await unlimited.request({ type: "AUTO_START" })).state.limit, null);

  const untouched = loadContent();
  assert.equal((await untouched.request({ type: "AUTO_START" })).state.limit, 10, "10 is the default");
});

test("a CLI job brings its own limit: a number, or null for no limit", async () => {
  const job = limit => ({ type: "AUTO_START_CLI", job: { jobId: "j1", url: "https://x.com/NASA/", limit } });
  assert.equal((await loadContent().request(job(3))).state.limit, 3);
  assert.equal((await loadContent().request(job(null))).state.limit, null);
  assert.equal(
    (await loadContent().request(job(undefined))).state.limit,
    null,
    "a job saved before the limit existed stays unlimited"
  );
});

test("a CLI job for another page is refused", async () => {
  const result = await loadContent().request({
    type: "AUTO_START_CLI",
    job: { jobId: "j1", url: "https://x.com/other/", limit: 3 }
  });
  assert.equal(result.ok, false);
});

test("the limit counts photos and videos together and reaches zero exactly", async () => {
  const page = loadContent();
  const { state, limitRemaining } =
    (await page.request({ type: "AUTO_START_CLI", job: { jobId: "j2", url: "https://x.com/NASA/", limit: 3 } }))
      .state && page.context.PageMediaSaver.scan;
  assert.equal(state.limit, 3);
  state.started = 2;
  state.videoStarted = 0;
  assert.equal(limitRemaining(), 1);
  state.videoStarted = 1;
  assert.equal(limitRemaining(), 0);
  state.started = 5;
  assert.equal(limitRemaining(), 0, "never negative");
});

test("a scan of an empty profile finishes and reports to the background", async () => {
  const page = loadContent({
    onSend: message =>
      message.type === "DRAIN_DOWNLOADS" || message.type === "DOWNLOAD_STATUS"
        ? { ok: true, pending: 0, failed: 0, retryable: 0 }
        : { ok: true, started: 0, skipped: 0, failed: 0, pending: 0, cached: 0 }
  });
  await page.request({ type: "AUTO_START_CLI", job: { jobId: "j3", url: "https://x.com/NASA/", limit: 5 } });
  for (let i = 0; i < 400 && page.context.PageMediaSaver.scan.state.running; i++) {
    await page.settle();
  }
  const state = page.context.PageMediaSaver.scan.state;
  assert.equal(state.running, false);
  assert.ok(["complete", "paused"].includes(state.status), state.status);
  assert.ok(page.sent.some(message => message.type === "AUTO_DONE" && message.state.jobId === "j3"));
});

test("stop requests are accepted and reported", async () => {
  const page = loadContent();
  const stopped = await page.request({ type: "AUTO_STOP" });
  assert.equal(stopped.ok, true);
  assert.equal((await page.request({ type: "AUTO_STATUS" })).ok, true);
});

test("the video helpers read ids from the page's own links", () => {
  const page = loadContent({ url: "https://www.instagram.com/jasondchen/" });
  const links = [
    { href: "https://www.instagram.com/jasondchen/reel/DYe3TWYTKkK/" },
    { href: "https://www.instagram.com/p/Dabc12345/" }
  ];
  page.context.document.querySelectorAll = selector => (selector === "a[href]" ? links : []);
  const ids = page.context.PageMediaSaver.videoSources.domVideoIds("Instagram");
  assert.deepEqual(plain(ids.sort()), ["DYe3TWYTKkK", "Dabc12345"]);
});

// A single post or reel page links to related posts and X keeps other videos of the
// account in its cache; none of them may be saved when the job names one post.
for (const [url, platform, own, others] of [
  [
    "https://www.instagram.com/reel/DezPoWNzXMt/",
    "Instagram",
    "DezPoWNzXMt",
    ["https://www.instagram.com/reel/Dother0001/", "https://www.instagram.com/p/Dother0002/"]
  ],
  [
    "https://www.facebook.com/reel/2059757664673295",
    "Facebook",
    "2059757664673295",
    ["https://www.facebook.com/reel/111", "https://www.facebook.com/watch/?v=222"]
  ],
  [
    "https://x.com/NASA/status/2115779022722630042",
    "Twitter",
    "2115779022722630042",
    ["https://x.com/NASA/status/1", "https://x.com/NASA/status/2"]
  ]
]) {
  test(`${platform}: a single post job asks for that post's video only`, async () => {
    const page = loadContent({
      url,
      onSend: message =>
        message.type === "DRAIN_DOWNLOADS" || message.type === "DOWNLOAD_STATUS"
          ? { ok: true, pending: 0, failed: 0, retryable: 0 }
          : { ok: true, started: 0, skipped: 0, failed: 0, pending: 0, cached: 0 }
    });
    const links = others.map(href => ({ href }));
    page.context.document.querySelectorAll = selector => (selector === "a[href]" ? links : []);
    vm.runInContext(
      "PageMediaDetection = { hasVisibleVideoPost: () => true, collectVideoContainers: () => [], isVideoPost: () => false }",
      page.context
    );
    const started = await page.request({ type: "AUTO_START_CLI", job: { jobId: "post-1", url, limit: 5 } });
    assert.equal(started.ok, true, started.error);
    for (let i = 0; i < 40 && page.context.PageMediaSaver.scan.state.running; i++) {
      await page.settle();
    }
    const request = page.sent.find(message => message.type === "DOWNLOAD_CACHED_MEDIA");
    assert.deepEqual(plain(request.ids), [own]);
  });
}

for (const [url, platform] of [
  ["https://www.instagram.com/jasondchen/", "Instagram"],
  ["https://www.facebook.com/lamoon.ladyofmoon/photos", "Facebook"]
]) {
  test(`${platform}: images in the page are never collected, only full-size data is`, async () => {
    const page = loadContent({
      url,
      onSend: () => ({ ok: true, started: 0, skipped: 0, failed: 0, pending: 0, cached: 0 })
    });
    const thumbnail = {
      naturalWidth: 206,
      naturalHeight: 206,
      width: 206,
      height: 206,
      currentSrc: "https://scontent.x.fbcdn.net/thumb_s206x206.jpg",
      src: "https://scontent.x.fbcdn.net/thumb_s206x206.jpg",
      getAttribute: () => null,
      closest: () => null
    };
    const tile = {
      href: "https://www.facebook.com/photo/?fbid=1086989087485347",
      isConnected: true,
      clicked: 0,
      querySelector: () => thumbnail,
      querySelectorAll: () => [thumbnail],
      getClientRects: () => [{}],
      closest: () => null,
      click() {
        this.clicked++;
      },
      getAttribute: () => "/p/DfakePost01/"
    };
    page.context.document.querySelectorAll = () => [tile];
    const result = await page.request({ type: "COLLECT_VISIBLE_MEDIA" });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(plain(result.items), []);
  });
}

test("Facebook: a photo link's fbid is an id the cache is asked for", () => {
  const page = loadContent({ url: "https://www.facebook.com/lamoon.ladyofmoon/photos" });
  const links = [
    { href: "https://www.facebook.com/photo/?fbid=1086989087485347&set=a.1" },
    { href: "https://www.facebook.com/photo.php?fbid=1092860713564851" }
  ];
  page.context.document.querySelectorAll = selector => (selector === "a[href]" ? links : []);
  assert.deepEqual(plain(page.context.PageMediaSaver.videoSources.domVideoIds("Facebook").sort()), [
    "1086989087485347",
    "1092860713564851"
  ]);
});

test("Instagram: a profile scan opens photo posts as well as reels to load their full-size data", () => {
  const source = fs.readFileSync(new URL("../../src/content/video-sources.js", import.meta.url), "utf8");
  assert.match(source, /a\[href\*="\/reel\/"\], a\[href\*="\/p\/"\]/);
});
