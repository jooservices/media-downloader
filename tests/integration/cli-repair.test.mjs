import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach, beforeEach } from "node:test";

// Never the real Downloads folder or queue: both live in a temp folder, set before the CLI is imported.
const home = await mkdtemp(path.join(os.tmpdir(), "pms-repair-"));
process.env.LOCALAPPDATA = home;
process.env.USERPROFILE = home;
process.env.HOME = home;
const store = await import("../../cli/store.mjs");
const repair = await import("../../cli/repair.mjs");

const DOWNLOADS = path.join(home, "Downloads");
const ACCOUNT_DIR = path.join(DOWNLOADS, "Instagram", "alice");
const URL_ALICE = "https://www.instagram.com/alice/";
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");

after(() => {
  store.closeJobStore();
  return rm(home, { recursive: true, force: true });
});
beforeEach(async () => {
  await store.removeAppData();
  await rm(DOWNLOADS, { recursive: true, force: true });
});
afterEach(() => {
  process.exitCode = undefined;
  Object.defineProperty(process, "platform", realPlatform);
});

const asPlatform = value => Object.defineProperty(process, "platform", { ...realPlatform, value });

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

async function put(file, text = "image", when = new Date()) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  await utimes(file, when, when);
}
const exists = file =>
  stat(file).then(
    () => true,
    () => false
  );

// A repair job created a minute ago whose re-downloaded copies sit in the account folder.
function repairJob(names, extra = {}) {
  return {
    jobId: id(1),
    url: URL_ALICE,
    platform: "Instagram",
    account: "alice",
    status: "complete",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    repairTargets: names.map(name => ({ basename: name, rootPath: path.join(DOWNLOADS, name) })),
    repairFiles: names.map(name => ({ basename: name, filename: name })),
    ...extra
  };
}

test("every verified copy lets its original be removed, and the job is marked finalized", async () => {
  await put(path.join(DOWNLOADS, "a.jpg"));
  await put(path.join(DOWNLOADS, "b.png"));
  await put(path.join(ACCOUNT_DIR, "a.jpg"));
  await put(path.join(ACCOUNT_DIR, "b.png"));
  const result = await repair.finalizeRepairJob(repairJob(["a.jpg", "b.png"]));
  assert.equal(result.repairFinalized, true);
  assert.equal(result.repairVerified, 2);
  assert.equal(result.repairDeleted, 2);
  assert.equal(result.status, "complete");
  assert.match(result.message, /Redownloaded and verified 2 files in Downloads\/Instagram\/alice; removed 2 old root/);
  assert.equal(await exists(path.join(DOWNLOADS, "a.jpg")), false);
  assert.equal(await exists(path.join(ACCOUNT_DIR, "a.jpg")), true, "the new copy stays");
  assert.equal((await store.readJob(id(1))).repairFinalized, true);
});

test("a copy that is missing, empty, older than the job or unnamed keeps every original", async () => {
  const old = new Date(Date.now() - 3_600_000);
  const cases = {
    missing: async () => {},
    empty: async () => put(path.join(ACCOUNT_DIR, "a.jpg"), ""),
    stale: async () => put(path.join(ACCOUNT_DIR, "a.jpg"), "image", old),
    folder: async () => mkdir(path.join(ACCOUNT_DIR, "a.jpg"), { recursive: true })
  };
  for (const [name, setup] of Object.entries(cases)) {
    await rm(DOWNLOADS, { recursive: true, force: true });
    await put(path.join(DOWNLOADS, "a.jpg"));
    await setup();
    const result = await repair.finalizeRepairJob(repairJob(["a.jpg"]));
    assert.equal(result.status, "incomplete", name);
    assert.equal(result.repairVerified, 0, name);
    assert.equal(result.repairDeleted, 0, name);
    assert.equal(result.repairFinalized, undefined, name);
    assert.match(result.message, /verified 0 of 1 new destination files. All original files were retained/, name);
    assert.equal(await exists(path.join(DOWNLOADS, "a.jpg")), true, name);
  }
  const noOutput = repairJob(["a.jpg"], { repairFiles: [{ basename: "a.jpg" }] });
  await put(path.join(DOWNLOADS, "a.jpg"));
  assert.equal((await repair.finalizeRepairJob(noOutput)).repairVerified, 0, "no file name reported");
});

test("only some verified copies means nothing is removed", async () => {
  await put(path.join(DOWNLOADS, "a.jpg"));
  await put(path.join(DOWNLOADS, "b.jpg"));
  await put(path.join(ACCOUNT_DIR, "a.jpg"));
  const result = await repair.finalizeRepairJob(repairJob(["a.jpg", "b.jpg"]));
  assert.equal(result.status, "incomplete");
  assert.equal(result.repairVerified, 1);
  assert.match(result.message, /verified 1 of 2/);
  assert.equal(await exists(path.join(DOWNLOADS, "a.jpg")), true, "even the verified one stays");
});

test("a repair source outside the Downloads root is never trusted or deleted", async () => {
  const outside = path.join(home, "Elsewhere", "a.jpg");
  await put(outside);
  await put(path.join(ACCOUNT_DIR, "a.jpg"));
  const wrongFolder = repairJob(["a.jpg"], { repairTargets: [{ basename: "a.jpg", rootPath: outside }] });
  const nested = repairJob(["a.jpg"], {
    repairTargets: [{ basename: "a.jpg", rootPath: path.join(DOWNLOADS, "Instagram", "alice", "a.jpg") }]
  });
  const wrongName = repairJob(["a.jpg"], {
    repairTargets: [{ basename: "other.jpg", rootPath: path.join(DOWNLOADS, "a.jpg") }]
  });
  for (const job of [wrongFolder, nested, wrongName]) {
    const result = await repair.finalizeRepairJob(job);
    assert.equal(result.status, "incomplete");
    assert.match(result.message, /Repair source validation failed; all original files were retained/);
  }
  assert.equal(await exists(outside), true);
  assert.equal(await exists(path.join(ACCOUNT_DIR, "a.jpg")), true);
});

test("a job without targets is finalized with nothing to remove, and an original already gone is not counted", async () => {
  const none = await repair.finalizeRepairJob(repairJob([]));
  assert.equal(none.repairFinalized, true);
  assert.equal(none.repairDeleted, 0);

  await put(path.join(ACCOUNT_DIR, "gone.jpg")); // the original was never in Downloads
  const result = await repair.finalizeRepairJob(repairJob(["gone.jpg"]));
  assert.equal(result.repairVerified, 1);
  assert.equal(result.repairDeleted, 0, "nothing could be removed");
  assert.equal(result.repairFinalized, true);
});

test(
  "source and copy names are matched without regard to letter case",
  { skip: process.platform !== "win32" },
  async () => {
    await put(path.join(DOWNLOADS, "Photo.JPG"));
    await put(path.join(ACCOUNT_DIR, "photo.jpg"));
    const job = repairJob(["Photo.JPG"], { repairFiles: [{ basename: "photo.jpg", filename: "photo.jpg" }] });
    assert.equal((await repair.finalizeRepairJob(job)).repairDeleted, 1);
  }
);

test("verifying a repair by id needs an id, a repair job and a finished scan", async () => {
  await assert.rejects(repair.finalizeRepairById(""), /Provide the repair job ID/);
  await assert.rejects(repair.finalizeRepairById(id(1)), /No repair job was found/);
  await store.writeJob({ jobId: id(1), status: "complete" });
  await assert.rejects(repair.finalizeRepairById(id(1)), /No repair job was found/, "not a repair job");
  await store.writeJob(repairJob(["a.jpg"], { status: "running" }));
  await assert.rejects(repair.finalizeRepairById(id(1)), /is running; originals stay in Downloads/);
});

test("verifying a repair by id prints the result and sets the exit code from it", async t => {
  const lines = capture(t);
  await put(path.join(DOWNLOADS, "a.jpg"));
  await put(path.join(ACCOUNT_DIR, "a.jpg"));
  await store.writeJob(repairJob(["a.jpg"]));
  await repair.finalizeRepairById(id(1));
  assert.match(lines.join(""), /Redownloaded and verified 1 files/);
  assert.equal(process.exitCode, undefined);

  await rm(ACCOUNT_DIR, { recursive: true, force: true });
  await put(path.join(DOWNLOADS, "a.jpg"));
  await store.writeJob(repairJob(["a.jpg"]));
  await repair.finalizeRepairById(id(1));
  assert.match(lines.join(""), /Status: incomplete/);
  assert.equal(process.exitCode, 1);
});

async function installed() {
  await store.writeJsonAtomic(store.EDGE_PROFILE_FILE, { profileDirectory: "Default" });
  await store.writeJsonAtomic(store.BRIDGE_CONFIG_FILE, { extensionOrigin: "chrome-extension://x", port: 1 });
}
const group = (files, extra = {}) => ({ url: URL_ALICE, platform: "Instagram", account: "alice", files, ...extra });
const manifest = groups => store.writeJsonAtomic(store.REPAIR_MANIFEST_FILE, { jobs: groups });
const never = () => assert.fail("nothing should be launched");

test("root repair is Windows only", async () => {
  asPlatform("linux");
  await assert.rejects(repair.repairRootDownloads(never), /supported on Windows only/);
});

test("root repair needs the CLI installed, no unfinished job and a manifest with jobs", async () => {
  asPlatform("win32");
  await assert.rejects(repair.repairRootDownloads(never), /Run the CLI install command/);
  await store.writeJsonAtomic(store.EDGE_PROFILE_FILE, { profileDirectory: "Default" });
  await assert.rejects(repair.repairRootDownloads(never), /Run the CLI install command/, "no bridge yet");
  await installed();
  await assert.rejects(repair.repairRootDownloads(never), /No repair jobs were found/);
  await manifest([]);
  await assert.rejects(repair.repairRootDownloads(never), /No repair jobs were found/);
  await store.writeJsonAtomic(store.REPAIR_MANIFEST_FILE, { jobs: "nope" });
  await assert.rejects(repair.repairRootDownloads(never), /No repair jobs were found/);

  await store.writeJob({ jobId: id(9), status: "running" });
  await store.writeJsonAtomic(store.QUEUE_FILE, { jobId: id(9) });
  await assert.rejects(repair.repairRootDownloads(never), new RegExp(`Job ${id(9)} is still running`));
});

test("root repair refuses a manifest entry for another account or an unsafe file", async () => {
  asPlatform("win32");
  await installed();
  await put(path.join(DOWNLOADS, "a.jpg"));
  await manifest([group([{ rootPath: path.join(DOWNLOADS, "a.jpg") }], { account: "bob" })]);
  await assert.rejects(repair.repairRootDownloads(never), /account does not match/);
  await manifest([group([{ rootPath: path.join(DOWNLOADS, "a.jpg") }], { platform: "Twitter" })]);
  await assert.rejects(repair.repairRootDownloads(never), /account does not match/);

  for (const bad of [
    path.join(DOWNLOADS, "notes.txt"), // not a picture
    path.join(home, "a.jpg"), // not in the Downloads root
    "" // no path at all
  ]) {
    await manifest([group([{ basename: path.basename(bad), rootPath: bad }])]);
    await assert.rejects(repair.repairRootDownloads(never), /Rejected unsafe repair source path/, bad);
  }
  assert.equal(await exists(path.join(DOWNLOADS, "a.jpg")), true);
});

test("root repair skips groups with no files or whose files are already gone", async () => {
  asPlatform("win32");
  await installed();
  await manifest([
    group([]),
    group(undefined),
    group([{ basename: "gone.jpg", rootPath: path.join(DOWNLOADS, "gone.jpg") }])
  ]);
  await repair.repairRootDownloads(never);
  assert.equal(process.exitCode, undefined);
});

// Stands in for the browser: the "download" lands the copy in the account folder, then the job is finalized.
function fakeBrowser({ succeed }) {
  const launched = [];
  const launch = async job => {
    launched.push(JSON.parse(JSON.stringify(job)));
    if (!succeed) {
      return;
    }
    for (const target of job.repairTargets) {
      await put(path.join(ACCOUNT_DIR, target.basename));
    }
    const done = {
      ...job,
      status: "complete",
      repairFiles: job.repairTargets.map(target => ({ basename: target.basename, filename: target.basename }))
    };
    await store.writeJob(await repair.finalizeRepairJob(done));
  };
  return { launched, launch };
}

test("root repair queues one job per account, and removes the originals once verified", async () => {
  asPlatform("win32");
  await installed();
  await put(path.join(DOWNLOADS, "a.jpg"));
  await put(path.join(DOWNLOADS, "B.PNG"));
  await manifest([
    group([
      { basename: "a.jpg", rootPath: path.join(DOWNLOADS, "a.jpg") },
      { basename: "B.PNG", rootPath: path.join(DOWNLOADS, "B.PNG") },
      { basename: "missing.jpg", rootPath: path.join(DOWNLOADS, "missing.jpg") }
    ])
  ]);
  const { launched, launch } = fakeBrowser({ succeed: true });
  await repair.repairRootDownloads(launch);

  assert.equal(launched.length, 1);
  const [job] = launched;
  assert.equal(job.mode, "repair-root");
  assert.equal(job.status, "queued");
  assert.equal(job.url, URL_ALICE);
  assert.deepEqual(job.repairBasenames, ["a.jpg", "B.PNG"], "files that no longer exist are left out");
  assert.equal((await store.readJson(store.QUEUE_FILE)).jobId, job.jobId);
  assert.equal(process.exitCode, undefined);
  assert.equal(await exists(path.join(DOWNLOADS, "a.jpg")), false);
  assert.equal(await exists(path.join(DOWNLOADS, "B.PNG")), false);
  assert.equal(await exists(path.join(ACCOUNT_DIR, "a.jpg")), true);
});

test("root repair keeps the originals and fails the run when the copies never arrive", async () => {
  asPlatform("win32");
  await installed();
  await put(path.join(DOWNLOADS, "a.jpg"));
  await manifest([group([{ basename: "a.jpg", rootPath: path.join(DOWNLOADS, "a.jpg") }])]);
  const { launched, launch } = fakeBrowser({ succeed: false });
  await repair.repairRootDownloads(launch);
  assert.equal(launched.length, 1);
  assert.equal(process.exitCode, 1);
  assert.equal(await readFile(path.join(DOWNLOADS, "a.jpg"), "utf8"), "image");
});
