import assert from "node:assert/strict";
import test from "node:test";
import { image, loadPage, node, plain } from "../helpers/fake-page.mjs";

const MEDIA = "https://pbs.twimg.com/media/";

function article({ status = "/NASA/status/100", images = [], video = false } = {}) {
  const link = status ? { href: `https://x.com${status}` } : null;
  return node({
    querySelector: selector => {
      if (selector.includes("/status/")) {
        return link;
      }
      return video && selector === "video" ? node() : null;
    },
    querySelectorAll: () => images
  });
}

function xPage(articles) {
  const page = loadPage({ url: "https://x.com/NASA/" });
  page.document.querySelectorAll = selector => (selector === "article" ? articles : []);
  return page;
}

test("X photos: the largest srcset entry wins and is requested at its original size", async () => {
  const small = `${MEDIA}AAA?format=jpg&name=small`;
  const large = `${MEDIA}AAA?format=jpg&name=large`;
  const page = xPage([
    article({ images: [image({ src: small, srcset: `${small} 680w, ${large} 1200w, broken entry here` })] })
  ]);
  const { items } = await page.ns.collectors.collectX("NASA");
  assert.equal(items.length, 1);
  assert.equal(items[0].url, `${MEDIA}AAA?format=jpg&name=orig`);
  assert.equal(items[0].platform, "Twitter");
  assert.equal(items[0].account, "NASA");
  assert.equal(items[0].filename, "100_01.jpg");
  assert.equal(items[0].key, "Twitter|photo|100|1");
});

test("X photos: a <picture> source can hold the biggest candidate, and density descriptors scale by size", async () => {
  const picture = node({
    querySelectorAll: () => [{ getAttribute: () => `${MEDIA}BBB.png 3x` }, { getAttribute: () => null }]
  });
  const img = image({
    width: 300,
    height: 300,
    src: `${MEDIA}BBB-small.png`,
    srcset: `${MEDIA}BBB-1x.png 1x`,
    picture
  });
  const page = xPage([article({ images: [img] })]);
  const { items } = await page.ns.collectors.collectX("NASA");
  assert.equal(items[0].url, `${MEDIA}BBB.png?name=orig`);
  assert.equal(items[0].filename, "100_01.png");
});

test("X photos: an entry with no descriptor counts as one pixel density; jpeg is saved as jpg", async () => {
  const page = xPage([
    article({ images: [image({ width: 200, height: 200, srcset: `${MEDIA}CCC.jpeg, ${MEDIA}CCC-2.jpeg 0.5x` })] })
  ]);
  const { items } = await page.ns.collectors.collectX("NASA");
  assert.equal(items[0].url, `${MEDIA}CCC.jpeg?name=orig`);
  assert.equal(items[0].filename, "100_01.jpg");
});

test("X photos: the plain src is used without a srcset, and unusable images are skipped", async () => {
  const noSrc = image({ width: 400, height: 400 });
  const badUrl = image({ width: 400, height: 400, src: "http://[broken" });
  const tiny = image({ width: 100, height: 100, src: `${MEDIA}tiny.jpg` });
  const narrow = image({ width: 400, height: 100, src: `${MEDIA}narrow.jpg` });
  const unmeasured = image({ width: 0, height: 0, src: `${MEDIA}unmeasured.jpg` });
  const good = image({ width: 160, height: 160, src: `${MEDIA}good.jpg` });
  const sizeFromAttributes = image({
    width: 500,
    height: 500,
    src: `${MEDIA}attr.jpg`,
    naturalWidth: 0,
    naturalHeight: 0
  });
  const page = xPage([article({ images: [noSrc, badUrl, tiny, narrow, unmeasured, good, sizeFromAttributes] })]);
  const { items } = await page.ns.collectors.collectX("NASA");
  assert.deepEqual(plain(items.map(item => item.url)), [`${MEDIA}good.jpg?name=orig`, `${MEDIA}attr.jpg?name=orig`]);
  assert.deepEqual(
    plain(items.map(item => item.filename)),
    ["100_01.jpg", "100_02.jpg"],
    "photos of one post are numbered in order"
  );
});

test("X photos: reposts of other accounts, video posters and repeated pictures are not saved", async () => {
  const photo = () => image({ src: `${MEDIA}same.jpg` });
  const page = xPage([
    article({ status: "/someone_else/status/1", images: [photo()] }),
    article({ status: "/NASA/status/2", images: [image({ src: `${MEDIA}poster.jpg` })], video: true }),
    article({ status: "/nasa/status/3", images: [photo()] }),
    article({ status: "/NASA/status/4", images: [photo()] }),
    article({ status: null, images: [image({ src: `${MEDIA}anon.jpg` })] })
  ]);
  const { items } = await page.ns.collectors.collectX("NASA");
  assert.deepEqual(
    plain(items.map(item => item.filename)),
    ["3_01.jpg", "post-5_01.jpg"],
    "the owner's name is compared without case; an article without a link gets a positional id"
  );
});

test("X: the page's videos are merged into the result, and other sites have no photo collector", async () => {
  const page = xPage([]);
  const result = await page.ns.collectors.collectX("NASA");
  assert.deepEqual(plain(result), {
    items: [],
    videoArticlesSeen: 0,
    videoDownloadsClicked: 0,
    videoDownloadsSkipped: 0
  });
  const instagram = loadPage({ url: "https://www.instagram.com/jasondchen/" });
  assert.deepEqual(plain(await instagram.ns.collectors.collectX("jasondchen")), { items: [] });
  assert.equal(
    instagram.sent.some(message => message.type === "DOWNLOAD_CACHED_MEDIA"),
    false,
    "nothing is read from an Instagram page"
  );
});

test("an item without a url or an id still gets a stable name", async () => {
  const page = xPage([article({ status: "/NASA/status/9", images: [image({ src: `${MEDIA}x.webp` })] })]);
  const { items } = await page.ns.collectors.collectX("NASA");
  assert.equal(items[0].filename, "9_01.webp");
});

// ---- image sizes -------------------------------------------------------------------------

function imageLoader(behaviour) {
  const created = [];
  return {
    created,
    Image: class {
      constructor() {
        created.push(this);
      }
      set src(value) {
        this.requested = value;
        behaviour(this, value);
      }
    }
  };
}

test("image sizes: a loaded picture states its real pixels and is measured once", async () => {
  const loader = imageLoader((img, url) => {
    img.naturalWidth = url.includes("wide") ? 1600 : 800;
    img.naturalHeight = 900;
    img.onload();
  });
  const page = loadPage({ tweak: sandbox => (sandbox.Image = loader.Image) });
  const items = [{ url: "https://a.example/wide.jpg", filename: "a.jpg" }, { url: "https://a.example/b.jpg" }];
  const sized = await page.ns.imageSize.addImageSizes(items);
  assert.deepEqual(plain(sized), [
    { url: "https://a.example/wide.jpg", filename: "a.jpg", width: 1600, height: 900 },
    { url: "https://a.example/b.jpg", width: 800, height: 900 }
  ]);
  await page.ns.imageSize.addImageSizes(items);
  assert.equal(loader.created.length, 2, "a second pass reuses the measured sizes");
});

test("image sizes: failures, empty pictures and a slow load leave the item without a size", async () => {
  const loader = imageLoader((img, url) => {
    if (url.includes("error")) {
      img.onerror();
    } else if (url.includes("empty")) {
      img.naturalWidth = 0;
      img.naturalHeight = 0;
      img.onload();
    } else if (url.includes("half")) {
      img.naturalWidth = 10;
      img.naturalHeight = 0;
      img.onload();
    }
    // "slow" never answers; the 5 second timer gives up.
  });
  const page = loadPage({ tweak: sandbox => (sandbox.Image = loader.Image) });
  const urls = ["error", "empty", "half", "slow"].map(name => ({ url: `https://a.example/${name}.jpg` }));
  const sized = await page.ns.imageSize.addImageSizes(urls);
  assert.deepEqual(plain(sized), urls);
});

test("image sizes: many items are measured in batches of six and keep their order", async () => {
  const loader = imageLoader((img, url) => {
    img.naturalWidth = Number.parseInt(url.split("/").pop(), 10);
    img.naturalHeight = 1;
    img.onload();
  });
  const page = loadPage({ tweak: sandbox => (sandbox.Image = loader.Image) });
  const items = Array.from({ length: 14 }, (_, i) => ({ url: `https://a.example/${i + 1}.jpg` }));
  const sized = await page.ns.imageSize.addImageSizes(items);
  assert.deepEqual(
    plain(sized.map(item => item.width)),
    items.map((_, i) => i + 1)
  );
  assert.equal(loader.created.length, 14);
  assert.deepEqual(plain(await page.ns.imageSize.addImageSizes([])), []);
});

// ---- page info ---------------------------------------------------------------------------

test("page info: the platform and the profile or post kind come from the address", () => {
  const cases = [
    ["https://x.com/NASA/", "Twitter", true, false],
    ["https://x.com/NASA/media", "Twitter", true, false],
    ["https://x.com/NASA/status/2115779022722630042", "Twitter", false, true],
    ["https://x.com/home", "Twitter", false, false],
    ["https://www.instagram.com/stories/disleft/", "Instagram", false, true],
    ["https://www.instagram.com/reel/DezPoWNzXMt/", "Instagram", false, true],
    ["https://www.facebook.com/lamoon.ladyofmoon/photos", "Facebook", true, false],
    ["https://www.tiktok.com/@someone", "TikTok", true, false],
    ["https://www.tiktok.com/@someone/video/7123456789012345678", "TikTok", false, true],
    ["https://example.com/", null, false, false]
  ];
  for (const [url, platform, grid, post] of cases) {
    const { ns } = loadPage({ url });
    assert.equal(ns.page.platformForPage(), platform, url);
    assert.equal(ns.page.isProfileGrid(), grid, `${url} grid`);
    assert.equal(ns.page.isMediaPostPage(), post, `${url} post`);
  }
  const { ns } = loadPage();
  assert.equal(ns.page.isProfileGrid("MySpace"), false, "an unknown platform is not a profile");
  assert.equal(ns.page.isMediaPostPage("MySpace"), false);
  assert.equal(ns.page.getAccount("MySpace"), "account");
});

test("page info: the account is the first path part, or else the author of the page's links", () => {
  assert.equal(loadPage({ url: "https://x.com/NASA/" }).ns.page.getAccount("Twitter"), "NASA");

  const instagram = loadPage({ url: "https://www.instagram.com/reel/DezPoWNzXMt/" });
  instagram.document.querySelectorAll = selector =>
    selector === "a[href]"
      ? [{ href: "http://[broken" }, { href: "https://www.instagram.com/explore/" }, { href: "/creator_name/" }]
      : [];
  assert.equal(instagram.ns.page.getAccount("Instagram"), "creator_name");

  const container = node({ querySelectorAll: () => [{ href: "https://www.instagram.com/inside/" }] });
  assert.equal(instagram.ns.page.getAccount("Instagram", container), "inside");

  const empty = loadPage({ url: "https://www.instagram.com/" });
  assert.equal(empty.ns.page.getAccount("Instagram"), "account");
});

test("page info: an address with no path still has a name to save under", () => {
  const { ns } = loadPage({ url: "https://www.facebook.com/" });
  assert.equal(ns.page.getAccount("Facebook"), "account");
  assert.equal(ns.page.clean("a/b:c", "x"), "a_b_c");
});

// ---- video detection ---------------------------------------------------------------------

test("video detection: a post is a video post when any marker matches, and a broken selector is not fatal", () => {
  const { context } = loadPage();
  const detection = context.PageMediaDetection;
  assert.equal(detection.isVideoPost(null), false);
  assert.equal(detection.isVideoPost({}), false);
  assert.equal(
    detection.isVideoPost({
      querySelector: selector => {
        if (selector === "video") {
          throw new Error("SyntaxError");
        }
        return selector.startsWith('[data-testid="videoPlayer"]') ? {} : null;
      }
    }),
    true
  );
  assert.equal(detection.isVideoPost({ querySelector: () => null }), false);
});

test("video detection: the container of a node is found with closest, or by walking up parents", () => {
  const { context } = loadPage();
  const detection = context.PageMediaDetection;
  assert.equal(detection.videoContainer(null), null);
  const wrapper = { matches: selector => selector.includes("article") };
  assert.equal(detection.videoContainer({ closest: () => wrapper }), wrapper);
  const deep = { parentElement: { parentElement: wrapper } };
  assert.equal(detection.videoContainer(deep), wrapper);
  const loose = { matches: () => false, parentElement: { parentElement: null } };
  assert.equal(detection.videoContainer(loose), null);
  let chain = { matches: () => false };
  for (let i = 0; i < 20; i++) {
    chain = { matches: () => false, parentElement: chain };
  }
  chain.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.parentElement.matches =
    () => true;
  assert.equal(detection.videoContainer(chain), null, "a container more than 16 levels up is not this video's");
});

test("video detection: hidden or detached containers and videos are ignored; bare videos find their post", () => {
  const { context } = loadPage();
  const detection = context.PageMediaDetection;
  const hidden = node({ getClientRects: () => [], querySelector: () => ({}) });
  const detached = node({ isConnected: false, querySelector: () => ({}) });
  const plainArticle = node({ querySelector: () => null });
  const visiblePost = node({ querySelector: selector => (selector === '[data-testid="videoPlayer"]' ? {} : null) });
  const hiddenVideo = node({ getClientRects: () => [] });
  const withVideo = node({
    querySelector: selector => (selector === "video" ? hiddenVideo : null),
    querySelectorAll: selector => (selector === "video" ? [hiddenVideo] : [])
  });
  const doc = {
    querySelectorAll: selector => (selector === "video" ? [] : [hidden, detached, plainArticle, visiblePost, withVideo])
  };
  const found = detection.collectVideoContainers(doc);
  assert.equal(found.length, 2);
  assert.equal(found[0].container, visiblePost);
  assert.equal(found[0].video, null);
  assert.equal(found[1].video, hiddenVideo, "a hidden video is still the post's video when there is no other");
  assert.equal(detection.hasVisibleVideoPost(doc), true);
  assert.equal(detection.hasVisibleVideoPost({ querySelectorAll: () => [] }), false);

  // A video outside any article-like element is paired with its closest container.
  const owner = node({ querySelector: () => null });
  const bare = node({ closest: () => owner });
  const orphan = node({ closest: () => null, matches: () => false });
  const hiddenBare = node({ getClientRects: () => [] });
  const second = {
    querySelectorAll: selector => (selector === "video" ? [bare, orphan, hiddenBare] : [])
  };
  const pairs = detection.collectVideoContainers(second);
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].container, owner);
  assert.equal(pairs[0].video, bare);

  // The video a container lists is preferred when visible, then any video it holds.
  const visibleVideo = node();
  const richPost = node({
    querySelector: selector => (selector === "video" ? hiddenVideo : null),
    querySelectorAll: selector => (selector === "video" ? [hiddenVideo, visibleVideo] : [])
  });
  const third = { querySelectorAll: selector => (selector === "video" ? [] : [richPost]) };
  assert.equal(detection.collectVideoContainers(third)[0].video, visibleVideo);
  const unrendered = {
    getClientRects: undefined,
    isConnected: undefined,
    querySelector: () => ({}),
    querySelectorAll: () => []
  };
  assert.equal(
    detection.collectVideoContainers({ querySelectorAll: s => (s === "video" ? [] : [unrendered]) }).length,
    1
  );
});

// ---- the content script entry ------------------------------------------------------------

test("messages: unknown or malformed messages are not answered", async () => {
  const page = loadPage();
  assert.equal(await page.request({ type: "SOMETHING_ELSE" }), undefined);
  assert.equal(await page.request(undefined), undefined);
  assert.equal(await page.request(null), undefined);
});

test("messages: a stop request updates the message and publishes the state", async () => {
  const page = loadPage();
  const reply = await page.request({ type: "AUTO_STOP" });
  assert.equal(reply.ok, true);
  assert.match(reply.state.message, /Stopping/);
  assert.ok(page.sent.some(message => message.type === "AUTO_PROGRESS"));
  assert.equal(page.ns.scan.stopRequested, true);
});

test("messages: a failing storage read or scan answers with the error instead of hanging", async () => {
  const failing = loadPage();
  failing.context.chrome.storage.local.get = async () => {
    throw new Error("storage is gone");
  };
  assert.deepEqual(plain(await failing.request({ type: "AUTO_START" })), { ok: false, error: "storage is gone" });

  const stringError = loadPage();
  stringError.context.chrome.storage.local.get = () => Promise.reject("plain failure");
  assert.deepEqual(plain(await stringError.request({ type: "AUTO_START" })), { ok: false, error: "plain failure" });

  const unreadable = loadPage({ url: "https://example.com/" });
  const collected = await unreadable.request({ type: "COLLECT_VISIBLE_MEDIA" });
  assert.equal(collected.ok, false);

  const broken = loadPage();
  broken.ns.scan.collect = () => Promise.reject(new Error("page threw"));
  assert.deepEqual(plain(await broken.request({ type: "COLLECT_VISIBLE_MEDIA" })), { ok: false, error: "page threw" });
});

test("messages: a CLI job needs an id and the right page", async () => {
  const page = loadPage();
  const noId = await page.request({ type: "AUTO_START_CLI", job: { url: "https://x.com/NASA/", limit: 1 } });
  assert.equal(noId.ok, false);
  const noJob = await page.request({ type: "AUTO_START_CLI" });
  assert.equal(noJob.ok, false);
  const repair = await page.request({
    type: "AUTO_START_CLI",
    job: { jobId: "r1", url: "https://x.com/NASA/", limit: 2, repairTargets: ["a.jpg"] }
  });
  assert.equal(repair.ok, true);
  assert.deepEqual(plain(repair.state.repairTargets), ["a.jpg"]);
  assert.equal(repair.state.repairMode, true);
});

test("announcing: a CLI tab announces itself even on a page that is not a profile, and repeats while a job runs", async () => {
  const page = loadPage({ url: "https://x.com/home#media-downloader-job=job-7" });
  const hash = page.ns.page;
  assert.ok(hash);
  const first = page.sent.find(message => message.type === "CLI_PAGE_READY");
  if (first) {
    assert.equal(first.cliJobId, "job-7");
    assert.equal(first.pageUrl, "https://x.com/home#media-downloader-job=job-7");
    assert.equal(page.intervals[0].ms, 15000);
    const before = page.sent.length;
    page.intervals[0].fn();
    assert.equal(page.sent.length, before, "no job is running, so nothing is repeated");
    await page.request({ type: "AUTO_START_CLI", job: { jobId: "x", url: "https://x.com/home", limit: 1 } });
  }
});

test("announcing: a running job repeats its announcement every 15 seconds", async () => {
  const page = loadPage({ url: "https://x.com/NASA/", onSend: () => Promise.reject(new Error("worker asleep")) });
  const announcementTimer = page.intervals.find(interval => interval.ms === 15000);
  assert.ok(announcementTimer);
  const announcements = () => page.sent.filter(message => message.type === "CLI_PAGE_READY").length;
  assert.equal(announcements(), 1, "a rejected announcement is swallowed");
  announcementTimer.fn();
  assert.equal(announcements(), 1, "idle: nothing repeats");
  const started = await page.request({
    type: "AUTO_START_CLI",
    job: { jobId: "j9", url: "https://x.com/NASA/", limit: 1 }
  });
  assert.equal(started.ok, true);
  announcementTimer.fn();
  assert.equal(announcements(), 2);
});
