import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createFakeIndexedDB, loadBackground, plain } from "./helpers/background.mjs";

const keysFile = new URL("../lib/keys.js", import.meta.url);
const keysContext = vm.createContext({});
new vm.Script(fs.readFileSync(keysFile, "utf8"), { filename: keysFile.pathname }).runInContext(keysContext);
const { photoKey, videoKey, toCanonicalKey } = keysContext.PageMediaLib.keys;

const photo = (account, extra = {}) => ({
  platform: "Instagram", account, key: photoKey("Instagram", "Dabc12345", 1),
  url: "https://scontent.cdninstagram.com/x.jpg", filename: "Dabc12345_01.jpg", ...extra
});

async function complete(harness, downloadId) {
  harness.downloads.set(downloadId, { id: downloadId, state: "complete" });
  await harness.listeners.changed[0]({ id: downloadId, state: { current: "complete" } });
}

test("a key names the media, not the account folder it was found under", () => {
  assert.equal(photoKey("Instagram", "Dabc12345", 2), "Instagram|photo|Dabc12345|2");
  assert.equal(videoKey("Twitter", "2115779022722630042", 1), "Twitter|video|2115779022722630042|1");
});

test("old keys map onto the new form, and new keys map onto themselves", () => {
  const cases = [
    ["Instagram:creator:Dabc12345:1", "Instagram|photo|Dabc12345|1"],
    ["Twitter:asagi2211:1999:2", "Twitter|photo|1999|2"],
    ["Twitter:Fxtyoo:video:2116511528275030211", "Twitter|video|2116511528275030211|1"],
    ["Instagram:jasondchen:video:DezPoWNzXMt", "Instagram|video|DezPoWNzXMt|1"],
    ["Facebook:page.name:video:555:2", "Facebook|video|555|2"],
    ["Facebook|video|555|2", "Facebook|video|555|2"],
    ["repair:job-1:file.jpg", "repair:job-1:file.jpg"],
    ["Tumblr:a:b:1", "Tumblr:a:b:1"],
    ["Instagram:a:b", "Instagram:a:b"]
  ];
  for (const [input, expected] of cases) {
    assert.equal(toCanonicalKey(input), expected, input);
    assert.equal(toCanonicalKey(toCanonicalKey(input)), expected, `${input} is stable`);
  }
});

test("the same media seen through two accounts is saved once", async () => {
  const harness = loadBackground();
  assert.equal((await harness.send({ type: "DOWNLOAD_ITEMS", items: [photo("alice")] })).started, 1);
  await complete(harness, 1);
  const second = await harness.send({ type: "DOWNLOAD_ITEMS", items: [photo("bob")] });
  assert.equal(second.started, 0);
  assert.equal(second.skipped, 1);
  assert.equal(harness.started.length, 1);
});

test("while one copy is still downloading, a second request for it is skipped", async () => {
  const harness = loadBackground();
  await harness.send({ type: "DOWNLOAD_ITEMS", items: [photo("alice")] });
  const second = await harness.send({ type: "DOWNLOAD_ITEMS", items: [photo("bob")] });
  assert.equal(second.skipped, 1);
  assert.equal(harness.started.length, 1);
});

test("a cached video and the same video from the page menu share one key", async () => {
  const harness = loadBackground();
  await harness.send({ type: "MEDIA_FOUND", media: [
    { platform: "Instagram", id: "DezPoWNzXMt", index: 1, owner: "jasondchen", url: "https://scontent.cdninstagram.com/a.mp4" }
  ] });
  await harness.send({ type: "DOWNLOAD_CACHED_MEDIA", platform: "Instagram", account: "jasondchen", ids: ["DezPoWNzXMt"] });
  await complete(harness, 1);
  const menu = await harness.send({ type: "SET_NATIVE_VIDEO_TARGET", target: {
    platform: "Instagram", account: "jasondchen", key: videoKey("Instagram", "DezPoWNzXMt", 1), filename: "video_DezPoWNzXMt.mp4"
  } });
  assert.equal(menu.reason, "already-saved");
});

test("a video saved by an older version is not downloaded again", async () => {
  const harness = loadBackground({ storage: { downloadedKeys: ["Twitter:Fxtyoo:video:123", "Instagram:creator:Dabc12345:1"] } });
  await harness.send({ type: "MEDIA_FOUND", media: [
    { platform: "Twitter", id: "123", index: 1, owner: "Fxtyoo", url: "https://video.twimg.com/v/123.mp4" }
  ] });
  const result = await harness.send({ type: "DOWNLOAD_CACHED_MEDIA", platform: "Twitter", account: "Fxtyoo" });
  assert.equal(result.started, 0);
  assert.equal(harness.started.length, 0);
  assert.equal((await harness.send({ type: "DOWNLOAD_ITEMS", items: [photo("someone-else")] })).started, 0);
});

test("old keys are moved into the ledger once and removed from chrome.storage", async () => {
  const indexedDB = createFakeIndexedDB();
  const first = loadBackground({ indexedDB, storage: { downloadedKeys: ["Twitter:a:video:1", "Instagram:b:Dxyz12345:1"] } });
  assert.equal(await first.ledger.count(), 2);
  assert.equal(first.storage.downloadedKeys, undefined);
  assert.equal(first.storage.ledgerImported, true);
  assert.ok(await first.ledger.has("Twitter|video|1|1"));
  assert.ok(await first.ledger.has("Instagram|photo|Dxyz12345|1"));

  // Keys that reappear in chrome.storage later are not imported a second time.
  const second = loadBackground({ indexedDB, storage: { ledgerImported: true, downloadedKeys: ["Twitter:z:video:9"] } });
  assert.equal(await second.ledger.has("Twitter|video|9|1"), false);
});

test("the ledger survives a service worker restart", async () => {
  const indexedDB = createFakeIndexedDB();
  const before = loadBackground({ indexedDB });
  await before.ledger.add(videoKey("Facebook", "2059757664673295", 1));
  const after = loadBackground({ indexedDB });
  assert.ok(await after.ledger.has(videoKey("Facebook", "2059757664673295", 1)));
  assert.equal(await after.ledger.has(videoKey("Facebook", "1", 1)), false);
});

test("the ledger keeps more than the 10,000 newest keys the old list was cut to", async () => {
  const harness = loadBackground();
  for (let i = 0; i < 10500; i++) await harness.ledger.add(photoKey("Instagram", `P${i}`, 1));
  assert.equal(await harness.ledger.count(), 10500);
  assert.ok(await harness.ledger.has(photoKey("Instagram", "P0", 1)), "the oldest key is still remembered");
});

test("the new key form is found whichever spelling the caller uses", async () => {
  const harness = loadBackground();
  await harness.ledger.add("Twitter:acct:video:77");
  assert.ok(await harness.ledger.has("Twitter|video|77|1"));
  assert.ok(await harness.ledger.has("Twitter:other:video:77"));
});

test("a cached-video request with a limit does not spend it on videos already saved", async () => {
  const harness = loadBackground();
  const videos = ["1001", "1002", "1003"].map(id => ({ platform: "Twitter", id, index: 1, owner: "acct", url: `https://video.twimg.com/v/${id}.mp4` }));
  await harness.send({ type: "MEDIA_FOUND", media: videos });
  await harness.ledger.add(videoKey("Twitter", "1001", 1));
  const result = await harness.send({ type: "DOWNLOAD_CACHED_MEDIA", platform: "Twitter", account: "acct", limit: 2 });
  assert.equal(result.started, 2);
  assert.deepEqual(plain(harness.started.map(options => options.filename)), ["Twitter/acct/video_1002.mp4", "Twitter/acct/video_1003.mp4"]);
});

test("a full-size photo is not blocked by a thumbnail an older version recorded for the same post", async () => {
  const harness = loadBackground();
  await harness.ledger.add(photoKey("Facebook", "1086989087485347", 1));
  await harness.send({ type: "MEDIA_FOUND", media: [
    { platform: "Facebook", kind: "photo", id: "1086989087485347", index: 1, owner: null, width: 2048, height: 1365, url: "https://scontent.fsgn19-1.fna.fbcdn.net/big.jpg" }
  ] });
  const result = await harness.send({ type: "DOWNLOAD_CACHED_MEDIA", platform: "Facebook", account: "lamoon.ladyofmoon", ids: ["1086989087485347"] });
  assert.equal(result.started, 1);
  assert.match(harness.started[0].filename, /1086989087485347_01_2048x1365\.jpg$/);
  await complete(harness, 1);
  const again = await harness.send({ type: "DOWNLOAD_CACHED_MEDIA", platform: "Facebook", account: "lamoon.ladyofmoon", ids: ["1086989087485347"] });
  assert.equal(again.started, 0, "the full-size copy itself is saved only once");
  assert.equal(harness.started.length, 1);
});

test("the three key kinds never collide", () => {
  const keys = [photoKey("Instagram", "Dx", 1), videoKey("Instagram", "Dx", 1), keysContext.PageMediaLib.keys.imageKey("Instagram", "Dx", 1)];
  assert.equal(new Set(keys).size, 3);
  assert.equal(toCanonicalKey(keys[2]), keys[2]);
});
