import assert from "node:assert/strict";
import test from "node:test";
import { loadBackground } from "../helpers/background.mjs";

const posted = [];
const fetchImpl = async (_url, init) => {
  posted.push(JSON.parse(init.body));
  return { ok: true, status: 200, json: async () => ({ ok: true, type: "ACK" }) };
};

const jobErrors = () => posted.filter(message => message.type === "JOB_ERROR").map(message => message.jobId);
const closeTab = (listeners, id) => Promise.all(listeners.tabRemoved.map(listener => listener(id)));

test("each tab remembers its own job, so closing one tab only fails that tab's job", async () => {
  posted.length = 0;
  const env = loadBackground({ fetchImpl, storage: { activeCliJobs: { 7: "job-a", 8: "job-b" } } });

  await closeTab(env.listeners, 7);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(jobErrors(), ["job-a"]);
  assert.deepEqual(env.storage.activeCliJobs, { 8: "job-b" }, "the other tab's job is still tracked");

  await closeTab(env.listeners, 99);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(jobErrors(), ["job-a"], "a tab that never ran a job reports nothing");
});

test("a finished job's tab is closed and forgotten, and its later removal is not an error", async () => {
  posted.length = 0;
  const env = loadBackground({ fetchImpl, storage: { activeCliJobs: { 7: "job-a", 8: "job-b" } } });

  await env.send({ type: "AUTO_DONE", state: { jobId: "job-a", status: "complete" } }, { tab: { id: 7 } });
  assert.deepEqual(env.tabRemoves, [7]);
  assert.deepEqual(env.storage.activeCliJobs, { 8: "job-b" });

  await closeTab(env.listeners, 7);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(jobErrors(), [], "closing the finished tab does not fail the job");
  assert.equal(posted.filter(message => message.type === "JOB_DONE").length, 1);
});

test("two tabs that become ready at the same moment are both remembered", async () => {
  const env = loadBackground({ fetchImpl });
  await env.inContext(
    `Promise.all([rememberCliJob(7, "job-a"), rememberCliJob(8, "job-b"), rememberCliJob(9, "job-c")])`
  );
  assert.deepEqual(env.storage.activeCliJobs, { 7: "job-a", 8: "job-b", 9: "job-c" });

  const taken = await env.inContext(`Promise.all([takeCliJob(7), rememberCliJob(10, "job-d"), takeCliJob(9)])`);
  assert.deepEqual([taken[0], taken[2]], ["job-a", "job-c"]);
  assert.deepEqual(env.storage.activeCliJobs, { 8: "job-b", 10: "job-d" });
});

test("progress from a running tab does not close it", async () => {
  posted.length = 0;
  const env = loadBackground({ fetchImpl, storage: { activeCliJobs: { 7: "job-a" } } });
  await env.send({ type: "AUTO_PROGRESS", state: { jobId: "job-a" } }, { tab: { id: 7 } });
  assert.deepEqual(env.tabRemoves, []);
  assert.deepEqual(env.storage.activeCliJobs, { 7: "job-a" });
});
