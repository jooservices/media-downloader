import assert from "node:assert/strict";
import test from "node:test";
import { createFakeIndexedDB, loadBackground, plain } from "../helpers/background.mjs";

const settle = () => new Promise(resolve => setImmediate(resolve));
const SIGNED_IN = { "x.com": ["auth_token"], "instagram.com": ["sessionid"], "facebook.com": ["c_user", "xs"] };

// A storage area defined inside the worker's scope, so the real factories can be driven directly.
const AREA = `
  globalThis.__area = {
    data: {},
    failSets: 0,
    get: async defaults => ({ ...defaults, ...JSON.parse(JSON.stringify(globalThis.__area.data)) }),
    set: async values => {
      if (globalThis.__area.failSets > 0) { globalThis.__area.failSets--; throw new Error("quota"); }
      Object.assign(globalThis.__area.data, JSON.parse(JSON.stringify(values)));
    }
  };
`;
const storeEnv = () => {
  const env = loadBackground();
  env.inContext(AREA);
  env.inContext(`
    globalThis.__ids = 0;
    globalThis.__clock = Date.parse("2026-01-01T00:00:00Z");
    globalThis.__store = createJobStore(__area, () => "job-" + (++__ids), () => (__clock += 1000));
  `);
  return env;
};
const run = (env, code) => env.inContext(code).then(plain);

test("added links become waiting jobs, newest first, with the queue's limit", async () => {
  const env = storeEnv();
  const result = await run(
    env,
    `__store.addUrls(["https://x.com/alice?s=20", "https://www.instagram.com/bob/"], { limit: 5 })`
  );
  assert.deepEqual(
    result.created.map(job => [job.jobId, job.platform, job.account, job.status, job.limit, job.source]),
    [
      ["job-1", "Twitter", "alice", "queued", 5, "extension"],
      ["job-2", "Instagram", "bob", "queued", 5, "extension"]
    ]
  );
  assert.equal(result.created[0].message, "Waiting to start.");
  const listed = await run(env, `__store.listJobs()`);
  assert.deepEqual(
    listed.map(job => job.account),
    ["bob", "alice"]
  );
  const defaultLimit = await run(env, `__store.addUrls(["https://x.com/carol"])`);
  assert.equal(defaultLimit.created[0].limit, null);
});

test("duplicates and unsupported links are skipped with a reason, the rest still added", async () => {
  const env = storeEnv();
  await run(env, `__store.addUrls(["https://x.com/alice"])`);
  const result = await run(
    env,
    `__store.addUrls(["https://x.com/Alice/", "  https://example.com/nope  ", "", 42, "https://x.com/dave", "https://x.com/dave"])`
  );
  assert.deepEqual(
    result.created.map(job => job.account),
    ["dave"]
  );
  assert.equal(result.skipped.length, 5);
  assert.equal(result.skipped[0].reason, "Already in the list.");
  assert.match(result.skipped[1].reason, /Automatic URL downloads support/);
  assert.equal(result.skipped.at(-1).reason, "Already in the list.");
});

test("a job can be changed in place or replaced; a missing job is reported as such", async () => {
  const env = storeEnv();
  await run(env, `__store.addUrls(["https://x.com/alice"])`);
  const changed = await run(env, `__store.updateJob("job-1", job => { job.message = "Hello"; })`);
  assert.equal(changed.message, "Hello");
  assert.equal(changed.updatedAt, "2026-01-01T00:00:02.000Z");
  const replaced = await run(env, `__store.updateJob("job-1", job => ({ ...job, message: "Replaced" }))`);
  assert.equal(replaced.message, "Replaced");
  assert.equal((await run(env, `__store.listJobs()`))[0].message, "Replaced");
  assert.equal(await run(env, `__store.updateJob("nope", () => { throw new Error("must not run"); })`), null);
  const awaited = await run(env, `__store.updateJob("job-1", async job => { job.message = "Later"; })`);
  assert.equal(awaited.message, "Later");
});

test("updates run one at a time, and a failed one does not block the next", async () => {
  const env = storeEnv();
  await run(env, `__store.addUrls(["https://x.com/alice"])`);
  const results = await env.inContext(`
    Promise.allSettled([
      __store.updateJob("job-1", job => { job.rounds = 1; }),
      __store.updateJob("job-1", () => { throw new Error("boom"); }),
      __store.updateJob("job-1", job => { job.rounds += 1; })
    ]).then(list => list.map(item => item.status))
  `);
  assert.deepEqual(plain(results), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal((await run(env, `__store.listJobs()`))[0].rounds, 2);
  env.inContext(`__area.failSets = 1`);
  await assert.rejects(env.inContext(`__store.updateJob("job-1", job => { job.rounds = 9; })`), /quota/);
  assert.equal((await run(env, `__store.updateJob("job-1", job => { job.rounds += 1; })`)).rounds, 3);
});

test("removing returns what it removed; an empty or null stored list reads as no jobs", async () => {
  const env = storeEnv();
  await run(env, `__store.addUrls(["https://x.com/alice", "https://x.com/bob"])`);
  const removed = await run(env, `__store.removeWhere(job => job.account === "alice")`);
  assert.deepEqual(
    removed.map(job => job.account),
    ["alice"]
  );
  assert.equal((await run(env, `__store.listJobs()`)).length, 1);
  assert.deepEqual(await run(env, `__store.removeWhere(() => false)`), []);

  env.inContext(`__area.data.queueJobs = null`);
  assert.deepEqual(await run(env, `__store.listJobs()`), []);
});

test("the default store makes real ids and uses the clock", async () => {
  const env = loadBackground();
  env.inContext(AREA);
  const result = await run(env, `createJobStore(__area).addUrls(["https://x.com/alice"])`);
  assert.match(result.created[0].jobId, /^[0-9a-f-]{36}$/);
  assert.ok(Date.parse(result.created[0].createdAt) > 0);
});

test("sign-in is judged from cookie names only; an unreadable cookie jar counts as signed out", async () => {
  const env = loadBackground({ cookies: { "x.com": ["auth_token"], "instagram.com": ["unrelated"] } });
  const status = await run(env, `createLoginChecker(chrome.cookies).status()`);
  assert.deepEqual(Object.fromEntries(Object.entries(status).map(([site, info]) => [site, info.signedIn])), {
    Instagram: false,
    Facebook: false,
    Twitter: true,
    TikTok: false
  });
  assert.equal(status.Twitter.label, "X");
  assert.match(status.Twitter.signInUrl, /^https:\/\/x\.com\//);

  const signedOut = await run(env, `createLoginChecker(chrome.cookies).signedOutSites()`);
  assert.deepEqual(signedOut.sort(), ["Facebook", "Instagram", "TikTok"]);

  const broken = await run(
    env,
    `createLoginChecker({ getAll: async () => { throw new Error("no cookies permission"); } }).signedOutSites()`
  );
  assert.equal(broken.length, 4);
});

test("queue settings default, round-trip, and reject a bad value with the validator's message", async () => {
  const env = loadBackground();
  env.inContext(AREA);
  env.inContext(`globalThis.__settings = createQueueSettings(__area)`);
  const defaults = await run(env, `__settings.load()`);
  assert.equal(defaults.maxAttempts, 3);
  assert.equal(defaults.limit, null);

  const saved = await run(env, `__settings.save({ ...(${JSON.stringify(defaults)}), maxAttempts: 5, limit: 12 })`);
  assert.deepEqual([saved.maxAttempts, saved.limit], [5, 12]);
  assert.deepEqual([(await run(env, `__settings.load()`)).maxAttempts], [5]);

  await assert.rejects(env.inContext(`__settings.save({ maxAttempts: 0 })`), /./);
  assert.equal((await run(env, `__settings.load()`)).maxAttempts, 5, "a refused save changes nothing");

  assert.equal(await env.inContext(`__settings.isPaused()`), false);
  await env.inContext(`__settings.setPaused(1)`);
  assert.equal(await env.inContext(`__settings.isPaused()`), true);
  assert.equal(env.inContext(`__area.data.queuePaused`), true);
  await env.inContext(`__settings.setPaused(false)`);
  assert.equal(await env.inContext(`__settings.isPaused()`), false);
});

test("the dashboard's messages drive the queue and answer { ok, ... } or { ok: false, error }", async () => {
  const env = loadBackground({ cookies: SIGNED_IN });
  const ask = message => env.send(message).then(plain);

  const added = await ask({ type: "QUEUE_ADD", urls: ["https://x.com/alice"] });
  assert.equal(added.ok, true);
  assert.equal(added.created.length, 1);
  assert.deepEqual((await ask({ type: "QUEUE_ADD", urls: "not a list" })).created, [], "a non-list is an empty list");
  assert.deepEqual(await ask({ type: "QUEUE_ADD" }), { ok: true, created: [], skipped: [] });

  const state = await ask({ type: "QUEUE_STATE" });
  assert.deepEqual([state.ok, state.paused, state.jobs.length], [true, false, 1]);
  assert.equal(state.login.Twitter.signedIn, true);
  assert.equal(state.settings.maxAttempts, 3);

  assert.deepEqual(await ask({ type: "QUEUE_PAUSE", paused: true }), { ok: true });
  assert.equal((await ask({ type: "QUEUE_STATE" })).paused, true);

  const saved = await ask({ type: "QUEUE_SETTINGS_SAVE", settings: { ...state.settings, maxAttempts: 4 } });
  assert.equal(saved.settings.maxAttempts, 4);
  const refused = await ask({ type: "QUEUE_SETTINGS_SAVE", settings: { maxAttempts: 0 } });
  assert.equal(refused.ok, false);
  assert.equal(typeof refused.error, "string");

  assert.deepEqual(await ask({ type: "QUEUE_ACTION", action: "clear-finished" }), { ok: true });
  assert.deepEqual(await ask({ type: "QUEUE_ACTION", action: "explode" }), {
    ok: false,
    error: "Unknown action: explode"
  });
  assert.deepEqual(await ask({ type: "QUEUE_SIGNED_IN" }), { ok: true });
});

test("a failure that is not an Error is still reported as text", async () => {
  const env = loadBackground();
  env.inContext(`queueEngine.snapshot = () => Promise.reject("plain failure")`);
  assert.deepEqual(plain(await env.send({ type: "QUEUE_STATE" })), { ok: false, error: "plain failure" });
});

test("the queue ticks on its alarm and ignores other alarms", async () => {
  const env = loadBackground({ cookies: SIGNED_IN });
  assert.deepEqual(plain(env.alarms), [{ name: "pms-queue", info: { periodInMinutes: 0.5 } }]);
  await env.send({ type: "QUEUE_ADD", urls: ["https://x.com/alice"] });
  await settle();
  env.tabsCreated.length = 0;
  env.inContext(`
    globalThis.__ticks = 0;
    queueEngine.tick = () => { __ticks++; return Promise.reject(new Error("tick failed")); };
  `);
  env.listeners.alarm[0]({ name: "something-else" });
  assert.equal(env.inContext("__ticks"), 0);
  env.listeners.alarm[0]({ name: "pms-queue" });
  await settle();
  assert.equal(env.inContext("__ticks"), 1);
});

test("the queue opens its page in a background tab through the real tab API", async () => {
  const env = loadBackground({ cookies: SIGNED_IN });
  await env.send({ type: "QUEUE_ADD", urls: ["https://x.com/alice"] });
  await env.inContext("queueEngine.tick()");
  assert.equal(env.tabsCreated.length, 1);
  await env.send({
    type: "QUEUE_ACTION",
    action: "remove",
    jobId: (await env.send({ type: "QUEUE_STATE" })).jobs[0].jobId
  });
  assert.deepEqual(env.tabRemoves, [100], "removing a running job closes its tab");
  const random = await env.inContext("(0).constructor === Number");
  assert.equal(random, true);
});

test("after the browser restarts the queue recovers what was running and ticks; failures are swallowed", async () => {
  const env = loadBackground({ cookies: SIGNED_IN });
  env.inContext(`
    globalThis.__calls = [];
    queueEngine.recover = async () => { __calls.push("recover"); };
    queueEngine.tick = async () => { __calls.push("tick"); };
  `);
  env.listeners.startup[0]();
  await settle();
  assert.deepEqual(plain(env.inContext("__calls")), ["recover", "tick"]);

  env.inContext(`queueEngine.recover = () => Promise.reject(new Error("no storage"))`);
  env.listeners.startup[0]();
  await settle();
  assert.deepEqual(plain(env.inContext("__calls")), ["recover", "tick"], "no tick after a failed recovery");
});

test("a first install opens the dashboard; updates do not; a refusal is swallowed", async () => {
  const env = loadBackground();
  env.listeners.installed[0]({ reason: "update" });
  await settle();
  assert.equal(env.optionsOpened.count, 0);
  env.listeners.installed[0]({ reason: "install" });
  await settle();
  assert.equal(env.optionsOpened.count, 1);
  env.inContext(`chrome.runtime.openOptionsPage = () => Promise.reject(new Error("no ui"))`);
  env.listeners.installed[0]({ reason: "install" });
  await settle();
});

test("tab navigation and closing are passed to the queue; failures are swallowed", async () => {
  const env = loadBackground();
  env.inContext(`
    globalThis.__seen = [];
    queueEngine.tabNavigated = async (id, url) => { __seen.push(["nav", id, url]); throw new Error("x"); };
    queueEngine.tabClosed = async id => { __seen.push(["closed", id]); throw new Error("y"); };
  `);
  env.listeners.tabUpdated[0](5, { status: "loading" });
  env.listeners.tabUpdated[0](5, { url: "https://x.com/alice/" });
  env.listeners.tabRemoved[0](5);
  await settle();
  assert.deepEqual(plain(env.inContext("__seen")), [
    ["nav", 5, "https://x.com/alice/"],
    ["closed", 5]
  ]);
});

test("the ledger remembers keys, finds old-form keys, and imports the legacy list once", async () => {
  const indexedDB = createFakeIndexedDB();
  const env = loadBackground({
    indexedDB,
    storage: { downloadedKeys: ["Twitter:alice:img:abc", "Twitter|image|9|1"] }
  });
  assert.equal(await env.ledger.count(), 2);
  assert.equal(await env.ledger.has("Twitter:alice:img:abc"), true);
  assert.equal(env.storage.downloadedKeys, undefined, "the old list is removed after the import");
  assert.equal(env.storage.ledgerImported, true);
  assert.equal(await env.ledger.has("never-saved"), false);
  await env.ledger.add("Twitter|image|new|1");
  await env.ledger.add("Twitter|image|new|1");
  assert.equal(await env.ledger.count(), 3);

  const restarted = loadBackground({ indexedDB, storage: { ...env.storage, downloadedKeys: ["stale|key"] } });
  assert.equal(await restarted.ledger.has("stale|key"), false, "an import already done is not repeated");
  assert.equal(await restarted.ledger.count(), 3, "and the data survives a restart");
});

test("an empty legacy list is simply marked as imported", async () => {
  const env = loadBackground();
  assert.equal(await env.ledger.count(), 0);
  assert.equal(env.storage.ledgerImported, true);
});

// An IndexedDB whose requests or transactions fail on demand.
function brokenIndexedDB({ failOpen = false, failRequest = false, failTransaction = null } = {}) {
  const request = work => {
    const req = {};
    setImmediate(() => {
      if (failRequest) {
        req.error = new Error("request failed");
        req.onerror?.({ target: req });
      } else {
        req.result = work();
        req.onsuccess?.({ target: req });
      }
    });
    return req;
  };
  const db = {
    createObjectStore() {},
    transaction() {
      const transaction = {
        objectStore: () => ({
          get: () => request(() => undefined),
          put: () => request(() => undefined),
          count: () => request(() => 0)
        })
      };
      if (failTransaction) {
        setImmediate(() => {
          transaction.error = new Error(`transaction ${failTransaction}`);
          transaction[failTransaction === "abort" ? "onabort" : "onerror"]?.({ target: transaction });
        });
      } else {
        setImmediate(() => setImmediate(() => transaction.oncomplete?.({ target: transaction })));
      }
      return transaction;
    }
  };
  return {
    open() {
      const opening = {};
      setImmediate(() => {
        if (failOpen) {
          opening.error = new Error("open failed");
          opening.onerror?.({ target: opening });
        } else {
          opening.result = db;
          opening.onupgradeneeded?.({ target: opening });
          opening.onsuccess?.({ target: opening });
        }
      });
      return opening;
    }
  };
}

test("ledger failures surface as rejections instead of hanging", async () => {
  const opening = loadBackground({ indexedDB: brokenIndexedDB({ failOpen: true }) });
  await assert.rejects(opening.ledger.count(), /open failed/);

  const reading = loadBackground({ indexedDB: brokenIndexedDB({ failRequest: true }) });
  await assert.rejects(reading.ledger.has("k"), /request failed/);

  const errored = loadBackground({ indexedDB: brokenIndexedDB({ failTransaction: "error" }) });
  await assert.rejects(errored.ledger.add("k"), /transaction error/);

  const aborted = loadBackground({ indexedDB: brokenIndexedDB({ failTransaction: "abort" }) });
  await assert.rejects(aborted.ledger.add("k"), /transaction abort/);
});

test("the worker's serial queues keep running after one operation fails", async () => {
  const env = loadBackground();
  const outcome = await env.inContext(`
    (async () => {
      const order = [];
      const first = queueBatch(async () => { order.push(1); throw new Error("fail"); }).catch(() => order.push("caught"));
      const second = queueBatch(async () => { order.push(2); return "ok"; });
      const third = queueFilenameOperation(async () => { throw new Error("fail"); }).catch(() => order.push("caught2"));
      const fourth = queueFilenameOperation(async () => "ok2");
      await Promise.all([first, third]);
      return [order, await second, await fourth];
    })()
  `);
  assert.deepEqual(
    plain(outcome[0]).filter(item => typeof item === "number"),
    [1, 2],
    "batches stay in order"
  );
  assert.deepEqual(plain(outcome).slice(1), ["ok", "ok2"]);
  const started = Date.now();
  await env.inContext("pause(20)");
  assert.ok(Date.now() - started >= 15);
});

test("a first install does not open the dashboard over a page the CLI opened for a job", async () => {
  const marker = "#pms=11111111-1111-4111-8111-111111111111";
  const env = loadBackground();
  env.inContext(`chrome.tabs.query = async () => [{ url: "https://x.com/a/${marker}" }]`);
  env.listeners.installed[0]({ reason: "install" });
  await settle();
  assert.equal(env.optionsOpened.count, 0);

  env.inContext(
    `chrome.tabs.query = async () => [{ url: "https://x.com/a/" }, { url: undefined }, { url: "not a url" }]`
  );
  env.listeners.installed[0]({ reason: "install" });
  await settle();
  assert.equal(env.optionsOpened.count, 1, "ordinary tabs do not stop the dashboard");

  env.inContext("chrome.tabs.query = async () => { throw new Error('no tabs'); }");
  env.listeners.installed[0]({ reason: "install" });
  await settle();
  assert.equal(env.optionsOpened.count, 2, "if the tabs cannot be read the dashboard still opens");
});
