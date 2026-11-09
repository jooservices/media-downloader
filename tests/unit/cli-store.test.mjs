import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// The CLI keeps its files under %LOCALAPPDATA%\PageMediaSaver; point it at a temp folder before importing.
const home = await mkdtemp(path.join(os.tmpdir(), "pms-store-"));
process.env.LOCALAPPDATA = home;
process.env.USERPROFILE = home;
const store = await import("../../cli/store.mjs");
const config = await import("../../cli/config.mjs");
const prune = await import("../../cli/prune.mjs");
const { DEFAULT_LIMIT, parseDownloadArgs } = await import("../../cli/args.mjs");

after(() => {
  store.closeJobStore();
  return rm(home, { recursive: true, force: true });
});

const reset = () => store.removeAppData();
const DAY = 24 * 60 * 60 * 1000;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("the app folder lives under LOCALAPPDATA and every file sits inside it", () => {
  assert.equal(store.APP_DIR, path.join(home, "PageMediaSaver"));
  for (const file of [
    store.QUEUE_FILE,
    store.CONFIG_FILE,
    store.DAEMON_FILE,
    store.API_TOKEN_FILE,
    store.JOBS_DB_FILE
  ]) {
    assert.equal(path.dirname(file), store.APP_DIR);
  }
  assert.equal(store.EXTENSION_ROOT, path.resolve("."));
  assert.deepEqual([...store.TERMINAL_STATES].sort(), ["complete", "error", "incomplete", "paused"]);
});

test("readJson returns null for a missing file and throws for a broken one", async () => {
  await reset();
  assert.equal(await store.readJson(path.join(store.APP_DIR, "missing.json")), null);
  await mkdir(store.APP_DIR, { recursive: true });
  const broken = path.join(store.APP_DIR, "broken.json");
  await writeFile(broken, "{ nope");
  await assert.rejects(store.readJson(broken), SyntaxError);
});

test("writeJsonAtomic creates folders, writes pretty JSON and leaves no temp file", async () => {
  await reset();
  const file = path.join(store.APP_DIR, "deep", "x.json");
  await store.writeJsonAtomic(file, { a: 1 });
  await store.writeJsonAtomic(file, { a: 2 });
  assert.equal(await readFile(file, "utf8"), '{\n  "a": 2\n}\n');
  assert.deepEqual(await readdir(path.dirname(file)), ["x.json"]);
});

test("writeJsonAtomic reports a rename that can never succeed and cleans its temp file", async () => {
  await reset();
  const target = path.join(store.APP_DIR, "target");
  await mkdir(target, { recursive: true }); // a folder cannot be replaced by a file
  await assert.rejects(store.writeJsonAtomic(target, { a: 1 }));
  assert.deepEqual(await readdir(store.APP_DIR), ["target"]);
});

test("listJobs returns newest first; saving a job again replaces it", async () => {
  await reset();
  await store.writeJob({ jobId: id(1), createdAt: "2026-01-01T00:00:00Z" });
  await store.writeJob({ jobId: id(2), createdAt: "2026-03-01T00:00:00Z" });
  await store.writeJob({ jobId: id(3) }); // no createdAt sorts last
  await store.writeJob({ jobId: id(1), createdAt: "2026-02-01T00:00:00Z" }); // the same job saved again
  assert.deepEqual(
    (await store.listJobs()).map(job => job.jobId),
    [id(2), id(1), id(3)]
  );
  await reset();
  assert.deepEqual(await store.listJobs(), [], "no jobs folder is an empty list");
});

test("updateJob applies concurrent changes one at a time and stamps updatedAt", async () => {
  await reset();
  await store.writeJob({ jobId: id(1), count: 0, updatedAt: "old" });
  await Promise.all(
    Array.from({ length: 12 }, () =>
      store.updateJob(id(1), async job => {
        const seen = job.count;
        await store.sleep(1);
        job.count = seen + 1;
      })
    )
  );
  const job = await store.readJob(id(1));
  assert.equal(job.count, 12, "no update was lost");
  assert.notEqual(job.updatedAt, "old");
});

test("updateJob can replace the job, ignores a missing job, and survives a failing mutation", async () => {
  await reset();
  assert.equal(await store.updateJob(id(1), () => assert.fail("never called")), null);
  await store.writeJob({ jobId: id(1), status: "queued" });
  const replaced = await store.updateJob(id(1), () => ({ jobId: id(1), status: "running" }));
  assert.equal(replaced.status, "running");
  await assert.rejects(
    store.updateJob(id(1), () => {
      throw new Error("boom");
    }),
    /boom/
  );
  const final = await store.updateJob(id(1), job => {
    job.status = "complete";
  });
  assert.equal(final.status, "complete", "the next update still runs");
  assert.throws(() => store.updateJob("../x", () => {}), /Invalid job id/);
});

test("getActiveJob follows the queue file to its job", async () => {
  await reset();
  assert.equal(await store.getActiveJob(), null);
  await store.writeJsonAtomic(store.QUEUE_FILE, { updatedAt: "x" });
  assert.equal(await store.getActiveJob(), null, "a queue file without a job id is ignored");
  await store.writeJob({ jobId: id(1), status: "running" });
  await store.writeJsonAtomic(store.QUEUE_FILE, { jobId: id(1) });
  assert.equal((await store.getActiveJob()).status, "running");
});

test("ensureApiToken makes one random token, keeps it, and replaces an empty file", async () => {
  await reset();
  const token = await store.ensureApiToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(await store.ensureApiToken(), token);
  assert.equal((await readFile(store.API_TOKEN_FILE, "utf8")).trim(), token);
  await writeFile(store.API_TOKEN_FILE, "  \n");
  const fresh = await store.ensureApiToken();
  assert.match(fresh, /^[0-9a-f]{64}$/);
  assert.notEqual(fresh, token);
});

test("ensureApiToken secures a pre-existing empty token file before writing the secret on POSIX", async t => {
  if (process.platform === "win32") {
    return t.skip("POSIX permission bits are not available on Windows");
  }
  await reset();
  await mkdir(store.APP_DIR, { recursive: true });
  await writeFile(store.API_TOKEN_FILE, "", { mode: 0o644 });
  await chmod(store.API_TOKEN_FILE, 0o644);
  const token = await store.ensureApiToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal((await stat(store.API_TOKEN_FILE)).mode & 0o777, 0o600);
  assert.equal((await readFile(store.API_TOKEN_FILE, "utf8")).trim(), token);
});

test("ensureApiToken surfaces an unreadable token file instead of replacing it", async () => {
  await reset();
  await mkdir(store.API_TOKEN_FILE, { recursive: true }); // reading a folder fails with EISDIR
  await assert.rejects(store.ensureApiToken(), error => error.code === "EISDIR");
});

test("URL helpers shared with the extension are re-exported", () => {
  assert.equal(store.normalizeProfileUrl("https://x.com/Alice/").platform, "Twitter");
  assert.ok(Array.isArray(store.accountPages("https://x.com/alice")));
  assert.equal(typeof store.cliTabMarker(id(1)), "string");
  assert.equal(store.isSignInPage("https://x.com/i/flow/login"), true);
  assert.equal(typeof store.cleanPathPart("a/b"), "string");
});

test("config: a missing file gives the defaults, a saved one is validated", async () => {
  await reset();
  assert.deepEqual(await config.loadConfig(), config.parseConfig(null));
  await store.writeJsonAtomic(store.CONFIG_FILE, { limit: 5, workers: { x: 2 } });
  const loaded = await config.loadConfig();
  assert.equal(loaded.limit, 5);
  assert.equal(loaded.workers.Twitter, 2);
  await store.writeJsonAtomic(store.CONFIG_FILE, { limit: 0 });
  await assert.rejects(config.loadConfig(), /limit/);
});

test("ensureConfigFile writes the defaults once and never overwrites", async () => {
  await reset();
  assert.equal(await config.ensureConfigFile(), true);
  assert.deepEqual(await store.readJson(store.CONFIG_FILE), JSON.parse(JSON.stringify(config.DEFAULT_CONFIG)));
  await store.writeJsonAtomic(store.CONFIG_FILE, { limit: 7 });
  assert.equal(await config.ensureConfigFile(), false);
  assert.deepEqual(await store.readJson(store.CONFIG_FILE), { limit: 7 });
  assert.equal(config.MAX_WORKERS, 8);
  assert.ok(config.PLATFORM_NAMES.includes("Instagram"));
});

test("prune removes old finished jobs and logs, keeping the newest job of each URL", async () => {
  await reset();
  const now = Date.now();
  const put = async (n, url, status, daysAgo) => {
    const stamp = new Date(now - daysAgo * DAY).toISOString();
    await store.writeJob({
      jobId: id(n),
      url,
      status,
      createdAt: stamp,
      updatedAt: stamp
    });
  };
  await put(1, "u1", "complete", 90);
  await put(2, "u1", "complete", 60);
  await put(3, "u1", "complete", 2);
  await put(4, "u2", "running", 90);
  await put(5, "u3", "error", 40);
  await put(6, "u3", "complete", 3);
  const logs = path.join(store.APP_DIR, "logs");
  await mkdir(path.join(logs, "folder"), { recursive: true });
  const stale = new Date(now - 20 * DAY);
  await writeFile(path.join(logs, "old.log"), "x");
  await utimes(path.join(logs, "old.log"), stale, stale);
  await writeFile(path.join(logs, "new.log"), "x");

  const result = await prune.prune(now);
  assert.equal(result.jobs, 3);
  assert.equal(result.logs, 1);
  assert.equal(result.dir, store.JOBS_DB_FILE);
  assert.deepEqual((await store.listJobs()).map(job => job.jobId).sort(), [id(3), id(4), id(6)]);
  assert.deepEqual((await readdir(logs)).sort(), ["folder", "new.log"]);
  assert.deepEqual(await prune.prune(now), { jobs: 0, logs: 0, dir: store.JOBS_DB_FILE });
  assert.ok(prune.JOB_RETENTION_MS > prune.LOG_RETENTION_MS);
  assert.equal(prune.PRUNE_EVERY_MS, 3600_000);
});

test("prune copes with no folders at all and jobs with unparsable dates", async () => {
  await reset();
  assert.deepEqual(await prune.prune(), { jobs: 0, logs: 0, dir: store.JOBS_DB_FILE });
  await store.writeJob({
    jobId: id(1),
    url: "u",
    status: "complete",
    createdAt: "2020-01-01",
    updatedAt: "garbage"
  });
  await store.writeJob({
    jobId: id(2),
    url: "u",
    status: "complete",
    createdAt: "2026-06-01"
  });
  const expired = prune.expiredJobs(await store.listJobs(), Date.parse("2026-11-09")).map(job => job.jobId);
  assert.deepEqual(expired, [], "the newest job of a URL stays, and a date that cannot be read is never old");
  assert.ok(await store.readJob(id(1)), "nothing was removed");
});

test("download args: URL, default limit, --limit N, --limit=N and --unlimited", () => {
  assert.deepEqual(parseDownloadArgs(["https://x.com/a"]), { url: "https://x.com/a", limit: DEFAULT_LIMIT });
  assert.equal(parseDownloadArgs(["--limit", "25", "u"]).limit, 25);
  assert.equal(parseDownloadArgs(["u", "--limit=3"]).limit, 3);
  assert.equal(parseDownloadArgs(["--unlimited", "u"]).limit, null);
  assert.deepEqual(parseDownloadArgs([]), { url: null, limit: DEFAULT_LIMIT });
});

test("download args reject bad limits, duplicates and extra arguments", () => {
  for (const bad of [["--limit"], ["--limit", "0"], ["--limit=abc"], ["--limit", "2.5"], ["--limit="]]) {
    assert.throws(() => parseDownloadArgs(["u", ...bad]), /--limit needs a whole number/, bad.join(" "));
  }
  assert.throws(() => parseDownloadArgs(["--limit", "2", "--unlimited"]), /only one of/);
  assert.throws(() => parseDownloadArgs(["--limit=2", "--limit=3"]), /only one of/);
  assert.throws(() => parseDownloadArgs(["--unlimited", "--limit", "x"]), /only one of/);
  assert.throws(() => parseDownloadArgs(["a", "b"]), /Unexpected argument: b/);
});

test("jobs from the old one-file-per-job layout are imported once and the folder is kept as a backup", async () => {
  await reset();
  await mkdir(store.JOBS_DIR, { recursive: true });
  const put = (name, text) => writeFile(path.join(store.JOBS_DIR, name), text);
  await put(`${id(1)}.json`, JSON.stringify({ jobId: id(1), status: "complete", createdAt: "2026-01-01" }));
  await put(`${id(2)}.json`, JSON.stringify({ jobId: id(1), status: "complete" })); // wrong id inside
  await put(`${id(3)}.json`, "{ broken");
  await put("notes.json", "{}");
  await put("readme.txt", "x");
  await mkdir(path.join(store.JOBS_DIR, `${id(6)}.json`));
  assert.deepEqual(
    (await store.listJobs()).map(job => job.jobId),
    [id(1)]
  );
  await assert.rejects(stat(store.JOBS_DIR), "the old folder is renamed, not left to be read again");
  assert.ok((await stat(`${store.JOBS_DIR}.imported`)).isDirectory());
  store.closeJobStore();
  assert.equal((await store.listJobs()).length, 1, "a second start does not import again");
});

test("the job store pages, filters, counts, updates one job at a time and deletes", async () => {
  await reset();
  const jobs = store.jobs();
  for (const n of [1, 2, 3, 4]) {
    jobs.write({ jobId: id(n), status: n % 2 ? "complete" : "running", createdAt: `2026-01-0${n}` });
  }
  assert.equal(jobs.count(), 4);
  assert.equal(jobs.count({ status: "running" }), 2);
  assert.deepEqual(jobs.counts(), { complete: 2, running: 2 });
  jobs.write({ jobId: id(5), createdAt: "2026-01-05" });
  assert.equal(jobs.counts().unknown, 1, "a job without a status is counted as unknown");
  jobs.remove(id(5));
  assert.deepEqual(
    jobs.list({ status: "complete" }).map(job => job.jobId),
    [id(3), id(1)]
  );
  assert.deepEqual(
    jobs.list({ limit: 2, offset: 1 }).map(job => job.jobId),
    [id(3), id(2)]
  );
  assert.equal(jobs.read(id(2).toUpperCase()).jobId, id(2), "ids are case-insensitive");
  assert.equal(jobs.read(id(9)), null);
  assert.equal(await jobs.update(id(9), job => job), null, "updating a job that is gone changes nothing");
  assert.equal(jobs.remove(id(9)), false);
  assert.equal(jobs.remove(id(1)), true);
  assert.equal(jobs.count(), 3);
  assert.equal(jobs.file, store.JOBS_DB_FILE);
});

test("closeJobStore lets the store open again, and the database can be copied while it is closed", async () => {
  await reset();
  await store.writeJob({ jobId: id(1), status: "queued" });
  store.closeJobStore();
  store.closeJobStore(); // closing twice is harmless
  assert.equal((await store.readJob(id(1))).status, "queued");
});
