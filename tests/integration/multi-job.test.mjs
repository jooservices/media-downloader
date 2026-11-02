import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// The CLI keeps its files under %LOCALAPPDATA%\PageMediaSaver; point it at a temp folder.
process.env.LOCALAPPDATA = await mkdtemp(path.join(os.tmpdir(), "pms-multi-"));
const store = await import("../../cli/store.mjs");
const { handleBridgeMessage } = await import("../../cli/bridge-server.mjs");
const { addUrls, readUrlFile } = await import("../../cli/serve.mjs");
const { createJob } = await import("../../cli/jobs.mjs");

const page = (job, tabId) => ({
  type: "PAGE_READY",
  tabId,
  pageUrl: job.url,
  platform: job.platform,
  account: job.account
});

test("two jobs on different sites each start on their own page", async () => {
  const ig = await createJob("https://www.instagram.com/alice/");
  const x = await createJob("https://x.com/bob");
  const claimed = new Set();

  const igResult = await handleBridgeMessage(page(ig, 11), claimed);
  const xResult = await handleBridgeMessage(page(x, 12), claimed);
  assert.deepEqual([igResult.type, igResult.job.jobId, igResult.tabId], ["START_JOB", ig.jobId, 11]);
  assert.deepEqual([xResult.type, xResult.job.jobId, xResult.tabId], ["START_JOB", x.jobId, 12]);
  assert.equal((await store.listJobs()).filter(job => job.status === "running").length, 2);
});

test("two jobs on the same site are told apart by account", async () => {
  const a = await createJob("https://www.instagram.com/carol/");
  const b = await createJob("https://www.instagram.com/dave/");
  const claimed = new Set();
  assert.equal((await handleBridgeMessage(page(b, 21), claimed)).job.jobId, b.jobId);
  assert.equal((await handleBridgeMessage(page(a, 22), claimed)).job.jobId, a.jobId);
});

test("a page with no waiting job gets NO_JOB, and a reloaded page reconnects to its running job", async () => {
  const stranger = {
    type: "PAGE_READY",
    tabId: 5,
    pageUrl: "https://x.com/nobody/",
    platform: "Twitter",
    account: "nobody"
  };
  assert.equal((await handleBridgeMessage(stranger, new Set())).type, "NO_JOB");

  const job = await createJob("https://x.com/erin");
  const claimed = new Set();
  assert.equal((await handleBridgeMessage(page(job, 31), claimed)).type, "START_JOB");
  assert.equal((await handleBridgeMessage(page(job, 31), claimed)).type, "JOB_CONNECTED");
});

const tagged = (job, tabId, pageUrl = job.url) => ({ ...page(job, tabId), pageUrl, cliJobId: job.jobId });

test("a tab whose job is finished or gone is told to close", async () => {
  const done = await createJob("https://x.com/finished");
  await handleBridgeMessage({ type: "JOB_DONE", jobId: done.jobId, state: { status: "complete" } }, new Set());
  assert.equal((await handleBridgeMessage(tagged(done, 1), new Set())).close, true);

  const gone = {
    jobId: "00000000-0000-4000-8000-000000000001",
    platform: "Twitter",
    account: "x",
    url: "https://x.com/x/"
  };
  assert.equal((await handleBridgeMessage(tagged(gone, 2), new Set())).close, true);
});

test("a tab for a waiting job on the right page is not closed and starts the job", async () => {
  const job = await createJob("https://x.com/ivy");
  const result = await handleBridgeMessage(tagged(job, 3), new Set());
  assert.equal(result.type, "START_JOB");
  assert.equal(result.close, undefined);
  assert.equal((await store.listJobs()).find(item => item.jobId === job.jobId).tabId, 3);
});

test("a second tab for a running job is closed, the first can reload and keeps going", async () => {
  const job = await createJob("https://x.com/june");
  const claimed = new Set();
  await handleBridgeMessage(tagged(job, 10), claimed);
  assert.equal((await handleBridgeMessage(tagged(job, 11), claimed)).close, true, "a duplicate tab");
  const reload = await handleBridgeMessage(tagged(job, 10), claimed);
  assert.equal(reload.type, "JOB_CONNECTED");
  assert.equal(reload.close, undefined);
});

test("a sign-in page ends the job without retries and closes the tab", async () => {
  const job = await createJob("https://www.instagram.com/kim/");
  const result = await handleBridgeMessage(
    tagged(job, 20, "https://www.instagram.com/accounts/login/?next=%2Fkim%2F"),
    new Set()
  );
  assert.equal(result.close, true);
  const saved = (await store.listJobs()).find(item => item.jobId === job.jobId);
  assert.equal(saved.status, "error");
  assert.equal(saved.noRetry, true);
  assert.match(saved.message, /asked to sign in/);
});

test("a tab that landed on a different page than its job is closed and the job stays waiting", async () => {
  const job = await createJob("https://x.com/lee");
  const result = await handleBridgeMessage(tagged(job, 30, "https://x.com/somebody_else/"), new Set());
  assert.equal(result.close, true);
  assert.equal((await store.listJobs()).find(item => item.jobId === job.jobId).status, "queued");
});

test("progress and completion of one job never touch another", async () => {
  const one = await createJob("https://x.com/frank");
  const two = await createJob("https://x.com/gina");
  await handleBridgeMessage({ type: "JOB_PROGRESS", jobId: one.jobId, state: { started: 7 } }, new Set());
  await handleBridgeMessage(
    { type: "JOB_DONE", jobId: two.jobId, state: { started: 3, status: "complete" } },
    new Set()
  );
  const saved = Object.fromEntries((await store.listJobs()).map(job => [job.jobId, job]));
  assert.deepEqual([saved[one.jobId].status, saved[one.jobId].started], ["running", 7]);
  assert.deepEqual([saved[two.jobId].status, saved[two.jobId].started], ["complete", 3]);
});

test("updates to one job file made at the same time are all applied", async () => {
  const job = await createJob("https://x.com/hank");
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      store.updateJob(job.jobId, current => {
        current.counter = (current.counter || 0) + 1;
        current[`mark${i}`] = true;
      })
    )
  );
  const saved = JSON.parse(await readFile(store.jobFile(job.jobId), "utf8"));
  assert.equal(saved.counter, 25);
  assert.equal(Object.keys(saved).filter(key => key.startsWith("mark")).length, 25);
});

test("updateJob on a missing job does nothing", async () => {
  assert.equal(await store.updateJob("00000000-0000-4000-8000-000000000000", () => {}), null);
});

test("addUrls queues each profile once, ignoring tracking parameters and letter case", async () => {
  const first = await addUrls([
    "https://www.instagram.com/iris/?e=abc&g=5",
    "https://www.instagram.com/IRIS/",
    "https://www.instagram.com/jack/"
  ]);
  assert.equal(first.created.length, 2);
  assert.equal(first.skipped.length, 1);

  const again = await addUrls(["https://www.instagram.com/iris/", "https://www.instagram.com/jack"]);
  assert.equal(again.created.length, 0, "already queued");

  const forced = await addUrls(["https://www.instagram.com/iris/"], { force: true });
  assert.equal(forced.created.length, 1, "--again queues it anew");
});

test("addUrls reports a URL it cannot use instead of failing the whole batch", async () => {
  const { created, skipped } = await addUrls(["https://example.com/nope", "https://x.com/kate"]);
  assert.equal(created.length, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /\S/);
});

test("queued jobs carry no limit unless one is given", async () => {
  const [job] = (await addUrls(["https://x.com/leo"])).created;
  assert.equal(job.limit, null);
  assert.equal(job.attempts, 0);
  assert.equal(job.openedAt, null);
});

test("the inbox file is read as one https URL per line, ignoring blanks and notes", async () => {
  const file = path.join(process.env.LOCALAPPDATA, "inbox-test.txt");
  await writeFile(file, "\r\nhttps://x.com/a\r\n# a note\r\n   https://www.instagram.com/b/?e=1  \r\nftp://nope\r\n");
  assert.deepEqual(await readUrlFile(file), ["https://x.com/a", "https://www.instagram.com/b/?e=1"]);
  assert.deepEqual(await readUrlFile(path.join(process.env.LOCALAPPDATA, "missing.txt")), []);
});
