import assert from "node:assert/strict";
import test from "node:test";
import { loadBackground, plain } from "../helpers/background.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));
const photo = (n, overrides = {}) => ({
  platform: "Twitter",
  account: "alice",
  key: `Twitter|image|${n}|1`,
  url: `https://pbs.twimg.com/media/pic${n}.jpg`,
  filename: `pic${n}.jpg`,
  ...overrides
});
const download = (env, items) => env.send({ type: "DOWNLOAD_ITEMS", items });
const status = (env, platform, account) => env.send({ type: "DOWNLOAD_STATUS", platform, account }).then(plain);
const finish = (env, id, extra = {}) =>
  env.downloads.set(id, {
    id,
    state: "complete",
    bytesReceived: 10,
    totalBytes: 10,
    fileSize: 10,
    filename: id > 10 ? "video.mp4" : "photo.jpg",
    mime: id > 10 ? "video/mp4" : "image/jpeg",
    ...extra
  });

test("a batch must be a list", async () => {
  const env = loadBackground();
  assert.deepEqual(plain(await download(env, "nope")), { ok: false, error: "No media list was provided." });
  assert.deepEqual(plain(await download(env, undefined)), { ok: false, error: "No media list was provided." });
});

test("items that are not downloadable are skipped without touching the browser", async () => {
  const env = loadBackground();
  const bad = [
    null,
    { platform: "Nowhere", key: "k", url: "https://pbs.twimg.com/a.jpg" },
    photo(1, { url: "" }),
    photo(2, { key: "" }),
    photo(3, { url: "http://pbs.twimg.com/media/a.jpg" }),
    photo(4, { url: "https://evil.example.com/a.jpg" }),
    photo(5, { url: "not a url" })
  ];
  const result = plain(await download(env, bad));
  assert.deepEqual([result.started, result.skipped, result.failed], [0, 7, 0]);
  assert.equal(env.started.length, 0);
});

test("a photo starts into its platform and account folder, with its size in the name", async () => {
  const env = loadBackground();
  const result = plain(await download(env, [photo(1, { width: 1200, height: 800 })]));
  assert.deepEqual([result.started, result.pending, result.errors], [1, 1, []]);
  assert.deepEqual(plain(env.started), [
    {
      url: "https://pbs.twimg.com/media/pic1.jpg",
      filename: "Twitter/alice/pic1_1200x800.jpg",
      conflictAction: "uniquify",
      saveAs: false
    }
  ]);
  assert.deepEqual(plain(env.storage.pendingDownloads), { "Twitter|image|1|1": 1 });
});

test("a download batch replies without searching for downloads it just started", async () => {
  const env = loadBackground();
  env.inContext(
    "chrome.downloads.search = async () => new Promise(resolve => { globalThis.__resolveDownloadSearch = resolve })"
  );
  const request = download(env, [photo(1)]);
  const returnedQuickly = await Promise.race([
    request.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100))
  ]);
  env.inContext("globalThis.__resolveDownloadSearch?.([])");
  const result = plain(await request);
  assert.equal(returnedQuickly, true);
  assert.deepEqual([result.started, result.pending], [1, 1]);
});

test("a photo with no file name is named after its type, and overwrite is honoured", async () => {
  const env = loadBackground();
  await download(env, [photo(1, { filename: "", overwrite: true, url: "https://pbs.twimg.com/media/x.png" })]);
  assert.equal(env.started[0].filename, "Twitter/alice/photo.png");
  assert.equal(env.started[0].conflictAction, "overwrite");
});

test("a download the browser refuses is recorded as failed with its reason, and its name target is dropped", async () => {
  const env = loadBackground();
  env.inContext(`chrome.downloads.download = async () => { throw new Error("Invalid filename"); }`);
  const result = plain(await download(env, [photo(1)]));
  assert.deepEqual([result.started, result.failed], [0, 1]);
  assert.deepEqual(result.errors, ["pic1.jpg: Invalid filename"]);
  assert.deepEqual(plain(env.storage.downloadTargets), {});
  assert.equal(env.storage.failedDownloads["Twitter|image|1|1"].attempts, 1);

  const retried = plain(await status(env));
  assert.deepEqual([retried.failed, retried.retryable], [1, 1]);

  env.inContext(`chrome.downloads.download = () => Promise.reject("plain text")`);
  const again = plain(await env.send({ type: "RETRY_FAILED_DOWNLOADS" }));
  assert.equal(again.failed, 1);
  assert.equal(env.storage.failedDownloads["Twitter|image|1|1"].attempts, 2);
  assert.equal(again.errors[0], "pic1.jpg: plain text");
});

test("an item that keeps failing stops being retried after three attempts", async () => {
  const env = loadBackground();
  env.inContext(`chrome.downloads.download = async () => { throw new Error("nope"); }`);
  for (let round = 0; round < 3; round++) {
    await download(env, [photo(1)]);
  }
  assert.equal(env.storage.failedDownloads["Twitter|image|1|1"].attempts, 3);
  const result = plain(await download(env, [photo(1)]));
  assert.deepEqual([result.skipped, result.failed], [1, 1]);
  const now = await status(env);
  assert.deepEqual([now.failed, now.retryable], [1, 0]);
  const retry = plain(await env.send({ type: "RETRY_FAILED_DOWNLOADS" }));
  assert.equal(retry.started ?? 0, 0, "nothing is left to retry");
  assert.equal(retry.failed, 1);
});

test("download retries respect the configured maxAttempts value", async () => {
  const env = loadBackground({ storage: { queueSettings: { maxAttempts: 1 } } });
  await download(env, [photo(1)]);
  finish(env, 1, { state: "interrupted", error: "NETWORK_FAILED" });
  const current = await status(env);
  assert.deepEqual([current.failed, current.retryable], [1, 0]);
  const retry = plain(await env.send({ type: "RETRY_FAILED_DOWNLOADS" }));
  assert.equal(retry.started ?? 0, 0);
  assert.equal(env.started.length, 1);
});

test("already saved or already pending items are skipped, and so are items in the official-video flow", async () => {
  const env = loadBackground({
    storage: { nativeVideoPending: { 9: { key: "Twitter|video|9|1", platform: "Twitter", account: "alice" } } }
  });
  await env.ledger.add("Twitter|image|1|1");
  await download(env, [photo(2)]);
  const result = plain(await download(env, [photo(1), photo(2), photo(9, { key: "Twitter|video|9|1" }), photo(3)]));
  assert.deepEqual([result.started, result.skipped], [1, 3]);
});

test("only the first 300 items of a batch are looked at", async () => {
  const env = loadBackground();
  const result = plain(
    await download(
      env,
      Array.from({ length: 305 }, () => null)
    )
  );
  assert.equal(result.skipped, 300);
});

test("finished downloads are reconciled: complete is remembered, interrupted is failed or settled", async () => {
  const env = loadBackground();
  await download(env, [photo(1), photo(2), photo(3), photo(4)]);
  finish(env, 1);
  finish(env, 2, { state: "interrupted", error: "NETWORK_FAILED" });
  finish(env, 3, { state: "interrupted", error: "SERVER_FORBIDDEN" });
  env.downloads.set(4, { id: 4, state: "in_progress" });
  const result = await status(env);
  assert.deepEqual([result.pending, result.failed, result.unavailable, result.retryable], [1, 1, 1, 1]);
  assert.equal(await env.ledger.has("Twitter|image|1|1"), true);
  assert.equal(await env.ledger.has("Twitter|image|3|1"), true, "an unavailable file is settled for good");
  assert.equal(env.storage.failedDownloads["Twitter|image|2|1"].error, "NETWORK_FAILED");

  const filtered = await status(env, "Instagram");
  assert.deepEqual([filtered.pending, filtered.failed, filtered.unavailable], [0, 0, 0]);
  const account = await status(env, "Twitter", "alice");
  assert.equal(account.failed, 1);
  assert.equal((await status(env, "Twitter", "bob")).failed, 0);
});

test("empty, size-mismatched and non-image completions stay retryable instead of entering the ledger", async () => {
  const env = loadBackground();
  await download(env, [photo(1), photo(2), photo(3), photo(4)]);
  finish(env, 1, { bytesReceived: 0, totalBytes: 10, fileSize: 0 });
  finish(env, 2, { bytesReceived: 8, totalBytes: 10, fileSize: 8 });
  finish(env, 3, { filename: "photo.mp4", mime: "video/mp4" });
  finish(env, 4, { fileSize: 0 });
  const result = await status(env);
  assert.equal(result.failed, 4);
  assert.equal(result.retryable, 4);
  assert.equal(await env.ledger.has("Twitter|image|1|1"), false);
  assert.deepEqual(
    env.removedDownloads,
    [1, 2, 3, 4],
    "rejected completed files are removed before the mover can publish them"
  );
  assert.match(env.storage.failedDownloads["Twitter|image|2|1"].error, /size did not match/);
  assert.match(env.storage.failedDownloads["Twitter|image|3|1"].error, /expected image/);
});

test("a rejected file that cannot be deleted is reported so the mover can keep it unpublished", async () => {
  const env = loadBackground();
  env.inContext(`chrome.downloads.removeFile = async () => { throw new Error("file is locked"); }`);
  await download(env, [photo(1)]);
  finish(env, 1, {
    filename: "C:\\Users\\test\\Downloads\\rejected.jpg",
    bytesReceived: 8,
    totalBytes: 10,
    fileSize: 8
  });

  const result = await status(env);
  assert.deepEqual(result.rejectedFiles, ["rejected.jpg"]);
  assert.equal(await env.ledger.has("Twitter|image|1|1"), false);
});

test("a corrupt completion can be retried and only the verified retry enters the ledger", async () => {
  const env = loadBackground();
  await download(env, [photo(1)]);
  finish(env, 1, { bytesReceived: 4, totalBytes: 10, fileSize: 4 });
  assert.equal((await status(env)).retryable, 1);
  await env.send({ type: "RETRY_FAILED_DOWNLOADS" });
  assert.equal(env.started.length, 2);
  finish(env, 2, { filename: "photo.jpg", mime: "image/jpeg" });
  const result = await status(env);
  assert.equal(result.failed, 0);
  assert.equal(await env.ledger.has("Twitter|image|1|1"), true);
});

test("verified outputs keep their filename and size, and repair keys can replace ledgered media", async () => {
  const env = loadBackground();
  await env.ledger.add("Twitter|image|1|1");
  const item = photo(1, { key: "repair:job-1:pic1.jpg", filename: "pic1.jpg", overwrite: true, jobId: "job-1" });
  await download(env, [item]);
  assert.equal(env.started[0].conflictAction, "overwrite");
  finish(env, 1, { filename: "Twitter/alice/pic1.jpg" });
  await status(env);
  const outputs = plain(
    await env.send({ type: "GET_VERIFIED_OUTPUTS", platform: "Twitter", account: "alice", jobId: "job-1" })
  );
  assert.deepEqual(outputs, [
    { filename: "pic1.jpg", size: 10, platform: "Twitter", account: "alice", jobId: "job-1" }
  ]);
});

test("an interrupted download with no reason gets a plain one, and one with no item record is just forgotten", async () => {
  const env = loadBackground({
    storage: { pendingDownloads: { a: 1, b: 2 }, pendingItems: { a: photo(1, { key: "a" }) }, downloadAttempts: {} }
  });
  finish(env, 1, { state: "interrupted" });
  finish(env, 2, { state: "interrupted" });
  const result = await status(env);
  assert.equal(result.failed, 1);
  assert.equal(env.storage.failedDownloads.a.error, "The browser interrupted this download.");
  assert.deepEqual(plain(env.storage.pendingDownloads), {});
});

test("a download the browser cannot inspect yet stays pending", async () => {
  const env = loadBackground({ storage: { pendingDownloads: { a: 1 }, pendingItems: { a: photo(1, { key: "a" }) } } });
  env.inContext(`chrome.downloads.search = async () => { throw new Error("busy"); }`);
  assert.equal((await status(env)).pending, 1);
});

test("official video downloads are reconciled the same way", async () => {
  const native = (key, account = "alice") => ({ key, platform: "Twitter", account });
  const env = loadBackground({
    storage: {
      nativeVideoPending: { 11: native("v1"), 12: native("v2"), 13: native("v3"), 14: native("v4") }
    }
  });
  finish(env, 11);
  finish(env, 12, { state: "interrupted", error: "SERVER_BAD_CONTENT" });
  finish(env, 13, { state: "interrupted" });
  const result = await status(env);
  assert.deepEqual([result.pending, result.failed, result.unavailable], [1, 1, 1]);
  assert.equal(env.storage.nativeVideoFailures.v3.error, "The browser interrupted this official video download.");
  assert.equal(await env.ledger.has("v1"), true);
});

test("official video completions with an image type or unsupported extension stay retryable", async () => {
  const env = loadBackground({
    storage: { nativeVideoPending: { 11: { key: "v1", platform: "Twitter", account: "alice" } } }
  });
  finish(env, 11, { filename: "video.jpg", mime: "image/jpeg" });
  const result = await status(env);
  assert.equal(result.failed, 1);
  assert.equal(result.retryable, 0, "native video retries are handled when the post is scanned again");
  assert.equal(await env.ledger.has("v1"), false);
});

test("cached video downloads require video metadata and can pass the integrity check", async () => {
  const env = loadBackground();
  await download(env, [photo(1, { filename: "video.mp4", key: "Twitter|video|1|1" })]);
  finish(env, 1, { filename: "video.mp4", mime: "video/mp4" });
  assert.equal((await status(env)).failed, 0);
  assert.equal(await env.ledger.has("Twitter|video|1|1"), true);
});

test("an armed official-video target counts as pending until it expires, then as a failure", async () => {
  let clock = 1_000_000;
  const target = { platform: "Twitter", account: "alice", key: "v1", expiresAt: clock + 30_000 };
  const env = loadBackground({ storage: { nativeVideoTarget: target }, now: () => clock });
  assert.equal((await status(env)).pending, 1);
  assert.equal((await status(env, "Twitter", "bob")).pending, 0);
  clock += 31_000;
  const after = await status(env);
  assert.deepEqual([after.pending, after.failed], [0, 1]);
  assert.match(env.storage.nativeVideoFailures.v1.error, /did not start a browser download/);
});

test("failures from an earlier pass that can never succeed are settled when seen again", async () => {
  const env = loadBackground({
    storage: {
      failedDownloads: {
        gone: { item: photo(1, { key: "gone" }), attempts: 1, error: "SERVER_UNAUTHORIZED" },
        flaky: { item: photo(2, { key: "flaky" }), attempts: 1, error: "NETWORK_FAILED" }
      },
      nativeVideoFailures: {
        vgone: { platform: "Twitter", account: "alice", error: "SERVER_FORBIDDEN" },
        vflaky: { platform: "Twitter", account: "alice", error: "slow" }
      }
    }
  });
  const result = await status(env);
  assert.deepEqual([result.failed, result.unavailable], [2, 2]);
  assert.equal(await env.ledger.has("gone"), true);
  assert.equal(await env.ledger.has("vgone"), true);
  assert.equal(await env.ledger.has("flaky"), false);
});

test("retrying starts only failed items that have tries left, within the asked platform and account", async () => {
  const env = loadBackground({
    storage: {
      failedDownloads: {
        a: { item: photo(1, { key: "a" }), attempts: 1, error: "x" },
        b: { item: photo(2, { key: "b", account: "bob" }), attempts: 1, error: "x" },
        c: { item: photo(3, { key: "c" }), attempts: 3, error: "x" }
      },
      downloadAttempts: { a: 1, b: 1, c: 3 }
    }
  });
  const result = plain(await env.send({ type: "RETRY_FAILED_DOWNLOADS", platform: "Twitter", account: "alice" }));
  assert.equal(result.ok, true);
  assert.equal(result.started, 1);
  assert.deepEqual(
    env.started.map(item => item.url),
    ["https://pbs.twimg.com/media/pic1.jpg"]
  );
  assert.equal(result.pending, 1);
  assert.equal(result.retryable, 0, "bob's item is outside the asked account");
  assert.equal((await status(env)).retryable, 1, "and can still be retried later");

  const none = loadBackground();
  assert.deepEqual(plain(await none.send({ type: "RETRY_FAILED_DOWNLOADS" })), {
    ok: true,
    pending: 0,
    failed: 0,
    unavailable: 0,
    retryable: 0
  });
});

test("draining waits for pending downloads to finish and returns the final status", async () => {
  const env = loadBackground();
  await download(env, [photo(1)]);
  setTimeout(() => finish(env, 1), 100);
  const result = plain(await env.send({ type: "DRAIN_DOWNLOADS", timeoutMs: 20000 }));
  assert.deepEqual([result.pending, result.failed], [0, 0]);
  assert.equal(await env.ledger.has("Twitter|image|1|1"), true);
});

test("draining does not hold the batch queue while it waits for downloads", async () => {
  const env = loadBackground();
  await download(env, [photo(1)]);

  const draining = env.send({ type: "DRAIN_DOWNLOADS", platform: "Twitter", account: "alice", timeoutMs: 5000 });
  await settle();
  const next = env.send({ type: "DOWNLOAD_ITEMS", items: [photo(2)] });
  const returnedQuickly = await Promise.race([
    next.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 200))
  ]);
  assert.equal(returnedQuickly, true);
  assert.equal(plain(await next).started, 1);

  finish(env, 1);
  finish(env, 2);
  assert.equal(plain(await draining).pending, 0);
});

test("draining gives up at its deadline, clamped to between one and two minutes", async () => {
  let clock = 1_000_000;
  const env = loadBackground({ now: () => clock });
  await download(env, [photo(1)]);
  env.inContext(
    "chrome.downloads.search = async () => { globalThis.__searches = (globalThis.__searches || 0) + 1; return []; }"
  );
  const first = env.send({ type: "DRAIN_DOWNLOADS", timeoutMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 900));
  clock += 1_500;
  assert.equal(plain(await first).pending, 1, "short asks are raised to one second, then it gives up");

  const second = env.send({ type: "DRAIN_DOWNLOADS" });
  await new Promise(resolve => setTimeout(resolve, 900));
  clock += 61_000;
  assert.equal(plain(await second).pending, 1, "the default wait is a minute");

  const third = env.send({ type: "DRAIN_DOWNLOADS", timeoutMs: 10_000_000 });
  await new Promise(resolve => setTimeout(resolve, 900));
  clock += 121_000;
  assert.equal(plain(await third).pending, 1, "long asks are capped at two minutes");
});

test("at most eight downloads run at once; a later scan uses the next free slot", async () => {
  const env = loadBackground();
  await download(
    env,
    Array.from({ length: 8 }, (_, index) => photo(index + 1))
  );
  assert.equal(env.started.length, 8);
  const ninth = download(env, [photo(9)]);
  const result = plain(await ninth);
  assert.deepEqual([result.started, result.pending], [0, 8]);
  assert.equal(env.started.length, 8);
  finish(env, 1);
  assert.equal(plain(await download(env, [photo(9)])).started, 1);
  assert.equal(env.started.length, 9);
});

test("a full download batch returns without holding the queue for a slot", async () => {
  const env = loadBackground();
  await download(
    env,
    Array.from({ length: 8 }, (_, index) => photo(index + 1))
  );
  const queued = download(
    env,
    Array.from({ length: 20 }, (_, index) => photo(index + 9))
  );
  const returnedQuickly = await Promise.race([
    queued.then(() => true),
    new Promise(resolve => setTimeout(() => resolve(false), 100))
  ]);
  const result = plain(await queued);
  assert.equal(returnedQuickly, true);
  assert.deepEqual([result.started, result.pending], [0, 8]);
  assert.equal(env.started.length, 8);
});

test("an item already saved while all slots are busy is skipped", async () => {
  const env = loadBackground();
  await download(
    env,
    Array.from({ length: 8 }, (_, index) => photo(index + 1))
  );
  const key = photo(9).key;
  await env.ledger.add(key);
  const result = plain(await download(env, [photo(9)]));
  assert.deepEqual([result.started, result.skipped], [0, 1]);
  assert.equal(env.started.length, 8);
});

test("only a finished-download event triggers a reconcile, and a failing one is swallowed", async () => {
  const env = loadBackground();
  await download(env, [photo(1)]);
  finish(env, 1);
  const [onChanged] = env.listeners.changed;
  await onChanged({ id: 1 });
  await onChanged({ id: 1, state: { current: "in_progress" } });
  assert.equal(env.storage.pendingDownloads["Twitter|image|1|1"], 1, "nothing reconciled yet");
  await onChanged({ id: 1, state: { current: "complete" } });
  assert.deepEqual(plain(env.storage.pendingDownloads), {});

  env.inContext(`chrome.storage.local.get = async () => { throw new Error("storage unavailable"); }`);
  await onChanged({ id: 1, state: { current: "interrupted" } });
});

test("the filename listener answers for this extension's own downloads from the stored targets", async () => {
  const env = loadBackground({
    storage: {
      downloadTargets: {
        "https://a/1": ["Twitter/alice/one.jpg"],
        "https://a/2": [{ filename: "Twitter/alice/two.jpg", conflictAction: "overwrite" }],
        "https://a/3": [{ filename: "Twitter/alice/three.jpg" }],
        "https://a/4": [{ nothing: true }]
      }
    }
  });
  const own = url => env.determine({ id: 1, url, byExtensionId: "test-extension-id" });
  assert.deepEqual(plain((await own("https://a/1"))[0]), {
    filename: "Twitter/alice/one.jpg",
    conflictAction: "uniquify"
  });
  assert.deepEqual(plain((await own("https://a/2"))[0]), {
    filename: "Twitter/alice/two.jpg",
    conflictAction: "overwrite"
  });
  assert.equal((await own("https://a/3"))[0].conflictAction, "uniquify");
  assert.deepEqual(await own("https://a/4"), [], "a target without a name leaves the browser's choice");
  assert.deepEqual(await own("https://a/unknown"), [], "no target leaves the browser's choice");
  assert.equal(env.storage.downloadTargets["https://a/1"], undefined, "a used target is consumed");
});

test("the filename listener falls back to the browser's name when storage fails", async () => {
  const env = loadBackground();
  env.inContext(`chrome.storage.local.get = async () => { throw new Error("storage unavailable"); }`);
  assert.deepEqual(await env.determine({ id: 1, url: "https://a/1", byExtensionId: "test-extension-id" }), []);
  assert.deepEqual(await env.determine({ id: 2, url: "https://a/1", filename: "x.bin" }), []);
});

test("two downloads of one URL each get their own name target, and a failure removes only its own", async () => {
  const env = loadBackground();
  await env.inContext(`enqueueDownloadTarget("https://u", "first.jpg")`);
  await env.inContext(`enqueueDownloadTarget("https://u", { filename: "second.jpg" })`);
  await env.inContext(`removeDownloadTarget("https://u", "second.jpg")`);
  await env.inContext(`removeDownloadTarget("https://u", "not-there.jpg")`);
  await env.inContext(`removeDownloadTarget("https://other", "x.jpg")`);
  assert.deepEqual(plain(env.storage.downloadTargets), { "https://u": ["first.jpg"] });
  await env.inContext(`removeDownloadTarget("https://u", "first.jpg")`);
  assert.deepEqual(plain(env.storage.downloadTargets), {});
});

test("messages are routed to the right handler and a handler's failure becomes an error reply", async () => {
  const env = loadBackground();
  assert.equal(
    env.listeners.message[0]({ type: "toString" }, {}, () => {}),
    false
  );
  assert.equal(
    env.listeners.message[0]({ type: "NOT_A_TYPE" }, {}, () => {}),
    false
  );
  assert.equal(
    env.listeners.message[0](null, {}, () => {}),
    false
  );

  const failing = loadBackground({ failStorageGet: true });
  const reply = plain(await failing.send({ type: "DOWNLOAD_ITEMS", items: [] }));
  assert.deepEqual(reply, { ok: false, error: "storage unavailable" });

  const odd = loadBackground();
  odd.inContext(`chrome.storage.local.get = () => Promise.reject("just a string")`);
  assert.deepEqual(plain(await odd.send({ type: "DOWNLOAD_STATUS" })), { ok: false, error: "just a string" });
  await settle();
});
