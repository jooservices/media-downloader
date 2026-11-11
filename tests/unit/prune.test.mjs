import assert from "node:assert/strict";
import test from "node:test";
import { expiredJobs } from "../../cli/prune.mjs";
import { createRequire } from "node:module";

const { platformHealth } = createRequire(import.meta.url)("../../lib/platform-health.js");

const day = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-11-09T00:00:00Z");
const job = (id, url, status, daysAgo) => ({
  jobId: id,
  url,
  status,
  createdAt: new Date(now - daysAgo * day).toISOString(),
  updatedAt: new Date(now - daysAgo * day).toISOString()
});
const agedJob = (id, url, status, daysAgo, options) => ({
  ...job(1, url, status, daysAgo),
  jobId: id,
  ...options
});

test("old finished jobs go, but the newest job of each URL and active jobs stay", () => {
  const jobs = [
    job("a1", "u1", "complete", 90),
    job("a2", "u1", "complete", 60),
    job("a3", "u1", "complete", 40),
    job("b1", "u2", "complete", 90),
    job("c1", "u3", "running", 90),
    job("c2", "u3", "queued", 80),
    job("d1", "u4", "complete", 5),
    job("d2", "u4", "complete", 1)
  ];
  const gone = expiredJobs(jobs, now).map(item => item.jobId);
  assert.deepEqual(gone.sort(), ["a1", "a2"]);
});

test("pruning preserves an unresolved diagnostic and its recent zero-media history", () => {
  const aliceError = {
    ...agedJob("diag", "https://instagram.com/alice/", "error", 60, {
      platform: "Instagram",
      account: "alice",
      message: "Selector failed to find media"
    })
  };
  const aliceZero = {
    ...agedJob("zero", "https://instagram.com/alice/", "complete", 31, {
      platform: "Instagram",
      account: "alice",
      started: 0
    })
  };
  const before = platformHealth([aliceError, aliceZero]).find(item => item.platform === "Instagram");
  assert.equal(before.state, "broken");

  const expired = expiredJobs([aliceError, aliceZero], now);
  const afterJobs = [aliceError, aliceZero].filter(item => !expired.includes(item));
  const after = platformHealth(afterJobs).find(item => item.platform === "Instagram");
  assert.deepEqual(expired, []);
  assert.equal(after.state, "broken");
  assert.match(after.reason, /Selector failed/);
});
