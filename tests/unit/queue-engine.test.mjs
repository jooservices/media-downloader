import assert from "node:assert/strict";
import test from "node:test";
import { loadBackground, plain } from "../helpers/background.mjs";

const SIGNED_IN = { "x.com": ["auth_token"], "instagram.com": ["sessionid"], "facebook.com": ["c_user", "xs"] };
const PAGE = { pageUrl: "https://x.com/alice/", platform: "Twitter", account: "alice" };

// Starts the background with every site signed in, unless told otherwise.
const start = (options = {}) => loadBackground({ cookies: SIGNED_IN, ...options });
const ask = (env, message, sender) => env.send(message, sender);
// Results come from the sandboxed worker, so copy them into this realm before comparing.
const jobs = async env => plain((await ask(env, { type: "QUEUE_STATE" })).jobs);
const only = async env => (await jobs(env))[0];
const settle = () => new Promise(resolve => setImmediate(resolve));

test("the dashboard adds profile links, ignoring tracking parameters and duplicates", async () => {
  const env = start();
  const result = await ask(env, {
    type: "QUEUE_ADD",
    urls: [
      "https://x.com/alice?s=20",
      "https://x.com/Alice/",
      "https://www.instagram.com/bob/",
      "https://example.com/no"
    ]
  });
  assert.equal(result.ok, true);
  assert.equal(result.created.length, 2);
  assert.deepEqual(
    plain(result.skipped.map(item => item.reason)).map(reason => typeof reason),
    ["string", "string"]
  );
  assert.deepEqual((await jobs(env)).map(job => job.account).sort(), ["alice", "bob"]);
});

test("adding a link opens its page in a background tab and records the tab", async () => {
  const env = start();
  await ask(env, { type: "QUEUE_ADD", urls: ["https://x.com/alice"] });
  await settle();
  await env.inContext("queueEngine.tick()");
  assert.equal(env.tabsCreated.length, 1);
  assert.deepEqual(plain(env.tabsCreated[0]), { url: "https://x.com/alice/", active: false });
  const job = await only(env);
  assert.equal(job.tabId, 100);
  assert.ok(job.openedAt);
  assert.equal(job.attempts, 1);
});

test("one worker per site: a second profile on the same site waits, another site starts", async () => {
  const env = start();
  await ask(env, { type: "QUEUE_ADD", urls: ["https://x.com/a", "https://x.com/b", "https://www.instagram.com/c/"] });
  await env.inContext("queueEngine.tick()");
  assert.deepEqual(env.tabsCreated.map(tab => new URL(tab.url).hostname).sort(), ["www.instagram.com", "x.com"]);
});

test("the scan starts when the opened page announces itself, and finishes when the page reports it", async () => {
  const env = start({ tabResponder: () => ({ ok: true, state: { running: true } }) });
  await ask(env, { type: "QUEUE_ADD", urls: ["https://x.com/alice"] });
  await env.inContext("queueEngine.tick()");
  const tab = { tab: { id: 100, url: "https://x.com/alice/" } };

  await ask(env, { type: "CLI_PAGE_READY", ...PAGE }, tab).catch(() => undefined);
  assert.equal(env.tabMessages.at(-1).message.type, "AUTO_START_CLI");
  assert.equal((await only(env)).status, "running");

  const jobId = (await only(env)).jobId;
  await env.send({ type: "AUTO_PROGRESS", state: { jobId, started: 5, message: "scanning" } }, tab);
  assert.equal((await only(env)).started, 5);

  await env.send({ type: "AUTO_DONE", state: { jobId, started: 9, status: "complete" } }, tab);
  await env.inContext("queueEngine.tick()");
  assert.equal((await only(env)).status, "complete");
  assert.deepEqual(env.tabRemoves, [100], "the tab is closed once the job is over");
  assert.equal((await only(env)).tabId, null);
});

test("a real page rate-limit signal becomes the terminal job outcome and pauses its platform", async () => {
  const env = start({
    tabResponder: () => ({ ok: true, state: { running: true } }),
    storage: { queueSettings: { workers: { x: 2 }, delaySeconds: { min: 0, max: 0 }, maxAttempts: 3 } }
  });
  await ask(env, { type: "QUEUE_ADD", urls: ["https://x.com/alice"] });
  await env.inContext("queueEngine.tick()");
  const tab = { tab: { id: 100, url: PAGE.pageUrl } };
  const jobId = (await only(env)).jobId;
  assert.deepEqual(plain(await ask(env, { type: "PLATFORM_RATE_LIMIT", status: 429 }, tab)), { ok: true });
  await ask(env, { type: "CLI_PAGE_READY", ...PAGE }, tab);
  assert.equal((await only(env)).status, "running");
  assert.equal((await only(env)).tabId, 100);
  assert.equal((await only(env)).rateLimitStatus, 429);
  await ask(env, { type: "AUTO_DONE", state: { jobId, status: "complete", message: "Scan complete." } }, tab);
  await env.inContext("queueEngine.tick()");
  const job = await only(env);
  assert.equal(job.rateLimitStatus, 429);
  assert.equal(job.status, "incomplete");
  assert.match(job.message, /HTTP 429/);
  assert.equal(env.storage.rateLimitBackoffs.platforms.Twitter.level, 1);
});

test("a rate-limit signal racing after completion changes the outcome and pauses the platform", async () => {
  const env = start({
    tabResponder: () => ({ ok: true, state: { running: true } }),
    storage: { queueSettings: { workers: { x: 2 }, delaySeconds: { min: 0, max: 0 }, maxAttempts: 3 } }
  });
  await ask(env, { type: "QUEUE_ADD", urls: ["https://x.com/alice"] });
  await env.inContext("queueEngine.tick()");
  const tab = { tab: { id: 100, url: PAGE.pageUrl } };
  const jobId = (await only(env)).jobId;
  await ask(env, { type: "CLI_PAGE_READY", ...PAGE }, tab);
  await ask(env, { type: "AUTO_DONE", state: { jobId, status: "complete", message: "Scan complete." } }, tab);
  assert.equal((await only(env)).status, "complete");

  await ask(env, { type: "PLATFORM_RATE_LIMIT", status: 429 }, tab);
  assert.equal((await only(env)).rateLimitStatus, 429);
  await env.inContext("queueEngine.tick()");
  assert.equal((await only(env)).status, "incomplete");
  assert.equal(env.storage.rateLimitBackoffs.platforms.Twitter.level, 1, JSON.stringify(env.storage));
});

test("a late rate-limit signal after an incomplete scan was requeued pauses its platform", async () => {
  const env = start({
    tabResponder: () => ({ ok: true, state: { running: true } }),
    storage: { queueSettings: { workers: { x: 2 }, delaySeconds: { min: 0, max: 0 }, maxAttempts: 3 } }
  });
  await ask(env, { type: "QUEUE_ADD", urls: ["https://x.com/alice"] });
  await env.inContext("queueEngine.tick()");
  const tab = { tab: { id: 100, url: PAGE.pageUrl } };
  const jobId = (await only(env)).jobId;
  await ask(env, { type: "CLI_PAGE_READY", ...PAGE }, tab);
  await ask(
    env,
    { type: "AUTO_DONE", state: { jobId, status: "incomplete", started: 1, message: "Scan was interrupted." } },
    tab
  );
  await env.inContext("queueEngine.tick()");
  const retried = await only(env);
  assert.equal(retried.status, "queued");
  assert.equal(retried.openedAt, null);

  await ask(env, { type: "PLATFORM_RATE_LIMIT", status: 429 }, tab);
  await env.inContext("queueEngine.tick()");
  assert.equal(env.storage.rateLimitBackoffs.platforms.Twitter.level, 1);
});

test("a late signal does not count the same extension opening twice after worker restart", async () => {
  const env = start({
    tabResponder: () => ({ ok: true, state: { running: true } }),
    storage: { queueSettings: { workers: { x: 2 }, delaySeconds: { min: 0, max: 0 }, maxAttempts: 3 } }
  });
  await ask(env, { type: "QUEUE_ADD", urls: ["https://x.com/alice"] });
  await env.inContext("queueEngine.tick()");
  const job = Object.values(env.storage.queueJobs)[0];
  Object.assign(job, { status: "error", message: "HTTP 429 Too Many Requests" });
  await env.inContext("queueEngine.tick()");
  assert.equal(env.storage.rateLimitBackoffs.platforms.Twitter.level, 1);
  assert.equal((await only(env)).status, "queued");

  await ask(env, { type: "PLATFORM_RATE_LIMIT", status: 429 }, { tab: { id: 100, url: PAGE.pageUrl } });
  const restarted = start({ storage: env.storage });
  await restarted.inContext("queueEngine.tick()");

  assert.equal(restarted.storage.rateLimitBackoffs.platforms.Twitter.level, 1);
  assert.equal(
    restarted.storage.rateLimitBackoffs.platforms.Twitter.until,
    env.storage.rateLimitBackoffs.platforms.Twitter.until
  );
});

test("a rate-limit signal arriving before an extension tab is associated reaches back-off state", async () => {
  const env = start({
    tabResponder: () => ({ ok: true, state: { running: true } }),
    storage: { queueSettings: { workers: { x: 2 }, delaySeconds: { min: 0, max: 0 }, maxAttempts: 3 } }
  });
  env.inContext(`chrome.tabs.create = options => new Promise(resolve => {
    globalThis.__resolveQueueTab = () => resolve({ id: 100, url: options.url });
  })`);
  await ask(env, { type: "QUEUE_ADD", urls: ["https://x.com/alice"] });
  await settle();
  const tab = { tab: { id: 100, url: PAGE.pageUrl } };

  assert.deepEqual(plain(await ask(env, { type: "PLATFORM_RATE_LIMIT", status: 429 }, tab)), { ok: true });
  assert.equal(plain(env.storage.pendingCliRateLimits)[100].status, 429);
  assert.ok(Number.isFinite(plain(env.storage.pendingCliRateLimits)[100].at));
  env.inContext("globalThis.__resolveQueueTab()");
  await env.inContext("queueEngine.tick()");

  const job = await only(env);
  assert.equal(job.tabId, 100);
  assert.equal(job.rateLimitStatus, 429);
  const jobId = job.jobId;
  await ask(env, { type: "CLI_PAGE_READY", ...PAGE }, tab);
  await ask(env, { type: "AUTO_DONE", state: { jobId, status: "complete", message: "Scan complete." } }, tab);
  await env.inContext("queueEngine.tick()");

  assert.equal((await only(env)).status, "incomplete");
  assert.equal(env.storage.rateLimitBackoffs.platforms.Twitter.level, 1);
  assert.deepEqual(plain(env.storage.pendingCliRateLimits), {});
});

test("a page that cannot start the scan fails the job", async () => {
  const env = start({ tabResponder: () => ({ ok: false, error: "no grid" }) });
  await ask(env, { type: "QUEUE_ADD", urls: ["https://x.com/alice"] });
  await env.inContext("queueEngine.tick()");
  await env.send({ type: "CLI_PAGE_READY", ...PAGE }, { tab: { id: 100, url: PAGE.pageUrl } });
  const job = await only(env);
  assert.equal(job.status, "error");
  assert.equal(job.message, "no grid");
});

test("a page that is not the job's profile does not start it", async () => {
  const env = start();
  await ask(env, { type: "QUEUE_ADD", urls: ["https://x.com/alice"] });
  await env.inContext("queueEngine.tick()");
  await env.send({ type: "CLI_PAGE_READY", ...PAGE, pageUrl: "https://x.com/other/" }, { tab: { id: 100 } });
  assert.equal((await only(env)).status, "queued");
  assert.equal(env.tabMessages.length, 0);
});

test("a site the user is not signed in to starts nothing and its waiting jobs say why", async () => {
  const env = start({ cookies: { "x.com": ["auth_token"] } });
  await ask(env, { type: "QUEUE_ADD", urls: ["https://www.instagram.com/c/", "https://x.com/a"] });
  await env.inContext("queueEngine.tick()");
  assert.deepEqual(
    env.tabsCreated.map(tab => new URL(tab.url).hostname),
    ["x.com"]
  );
  const waiting = (await jobs(env)).find(job => job.platform === "Instagram");
  assert.equal(waiting.status, "queued");
  assert.match(waiting.message, /sign in to Instagram/);
  assert.equal(waiting.attempts, 0, "nothing was spent on it");
});

test("the sign-in status is reported per site, from cookie names only", async () => {
  const env = start({ cookies: { "x.com": ["auth_token"], "facebook.com": ["c_user"] } });
  const { login } = await ask(env, { type: "QUEUE_STATE" });
  assert.deepEqual(plain(Object.fromEntries(Object.entries(login).map(([site, info]) => [site, info.signedIn]))), {
    Twitter: true,
    Instagram: false,
    Facebook: false,
    TikTok: false
  });
  assert.match(login.Instagram.signInUrl, /instagram\.com\/accounts\/login/);
});

test("a sign-in wall in the opened tab ends the job, holds the site and keeps the link", async () => {
  const env = start();
  await ask(env, { type: "QUEUE_ADD", urls: ["https://www.instagram.com/c/", "https://www.instagram.com/d/"] });
  await env.inContext("queueEngine.tick()");
  env.listeners.tabUpdated[0](100, { url: "https://www.instagram.com/accounts/login/?next=%2Fc%2F" });
  await settle();
  await settle();
  await env.inContext("queueEngine.tick()");
  const all = await jobs(env);
  assert.equal(all.length, 2, "no link is lost");
  assert.equal(all.find(job => job.reason)?.status, "incomplete");
  assert.equal(all.find(job => job.reason)?.reason, "login_required");
  assert.equal(all.filter(job => job.status === "queued").length, 1);
  assert.equal(env.tabsCreated.length, 1, "nothing else starts on Instagram");
  assert.ok(env.tabRemoves.includes(100), "the sign-in tab is closed");
});

test("a checkpoint navigation leaves a challenge signal in the job outcome", async () => {
  const env = start();
  await ask(env, { type: "QUEUE_ADD", urls: ["https://www.instagram.com/c/"] });
  await env.inContext("queueEngine.tick()");
  env.listeners.tabUpdated[0](100, { url: "https://www.instagram.com/challenge/1234/" });
  await settle();
  const [job] = await jobs(env);
  assert.match(job.message, /checkpoint or security challenge/i);
  assert.equal(job.status, "incomplete");
  assert.equal(job.reason, "login_required");
});

test("telling the extension the user signed in does not bypass a login-wall back-off", async () => {
  const env = start();
  await ask(env, { type: "QUEUE_ADD", urls: ["https://www.instagram.com/c/"] });
  await env.inContext("queueEngine.tick()");
  env.listeners.tabUpdated[0](100, { url: "https://www.instagram.com/accounts/login/" });
  await settle();
  await env.inContext("queueEngine.tick()");
  assert.equal(env.tabsCreated.length, 1);
  await ask(env, { type: "QUEUE_SIGNED_IN" });
  assert.equal(env.tabsCreated.length, 1);
});

test("closing the tab of a running scan fails the job so it can be retried", async () => {
  const env = start({ tabResponder: () => ({ ok: true, state: { running: true } }) });
  await ask(env, { type: "QUEUE_ADD", urls: ["https://x.com/alice"] });
  await env.inContext("queueEngine.tick()");
  await env.send({ type: "CLI_PAGE_READY", ...PAGE }, { tab: { id: 100, url: PAGE.pageUrl } });
  for (const listener of env.listeners.tabRemoved) {
    listener(100);
  }
  await settle();
  await settle();
  assert.equal((await only(env)).status, "error");
  assert.match((await only(env)).message, /closed before the scan finished/);
});

test("pausing stops new pages from opening, and resuming lets them open", async () => {
  const env = start();
  await ask(env, { type: "QUEUE_PAUSE", paused: true });
  await ask(env, { type: "QUEUE_ADD", urls: ["https://x.com/alice"] });
  await env.inContext("queueEngine.tick()");
  assert.equal(env.tabsCreated.length, 0);
  assert.equal((await ask(env, { type: "QUEUE_STATE" })).paused, true);
  await ask(env, { type: "QUEUE_PAUSE", paused: false });
  await env.inContext("queueEngine.tick()");
  assert.equal(env.tabsCreated.length, 1);
});

test("settings are validated with the shared rules and change how many pages open", async () => {
  const env = start();
  const bad = await ask(env, { type: "QUEUE_SETTINGS_SAVE", settings: { workers: { x: 99 } } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /workers\.x/);

  const saved = await ask(env, {
    type: "QUEUE_SETTINGS_SAVE",
    settings: { workers: { x: 2 }, delaySeconds: { min: 0, max: 0 } }
  });
  assert.equal(saved.ok, true);
  await ask(env, { type: "QUEUE_ADD", urls: ["https://x.com/a", "https://x.com/b", "https://x.com/c"] });
  await env.inContext("queueEngine.tick()");
  assert.equal(env.tabsCreated.length, 2);
});

test("retry, stop, remove and clear-finished act on the right jobs", async () => {
  const env = start({ tabResponder: () => ({ ok: true, state: { running: true } }) });
  await ask(env, { type: "QUEUE_ADD", urls: ["https://x.com/a", "https://www.instagram.com/b/"] });
  const [first, second] = await jobs(env);

  await ask(env, { type: "QUEUE_ACTION", action: "stop", jobId: first.jobId });
  assert.equal((await jobs(env)).find(job => job.jobId === first.jobId).status, "paused");
  await ask(env, { type: "QUEUE_ACTION", action: "retry", jobId: first.jobId });
  assert.equal((await jobs(env)).find(job => job.jobId === first.jobId).status, "queued");

  await ask(env, { type: "QUEUE_ACTION", action: "remove", jobId: second.jobId });
  assert.equal((await jobs(env)).length, 1);

  const bad = await ask(env, { type: "QUEUE_ACTION", action: "explode", jobId: first.jobId });
  assert.equal(bad.ok, false);
});

test("the queue ticks on an alarm and recovers interrupted jobs when the browser starts", async () => {
  const env = start({
    storage: {
      queueJobs: {
        j1: {
          jobId: "j1",
          platform: "Twitter",
          account: "a",
          url: "https://x.com/a/",
          status: "running",
          createdAt: "2026-01-01T00:00:00Z"
        }
      }
    }
  });
  assert.equal(env.alarms[0].name, "pms-queue");
  assert.equal(env.alarms[0].info.periodInMinutes, 0.5);
  env.listeners.startup[0]();
  await settle();
  await settle();
  assert.equal((await only(env)).status, "incomplete");
});

test("a new service worker restores the saved platform cooldown before opening queued jobs", async () => {
  const env = start({
    storage: {
      queueSettings: { workers: { instagram: 3 }, delaySeconds: { min: 0, max: 0 }, maxAttempts: 3 },
      queueJobs: {
        first: {
          jobId: "first",
          platform: "Instagram",
          account: "first",
          url: "https://www.instagram.com/first/",
          status: "queued",
          createdAt: "2026-01-01T00:00:00Z",
          attempts: 0
        },
        second: {
          jobId: "second",
          platform: "Instagram",
          account: "second",
          url: "https://www.instagram.com/second/",
          status: "queued",
          createdAt: "2026-01-01T00:00:01Z",
          attempts: 0
        }
      }
    }
  });
  await env.inContext("queueEngine.tick()");
  assert.equal(env.tabsCreated.length, 2);
  const failed = Object.values(env.storage.queueJobs).find(job => job.account === "first");
  Object.assign(failed, { status: "error", message: "HTTP 429 Too Many Requests" });
  await env.inContext("queueEngine.tick()");
  assert.ok(env.storage.rateLimitBackoffs.platforms.Instagram.until > Date.now());

  const restarted = start({ storage: env.storage });
  await restarted.inContext("queueEngine.tick()");
  assert.deepEqual(restarted.tabsCreated, []);
  assert.equal(restarted.storage.rateLimitBackoffs.platforms.Instagram.level, 1);
});

test("a fresh install opens the dashboard; an update does not", async () => {
  const env = start();
  env.listeners.installed[0]({ reason: "update" });
  await settle();
  assert.equal(env.optionsOpened.count, 0);
  env.listeners.installed[0]({ reason: "install" });
  await settle();
  assert.equal(env.optionsOpened.count, 1);
});

test("clearing finished removes only completed jobs", async () => {
  const env = start({
    storage: {
      queueJobs: {
        a: { jobId: "a", status: "complete", createdAt: "2026-01-01T00:00:00Z" },
        b: { jobId: "b", status: "error", createdAt: "2026-01-01T00:00:01Z" },
        c: { jobId: "c", status: "queued", createdAt: "2026-01-01T00:00:02Z" }
      }
    }
  });
  await ask(env, { type: "QUEUE_PAUSE", paused: true });
  await ask(env, { type: "QUEUE_ACTION", action: "clear-finished" });
  assert.deepEqual((await jobs(env)).map(job => job.jobId).sort(), ["b", "c"]);
});
