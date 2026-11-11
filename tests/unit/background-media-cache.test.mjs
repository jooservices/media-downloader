import assert from "node:assert/strict";
import test from "node:test";
import { loadBackground, plain } from "../helpers/background.mjs";

const photo = (id, overrides = {}) => ({
  platform: "Twitter",
  kind: "photo",
  id,
  index: 1,
  owner: "Alice",
  width: 1000,
  height: 500,
  url: `https://pbs.twimg.com/media/${id}.jpg`,
  ...overrides
});
const video = (id, overrides = {}) => ({
  platform: "Twitter",
  kind: "video",
  id,
  index: 1,
  owner: "Alice",
  durationMs: 5000,
  width: 1280,
  height: 720,
  url: `https://video.twimg.com/ext_tw_video/${id}/vid/a.mp4`,
  ...overrides
});
const found = (env, media) => env.send({ type: "MEDIA_FOUND", media }).then(plain);
const saveCached = async (env, request) => {
  const reply = await env.send({ type: "DOWNLOAD_CACHED_MEDIA", ...request });
  return plain(reply?.requestId ? await env.send({ type: "CACHED_MEDIA_RESULT", requestId: reply.requestId }) : reply);
};

test("media must be a list", async () => {
  const env = loadBackground();
  assert.deepEqual(await found(env, "x"), { ok: false, error: "No media was provided." });
});

test("only well-formed entries from the platform's own hosts are cached, with safe defaults", async () => {
  const env = loadBackground();
  const result = await found(env, [
    photo("abc123"),
    video("vid456"),
    photo("bad id!"),
    photo("ab"),
    photo("zzz999", { platform: "Nowhere" }),
    photo("kind111", { kind: "audio" }),
    photo("host222", { url: "https://evil.example.com/a.jpg" }),
    photo("http333", { url: "http://pbs.twimg.com/media/a.jpg" }),
    photo("junk444", { url: "not a url" }),
    video("photo555", { url: "https://pbs.twimg.com/media/a.jpg" }),
    null,
    {
      platform: "Twitter",
      id: "implied1",
      url: "https://video.twimg.com/a.mp4",
      index: "x",
      owner: "",
      durationMs: "q"
    }
  ]);
  assert.deepEqual(result, { ok: true, added: 3, cached: 3 });
  const cache = plain(env.storage.mediaCache);
  assert.deepEqual(Object.keys(cache), [
    "Twitter:photo:abc123:1",
    "Twitter:video:vid456:1",
    "Twitter:video:implied1:1"
  ]);
  assert.deepEqual(cache["Twitter:video:implied1:1"], {
    platform: "Twitter",
    kind: "video",
    id: "implied1",
    index: 1,
    owner: null,
    durationMs: 0,
    width: 0,
    height: 0,
    url: "https://video.twimg.com/a.mp4"
  });
});

test("reporting an entry again replaces it without counting it as new, and keeps the newest on top", async () => {
  const env = loadBackground();
  await found(env, [photo("aaa111"), photo("bbb222")]);
  const result = await found(env, [photo("aaa111", { width: 2000 })]);
  assert.deepEqual(result, { ok: true, added: 0, cached: 2 });
  assert.deepEqual(Object.keys(env.storage.mediaCache), ["Twitter:photo:bbb222:1", "Twitter:photo:aaa111:1"]);
  assert.equal(env.storage.mediaCache["Twitter:photo:aaa111:1"].width, 2000);
});

test("at most 100 entries are taken per report and 4000 are kept, dropping the oldest", async () => {
  const many = Array.from({ length: 101 }, (_, index) => photo(`many${String(index).padStart(3, "0")}`));
  const env = loadBackground();
  assert.equal((await found(env, many)).added, 100);

  const full = Object.fromEntries(
    Array.from({ length: 4000 }, (_, index) => [`Twitter:photo:old${index}:1`, photo(`old${index}`)])
  );
  const crowded = loadBackground({ storage: { mediaCache: full } });
  const result = await found(crowded, [photo("new0001"), photo("new0002")]);
  assert.deepEqual(result, { ok: true, added: 2, cached: 4000 });
  const keys = Object.keys(crowded.storage.mediaCache);
  assert.equal(keys.includes("Twitter:photo:old0:1"), false);
  assert.equal(keys.includes("Twitter:photo:old1:1"), false);
  assert.equal(keys.at(-1), "Twitter:photo:new0002:1");
});

test("cached media is saved for the scanned account only, photos and videos named their usual way", async () => {
  const env = loadBackground();
  await found(env, [
    photo("p100", { index: 2 }),
    video("v100"),
    video("v200", { index: 3 }),
    photo("other1", { owner: "Someone Else" }),
    photo("noowner", { owner: "" })
  ]);
  const result = await saveCached(env, { platform: "Twitter", account: "alice" });
  assert.deepEqual([result.ok, result.started, result.cached], [true, 3, 3]);
  assert.deepEqual(plain(result.coveredIds).sort(), ["p100", "v100", "v200"]);
  assert.deepEqual(env.started.map(item => item.filename).sort(), [
    "Twitter/Alice/p100_02_1000x500.jpg",
    "Twitter/Alice/video_v100_1280x720.mp4",
    "Twitter/Alice/video_v200_03_1280x720.mp4"
  ]);
});

test("with post ids from the page, entries of unknown owner are saved into the scanned account's folder", async () => {
  const env = loadBackground();
  await found(env, [
    photo("known1", { owner: "" }),
    photo("known2", { owner: "bob" }),
    photo("unwanted", { owner: "" })
  ]);
  const result = await saveCached(env, { platform: "Twitter", account: "alice", ids: ["known1", "known2", 77] });
  assert.equal(result.started, 1, "bob's media does not land in alice's folder");
  assert.deepEqual(plain(result.coveredIds), ["known1"]);
  assert.equal(env.started[0].filename, "Twitter/alice/known1_01_1000x500.jpg");

  const noAccount = loadBackground();
  await found(noAccount, [photo("kay1", { owner: "bob" })]);
  const any = await saveCached(noAccount, { platform: "Twitter", ids: ["kay1"] });
  assert.equal(any.started, 1, "without a scanned account any owner is accepted");
});

test("the same full-size item reached from grid data and its opened post is saved only once", async () => {
  const env = loadBackground();
  const item = photo("same001", {
    platform: "Instagram",
    url: "https://scontent.cdninstagram.com/v/same.jpg",
    width: 1080,
    height: 1350,
    fullSize: true
  });
  await found(env, [item]);
  const fromGrid = await saveCached(env, { platform: "Instagram", account: "alice", ids: ["same001"] });
  await found(env, [item]);
  const fromPost = await saveCached(env, { platform: "Instagram", account: "alice", ids: ["same001"] });

  assert.equal(fromGrid.started, 1);
  assert.equal(fromPost.started, 0);
  assert.equal(fromPost.pending, 1, "an active download remains reserved without starting twice");
  assert.equal(env.started.length, 1);
  assert.equal(env.started[0].filename, "Instagram/Alice/same001_01_1080x1350.jpg");
});

test("Instagram and Facebook previews do not cover grid ids, but full-size parser entries do", async () => {
  const env = loadBackground();
  await found(env, [
    photo("igpreview", {
      platform: "Instagram",
      owner: "alice",
      url: "https://scontent.cdninstagram.com/v/preview.jpg",
      width: 320,
      height: 400,
      fullSize: false
    }),
    photo("fbpreview", {
      platform: "Facebook",
      owner: "",
      url: "https://scontent.fbcdn.net/v/preview.jpg",
      width: 320,
      height: 240,
      fullSize: false
    }),
    photo("igfull001", {
      platform: "Instagram",
      owner: "alice",
      url: "https://scontent.cdninstagram.com/v/full.jpg",
      width: 1440,
      height: 1800,
      fullSize: true
    }),
    photo("fbfull001", {
      platform: "Facebook",
      owner: "",
      url: "https://scontent.fbcdn.net/v/full.jpg",
      width: 2048,
      height: 1536,
      fullSize: true
    })
  ]);

  const previews = await saveCached(env, {
    platform: "Instagram",
    account: "alice",
    ids: ["igpreview"],
    limit: null
  });
  assert.equal(previews.started, 0);
  assert.deepEqual(plain(previews.coveredIds), []);
  const facebookPreview = await saveCached(env, {
    platform: "Facebook",
    account: "alice",
    ids: ["fbpreview"],
    limit: null
  });
  assert.equal(facebookPreview.started, 0);
  assert.deepEqual(plain(facebookPreview.coveredIds), []);

  const instagram = await saveCached(env, { platform: "Instagram", account: "alice", ids: ["igfull001"] });
  const facebook = await saveCached(env, { platform: "Facebook", account: "alice", ids: ["fbfull001"] });
  assert.equal(instagram.started, 1);
  assert.equal(facebook.started, 1);
  assert.deepEqual(plain(instagram.coveredIds), ["igfull001"]);
  assert.deepEqual(plain(facebook.coveredIds), ["fbfull001"]);
});

test("a partially cached Instagram carousel saves eligible items but remains uncovered for post fallback", async () => {
  const env = loadBackground();
  await found(env, [
    photo("carousel1", {
      platform: "Instagram",
      index: 1,
      expectedItems: 2,
      fullSize: true,
      url: "https://scontent.cdninstagram.com/v/carousel1.jpg"
    }),
    photo("carousel1", {
      platform: "Instagram",
      index: 2,
      expectedItems: 2,
      fullSize: false,
      url: "https://scontent.cdninstagram.com/v/carousel1-preview.jpg"
    })
  ]);

  const grid = await saveCached(env, { platform: "Instagram", account: "alice", ids: ["carousel1"] });
  assert.equal(grid.started, 1, "the eligible original is saved immediately");
  assert.deepEqual(plain(grid.coveredIds), [], "the incomplete sibling keeps the post available to fallback");

  await found(env, [
    photo("carousel1", {
      platform: "Instagram",
      index: 1,
      expectedItems: 2,
      fullSize: true,
      url: "https://scontent.cdninstagram.com/v/carousel1.jpg"
    }),
    photo("carousel1", {
      platform: "Instagram",
      index: 2,
      expectedItems: 2,
      fullSize: true,
      url: "https://scontent.cdninstagram.com/v/carousel1-largest.jpg"
    })
  ]);
  const opened = await saveCached(env, { platform: "Instagram", account: "alice", ids: ["carousel1"] });
  assert.equal(opened.started, 1, "opening the post saves the incomplete sibling");
  assert.equal(env.started.length, 2, "the already completed sibling is not started twice");
  const repeated = await saveCached(env, { platform: "Instagram", account: "alice", ids: ["carousel1"] });
  assert.equal(repeated.started, 0);
  assert.equal(repeated.pending, 2, "both carousel items remain reserved while their downloads are active");
  assert.equal(env.started.length, 2);
});

test("an Instagram video does not cover a carousel whose expected photo has no rendition", async () => {
  const env = loadBackground();
  await found(env, [
    video("mixed01", {
      platform: "Instagram",
      url: "https://scontent.cdninstagram.com/v/mixed.mp4",
      expectedPhotos: 1
    })
  ]);

  const result = await saveCached(env, { platform: "Instagram", account: "alice", ids: ["mixed01"] });
  assert.equal(result.started, 1, "the usable video is still saved");
  assert.deepEqual(plain(result.coveredIds), [], "the missing photo keeps the post eligible for fallback");
});

test("a later preview cannot replace a cached original or shrink carousel coverage metadata", async () => {
  const env = loadBackground();
  await found(env, [
    photo("upgrade01", {
      platform: "Instagram",
      index: 1,
      expectedItems: 1,
      fullSize: true,
      url: "https://scontent.cdninstagram.com/v/original.jpg"
    })
  ]);
  await found(env, [
    photo("upgrade01", {
      platform: "Instagram",
      index: 1,
      expectedItems: 2,
      fullSize: false,
      url: "https://scontent.cdninstagram.com/v/preview.jpg"
    })
  ]);

  const cached = env.storage.mediaCache["Instagram:photo:upgrade01:1"];
  assert.equal(cached.url, "https://scontent.cdninstagram.com/v/original.jpg");
  assert.equal(cached.fullSize, true);
  assert.equal(cached.expectedItems, 2);

  const result = await saveCached(env, { platform: "Instagram", account: "alice", ids: ["upgrade01"] });
  assert.deepEqual(plain(result.coveredIds), [], "the newly reported carousel sibling remains uncovered");
  assert.equal(env.started[0].url, "https://scontent.cdninstagram.com/v/original.jpg");
});

test("without a scanned account only entries with a known owner are taken", async () => {
  const env = loadBackground();
  await found(env, [photo("aye1"), photo("bee1", { owner: "" })]);
  const result = await saveCached(env, { platform: "Twitter" });
  assert.equal(result.started, 1);
});

test("the limit counts only items that are not already saved or pending", async () => {
  const env = loadBackground();
  await found(env, [photo("lim001"), photo("lim002"), photo("lim003"), photo("lim004")]);
  await env.ledger.add("Twitter|image|lim001|1");
  await env.inContext(`chrome.storage.local.set({ pendingDownloads: { "Twitter|image|lim002|1": 99 } })`);
  const result = await saveCached(env, { platform: "Twitter", account: "alice", limit: 1 });
  assert.equal(result.cached, 1);
  assert.equal(result.started, 1);
  assert.equal(env.started[0].url, "https://pbs.twimg.com/media/lim003.jpg");

  const zero = await saveCached(env, { platform: "Twitter", account: "alice", limit: 0 });
  assert.deepEqual(plain(zero), {
    ok: true,
    started: 0,
    skipped: 1,
    failed: 0,
    pending: 2,
    errors: [],
    cached: 0,
    coveredIds: ["lim001", "lim002", "lim003", "lim004"],
    diag: { cached: 4, owned: 4, idMatched: null, wantedIds: null, selected: 4 }
  });
});

test("bulk ledger lookups return saved canonical keys", async () => {
  const env = loadBackground();
  await env.ledger.add("Twitter|image|saved01|1");
  await env.ledger.add("Twitter:alice:video:legacy01");
  env.inContext("transactionDone = () => new Promise(() => {})");

  const result = await Promise.race([
    env.ledger
      .hasAny(["Twitter|image|saved01|1", "Twitter|video|missing1|1", "Twitter|video|legacy01|1"])
      .then(keys => [...keys]),
    new Promise((_, reject) => setTimeout(() => reject(new Error("lookup waited for the read-only transaction")), 100))
  ]);
  assert.deepEqual(result, ["Twitter|image|saved01|1", "Twitter|video|legacy01|1"]);
});

test("a limited cache request checks saved entries in bounded batches", async () => {
  const env = loadBackground();
  const oldItems = Array.from({ length: 100 }, (_, index) => photo(`old${String(index).padStart(3, "0")}`));
  const newItems = Array.from({ length: 10 }, (_, index) => photo(`new${String(index).padStart(3, "0")}`));
  await found(env, oldItems);
  await found(env, newItems);
  for (const item of oldItems) {
    await env.ledger.add(item.platform + "|image|" + item.id + "|" + item.index);
  }

  const result = await saveCached(env, { platform: "Twitter", account: "alice", limit: 1 });
  assert.equal(result.started, 1);
  assert.equal(env.started[0].url, newItems[0].url);
});

test("a cached-media request returns promptly when all download slots are busy", async () => {
  let clock = 1_000_000;
  const env = loadBackground({ now: () => clock });
  await found(env, [photo("free001"), photo("free002")]);
  await env.send({
    type: "DOWNLOAD_ITEMS",
    items: Array.from({ length: 8 }, (_, index) => ({
      platform: "Twitter",
      account: "alice",
      key: `Twitter|image|pending${index}|1`,
      url: `https://pbs.twimg.com/media/pending${index}.jpg`
    }))
  });
  env.inContext("chrome.downloads.search = async () => new Promise(() => {})");

  const request = saveCached(env, { platform: "Twitter", account: "alice", limit: 8 });
  const returnedQuickly = await Promise.race([
    request.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100))
  ]);
  clock += 61_000;
  const result = await request;
  assert.equal(returnedQuickly, true);
  assert.equal(result.started, 0);
  assert.equal(env.started.length, 8);

  env.setGlobal("__downloads", env.downloads);
  env.inContext(
    "chrome.downloads.search = async query => (__downloads.has(query.id) ? [__downloads.get(query.id)] : [])"
  );
  env.downloads.set(1, { id: 1, state: "complete" });
  await env.send({ type: "DOWNLOAD_STATUS", platform: "Twitter", account: "alice" });
  const queued = await saveCached(env, { platform: "Twitter", account: "alice", limit: 8 });
  assert.equal(queued.started, 0);
  assert.equal(queued.pending, 2, "one cached item started and one remains queued");
  assert.equal(env.started.length, 9);
});

test("a full image batch preserves queued media behind it", async () => {
  const env = loadBackground();
  await found(env, [video("afterfull")]);
  await env.send({
    type: "DOWNLOAD_ITEMS",
    items: Array.from({ length: 8 }, (_, index) => ({
      platform: "Twitter",
      account: "alice",
      key: `Twitter|image|busy${index}|1`,
      url: `https://pbs.twimg.com/media/busy${index}.jpg`
    }))
  });

  const fullBatch = env.send({
    type: "DOWNLOAD_ITEMS",
    items: Array.from({ length: 20 }, (_, index) => ({
      platform: "Twitter",
      account: "alice",
      key: `Twitter|image|later${index}|1`,
      url: `https://pbs.twimg.com/media/later${index}.jpg`
    }))
  });
  const cachedRequest = saveCached(env, { platform: "Twitter", account: "alice", limit: 1 });
  const returnedQuickly = await Promise.race([
    cachedRequest.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100))
  ]);
  const [batchResult, result] = await Promise.all([fullBatch, cachedRequest]);
  assert.equal(returnedQuickly, true);
  assert.equal(result.started, 0);
  assert.equal(batchResult.pending, 28);
  assert.equal(batchResult.queued, 20);
  assert.equal(env.started.length, 8);
});

test("a cached-media request includes an overlapping page-data write", async () => {
  const env = loadBackground();
  const write = found(env, [video("queued01")]);
  const result = await saveCached(env, { platform: "Twitter", account: "alice" });
  await write;
  assert.equal(result.started, 1);
  assert.equal(env.started[0].filename, "Twitter/Alice/video_queued01_1280x720.mp4");
});

test("a cached-media read responds when the download queue is busy", async () => {
  const env = loadBackground();
  await found(env, [video("busy001")]);
  await env.ledger.add("Twitter|video|busy001|1");
  env.inContext("batchQueue = new Promise(() => {})");

  const request = saveCached(env, { platform: "Twitter", account: "alice", limit: 8 });
  const returnedQuickly = await Promise.race([
    request.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100))
  ]);
  const result = await request;
  assert.equal(returnedQuickly, true);
  assert.equal(result.started, 0);
  assert.deepEqual(result.coveredIds, ["busy001"]);
});

test("a cache download does not wait for an unrelated queue and reserves its items", async () => {
  const env = loadBackground();
  await found(env, [video("queued02")]);
  env.inContext("batchQueue = new Promise(() => {})");

  const request = saveCached(env, { platform: "Twitter", account: "alice", limit: 8 });
  const returnedQuickly = await Promise.race([
    request.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 250))
  ]);
  const result = await request;
  assert.equal(returnedQuickly, true);
  assert.equal(result.started, 0);
  assert.equal(result.queued, 1);
  assert.equal(result.deferred, true);
  assert.deepEqual(env.started, []);

  const repeated = await saveCached(env, { platform: "Twitter", account: "alice", limit: 8 });
  assert.equal(repeated.started, 0);
  assert.deepEqual(repeated.coveredIds, ["queued02"]);
});

test("Facebook and TikTok cache acknowledgements preserve distinct media-id requests", async () => {
  for (const platform of ["Facebook", "TikTok"]) {
    const env = loadBackground();
    const item = video("delayed01", {
      platform,
      url:
        platform === "TikTok"
          ? "https://v16-webapp.tiktokcdn.com/play/delayed01.mp4"
          : "https://scontent.fbcdn.net/video/delayed01.mp4"
    });
    await found(env, [item]);
    env.inContext("batchQueue = new Promise(() => {})");

    const message = {
      type: "DOWNLOAD_CACHED_MEDIA",
      platform,
      account: "alice",
      ids: ["delayed01"],
      limit: 8
    };
    let result;
    const keepsMessageOpen = env.listeners.message[0](message, {}, value => {
      result = value;
    });
    assert.equal(keepsMessageOpen, false, platform);
    assert.equal(result.deferred, true, platform);
    assert.equal(result.diag.deferred, true, platform);
    assert.deepEqual(env.started, [], platform);

    const repeatedSameIds = await env.send({
      type: "DOWNLOAD_CACHED_MEDIA",
      platform,
      account: "alice",
      ids: ["delayed01"],
      limit: 8
    });
    assert.equal(repeatedSameIds.requestId, result.requestId, platform);
    const differentIds = await env.send({
      type: "DOWNLOAD_CACHED_MEDIA",
      platform,
      account: "alice",
      ids: ["page002"],
      limit: 8
    });
    assert.equal(differentIds.deferred, true, platform);
    assert.notEqual(differentIds.requestId, result.requestId, platform);
  }
});

test("Facebook and TikTok cache reads still start fresh videos when the queue is ready", async () => {
  for (const platform of ["Facebook", "TikTok"]) {
    const env = loadBackground();
    const item = video("fresh001", {
      platform,
      url:
        platform === "TikTok"
          ? "https://v16-webapp.tiktokcdn.com/play/fresh001.mp4"
          : "https://scontent.fbcdn.net/video/fresh001.mp4"
    });
    await found(env, [item]);
    const result = await saveCached(env, { platform, account: "alice", limit: 8 });
    assert.equal(result.started, 1, platform);
    assert.equal(env.started.length, 1, platform);
    assert.match(env.started[0].filename, new RegExp(`^${platform}/Alice/`), platform);
  }
});

test("a failed queued cache operation releases its item reservations", async () => {
  const env = loadBackground();
  await found(env, [
    video("failure01", {
      platform: "Facebook",
      url: "https://scontent.fbcdn.net/video/failure01.mp4"
    })
  ]);
  env.inContext('downloadBatch = async () => { throw new Error("batch failed"); }');

  const reply = await env.send({
    type: "DOWNLOAD_CACHED_MEDIA",
    platform: "Facebook",
    account: "alice",
    ids: ["failure01"]
  });
  const result = await env.send({ type: "CACHED_MEDIA_RESULT", requestId: reply.requestId });
  assert.equal(result.ok, false);
  assert.equal(env.inContext("queuedCachedKeys.size"), 0);
});

test("cached downloads do not wait for searches of unrelated pending files", async () => {
  const env = loadBackground();
  await found(env, [video("fresh01")]);
  await env.send({
    type: "DOWNLOAD_ITEMS",
    items: Array.from({ length: 7 }, (_, index) => ({
      platform: "Twitter",
      account: "other",
      key: `Twitter|image|unrelated${index}|1`,
      url: `https://pbs.twimg.com/media/unrelated${index}.jpg`
    }))
  });
  env.inContext("chrome.downloads.search = async () => new Promise(() => {})");

  const request = saveCached(env, { platform: "Twitter", account: "alice", limit: 1 });
  const returnedQuickly = await Promise.race([
    request.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100))
  ]);
  const result = await request;
  assert.equal(returnedQuickly, true);
  assert.equal(result.started, 1);
  assert.equal(env.started.length, 8);
  assert.equal(env.started.at(-1).url, video("fresh01").url);
});

test("a limit that is not a whole number is ignored", async () => {
  for (const limit of [1.5, "1"]) {
    const env = loadBackground();
    await found(env, [photo("nl001"), photo("nl002")]);
    assert.equal((await saveCached(env, { platform: "Twitter", account: "alice", limit })).cached, 2);
  }
});

test("saved entries do not displace fresh entries in an unlimited cache batch", async () => {
  const env = loadBackground();
  const saved = Array.from({ length: 300 }, (_, index) => photo(`saved${String(index).padStart(3, "0")}`));
  for (let offset = 0; offset < saved.length; offset += 100) {
    await found(env, saved.slice(offset, offset + 100));
  }
  await found(env, [photo("fresh999")]);
  for (const item of saved) {
    await env.ledger.add(`${item.platform}|image|${item.id}|${item.index}`);
  }

  const result = await saveCached(env, { platform: "Twitter", account: "alice" });
  assert.equal(result.started, 1);
  assert.equal(env.started[0].url, "https://pbs.twimg.com/media/fresh999.jpg");
});

test("nothing cached means nothing started, and an unsupported platform is refused", async () => {
  const env = loadBackground();
  const empty = await saveCached(env, { platform: "Twitter", account: "alice" });
  assert.deepEqual([empty.ok, empty.started, empty.cached, empty.coveredIds], [true, 0, 0, []]);
  assert.deepEqual(await saveCached(env, { platform: "Nowhere" }), {
    ok: false,
    error: "Unsupported platform for cached media."
  });
});
