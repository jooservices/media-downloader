import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Never the live queue's folder or port: a temp folder and a free port, set before the CLI is imported.
const home = await mkdtemp(path.join(os.tmpdir(), "pms-bridge-"));
const PORT = await freePort();
process.env.LOCALAPPDATA = home;
process.env.PMS_BRIDGE_PORT = String(PORT);
const store = await import("../../cli/store.mjs");
const { handleBridgeMessage, startBridgeServer } = await import("../../cli/bridge-server.mjs");

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PAGE = "https://www.instagram.com/alice/";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

after(() => rm(home, { recursive: true, force: true }));
beforeEach(() => rm(store.APP_DIR, { recursive: true, force: true }));

async function putJob(n, extra = {}) {
  const job = {
    jobId: id(n),
    url: PAGE,
    platform: "Instagram",
    account: "alice",
    mediaPage: false,
    status: "queued",
    createdAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
    ...extra
  };
  await store.writeJsonAtomic(store.jobFile(job.jobId), job);
  return job;
}

const ready = (extra = {}) => ({
  type: "PAGE_READY",
  tabId: 7,
  pageUrl: PAGE,
  platform: "Instagram",
  account: "Alice",
  ...extra
});
const read = n => store.readJson(store.jobFile(id(n)));

test("a page that is not a tab at all is refused", async () => {
  const result = await handleBridgeMessage(ready({ tabId: "7" }), new Set());
  assert.deepEqual(result, { ok: false, error: "The Edge tab could not be identified." });
});

test("a page with no waiting job gets NO_JOB, and one with a running job reconnects", async () => {
  const claimed = new Set();
  assert.deepEqual(await handleBridgeMessage(ready(), claimed), { ok: true, type: "NO_JOB" });
  await putJob(1, { status: "running", tabId: 7 });
  assert.deepEqual(await handleBridgeMessage(ready(), claimed), { ok: true, type: "JOB_CONNECTED" });
  assert.equal((await read(1)).status, "running");
});

test("the oldest waiting job for the page starts and is claimed so a second tab cannot take it", async () => {
  const claimed = new Set();
  await putJob(2); // newer
  await putJob(1); // older
  const first = await handleBridgeMessage(ready(), claimed);
  assert.equal(first.type, "START_JOB");
  assert.equal(first.tabId, 7);
  assert.equal(first.job.jobId, id(1));
  assert.equal(first.job.status, "running");
  assert.equal(first.job.tabId, 7);
  assert.match(first.job.message, /profile page/);
  assert.equal((await read(2)).status, "queued");

  const second = await handleBridgeMessage(ready({ tabId: 8 }), claimed);
  assert.equal(second.job.jobId, id(2), "the next tab gets the next job");
  const third = await handleBridgeMessage(ready({ tabId: 9 }), claimed);
  assert.equal(third.type, "JOB_CONNECTED", "both jobs are taken");
});

test("a page for another site, account or address does not match the job", async () => {
  await putJob(1);
  for (const other of [
    ready({ platform: "Twitter" }),
    ready({ account: "bob" }),
    ready({ pageUrl: "https://www.instagram.com/bob/" }),
    ready({ pageUrl: "https://www.instagram.com/accounts/login/" }),
    ready({ pageUrl: "" })
  ]) {
    assert.deepEqual(await handleBridgeMessage(other, new Set()), { ok: true, type: "NO_JOB" });
  }
  assert.equal((await read(1)).status, "queued");
});

test("an opened post takes the account name from the page", async () => {
  const post = "https://www.instagram.com/p/ABC/";
  await putJob(1, { url: post, mediaPage: true, account: "instagram-post" });
  const result = await handleBridgeMessage(ready({ pageUrl: post, account: "carol" }), new Set());
  assert.equal(result.job.account, "carol");
  assert.match(result.job.message, /media post/);
});

test("a tagged tab of a finished or unknown job is told to close", async () => {
  const claimed = new Set();
  const close = { ok: true, type: "NO_JOB", close: true };
  assert.deepEqual(await handleBridgeMessage(ready({ cliJobId: id(9) }), claimed), close);
  assert.deepEqual(await handleBridgeMessage(ready({ cliJobId: "../evil" }), claimed), close);
  await putJob(1, { status: "complete" });
  assert.deepEqual(await handleBridgeMessage(ready({ cliJobId: id(1) }), claimed), close);
});

test("a tagged tab on a sign-in page marks the job as needing login and closes", async () => {
  await putJob(1);
  const result = await handleBridgeMessage(
    ready({ cliJobId: id(1), pageUrl: "https://www.instagram.com/accounts/login/" }),
    new Set()
  );
  assert.deepEqual(result, { ok: true, type: "NO_JOB", close: true });
  const job = await read(1);
  assert.equal(job.status, "error");
  assert.equal(job.needsLogin, true);
  assert.match(job.message, /Instagram asked to sign in/);
});

test("a tagged tab is kept when it runs the job, closed when another tab already does or the page is wrong", async () => {
  await putJob(1, { status: "running", tabId: 7 });
  // The tab running the job may be on any page while it scans.
  const running = await handleBridgeMessage(
    ready({ cliJobId: id(1), pageUrl: "https://www.instagram.com/p/XYZ/" }),
    new Set()
  );
  assert.equal(running.close, undefined);
  assert.equal(running.type, "NO_JOB", "its page matches nothing, but the tab is not told to close");
  // A second tab for a running job is a duplicate.
  const duplicate = await handleBridgeMessage(ready({ cliJobId: id(1), tabId: 8 }), new Set());
  assert.equal(duplicate.close, true);

  await putJob(2, { url: "https://x.com/Bob/", platform: "Twitter", account: "Bob" });
  const wrong = await handleBridgeMessage(ready({ cliJobId: id(2) }), new Set());
  assert.equal(wrong.close, true, "a queued job opened on the wrong page");
  const right = await handleBridgeMessage(
    ready({ cliJobId: id(2), pageUrl: "https://x.com/Bob/", platform: "Twitter", account: "bob" }),
    new Set()
  );
  assert.equal(right.type, "START_JOB");
});

test("progress reports update the job and a final one clears the queue file", async () => {
  await putJob(1, { status: "running" });
  await store.writeJsonAtomic(store.QUEUE_FILE, { jobId: id(1) });
  const progress = await handleBridgeMessage(
    { type: "JOB_PROGRESS", jobId: id(1), state: { started: 3, pending: 2, message: "Scanning" } },
    new Set()
  );
  assert.deepEqual(progress, { ok: true, type: "ACK" });
  let job = await read(1);
  assert.equal(job.started, 3);
  assert.equal(job.message, "Scanning");
  assert.equal(job.status, "running");
  assert.ok(await store.readJson(store.QUEUE_FILE), "still the active job");

  await handleBridgeMessage({ type: "JOB_DONE", state: { jobId: id(1), status: "complete", started: 5 } }, new Set());
  job = await read(1);
  assert.equal(job.status, "complete");
  assert.equal(await store.readJson(store.QUEUE_FILE), null, "a finished active job is released");
});

test("a finished job that is not the active one leaves the queue file alone", async () => {
  await putJob(1, { status: "running" });
  await putJob(2, { status: "running" });
  await store.writeJsonAtomic(store.QUEUE_FILE, { jobId: id(2) });
  await handleBridgeMessage({ type: "JOB_DONE", jobId: id(1), state: { status: "paused" } }, new Set());
  assert.equal((await read(1)).status, "paused");
  assert.deepEqual(await store.readJson(store.QUEUE_FILE), { jobId: id(2) });
});

test("an error report ends the job with the error text", async () => {
  await putJob(1, { status: "running" });
  await handleBridgeMessage({ type: "JOB_ERROR", jobId: id(1), error: "tab crashed" }, new Set());
  const job = await read(1);
  assert.equal(job.status, "error");
  assert.equal(job.message, "tab crashed");
});

test("unknown messages, bad ids and vanished jobs are refused without touching files", async () => {
  const none = new Set();
  assert.deepEqual(await handleBridgeMessage(null, none), { ok: false, error: "Unsupported bridge message." });
  assert.deepEqual(await handleBridgeMessage({ type: "WHAT", jobId: id(1) }, none), {
    ok: false,
    error: "Unsupported bridge message."
  });
  assert.deepEqual(await handleBridgeMessage({ type: "JOB_DONE" }, none), {
    ok: false,
    error: "Unsupported bridge message."
  });
  assert.deepEqual(await handleBridgeMessage({ type: "JOB_DONE", jobId: "../../x" }, none), {
    ok: false,
    error: "Invalid job id."
  });
  assert.deepEqual(await handleBridgeMessage({ type: "JOB_DONE", jobId: id(5), state: {} }, none), {
    ok: false,
    error: "The CLI job no longer exists."
  });
});

function request(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: PORT, method, path: url, headers }, res => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", chunk => (text += chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function withBridge(fn) {
  await store.writeJsonAtomic(store.BRIDGE_CONFIG_FILE, { extensionOrigin: ORIGIN, port: PORT });
  const server = await startBridgeServer();
  try {
    await fn();
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const post = (body, headers = {}) =>
  request("POST", "/message", { headers: { origin: ORIGIN, "content-type": "application/json", ...headers }, body });

test("the bridge only answers the installed extension on the exact loopback address", async () => {
  await withBridge(async () => {
    assert.equal((await request("POST", "/message", { body: "{}" })).status, 403, "no origin");
    assert.equal((await post("{}", { origin: "https://evil.example" })).status, 403, "foreign origin");
    assert.equal((await post("{}", { host: `localhost:${PORT}` })).status, 403, "host name instead of address");
    const preflight = await request("OPTIONS", "/message", { headers: { origin: ORIGIN } });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(preflight.headers["access-control-allow-private-network"], "true");
    assert.equal((await request("GET", "/message", { headers: { origin: ORIGIN } })).status, 404);
    assert.equal((await request("POST", "/other", { headers: { origin: ORIGIN } })).status, 404);
  });
});

test("the bridge handles a message end to end and refuses broken ones", async () => {
  await putJob(1);
  await withBridge(async () => {
    const started = await post(JSON.stringify(ready()));
    assert.equal(started.status, 200);
    assert.equal(started.headers["cache-control"], "no-store");
    assert.equal(JSON.parse(started.text).type, "START_JOB");
    assert.equal((await read(1)).status, "running");

    const bad = await post("{ not json");
    assert.equal(bad.status, 400);
    assert.deepEqual(JSON.parse(bad.text), { ok: false, error: "Invalid JSON." });
  });
});

test("a message that fails inside returns a generic 500 and later messages still work", async t => {
  const errors = t.mock.method(console, "error", () => {});
  await putJob(1);
  await writeFile(store.jobFile(id(2)), "{ corrupt");
  await withBridge(async () => {
    const failed = await post(JSON.stringify(ready({ cliJobId: id(2) })));
    assert.equal(failed.status, 500);
    assert.deepEqual(JSON.parse(failed.text), { ok: false, error: "The CLI could not handle this message." });
    assert.doesNotMatch(failed.text, /JSON|corrupt/, "no internal detail leaks");
    assert.match(String(errors.mock.calls[0].arguments[0]), /Bridge message failed/);
    assert.equal(JSON.parse((await post(JSON.stringify(ready()))).text).type, "START_JOB");
  });
});

test("a request body over the size limit is dropped and changes nothing", async () => {
  await putJob(1);
  await withBridge(async () => {
    const huge = JSON.stringify({ type: "JOB_PROGRESS", jobId: id(1), state: { message: "x".repeat(1_200_000) } });
    const outcome = await post(huge).then(
      response => response.status,
      () => "reset"
    );
    assert.ok(outcome === 413 || outcome === "reset", `got ${outcome}`);
    assert.equal((await read(1)).status, "queued");
  });
});

test("the bridge refuses to start without a matching install, or when its port is taken", async () => {
  await assert.rejects(startBridgeServer(), /not configured/);
  await store.writeJsonAtomic(store.BRIDGE_CONFIG_FILE, { extensionOrigin: ORIGIN, port: PORT + 1 });
  await assert.rejects(startBridgeServer(), /not configured/, "a config for another port");
  await store.writeJsonAtomic(store.BRIDGE_CONFIG_FILE, { port: PORT });
  await assert.rejects(startBridgeServer(), /not configured/, "no extension origin");

  await store.writeJsonAtomic(store.BRIDGE_CONFIG_FILE, { extensionOrigin: ORIGIN, port: PORT });
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(PORT, "127.0.0.1", resolve));
  try {
    await assert.rejects(startBridgeServer(), new RegExp(`port ${PORT} is already in use`));
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
});

test("a retried job can be claimed again by the page of its new attempt, but not twice for one attempt", async () => {
  const claimed = new Set();
  await putJob(41, { openedAt: "2026-01-01T00:00:00.000Z" });
  const first = await handleBridgeMessage(ready({ tabId: 1 }), claimed);
  assert.equal(first.type, "START_JOB");
  // A second tab for the same opening only connects to the running job.
  await store.updateJob(id(41), job => {
    job.status = "queued";
  });
  assert.equal((await handleBridgeMessage(ready({ tabId: 2 }), claimed)).type, "JOB_CONNECTED");
  // The queue retries: the job is queued again and opened anew.
  await store.updateJob(id(41), job => {
    job.status = "queued";
    job.openedAt = "2026-01-01T00:05:00.000Z";
  });
  const retry = await handleBridgeMessage(ready({ tabId: 3 }), claimed);
  assert.equal(retry.type, "START_JOB");
  assert.equal(retry.tabId, 3);
});
