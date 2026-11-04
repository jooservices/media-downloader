import assert from "node:assert/strict";
import test from "node:test";
import { loadBackground } from "../helpers/background.mjs";

const video = (id, extra = {}) => ({
  platform: "Twitter",
  id,
  index: 1,
  owner: "acct",
  durationMs: 1,
  url: `https://video.twimg.com/amplify_video/${id}/vid/a.mp4`,
  ...extra
});

const request = send => send({ type: "DOWNLOAD_CACHED_MEDIA", platform: "Twitter", account: "acct" });
const status = send => send({ type: "DOWNLOAD_STATUS", platform: "Twitter", account: "acct" });

async function startOne(error) {
  const env = loadBackground();
  await env.send({ type: "MEDIA_FOUND", media: [video("1001")] });
  assert.equal((await request(env.send)).started, 1);
  env.downloads.set(1, { id: 1, state: "interrupted", error });
  return env;
}

test("a download the site refuses for good (403) is settled: not failed, not retried, and skipped from then on", async () => {
  const env = await startOne("SERVER_FORBIDDEN");
  const after = await status(env.send);
  assert.deepEqual([after.failed, after.unavailable, after.retryable], [0, 1, 0]);
  assert.ok(await env.ledger.has("Twitter|video|1001|1"), "remembered as settled");

  const again = await request(env.send);
  assert.equal(again.started, 0);
  assert.equal(env.started.length, 1, "no second attempt on a later scan");
});

test("the other permanent refusals (not found, not signed in) are settled the same way", async () => {
  for (const error of ["SERVER_BAD_CONTENT", "SERVER_UNAUTHORIZED"]) {
    const env = await startOne(error);
    const after = await status(env.send);
    assert.deepEqual([after.failed, after.unavailable], [0, 1], error);
  }
});

test("a network problem is still a failure that can be retried", async () => {
  for (const error of ["NETWORK_FAILED", "NETWORK_TIMEOUT", "SERVER_FAILED", undefined]) {
    const env = await startOne(error);
    const after = await status(env.send);
    assert.deepEqual([after.failed, after.unavailable, after.retryable], [1, 0, 1], String(error));
    assert.equal(env.started.length, 1);
  }
});

test("failures an earlier version recorded as 403 are settled the next time the state is read", async () => {
  const item = {
    platform: "Twitter",
    account: "acct",
    key: "Twitter|video|2002|1",
    url: "https://video.twimg.com/x.mp4",
    filename: "v.mp4"
  };
  const env = loadBackground({
    storage: { failedDownloads: { [item.key]: { item, attempts: 3, error: "SERVER_FORBIDDEN" } } }
  });
  const after = await status(env.send);
  assert.deepEqual([after.failed, after.unavailable], [0, 1]);
  assert.ok(await env.ledger.has(item.key));
  assert.deepEqual(Object.keys(env.storage.failedDownloads), []);
});

test("settled files are counted per account, so another account's summary is not affected", async () => {
  const env = await startOne("SERVER_FORBIDDEN");
  await status(env.send);
  const other = await env.send({ type: "DOWNLOAD_STATUS", platform: "Twitter", account: "someone-else" });
  assert.equal(other.unavailable, 0);
  const all = await env.send({ type: "DOWNLOAD_STATUS" });
  assert.equal(all.unavailable, 1);
});

test("a menu video the site refuses is settled too", async () => {
  const env = loadBackground({
    storage: {
      nativeVideoFailures: {
        "Twitter|video|3003|1": { platform: "Twitter", account: "acct", error: "SERVER_FORBIDDEN" }
      }
    }
  });
  const after = await status(env.send);
  assert.deepEqual([after.failed, after.unavailable], [0, 1]);
});
