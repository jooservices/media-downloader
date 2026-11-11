import assert from "node:assert/strict";
import test from "node:test";
import { queueCanaryAccounts } from "../../cli/canary.mjs";

test("canary probes enter the normal queue and active probes are not duplicated", async () => {
  const calls = [];
  const addUrls = async (...args) => {
    calls.push(args);
    return { created: [{ jobId: "queued" }], skipped: [] };
  };
  const config = {
    limit: 5,
    canary: { accounts: ["https://instagram.com/a/", "https://x.com/b/"], intervalMinutes: 30 }
  };
  const jobs = [{ url: "https://instagram.com/a/", status: "running" }];
  const result = await queueCanaryAccounts(config, jobs, addUrls);
  assert.equal(result.created.length, 1);
  assert.deepEqual(calls, [[["https://x.com/b/"], { force: true, limit: 5 }]]);
  assert.deepEqual(await queueCanaryAccounts(null, [], addUrls), { created: [], skipped: [] });
  assert.equal(calls.length, 1);
});
