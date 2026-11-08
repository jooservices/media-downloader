import assert from "node:assert/strict";
import test from "node:test";
import { loadBackground, plain } from "../helpers/background.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));
const PAGE = { type: "CLI_PAGE_READY", pageUrl: "https://x.com/alice/", platform: "Twitter", account: "alice" };
const JOB = { jobId: "job-1", url: "https://x.com/alice/", repairBasenames: ["a.jpg"] };

// A bridge that answers each POST from a script (a function of the posted message), recording them all.
function bridge(answer = () => ({ ok: true })) {
  const posted = [];
  const fetchImpl = async (_url, init) => {
    const message = JSON.parse(init.body);
    posted.push(message);
    const reply = await answer(message);
    if (reply instanceof Error) {
      throw reply;
    }
    return {
      ok: reply.httpOk ?? true,
      status: reply.status ?? 200,
      json: reply.badJson
        ? async () => {
            throw new Error("not json");
          }
        : async () => reply.body ?? reply
    };
  };
  return { posted, fetchImpl, types: () => posted.map(message => message.type) };
}

// The tab the CLI named is on `url`, and the page answers the start message with `pageReply`.
function withTab(env, { url = "https://x.com/alice/", pageReply = { ok: true, state: { running: true } } } = {}) {
  env.inContext(`chrome.tabs.get = async id => ({ id, url: ${JSON.stringify(url)} })`);
  env.inContext(
    `chrome.tabs.sendMessage = async (id, message) => { globalThis.__sent = [...(globalThis.__sent || []), { id, message }]; return ${JSON.stringify(pageReply)}; }`
  );
  return () => plain(env.inContext("globalThis.__sent || []"));
}

const sender = { tab: { id: 7, url: "https://x.com/alice/" } };

test("the bridge state follows what the CLI answered: connected, offline, or an error with its text", async () => {
  const cases = [
    { reply: { ok: true }, state: "connected", message: /Connected to the local CLI bridge/ },
    { reply: new Error("Failed to fetch"), state: "idle", message: /offline/ },
    { reply: new Error("connect ECONNREFUSED"), state: "idle", message: /offline/ },
    { reply: { httpOk: false, status: 500, body: {} }, state: "error", message: /HTTP 500/ },
    { reply: { httpOk: false, status: 400, body: { error: "bad job" } }, state: "error", message: /bad job/ },
    { reply: { ok: false, error: "bad request" }, state: "error", message: /bad request/ },
    { reply: { httpOk: false, status: 502, badJson: true }, state: "error", message: /HTTP 502/ },
    { reply: "plain failure", state: "error", message: /plain failure/ }
  ];
  for (const { reply, state, message } of cases) {
    const { fetchImpl } = bridge(() => (typeof reply === "string" ? Promise.reject(reply) : reply));
    const env = loadBackground({ fetchImpl });
    await env.send({ ...PAGE }, sender);
    await settle();
    assert.equal(env.storage.nativeBridgeState.state, state, JSON.stringify(reply));
    assert.match(env.storage.nativeBridgeState.message, message);
  }
});

test("a page announcing itself to an unidentified tab is refused", async () => {
  const { fetchImpl, posted } = bridge();
  const env = loadBackground({ fetchImpl });
  assert.deepEqual(plain(await env.send({ ...PAGE }, {})), {
    ok: false,
    error: "The page tab could not be identified."
  });
  assert.deepEqual(plain(await env.send({ ...PAGE }, { tab: { url: "https://x.com/" } })).ok, false);
  assert.equal(posted.length, 0);
});

test("a page the CLI does not know waits; the page's details are forwarded as they are", async () => {
  const { fetchImpl, posted } = bridge(() => ({ ok: true, type: "NO_JOB" }));
  const env = loadBackground({ fetchImpl });
  const reply = await env.send({ ...PAGE, cliJobId: "cli-9" }, sender);
  assert.deepEqual(plain(reply), { ok: true, waiting: true });
  assert.deepEqual(plain(posted[0]), {
    type: "PAGE_READY",
    tabId: 7,
    pageUrl: "https://x.com/alice/",
    platform: "Twitter",
    account: "alice",
    cliJobId: "cli-9"
  });
  assert.match(env.storage.nativeBridgeState.message, /no active job/);

  const noUrl = bridge(() => ({ ok: true }));
  const second = loadBackground({ fetchImpl: noUrl.fetchImpl });
  await second.send({ type: "CLI_PAGE_READY", platform: "Twitter", account: "a" }, sender);
  assert.equal(noUrl.posted[0].pageUrl, "https://x.com/alice/", "falls back to the tab's own URL");
  assert.equal(noUrl.posted[0].cliJobId, null);
});

test("a connected job answer is noted and the page keeps waiting for its start", async () => {
  const { fetchImpl } = bridge(() => ({ ok: true, type: "JOB_CONNECTED" }));
  const env = loadBackground({ fetchImpl });
  assert.deepEqual(plain(await env.send({ ...PAGE }, sender)), { ok: true, waiting: true });
  assert.match(env.storage.nativeBridgeState.message, /Connected to the running CLI job/);
});

test("a close answer closes the finished tab", async () => {
  const { fetchImpl } = bridge(() => ({ ok: true, close: true }));
  const env = loadBackground({ fetchImpl });
  assert.deepEqual(plain(await env.send({ ...PAGE }, sender)), { ok: true, waiting: false });
  assert.deepEqual(env.tabRemoves, [7]);
});

test("a start answer scans the page the CLI chose, remembers the tab's job, and passes repair targets", async () => {
  const { fetchImpl, posted } = bridge(() => ({ ok: true, type: "START_JOB", job: JOB, tabId: 7 }));
  const env = loadBackground({ fetchImpl });
  const sent = withTab(env);
  assert.deepEqual(plain(await env.send({ ...PAGE }, sender)), { ok: true, waiting: false });
  assert.equal(posted.length, 1, "nothing is reported as an error");
  assert.deepEqual(sent(), [
    {
      id: 7,
      message: { type: "AUTO_START_CLI", job: { ...JOB, repairTargets: ["a.jpg"] } }
    }
  ]);
  assert.deepEqual(plain(env.storage.activeCliJobs), { 7: "job-1" });
});

test("a job with no repair list still starts, and a scan that is not running is not remembered", async () => {
  const { fetchImpl } = bridge(() => ({
    ok: true,
    type: "START_JOB",
    job: { jobId: "job-2", url: "https://x.com/alice/" },
    tabId: 7
  }));
  const env = loadBackground({ fetchImpl });
  const sent = withTab(env, { pageReply: { ok: true, state: { running: false } } });
  await env.send({ ...PAGE }, sender);
  assert.deepEqual(sent()[0].message.job.repairTargets, []);
  assert.equal(env.storage.activeCliJobs, undefined);
});

test("a start answer is reported as a job error when the tab moved on, the page refuses, or messaging fails", async () => {
  const start = () => ({ ok: true, type: "START_JOB", job: JOB, tabId: 7 });

  const moved = bridge(request => (request.type === "PAGE_READY" ? start() : { ok: true }));
  const movedEnv = loadBackground({ fetchImpl: moved.fetchImpl });
  withTab(movedEnv, { url: "https://x.com/someone-else/" });
  await movedEnv.send({ ...PAGE }, sender);
  assert.deepEqual(
    moved.posted.filter(message => message.type === "JOB_ERROR").map(message => message.error),
    ["The tab URL changed before the download started."]
  );

  const refused = bridge(request => (request.type === "PAGE_READY" ? start() : { ok: true }));
  const refusedEnv = loadBackground({ fetchImpl: refused.fetchImpl });
  withTab(refusedEnv, { pageReply: { ok: false, error: "Not a profile" } });
  await refusedEnv.send({ ...PAGE }, sender);
  assert.equal(refused.posted.find(message => message.type === "JOB_ERROR").error, "Not a profile");

  const silent = bridge(request => (request.type === "PAGE_READY" ? start() : { ok: true }));
  const silentEnv = loadBackground({ fetchImpl: silent.fetchImpl });
  withTab(silentEnv, { pageReply: null });
  await silentEnv.send({ ...PAGE }, sender);
  assert.equal(
    silent.posted.find(message => message.type === "JOB_ERROR").error,
    "The page could not start the automatic scan."
  );

  const thrown = bridge(request => (request.type === "PAGE_READY" ? start() : { ok: true }));
  const thrownEnv = loadBackground({ fetchImpl: thrown.fetchImpl });
  thrownEnv.inContext(`chrome.tabs.get = async () => { throw new Error("No tab with id 7"); }`);
  await thrownEnv.send({ ...PAGE }, sender);
  assert.equal(thrown.posted.find(message => message.type === "JOB_ERROR").error, "No tab with id 7");

  const stringThrown = bridge(request => (request.type === "PAGE_READY" ? start() : { ok: true }));
  const stringEnv = loadBackground({ fetchImpl: stringThrown.fetchImpl });
  stringEnv.inContext(`chrome.tabs.get = () => Promise.reject("gone")`);
  await stringEnv.send({ ...PAGE }, sender);
  assert.equal(stringThrown.posted.find(message => message.type === "JOB_ERROR").error, "gone");
});

test("a failing error report is swallowed rather than crashing the page-ready reply", async () => {
  const { fetchImpl } = bridge(request =>
    request.type === "PAGE_READY" ? { ok: true, type: "START_JOB", job: JOB, tabId: 7 } : new Error("Failed to fetch")
  );
  const env = loadBackground({ fetchImpl });
  withTab(env, { url: "https://x.com/other/" });
  assert.deepEqual(plain(await env.send({ ...PAGE }, sender)), { ok: true, waiting: false });
});

test("start answers missing a job or a numeric tab are ignored", async () => {
  for (const answer of [
    { type: "START_JOB", tabId: 7 },
    { type: "START_JOB", job: JOB, tabId: "7" },
    { type: "START_JOB", job: JOB },
    { type: "SURPRISE" }
  ]) {
    const { fetchImpl, posted } = bridge(() => ({ ok: true, ...answer }));
    const env = loadBackground({ fetchImpl });
    const sent = withTab(env);
    const reply = plain(await env.send({ ...PAGE }, sender));
    assert.equal(reply.ok, true);
    assert.equal(sent().length, 0);
    assert.equal(posted.length, 1);
  }
});

test("when the bridge is down the page-ready reply carries the failure", async () => {
  const { fetchImpl } = bridge(() => new Error("Failed to fetch"));
  const env = loadBackground({ fetchImpl });
  assert.deepEqual(plain(await env.send({ ...PAGE }, sender)), { ok: false, error: "Failed to fetch" });
  const strange = bridge(() => Promise.reject(undefined));
  const other = loadBackground({ fetchImpl: strange.fetchImpl });
  assert.equal(plain(await other.send({ ...PAGE }, sender)).ok, false);
});

test("progress is forwarded to the CLI, and a message without a job id relays nothing", async () => {
  const { fetchImpl, posted } = bridge();
  const env = loadBackground({ fetchImpl });
  const state = { jobId: "job-1", status: "running" };
  assert.deepEqual(plain(await env.send({ type: "AUTO_PROGRESS", state }, sender)), { ok: true });
  assert.deepEqual(plain(posted[0]), { type: "JOB_PROGRESS", jobId: "job-1", state });

  assert.equal(await env.send({ type: "AUTO_PROGRESS", state: {} }, sender), null, "no job id: nothing to relay");
  assert.equal(
    env.listeners.message[0]({ type: "UNKNOWN" }, sender, () => {}),
    false
  );
  assert.equal(
    env.listeners.message[0](undefined, sender, () => {}),
    false
  );
  assert.equal(posted.length, 1);
});

test("a bridge that stays gone for 45 seconds stops the scan on the next progress, and a reply resets the clock", async () => {
  let clock = 1_000_000;
  let down = true;
  const { fetchImpl } = bridge(() => (down ? new Error("Failed to fetch") : { ok: true }));
  const env = loadBackground({ fetchImpl, now: () => clock });
  const progress = { type: "AUTO_PROGRESS", state: { jobId: "job-1" } };

  assert.equal(plain(await env.send(progress, sender)).ok, false);
  assert.equal(env.tabMessages.length, 0, "not yet");
  clock += 44_000;
  await env.send(progress, sender);
  assert.equal(env.tabMessages.length, 0, "still within the grace period");
  clock += 2_000;
  await env.send(progress, sender);
  assert.deepEqual(plain(env.tabMessages), [{ id: 7, message: { type: "AUTO_STOP" } }]);

  down = false;
  assert.equal(plain(await env.send(progress, sender)).ok, true);
  down = true;
  clock += 100_000;
  await env.send(progress, sender);
  assert.equal(env.tabMessages.length, 1, "the clock restarted after the bridge answered");
});

test("losing the bridge never stops a scan for a done message or an unidentified tab", async () => {
  let clock = 5_000_000;
  const { fetchImpl } = bridge(() => new Error("Failed to fetch"));
  const env = loadBackground({ fetchImpl, now: () => clock });
  await env.send({ type: "AUTO_PROGRESS", state: { jobId: "j" } }, sender);
  clock += 60_000;
  await env.send({ type: "AUTO_DONE", state: { jobId: "j" } }, sender);
  await env.send({ type: "AUTO_PROGRESS", state: { jobId: "j" } }, {});
  await env.send({ type: "AUTO_PROGRESS", state: { jobId: "j" } });
  assert.equal(env.tabMessages.length, 0);
});

test("a stop request the page cannot receive is ignored", async () => {
  let clock = 9_000_000;
  const { fetchImpl } = bridge(() => new Error("Failed to fetch"));
  const env = loadBackground({ fetchImpl, now: () => clock });
  env.inContext(`chrome.tabs.sendMessage = async () => { throw new Error("no receiver"); }`);
  await env.send({ type: "AUTO_PROGRESS", state: { jobId: "j" } }, sender);
  clock += 60_000;
  assert.equal(plain(await env.send({ type: "AUTO_PROGRESS", state: { jobId: "j" } }, sender)).ok, false);
});

test("a finished job is reported, its tab forgotten and closed; an unidentified tab just reports", async () => {
  const { fetchImpl, posted } = bridge();
  const env = loadBackground({ fetchImpl, storage: { activeCliJobs: { 7: "job-1" } } });
  await env.send({ type: "AUTO_DONE", state: { jobId: "job-1" } }, sender);
  assert.equal(posted[0].type, "JOB_DONE");
  assert.deepEqual(plain(env.storage.activeCliJobs), {});
  assert.deepEqual(env.tabRemoves, [7]);

  await env.send({ type: "AUTO_DONE", state: { jobId: "job-2" } });
  assert.equal(posted[1].type, "JOB_DONE");
  assert.deepEqual(env.tabRemoves, [7], "no tab to close");
});

test("closing a finished tab copes with a browser without tabs.remove or one that rejects", async () => {
  const { fetchImpl } = bridge(() => ({ ok: true, close: true }));
  const env = loadBackground({ fetchImpl });
  env.inContext("chrome.tabs.remove = undefined");
  assert.equal(plain(await env.send({ ...PAGE }, sender)).ok, true);
  env.inContext(`chrome.tabs.remove = async () => { throw new Error("already closed"); }`);
  assert.equal(plain(await env.send({ ...PAGE }, sender)).ok, true);
});

test("the remembered jobs map is read defensively and tabs without ids have no job", async () => {
  const env = loadBackground({ storage: { activeCliJobs: "garbage" } });
  assert.deepEqual(plain(await env.inContext("readCliJobs()")), {});
  const env2 = loadBackground({ storage: { activeCliJobs: null } });
  assert.deepEqual(plain(await env2.inContext("readCliJobs()")), {});
  assert.equal(await env.inContext("takeCliJob(undefined)"), null);
  assert.equal(await env.inContext("takeCliJob('7')"), null);
  assert.equal(await env.inContext("takeCliJob(3)"), null, "a tab that never ran a job");
});

test("a tab closed while storage is unreadable does not throw", async () => {
  const { fetchImpl, posted } = bridge();
  const env = loadBackground({ fetchImpl, storage: { activeCliJobs: { 7: "job-1" } } });
  env.inContext(`chrome.storage.local.get = async () => { throw new Error("storage unavailable"); }`);
  await Promise.all(env.listeners.tabRemoved.map(listener => listener(7)));
  assert.equal(posted.length, 0);
});

test("a tab closed mid-scan fails its job with advice to resume, even when the bridge is gone", async () => {
  const { fetchImpl, posted } = bridge(() => new Error("Failed to fetch"));
  const env = loadBackground({ fetchImpl, storage: { activeCliJobs: { 7: "job-1" } } });
  await Promise.all(env.listeners.tabRemoved.map(listener => listener(7)));
  await settle();
  assert.equal(posted[0].type, "JOB_ERROR");
  assert.match(posted[0].error, /use the CLI resume command/i);
});

test("the bridge state is still tracked when saving it fails", async () => {
  const { fetchImpl } = bridge();
  const env = loadBackground({ fetchImpl });
  env.inContext(`chrome.storage.local.set = async () => { throw new Error("quota"); }`);
  assert.equal(plain(await env.send({ ...PAGE }, sender)).ok, true);
  assert.equal(env.inContext("nativeBridgeState.state"), "connected");
});
