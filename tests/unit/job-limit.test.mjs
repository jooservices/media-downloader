import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { DEFAULT_LIMIT, parseDownloadArgs } from "../cli/args.mjs";
import { loadBackground, plain } from "./helpers/background.mjs";

const jobsSource = fs.readFileSync(new URL("../cli/jobs.mjs", import.meta.url), "utf8");

test("the CLI limits a scan to 10 files unless told otherwise", () => {
  assert.equal(DEFAULT_LIMIT, 10);
  assert.deepEqual(plain(parseDownloadArgs(["https://x.com/a/"])), { url: "https://x.com/a/", limit: 10 });
});

test("--limit N sets the limit, in both spellings and either order", () => {
  assert.deepEqual(plain(parseDownloadArgs(["https://x.com/a/", "--limit", "5"])), { url: "https://x.com/a/", limit: 5 });
  assert.deepEqual(plain(parseDownloadArgs(["--limit=3", "https://x.com/a/"])), { url: "https://x.com/a/", limit: 3 });
});

test("--unlimited removes the limit (null)", () => {
  assert.deepEqual(plain(parseDownloadArgs(["https://x.com/a/", "--unlimited"])), { url: "https://x.com/a/", limit: null });
});

test("rejects a bad limit, -1, both options together, or an extra argument", () => {
  for (const args of [["u", "--limit"], ["u", "--limit", "0"], ["u", "--limit", "-1"], ["u", "--limit=1.5"], ["u", "--limit", "abc"],
    ["u", "--limit", "5", "--unlimited"], ["u", "--unlimited", "--limit", "5"], ["u", "--unlimited", "--unlimited"], ["u", "v"]]) {
    assert.throws(() => parseDownloadArgs(args), /limit|Unexpected|Use only/, args.join(" "));
  }
});

test("the CLI job carries the limit to the extension", () => {
  assert.match(jobsSource, /mediaPage,\s*limit,\s*status: "queued"/);
});

const video = id => ({ platform: "Twitter", id, index: 1, owner: "acct", durationMs: 1, url: `https://video.twimg.com/v/${id}.mp4` });

test("limits how many cached videos one request starts and keeps the rest for later", async () => {
  const { send, started } = loadBackground();
  await send({ type: "MEDIA_FOUND", media: [video("1001"), video("1002"), video("1003")] });
  const request = limit => send({ type: "DOWNLOAD_CACHED_MEDIA", platform: "Twitter", account: "acct", limit });
  assert.equal((await request(2)).started, 2);
  assert.equal(started.length, 2);
  // Videos already started do not use the allowance of the next request.
  assert.equal((await request(2)).started, 1);
  assert.equal(started.length, 3);
  assert.equal((await request(0)).started, 0);
});

test("stops an abandoned scan only after the bridge has been unreachable for 45 seconds", async () => {
  let clock = 1_000_000;
  const { send, tabMessages } = loadBackground({
    now: () => clock,
    fetchImpl: async () => { throw new TypeError("Failed to fetch"); }
  });
  const progress = { type: "AUTO_PROGRESS", state: { jobId: "job-1" } };
  const sender = { tab: { id: 7 } };

  await send(progress, sender);
  clock += 30_000;
  await send(progress, sender);
  assert.equal(tabMessages.length, 0, "a short outage keeps the scan alive so resume can reconnect");

  clock += 20_000;
  await send(progress, sender);
  assert.deepEqual(plain(tabMessages), [{ id: 7, message: { type: "AUTO_STOP" } }]);
});
