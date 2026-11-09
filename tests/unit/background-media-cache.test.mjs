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
const saveCached = (env, request) => env.send({ type: "DOWNLOAD_CACHED_MEDIA", ...request }).then(plain);

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
    skipped: 0,
    failed: 0,
    pending: 0,
    errors: [],
    cached: 0,
    coveredIds: ["lim001", "lim002", "lim003", "lim004"],
    diag: { cached: 4, owned: 4, idMatched: null, wantedIds: null, selected: 4 }
  });
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

  env.downloads.set(1, { id: 1, state: "complete" });
  assert.equal((await saveCached(env, { platform: "Twitter", account: "alice", limit: 8 })).started, 1);
  assert.equal(env.started.length, 9);
});

test("a limit that is not a whole number is ignored", async () => {
  const env = loadBackground();
  await found(env, [photo("nl001"), photo("nl002")]);
  assert.equal((await saveCached(env, { platform: "Twitter", account: "alice", limit: 1.5 })).cached, 2);
  assert.equal((await saveCached(env, { platform: "Twitter", account: "alice", limit: "1" })).cached, 2);
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
