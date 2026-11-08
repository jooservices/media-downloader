import assert from "node:assert/strict";
import test from "node:test";
import { loadBackground, plain } from "../helpers/background.mjs";

const KEY = "Twitter|video|1|1";
const TARGET = {
  platform: "Twitter",
  account: "alice",
  key: KEY,
  filename: "clip.mp4",
  width: 1280,
  height: 720,
  sourceUrl: "https://x.com/alice/status/1"
};
const arm = (env, target = TARGET) => env.send({ type: "SET_NATIVE_VIDEO_TARGET", target }).then(plain);
const VIDEO_DOWNLOAD = {
  id: 71,
  url: "https://video.twimg.com/ext_tw_video/1/vid/1280x720/a.mp4",
  referrer: "https://x.com/alice/status/1",
  filename: "platform-video.mp4",
  mime: "video/mp4"
};

test("a target needs a known platform and a key", async () => {
  const env = loadBackground();
  const incomplete = { ok: false, error: "The official video-download target is incomplete." };
  assert.deepEqual(await arm(env, { ...TARGET, platform: "Nowhere" }), incomplete);
  assert.deepEqual(await arm(env, { ...TARGET, key: "" }), incomplete);
  assert.deepEqual(await arm(env, {}), incomplete);
  assert.deepEqual(await arm(env, null), incomplete);
});

test("arming a target records it with a 30 second life and counts the attempt", async () => {
  const env = loadBackground({ now: () => 1_000_000 });
  assert.deepEqual(await arm(env), { ok: true, armed: true });
  assert.deepEqual(plain(env.storage.nativeVideoTarget), {
    platform: "Twitter",
    account: "alice",
    key: KEY,
    filename: "clip.mp4",
    width: 1280,
    height: 720,
    sourceOrigin: "https://x.com",
    expiresAt: 1_030_000
  });
  assert.equal(env.storage.nativeVideoAttempts[KEY], 1);
});

test("a sparse target gets safe defaults, and an unreadable source URL leaves the origin open", async () => {
  const env = loadBackground();
  await arm(env, { platform: "Twitter", key: KEY, sourceUrl: "not a url" });
  const target = plain(env.storage.nativeVideoTarget);
  assert.equal(target.filename, "video.mp4");
  assert.deepEqual([target.width, target.height, target.sourceOrigin], [0, 0, ""]);
});

test("arming skips a video that is saved, armed, pending or out of tries, and says why", async () => {
  const env = loadBackground();
  await env.ledger.add("Twitter|video|saved|1");
  assert.deepEqual(await arm(env, { ...TARGET, key: "Twitter|video|saved|1" }), {
    ok: true,
    skip: true,
    reason: "already-saved"
  });

  await arm(env);
  assert.equal((await arm(env)).reason, "already-armed");

  const native = loadBackground({ storage: { nativeVideoPending: { 5: { key: KEY } } } });
  assert.equal((await arm(native)).reason, "already-pending");

  const direct = loadBackground({ storage: { pendingDownloads: { [KEY]: 5 }, pendingItems: { [KEY]: { key: KEY } } } });
  assert.equal((await arm(direct)).reason, "already-pending");

  const byItemKey = loadBackground({
    storage: { pendingDownloads: { other: 5 }, pendingItems: { other: { key: KEY } } }
  });
  assert.equal((await arm(byItemKey)).reason, "already-pending");

  const exhausted = loadBackground({ storage: { nativeVideoAttempts: { [KEY]: 3 } } });
  assert.equal((await arm(exhausted)).reason, "retry-limit");
});

test("arming another video fails the one the site never answered, and clears an old failure of its own", async () => {
  const env = loadBackground({
    storage: {
      nativeVideoTarget: { platform: "Twitter", account: "alice", key: "old", expiresAt: Date.now() + 30_000 },
      nativeVideoFailures: { [KEY]: { platform: "Twitter", account: "alice", error: "earlier" } }
    }
  });
  await arm(env);
  assert.match(env.storage.nativeVideoFailures.old.error, /did not start the previous official video download/);
  assert.equal(env.storage.nativeVideoFailures[KEY], undefined);
  assert.equal(env.storage.nativeVideoTarget.key, KEY);
});

test("the matching browser download is saved into the account folder, named with its size", async () => {
  const env = loadBackground();
  await arm(env);
  const [suggestion] = await env.determine(VIDEO_DOWNLOAD);
  assert.deepEqual(plain(suggestion), {
    filename: "Twitter/alice/clip_1280x720.mp4",
    conflictAction: "uniquify"
  });
  assert.equal(env.storage.nativeVideoTarget, null);
  assert.deepEqual(plain(env.storage.nativeVideoPending[71]), {
    platform: "Twitter",
    account: "alice",
    key: KEY,
    filename: "clip_1280x720.mp4"
  });
  assert.deepEqual(await env.determine({ ...VIDEO_DOWNLOAD, id: 72 }), [], "the target was claimed once");
});

test("downloads that are not the armed video are left to the browser", async () => {
  const cases = {
    "no target": [{}, VIDEO_DOWNLOAD],
    "an expired target": [{ expiresAt: 1 }, VIDEO_DOWNLOAD],
    "not a video": [{}, { ...VIDEO_DOWNLOAD, filename: "page.html", mime: "text/html" }],
    "another platform's host": [
      {},
      { ...VIDEO_DOWNLOAD, url: "https://evil.example.com/a.mp4", referrer: "https://evil.example.com/" }
    ],
    "an unreadable address": [{}, { ...VIDEO_DOWNLOAD, url: "", referrer: "" }],
    "another origin's referrer": [{}, { ...VIDEO_DOWNLOAD, referrer: "https://twitter.com/alice" }]
  };
  for (const [name, [override, item]] of Object.entries(cases)) {
    const env = loadBackground();
    if (name !== "no target") {
      await arm(env);
      env.storage.nativeVideoTarget = { ...env.storage.nativeVideoTarget, ...override };
    }
    assert.deepEqual(await env.determine(item), [], name);
  }
});

test("a download without a referrer still matches when the video host is the platform's", async () => {
  const env = loadBackground();
  await arm(env);
  const [suggestion] = await env.determine({ ...VIDEO_DOWNLOAD, referrer: "" });
  assert.match(suggestion.filename, /^Twitter\/alice\//);
});

test("a target with no known origin accepts any referrer from the platform's hosts", async () => {
  const env = loadBackground();
  await arm(env, { ...TARGET, sourceUrl: undefined });
  const [suggestion] = await env.determine({ ...VIDEO_DOWNLOAD, referrer: "https://twitter.com/x" });
  assert.equal(suggestion.filename, "Twitter/alice/clip_1280x720.mp4");
});

test("a video is recognised by its type or its extension, and the extension it keeps is a video one", async () => {
  const run = async item => {
    const env = loadBackground();
    await arm(env);
    return env.determine({ ...VIDEO_DOWNLOAD, ...item });
  };
  assert.match((await run({ filename: "x.webm", mime: "" }))[0].filename, /\.webm$/);
  assert.match((await run({ filename: "dir\\sub/x.MOV", mime: "" }))[0].filename, /\.mov$/);
  assert.match((await run({ filename: "noext", mime: "video/mp4" }))[0].filename, /\.mp4$/);
  assert.match((await run({ filename: "x.exe", mime: "video/mp4" }))[0].filename, /\.mp4$/, "never an unexpected type");
  assert.match((await run({ filename: undefined, mime: "VIDEO/MP4" }))[0].filename, /\.mp4$/);
  assert.deepEqual(await run({ filename: "x.pdf", mime: "" }), []);
  assert.deepEqual(await run({ filename: undefined, mime: undefined }), []);
});

test("a stored target without a name falls back to one built from the download id", async () => {
  const env = loadBackground({
    storage: {
      nativeVideoTarget: {
        platform: "Twitter",
        account: "alice",
        key: KEY,
        sourceOrigin: "",
        expiresAt: Date.now() + 30_000
      }
    }
  });
  const [suggestion] = await env.determine(VIDEO_DOWNLOAD);
  assert.equal(suggestion.filename, "Twitter/alice/video_71.mp4");
});

test("the filename listener falls back to the browser when claiming fails", async () => {
  const env = loadBackground();
  env.inContext(`chrome.storage.local.get = async () => { throw new Error("storage unavailable"); }`);
  assert.deepEqual(await env.determine(VIDEO_DOWNLOAD), []);
});
