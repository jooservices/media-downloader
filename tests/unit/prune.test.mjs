import assert from "node:assert/strict";
import test from "node:test";
import { expiredJobs } from "../../cli/prune.mjs";

const day = 24 * 60 * 60 * 1000;
const now = Date.parse("2026-11-09T00:00:00Z");
const job = (id, url, status, daysAgo) => ({
  jobId: id,
  url,
  status,
  createdAt: new Date(now - daysAgo * day).toISOString(),
  updatedAt: new Date(now - daysAgo * day).toISOString()
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
