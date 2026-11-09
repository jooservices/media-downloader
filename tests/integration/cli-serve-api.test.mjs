import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

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

// Never the live queue's folder or ports: a temp folder and free ports, set before the CLI is imported.
const home = await mkdtemp(path.join(os.tmpdir(), "pms-serve-api-"));
const API_PORT = await freePort();
process.env.LOCALAPPDATA = home;
process.env.PMS_BRIDGE_PORT = String(await freePort());
process.env.PMS_API_PORT = String(API_PORT);
const store = await import("../../cli/store.mjs");
const { serve } = await import("../../cli/serve.mjs");

const ALICE = "https://www.instagram.com/alice/";
const BOB = "https://x.com/Bob/";
const FINISHED = "00000000-0000-4000-8000-000000000077";
const RUNNING = "00000000-0000-4000-8000-000000000078";
const LIMITED = "00000000-0000-4000-8000-000000000079";

after(() => {
  store.closeJobStore();
  return rm(home, { recursive: true, force: true });
});

function interrupter() {
  const before = new Set(process.listeners("SIGINT"));
  return async () => {
    for (;;) {
      const added = process.listeners("SIGINT").find(listener => !before.has(listener));
      if (added) {
        return added;
      }
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

// A bridge that is "installed" for a browser that does not exist, so no window can ever open.
async function prepareHome() {
  const extension = path.join(home, "profile", "Default");
  await mkdir(extension, { recursive: true });
  await store.writeJsonAtomic(store.BRIDGE_CONFIG_FILE, {
    extensionOrigin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
    port: store.BRIDGE_PORT
  });
  await store.writeJsonAtomic(store.EDGE_PROFILE_FILE, {
    browser: "chrome",
    profileDirectory: "Default",
    userData: path.join(home, "profile"),
    executable: path.join(home, "no-such-browser")
  });
}

test("the running serve answers the REST API: create, read, watch and cancel", async t => {
  await prepareHome();
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  t.after(() => {
    process.stdout.write = originalWrite;
  });
  const nextHandler = interrupter();
  const done = serve({ inbox: path.join(home, "inbox.txt") });
  const stop = await nextHandler();
  const token = (await readFile(store.API_TOKEN_FILE, "utf8")).trim();
  const call = (method, pathname, body) =>
    fetch(`http://127.0.0.1:${API_PORT}${pathname}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
  try {
    const created = await call("POST", "/v1/jobs", { url: ALICE });
    assert.equal(created.status, 201);
    const [job] = (await created.json()).items;
    assert.equal(created.headers.get("location"), `/v1/jobs/${job.id}`);
    assert.equal((await call("POST", "/v1/jobs", { url: ALICE })).status, 409);

    // A job that is running right now (the queue never touches it) is cancelled, not erased.
    await store.writeJob({
      jobId: RUNNING,
      url: BOB,
      platform: "Twitter",
      account: "bob2",
      status: "running",
      createdAt: new Date().toISOString(),
      // Recent activity, so the queue does not take it for a job that was left behind and end it itself.
      updatedAt: new Date().toISOString(),
      openedAt: new Date().toISOString()
    });
    const cancelled = await call("DELETE", `/v1/jobs/${RUNNING}`);
    assert.equal(cancelled.status, 204);
    const kept = await store.readJob(RUNNING);
    assert.equal(kept.noRetry, true, "an active job is cancelled, not erased");
    assert.equal(kept.status, "paused");

    await store.writeJob({
      jobId: FINISHED,
      url: BOB,
      platform: "Twitter",
      account: "bob",
      status: "complete",
      createdAt: new Date().toISOString()
    });
    assert.equal((await call("DELETE", `/v1/jobs/${FINISHED}`)).status, 204);
    assert.equal(await store.readJob(FINISHED), null, "a finished job is removed");
    assert.equal((await call("DELETE", `/v1/jobs/${FINISHED}`)).status, 404);

    const status = await (await call("GET", "/v1/status")).json();
    assert.equal(status.pid, process.pid);
    assert.equal(typeof status.jobs, "object");
    assert.equal(status.platforms.twitter.configuredWorkers, 1);
    assert.ok(status.jobs.paused >= 1, "the cancelled job is counted");
    assert.ok((await (await call("GET", "/v1/metrics")).text()).includes('pms_jobs{status="paused"}'));

    const watching = await call("POST", "/v1/watches", { url: ALICE });
    assert.equal(watching.status, 201);
    assert.equal(watching.headers.get("location"), "/v1/watches/instagram/alice");
    assert.equal((await (await call("GET", "/v1/watches")).json()).items.length, 1);
    assert.equal((await call("DELETE", "/v1/watches/instagram/alice")).status, 204);
    assert.equal((await (await call("GET", "/v1/watches")).json()).items.length, 0);
  } finally {
    stop();
    await done;
  }
});

test("serve preserves platform back-off across process recreation", async t => {
  await store.removeAppData();
  await prepareHome();
  await store.writeJsonAtomic(store.CONFIG_FILE, { workers: { instagram: 3 } });
  await store.writeJob({
    jobId: LIMITED,
    url: ALICE,
    platform: "Instagram",
    account: "alice",
    status: "error",
    attempts: 1,
    message: "HTTP 429 Too Many Requests",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  });
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  t.after(() => {
    process.stdout.write = originalWrite;
  });
  const start = async () => {
    const nextHandler = interrupter();
    const done = serve({ inbox: path.join(home, "inbox.txt") });
    const stop = await nextHandler();
    const token = (await readFile(store.API_TOKEN_FILE, "utf8")).trim();
    const status = async () => {
      const response = await fetch(`http://127.0.0.1:${API_PORT}/v1/status`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      return response.json();
    };
    return { done, stop, status };
  };

  const first = await start();
  try {
    let initial;
    for (let attempt = 0; attempt < 20; attempt++) {
      initial = await first.status();
      if (initial.platforms?.instagram?.backoffUntil) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(initial.platforms.instagram.backoffLevel, 1);
    assert.equal(initial.platforms.instagram.effectiveWorkers, 1);
  } finally {
    first.stop();
    await first.done;
  }

  const second = await start();
  try {
    let restored;
    for (let attempt = 0; attempt < 20; attempt++) {
      restored = await second.status();
      if (restored.platforms?.instagram?.backoffLevel) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(restored.platforms.instagram.backoffLevel, 1);
    assert.equal(restored.platforms.instagram.effectiveWorkers, 1);
    assert.ok(Date.parse(restored.platforms.instagram.backoffUntil) > Date.now());
  } finally {
    second.stop();
    await second.done;
  }
});
