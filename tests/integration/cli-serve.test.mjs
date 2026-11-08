import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach, beforeEach } from "node:test";

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
// The mover reads the browser's Downloads folder, so the "browser profile" is inside the temp folder too.
const home = await mkdtemp(path.join(os.tmpdir(), "pms-serve-"));
const BRIDGE_PORT = await freePort();
const API_PORT = await freePort();
process.env.LOCALAPPDATA = home;
process.env.USERPROFILE = home;
process.env.HOME = home;
process.env.PMS_BRIDGE_PORT = String(BRIDGE_PORT);
process.env.PMS_API_PORT = String(API_PORT);
const store = await import("../../cli/store.mjs");
const serveModule = await import("../../cli/serve.mjs");
const watchModule = await import("../../cli/watch.mjs");
const { addUrls, addCommand, moveCommand, readUrlFile, runningServer, serve } = serveModule;

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const ALICE = "https://www.instagram.com/alice/";
const BOB = "https://x.com/Bob/";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DAY = 24 * 60 * 60 * 1000;
const INBOX = path.join(home, "inbox.txt");
const PROFILE = path.join(home, "browser-profile");
const SOURCE = path.join(home, "browser-downloads");
const MEDIA = path.join(home, "Media");

after(() => rm(home, { recursive: true, force: true }));
beforeEach(async () => {
  for (const dir of [store.APP_DIR, INBOX, PROFILE, SOURCE, MEDIA]) {
    await rm(dir, { recursive: true, force: true });
  }
});
afterEach(() => {
  process.exitCode = undefined;
});

function capture(t) {
  const lines = [];
  const original = process.stdout.write;
  t.mock.method(process.stdout, "write", function (chunk, ...rest) {
    if (typeof chunk !== "string") {
      return original.call(this, chunk, ...rest);
    }
    lines.push(chunk);
    return true;
  });
  return lines;
}

const installBridge = () =>
  store.writeJsonAtomic(store.BRIDGE_CONFIG_FILE, { extensionOrigin: ORIGIN, port: BRIDGE_PORT });

// Without a saved browser, opening a page fails at once and the job ends as an error, so nothing ever launches.
async function noBrowser() {
  await rm(store.EDGE_PROFILE_FILE, { force: true });
}

async function putJob(n, url, status, daysAgo = 0, extra = {}) {
  const stamp = new Date(Date.now() - daysAgo * DAY).toISOString();
  await store.writeJsonAtomic(store.jobFile(id(n)), {
    jobId: id(n),
    url,
    platform: "Instagram",
    account: "alice",
    status,
    createdAt: stamp,
    updatedAt: stamp,
    ...extra
  });
}

// SIGINT handlers added by the code under test; calling one is what Ctrl+C does, without signalling anyone.
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

test("addUrls queues each new profile once, whatever its letter case, and says why it skipped the rest", async () => {
  await putJob(1, ALICE, "complete");
  const { created, skipped } = await addUrls(
    [ALICE.toUpperCase(), BOB, BOB.toLowerCase(), "https://example.com/nope", "not a url"],
    { limit: 7 }
  );
  assert.deepEqual(
    created.map(job => [job.url, job.limit, job.status]),
    [[BOB, 7, "queued"]]
  );
  assert.equal(skipped.length, 4);
  assert.deepEqual(
    skipped.slice(0, 2).map(item => item.reason),
    ["already queued or done", "already queued or done"]
  );
  assert.match(skipped[2].reason, /Automatic URL downloads support/);
  assert.equal((await store.listJobs()).length, 2);
});

test("addUrls with force queues a URL again even though it ran before", async () => {
  await putJob(1, ALICE, "complete");
  const { created, skipped } = await addUrls([ALICE, ALICE], { force: true });
  assert.equal(created.length, 2);
  assert.equal(skipped.length, 0);
  assert.equal(created[0].limit, null, "no limit unless one is given");
});

test("readUrlFile keeps only trimmed https lines and treats a missing file as empty", async () => {
  assert.deepEqual(await readUrlFile(INBOX), []);
  await writeFile(INBOX, `# comment\r\n  ${ALICE}  \r\nhttp://x.com/no\r\n\r\n${BOB}\nftp://x\n`);
  assert.deepEqual(await readUrlFile(INBOX), [ALICE, BOB]);
});

test("runningServer sees another live process, but not this one, a dead one or a cleared file", async () => {
  assert.equal(await runningServer(), null, "no daemon file");
  await store.writeJsonAtomic(store.DAEMON_FILE, { pid: process.pid });
  assert.equal(await runningServer(), null, "this very process");
  await store.writeJsonAtomic(store.DAEMON_FILE, { pid: 2_000_000_000 });
  assert.equal(await runningServer(), null, "no such process");
  await store.writeJsonAtomic(store.DAEMON_FILE, { pid: null, stoppedAt: "x" });
  assert.equal(await runningServer(), null, "stopped");
  await writeFile(store.DAEMON_FILE, "{ broken");
  assert.equal(await runningServer(), null, "unreadable");
  await store.writeJsonAtomic(store.DAEMON_FILE, { pid: process.ppid, inbox: "x" });
  assert.equal((await runningServer())?.pid, process.ppid, "the parent process is alive");
});

test("add queues the URLs, reports the skipped ones and points to serve when nothing is running", async t => {
  const lines = capture(t);
  await assert.rejects(addCommand([]), /Give at least one profile URL/);
  await assert.rejects(addCommand(["--again"]), /Give at least one profile URL/);
  await addCommand([ALICE, "https://example.com/x"]);
  const text = lines.join("");
  assert.match(text, /Queued Instagram\/alice \(job [0-9a-f-]{36}\)\./);
  assert.match(text, /Skipped https:\/\/example\.com\/x: /);
  assert.match(text, /Nothing is processing the queue yet/);

  lines.length = 0;
  await addCommand([ALICE]);
  assert.match(lines.join(""), /Skipped .*alice\/: already queued or done/);
  lines.length = 0;
  await addCommand([ALICE, "--again"]);
  assert.match(lines.join(""), /Queued Instagram\/alice/);
  assert.equal((await store.listJobs()).filter(job => job.url === ALICE).length, 2);
});

test("add stays quiet about starting serve when one is already running", async t => {
  await store.writeJsonAtomic(store.DAEMON_FILE, { pid: process.ppid });
  const lines = capture(t);
  await addCommand([BOB]);
  assert.doesNotMatch(lines.join(""), /Nothing is processing/);
});

async function firefoxProfile(downloadDir) {
  await mkdir(PROFILE, { recursive: true });
  await writeFile(
    path.join(PROFILE, "prefs.js"),
    `user_pref("browser.download.dir", ${JSON.stringify(downloadDir)});\n`
  );
  await store.writeJsonAtomic(store.EDGE_PROFILE_FILE, { browser: "firefox", profilePath: PROFILE });
}

async function settledFile(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  const old = new Date(Date.now() - 120_000);
  await utimes(file, old, old);
}

test("move needs a download folder in the config", async () => {
  await assert.rejects(moveCommand(), /Set downloadDir in config\.json first/);
});

test("move relocates the finished files of the browser's download folder and says how many", async t => {
  await firefoxProfile(SOURCE);
  await store.writeJsonAtomic(store.CONFIG_FILE, { downloadDir: MEDIA });
  await settledFile(path.join(SOURCE, "Instagram", "alice", "a.jpg"), "photo");
  await settledFile(path.join(SOURCE, "Instagram", "alice", "b.jpg"), "photo2");
  const lines = capture(t);
  await moveCommand();
  assert.match(
    lines.join(""),
    /Moved 2 file\(s\) to .*Media; 0 duplicate\(s\) dropped, 0 still being written, 0 failed\./
  );
  assert.equal(await readFile(path.join(MEDIA, "Instagram", "alice", "a.jpg"), "utf8"), "photo");
  assert.deepEqual(
    await readdir(path.join(SOURCE, "Instagram")).catch(() => []),
    [],
    "no account folder is left behind"
  );
});

test("move also follows an Edge profile's download setting", { skip: process.platform !== "win32" }, async t => {
  const userData = path.join(home, "edge-data");
  await mkdir(path.join(userData, "Default"), { recursive: true });
  await writeFile(
    path.join(userData, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: SOURCE } })
  );
  await store.writeJsonAtomic(store.EDGE_PROFILE_FILE, { browser: "edge", userData, profileDirectory: "Default" });
  await store.writeJsonAtomic(store.CONFIG_FILE, { downloadDir: MEDIA });
  await settledFile(path.join(SOURCE, "Twitter", "bob", "v.mp4"), "video");
  const lines = capture(t);
  await moveCommand();
  assert.match(lines.join(""), /Moved 1 file\(s\)/);
  assert.equal(await readFile(path.join(MEDIA, "Twitter", "bob", "v.mp4"), "utf8"), "video");
});

test("serve opens the bridge and API, logs, and leaves a stopped daemon file when the queue is empty", async t => {
  await installBridge();
  await noBrowser();
  const lines = capture(t);
  await serve({ inbox: INBOX, once: true });
  const text = lines.join("");
  assert.match(text, /Serving\. POST http:\/\/127\.0\.0\.1:\d+\/downloads/);
  assert.match(text, /Stopped\.\n$/);
  const daemon = await store.readJson(store.DAEMON_FILE);
  assert.equal(daemon.pid, null);
  assert.ok(daemon.stoppedAt);
  assert.match(await readFile(store.API_TOKEN_FILE, "utf8"), /^[0-9a-f]{64}\n$/);
  assert.ok(await store.readJson(store.CONFIG_FILE), "the settings file was created for the user to edit");
  const logs = await readdir(store.LOGS_DIR);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /^serve-\d{4}-\d\d-\d\d\.log$/);
  assert.match(await readFile(path.join(store.LOGS_DIR, logs[0]), "utf8"), /Serving\./);
  // Both ports are free again.
  for (const port of [BRIDGE_PORT, API_PORT]) {
    await new Promise((resolve, reject) => {
      const probe = net.createServer().once("error", reject);
      probe.listen(port, "127.0.0.1", () => probe.close(resolve));
    });
  }
});

test("serve queues the inbox URLs with the configured limit, and a job that cannot be opened ends as an error", async t => {
  await installBridge();
  await noBrowser();
  await store.writeJsonAtomic(store.CONFIG_FILE, { limit: 3 });
  await writeFile(INBOX, `${ALICE}\n${ALICE}\nnot a url\n`);
  const lines = capture(t);
  await serve({ inbox: INBOX, once: true });
  const jobs = await store.listJobs();
  assert.equal(jobs.length, 1, "the same URL is queued once");
  assert.equal(jobs[0].limit, 3);
  assert.equal(jobs[0].attempts, 1);
  assert.match(jobs[0].message, /Could not open the page: Load the extension/);
  assert.match(lines.join(""), /Queued 1 URL\(s\) from the inbox\./);
});

test("serve uses the command-line limit when the settings have none", async t => {
  await installBridge();
  await noBrowser();
  await writeFile(INBOX, `${BOB}\n`);
  capture(t);
  await serve({ inbox: INBOX, once: true, limit: 9 });
  assert.equal((await store.listJobs())[0].limit, 9);
});

test("serve scans the URLs it is told are due again, even if they ran before", async t => {
  await installBridge();
  await noBrowser();
  await putJob(1, ALICE, "complete", 1);
  capture(t);
  await serve({ inbox: INBOX, once: true, dueUrls: async () => [ALICE] });
  const jobs = await store.listJobs();
  assert.equal(jobs.length, 2);
  assert.equal(jobs.filter(job => job.url === ALICE && job.attempts === 1).length, 1);
});

test("serve recovers interrupted jobs and removes old ones", async t => {
  await installBridge();
  await noBrowser();
  await putJob(1, ALICE, "complete", 90);
  await putJob(2, ALICE, "complete", 60);
  await putJob(3, BOB, "running", 0, { platform: "Twitter", account: "Bob" });
  const lines = capture(t);
  await serve({ inbox: INBOX, once: true });
  const text = lines.join("");
  assert.match(text, /Recovered 1 job\(s\) left by a previous run\./);
  assert.match(text, /Removed 1 old job\(s\) and 0 old log\(s\)\./);
  const left = (await store.listJobs()).map(job => job.jobId).sort();
  assert.ok(left.includes(id(2)) && left.includes(id(3)));
  assert.ok(!left.includes(id(1)), "the older of two finished jobs of a URL was pruned");
});

test("serve refuses to start while another serve is running", async () => {
  await installBridge();
  await store.writeJsonAtomic(store.DAEMON_FILE, { pid: process.ppid });
  await assert.rejects(
    serve({ inbox: INBOX, once: true }),
    new RegExp(`already running \\(process ${process.ppid}\\)`)
  );
  assert.equal((await store.readJson(store.DAEMON_FILE)).pid, process.ppid, "the other server's file is untouched");
});

test("serve without an installed bridge fails cleanly and writes no daemon file", async t => {
  const lines = capture(t);
  await assert.rejects(serve({ inbox: INBOX, once: true }), /bridge is not configured/);
  assert.equal(await store.readJson(store.DAEMON_FILE), null);
  assert.match(lines.join(""), /Stopped\./);
});

test("serve closes the bridge again when the API port is taken", async t => {
  await installBridge();
  const lines = capture(t);
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(API_PORT, "127.0.0.1", resolve));
  try {
    await assert.rejects(serve({ inbox: INBOX, once: true }), new RegExp(`API port ${API_PORT} is already in use`));
  } finally {
    await new Promise(resolve => blocker.close(resolve));
  }
  assert.match(lines.join(""), /Stopped\./);
  await new Promise((resolve, reject) => {
    const probe = net.createServer().once("error", reject);
    probe.listen(BRIDGE_PORT, "127.0.0.1", () => probe.close(resolve));
  });
  assert.equal((await store.readJson(store.DAEMON_FILE)).pid, null);
});

test("serve keeps going after a failed pass and carries on once the problem is gone", async t => {
  await installBridge();
  await noBrowser();
  await writeFile(INBOX, `${ALICE}\n`);
  await mkdir(store.APP_DIR, { recursive: true });
  await writeFile(store.JOBS_DIR, "not a folder"); // saving a job fails until this is removed
  const lines = capture(t);
  const done = serve({ inbox: INBOX, once: true });
  while (!lines.join("").includes("Pass failed (1/20)")) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await rm(store.JOBS_DIR, { force: true });
  await done;
  assert.equal((await store.listJobs()).length, 1);
  assert.match(lines.join(""), /Pass failed \(1\/20\): /);
});

test("serve gives up after twenty failed passes in a row", async t => {
  await installBridge();
  await noBrowser();
  await writeFile(INBOX, `${ALICE}\n`);
  await mkdir(store.APP_DIR, { recursive: true });
  await writeFile(store.JOBS_DIR, "not a folder");
  const lines = capture(t);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let outcome;
  const done = serve({ inbox: INBOX }).then(
    () => (outcome = "resolved"),
    error => (outcome = error)
  );
  while (!outcome) {
    await new Promise(resolve => setImmediate(resolve));
    t.mock.timers.tick(2000);
  }
  await done;
  t.mock.timers.reset();
  assert.ok(outcome instanceof Error, "serve ends with the last error");
  const text = lines.join("");
  assert.match(text, /Pass failed \(20\/20\)/);
  assert.doesNotMatch(text, /Pass failed \(21\/20\)/);
  assert.match(text, /Stopped\./);
});

test("Ctrl+C stops serve after the current pass", async t => {
  await installBridge();
  await noBrowser();
  const lines = capture(t);
  const nextHandler = interrupter();
  const done = serve({ inbox: INBOX });
  const stop = await nextHandler();
  stop();
  await done;
  assert.match(lines.join(""), /Stopped\./);
  assert.equal((await store.readJson(store.DAEMON_FILE)).pid, null);
});

test("watch add needs URLs, appends the profile pages and lists them", async t => {
  const lines = capture(t);
  await assert.rejects(watchModule.addToWatch([]), /Give at least one profile URL/);
  await assert.rejects(watchModule.addToWatch(["https://example.com/x"]), /Automatic URL downloads support/);
  await watchModule.addToWatch([ALICE, BOB]);
  await watchModule.addToWatch([ALICE]);
  assert.equal(watchModule.DEFAULT_WATCH, path.join(store.APP_DIR, "watch.txt"));
  assert.equal(await readFile(watchModule.DEFAULT_WATCH, "utf8"), `${ALICE}\n${BOB}\n${ALICE}\n`);
  assert.match(
    lines.join(""),
    /Watching 2 page\(s\)\. Start the loop with: node cli\/mediasaver\.mjs watch\n {2}https:\/\/www\.instagram\.com\/alice\/\n/
  );
});

test("watch scans the listed pages that are due and leaves recently scanned ones alone", async t => {
  await installBridge();
  await noBrowser();
  await mkdir(store.APP_DIR, { recursive: true });
  await writeFile(watchModule.DEFAULT_WATCH, `${ALICE}\n${BOB}\n`);
  await putJob(1, BOB, "complete", 0); // scanned a moment ago: not due for hours
  const lines = capture(t);
  const nextHandler = interrupter();
  const done = watchModule.watch();
  const stop = await nextHandler();
  while ((await store.listJobs()).filter(job => job.url === ALICE).length === 0) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  stop();
  await done;
  const jobs = await store.listJobs();
  assert.equal(jobs.filter(job => job.url === ALICE).length, 1, "the page that was never scanned is queued");
  assert.equal(jobs.filter(job => job.url === BOB).length, 1, "the recently scanned page is not queued again");
  assert.match(lines.join(""), /Queued 1 URL\(s\) from the inbox\./);
  assert.ok((await stat(store.DAEMON_FILE)).isFile());
});
