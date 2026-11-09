import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

// Never the live queue's folder or port: a temp folder and a free port, set before the CLI is imported.
const home = await mkdtemp(path.join(os.tmpdir(), "pms-jobs-"));
const PORT = await freePort();
process.env.LOCALAPPDATA = home;
process.env.USERPROFILE = home; // the "Downloads" folder of repairs is inside the temp folder too
process.env.PMS_BRIDGE_PORT = String(PORT);
const store = await import("../../cli/store.mjs");
const jobs = await import("../../cli/jobs.mjs");
const { printJob, showStatus } = await import("../../cli/status.mjs");

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const PAGE = "https://www.instagram.com/alice/";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

after(() => {
  store.closeJobStore();
  return rm(home, { recursive: true, force: true });
});
beforeEach(() => store.removeAppData());
afterEach(() => {
  process.exitCode = undefined;
});

// Collects what the CLI prints. `lines.onLine` can react to a line synchronously, before the CLI goes on.
// Only text is swallowed: the test runner reports its results through the same stream as binary chunks.
function capture(t) {
  const lines = [];
  lines.onLine = () => {};
  const original = process.stdout.write;
  t.mock.method(process.stdout, "write", function (chunk, ...rest) {
    if (typeof chunk !== "string") {
      return original.call(this, chunk, ...rest);
    }
    lines.push(chunk);
    lines.onLine(chunk);
    return true;
  });
  return lines;
}

async function putJob(n, extra = {}) {
  const job = {
    jobId: id(n),
    url: PAGE,
    platform: "Instagram",
    account: "alice",
    status: "queued",
    createdAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
    updatedAt: new Date(Date.UTC(2026, 0, n)).toISOString(),
    ...extra
  };
  await store.writeJob(job);
  return job;
}

// The browser is replaced by whatever launches: `node` with options it rejects, never a real browser.
async function install({ executable = process.execPath } = {}) {
  await store.writeJsonAtomic(store.EDGE_PROFILE_FILE, { browser: "edge", profileDirectory: "Default", executable });
  await store.writeJsonAtomic(store.BRIDGE_CONFIG_FILE, { extensionOrigin: ORIGIN, port: PORT });
}

const bridge = () => store.writeJsonAtomic(store.BRIDGE_CONFIG_FILE, { extensionOrigin: ORIGIN, port: PORT });

const finishWith = (jobId, patch) => () =>
  store.jobs().write({ jobId, platform: "Instagram", account: "alice", ...patch });
const announced = line => /^(Opening|Watching) /.test(line);

test("printJob lists status, account, counters, optional lines and the save folder", t => {
  const lines = capture(t);
  printJob({
    jobId: id(1),
    status: "running",
    platform: "Instagram",
    account: "alice",
    started: 4,
    pending: 1,
    failed: 2,
    skipped: 3,
    videoStarted: 5,
    videoSkipped: 6,
    message: "Scanning"
  });
  const text = lines.join("");
  assert.match(text, new RegExp(`Job: ${id(1)}\\nStatus: running\\nAccount: Instagram/alice\\n`));
  assert.match(text, /Started requests: 4 · pending: 1 · failed: 2 · skipped: 3/);
  assert.match(text, /Files from page data or menus started: 5 · unavailable or already saved: 6/);
  assert.match(text, /Scanning\n/);
  assert.match(text, /Downloads\/Instagram\/alice: 9 new, 9 already saved or unavailable\./);
});

test("printJob leaves out what a bare job does not have and names a chosen folder", t => {
  const lines = capture(t);
  printJob({ jobId: id(1), status: "queued" }, "D:\\Media");
  const text = lines.join("");
  assert.doesNotMatch(text, /Account:|Files from page data/);
  assert.match(text, /Started requests: 0 · pending: 0 · failed: 0 · skipped: 0/);
  assert.match(text, /D:\\Media\\Site\\account: 0 new, 0 already saved or unavailable\./);
});

test("status shows one job by id, and says so when it does not exist", async t => {
  await putJob(1, { status: "paused", message: "Paused by user" });
  const lines = capture(t);
  await showStatus(id(1));
  assert.match(lines.join(""), /Status: paused[\s\S]*Paused by user/);
  await assert.rejects(showStatus(id(2)), new RegExp(`No job was found with id ${id(2)}`));
});

test("status shows the active job, using the configured download folder", async t => {
  await putJob(1, { status: "running" });
  await store.writeJsonAtomic(store.QUEUE_FILE, { jobId: id(1) });
  await store.writeJsonAtomic(store.CONFIG_FILE, { downloadDir: "D:\\Media" });
  const lines = capture(t);
  await showStatus();
  assert.match(lines.join(""), /Status: running[\s\S]*D:\\Media\\Instagram\\alice/);
});

test("status falls back to the defaults when the config file is broken", async t => {
  await putJob(1, { status: "running" });
  await store.writeJsonAtomic(store.QUEUE_FILE, { jobId: id(1) });
  await writeFile(store.CONFIG_FILE, "{ broken");
  const lines = capture(t);
  await showStatus();
  assert.match(lines.join(""), /Downloads\/Instagram\/alice/);
});

test("status with no active job counts jobs by state, newest first, ten at most", async t => {
  const lines = capture(t);
  await showStatus();
  assert.deepEqual([...lines], ["No Page Media Saver jobs yet.\n"]);

  for (let n = 1; n <= 12; n++) {
    await putJob(n, { status: n % 3 ? "complete" : "error", message: `job ${n}` });
  }
  lines.length = 0;
  await showStatus();
  assert.equal(lines[0], "Jobs: 4 error, 8 complete\n");
  assert.equal(lines.length, 11);
  assert.match(lines[1], new RegExp(`^${id(12)}  error {5}  Instagram/alice  job 12\\n$`));
  assert.match(lines[10], new RegExp(`^${id(3)} `));
});

test("createJob writes a waiting job file for the normalised URL", async () => {
  const job = await jobs.createJob("https://www.instagram.com/alice", 5);
  assert.equal(job.url, PAGE);
  assert.equal(job.platform, "Instagram");
  assert.equal(job.account, "alice");
  assert.equal(job.limit, 5);
  assert.equal(job.status, "queued");
  assert.equal(job.openedAt, null);
  assert.equal(job.mediaPage, false);
  assert.deepEqual(await store.readJob(job.jobId), job);
  assert.equal((await jobs.createJob(PAGE)).limit, 10, "the default limit");
  assert.equal((await jobs.createJob(PAGE, null)).limit, null, "no limit");
  await assert.rejects(jobs.createJob("https://example.com/nope"), /Automatic URL downloads support/);
});

test("openJobInEdge refuses until the CLI is installed", async () => {
  await assert.rejects(jobs.openJobInEdge({ jobId: id(1), url: PAGE }), /Load the extension, then run install/);
  await store.writeJsonAtomic(store.EDGE_PROFILE_FILE, {});
  await assert.rejects(jobs.openJobInEdge({ jobId: id(1), url: PAGE }), /Load the extension/);
});

function fakeSpawn() {
  const calls = [];
  const spawnProcess = (...args) => {
    const child = new EventEmitter();
    child.unref = () => {
      child.unrefCalled = true;
    };
    calls.push({ args, child });
    return child;
  };
  return { calls, spawnProcess };
}

test("openJobInEdge starts the saved browser detached, on the job URL carrying the CLI tab marker", async () => {
  await install();
  const { calls, spawnProcess } = fakeSpawn();
  await jobs.openJobInEdge({ jobId: id(1), url: PAGE }, spawnProcess);
  assert.equal(calls.length, 1);
  const [executable, args, options] = calls[0].args;
  assert.equal(executable, process.execPath);
  assert.deepEqual(args, ["--profile-directory=Default", `${PAGE}${store.cliTabMarker(id(1))}`]);
  assert.deepEqual(options, { detached: true, stdio: "ignore", windowsHide: true });
  assert.equal(calls[0].child.unrefCalled, true);
});

test("openJobInEdge opens Firefox with its profile folder", async () => {
  await store.writeJsonAtomic(store.EDGE_PROFILE_FILE, {
    browser: "firefox",
    profilePath: path.join(home, "ff-profile"),
    executable: process.execPath
  });
  const { calls, spawnProcess } = fakeSpawn();
  await jobs.openJobInEdge({ jobId: id(1), url: PAGE }, spawnProcess);
  assert.deepEqual(calls[0].args[1], [
    "-profile",
    path.join(home, "ff-profile"),
    "-new-tab",
    `${PAGE}${store.cliTabMarker(id(1))}`
  ]);
});

test(
  "openJobInEdge says which browser is missing when none can be found",
  { skip: process.platform !== "win32" },
  async () => {
    const keep = { ProgramFiles: process.env.ProgramFiles, x86: process.env["PROGRAMFILES(X86)"] };
    // Point every well-known install location at an empty folder so no real browser is found.
    process.env.ProgramFiles = path.join(home, "empty");
    process.env["PROGRAMFILES(X86)"] = path.join(home, "empty");
    try {
      await store.writeJsonAtomic(store.EDGE_PROFILE_FILE, {
        browser: "firefox",
        profilePath: "x",
        executable: path.join(home, "gone.exe")
      });
      const { calls, spawnProcess } = fakeSpawn();
      await assert.rejects(
        jobs.openJobInEdge({ jobId: id(1), url: PAGE }, spawnProcess),
        /Firefox is not installed.*install firefox/
      );
      assert.equal(calls.length, 0);
    } finally {
      process.env.ProgramFiles = keep.ProgramFiles;
      process.env["PROGRAMFILES(X86)"] = keep.x86;
    }
  }
);

test(
  "openJobInEdge finds the browser in its usual folder when the saved path is gone",
  { skip: process.platform !== "win32" },
  async () => {
    const keep = { ProgramFiles: process.env.ProgramFiles, x86: process.env["PROGRAMFILES(X86)"] };
    const programs = path.join(home, "Programs");
    const exe = path.join(programs, "Microsoft", "Edge", "Application", "msedge.exe");
    await mkdir(path.dirname(exe), { recursive: true });
    await writeFile(exe, "");
    process.env.ProgramFiles = programs;
    process.env["PROGRAMFILES(X86)"] = path.join(home, "empty");
    try {
      await store.writeJsonAtomic(store.EDGE_PROFILE_FILE, {
        profileDirectory: "Profile 2",
        executable: path.join(home, "moved.exe")
      });
      const { calls, spawnProcess } = fakeSpawn();
      await jobs.openJobInEdge({ jobId: id(1), url: PAGE }, spawnProcess);
      assert.equal(path.normalize(calls[0].args[0]), path.normalize(exe));
      assert.equal(calls[0].args[1][0], "--profile-directory=Profile 2");
    } finally {
      process.env.ProgramFiles = keep.ProgramFiles;
      process.env["PROGRAMFILES(X86)"] = keep.x86;
    }
  }
);

test("a browser that cannot start fails the job and says why", async t => {
  await install();
  const job = await putJob(1);
  const { calls, spawnProcess } = fakeSpawn();
  const stderr = t.mock.method(process.stderr, "write", () => true);
  await jobs.openJobInEdge(job, spawnProcess);
  calls[0].child.emit("error", new Error("spawn EACCES"));
  await store.sleep(100);
  const saved = await store.readJob(id(1));
  assert.equal(saved.status, "error");
  assert.equal(saved.message, "Could not open Edge: spawn EACCES");
  assert.match(String(stderr.mock.calls[0].arguments[0]), /Could not open Edge: spawn EACCES/);
});

test("a finished job ends the monitor with its summary, and the bridge is closed again", async t => {
  await bridge();
  const job = await putJob(1);
  const lines = capture(t);
  lines.onLine = line => {
    if (announced(line)) {
      finishWith(id(1), { status: "complete", started: 2, pending: 0 })();
    }
  };
  await jobs.launchAndMonitor(job, { openPage: false });
  const text = lines.join("");
  assert.match(text, /Watching Instagram\/alice\. Job /);
  assert.match(text, /complete · 2 requests started/);
  assert.match(text, /Downloads\/Instagram\/alice: 2 new/);
  assert.equal(process.exitCode, undefined);
  // The port is free again, so a second monitor can start.
  const again = await putJob(2);
  lines.onLine = line => announced(line) && finishWith(id(2), { status: "complete" })();
  await jobs.launchAndMonitor(again, { openPage: false });
});

test("the monitor names the limit and sets the exit code from how the job ended", async t => {
  await bridge();
  const cases = [
    ["paused", 2, { limit: 3 }, /\(limit 3 files\)/],
    ["incomplete", 1, { limit: null }, /\(no limit\)/],
    ["error", 1, { limit: 0 }, /Watching Instagram\/alice\. Job/]
  ];
  const lines = capture(t);
  for (const [status, code, extra, pattern] of cases) {
    process.exitCode = undefined;
    lines.length = 0;
    const job = await putJob(1, extra);
    lines.onLine = line => announced(line) && finishWith(id(1), { status })();
    await jobs.launchAndMonitor(job, { openPage: false });
    assert.match(lines.join(""), pattern);
    assert.equal(process.exitCode, code, status);
  }
});

test("the monitor opens the browser page when asked to", async t => {
  await install();
  const job = await putJob(1);
  const lines = capture(t);
  lines.onLine = line => announced(line) && finishWith(id(1), { status: "complete" })();
  await jobs.launchAndMonitor(job);
  assert.match(lines.join(""), /Opening Instagram\/alice/);
});

test("a job nobody acknowledges within 90 seconds is failed with a hint", async t => {
  await bridge();
  t.mock.timers.enable({ apis: ["Date"], now: 1_800_000_000_000 });
  const job = await putJob(1);
  const lines = capture(t);
  const done = jobs.launchAndMonitor(job, { openPage: false });
  t.mock.timers.tick(91_000);
  await done;
  const saved = await store.readJob(id(1));
  assert.equal(saved.status, "error");
  assert.match(saved.message, /did not acknowledge the job within 90 seconds/);
  assert.match(lines.join(""), /Status: error/);
  assert.equal(process.exitCode, 1);
});

test("stopping the monitor leaves the job running and tells how to resume", async t => {
  await bridge();
  const job = await putJob(1, { status: "running" });
  const lines = capture(t);
  const before = new Set(process.listeners("SIGINT"));
  const done = jobs.launchAndMonitor(job, { openPage: false });
  let handler;
  while (!handler) {
    await new Promise(resolve => setImmediate(resolve));
    handler = process.listeners("SIGINT").find(listener => !before.has(listener));
  }
  handler();
  await done;
  assert.match(lines.join(""), new RegExp(`Stopped monitoring[\\s\\S]*resume ${id(1)}`));
  assert.equal((await store.readJob(id(1))).status, "running");
  assert.deepEqual(new Set(process.listeners("SIGINT")), before, "the handler is removed");
});

test("a finished repair job is verified before it is reported", async t => {
  await bridge();
  const job = await putJob(1, { status: "running" });
  const lines = capture(t);
  lines.onLine = line => {
    if (announced(line)) {
      // A repair job whose source file is gone from the Downloads root and whose copy was never made.
      store.jobs().write({
        ...job,
        status: "complete",
        repairTargets: [{ basename: "a.jpg", rootPath: path.join(home, "nowhere", "a.jpg") }]
      });
    }
  };
  await jobs.launchAndMonitor(job, { openPage: false });
  assert.match(lines.join(""), /Status: incomplete/);
  assert.match(lines.join(""), /Repair source validation failed/);
  assert.equal(process.exitCode, 1);
});

test("startDownload needs an installed extension and no unfinished job", async () => {
  await assert.rejects(jobs.startDownload(PAGE), /Load the extension/);
  await store.writeJsonAtomic(store.EDGE_PROFILE_FILE, { profileDirectory: "Default" });
  await assert.rejects(jobs.startDownload(PAGE), /Load the extension/, "no bridge config yet");
  await install();
  await putJob(1, { status: "running" });
  await store.writeJsonAtomic(store.QUEUE_FILE, { jobId: id(1) });
  await assert.rejects(jobs.startDownload(PAGE), new RegExp(`Job ${id(1)} is still running`));
  await assert.rejects(jobs.startDownload("https://example.com/x"), /Job .* is still running/);
});

test("startDownload queues the job, makes it the active one and monitors it", async t => {
  await install();
  const lines = capture(t);
  const running = jobs.startDownload(PAGE, 4);
  // Finish the job as soon as its file exists.
  for (;;) {
    const [job] = await store.listJobs();
    const queue = await store.readJson(store.QUEUE_FILE);
    if (job && queue) {
      assert.equal(job.limit, 4);
      assert.equal(queue.jobId, job.jobId);
      await store.updateJob(job.jobId, current => {
        current.status = "complete";
      });
      break;
    }
    await store.sleep(5);
  }
  await running;
  assert.match(lines.join(""), /Instagram\/alice \(limit 4 files\)/);
});

test("resumeJob refuses unknown, finished and competing jobs", async () => {
  await assert.rejects(jobs.resumeJob(), /No job was found to resume/);
  await assert.rejects(jobs.resumeJob(id(1)), /No job was found to resume/);
  await putJob(1, { status: "complete" });
  await assert.rejects(jobs.resumeJob(id(1)), /already complete/);
  await putJob(2, { status: "running" });
  await store.writeJsonAtomic(store.QUEUE_FILE, { jobId: id(2) });
  await assert.rejects(jobs.resumeJob(id(1)), new RegExp(`Job ${id(2)} is still running; finish or pause it`));
});

test("resuming the running active job just reconnects without opening a page", async t => {
  await bridge();
  await putJob(1, { status: "running" });
  await store.writeJsonAtomic(store.QUEUE_FILE, { jobId: id(1) });
  const lines = capture(t);
  lines.onLine = line => announced(line) && finishWith(id(1), { status: "complete" })();
  await jobs.resumeJob();
  assert.match(lines.join(""), /Watching Instagram\/alice/);
});

test("resuming a paused job queues it again and opens the browser", async t => {
  await install();
  await putJob(1, { status: "paused", message: "old" });
  let seen;
  const lines = capture(t);
  lines.onLine = line => {
    if (announced(line)) {
      seen = readNow(id(1));
      finishWith(id(1), { status: "complete" })();
    }
  };
  await jobs.resumeJob(id(1));
  assert.equal(seen.status, "queued");
  assert.equal(seen.message, "Resuming the saved profile scan.");
  assert.equal((await store.readJson(store.QUEUE_FILE)).jobId, id(1));
  assert.match(lines.join(""), /Opening Instagram\/alice/);
});

const readNow = jobId => store.jobs().read(jobId);

test("printJob and the job list cope with jobs that lack a site, account, message or dates", async t => {
  const lines = capture(t);
  printJob({ jobId: id(1), status: "queued", account: "alice" });
  printJob({ jobId: id(1), status: "queued", platform: "Instagram" });
  assert.match(lines.join(""), /Account: \/alice\n[\s\S]*Account: Instagram\/\n/);

  lines.length = 0;
  await store.writeJob({ jobId: id(2), status: "paused", createdAt: "2026-01-02" });
  await store.writeJob({ jobId: id(3), status: "paused", updatedAt: "2026-02-02" });
  await store.writeJob({ jobId: id(4), status: "paused" });
  await showStatus();
  assert.equal(lines[0], "Jobs: 3 paused\n");
  const order = lines.slice(1).map(line => line.split("  ")[0]);
  assert.equal(order.length, 3);
  assert.ok(order.indexOf(id(3)) < order.indexOf(id(2)), "the job updated last comes first");
  assert.match(
    lines.find(line => line.startsWith(id(4))),
    /paused {6}\/ {2}\n$/
  );
});
