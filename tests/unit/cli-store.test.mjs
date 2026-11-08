import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
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

after(() => rm(home, { recursive: true, force: true }));

const reset = () => rm(store.APP_DIR, { recursive: true, force: true });
const DAY = 24 * 60 * 60 * 1000;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("the app folder lives under LOCALAPPDATA and every file sits inside it", () => {
  assert.equal(store.APP_DIR, path.join(home, "PageMediaSaver"));
  for (const file of [store.QUEUE_FILE, store.CONFIG_FILE, store.DAEMON_FILE, store.API_TOKEN_FILE, store.JOBS_DIR]) {
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

test("listJobs returns newest first and skips foreign, mismatched and unreadable files", async () => {
  await reset();
  await store.writeJsonAtomic(store.jobFile(id(1)), { jobId: id(1), createdAt: "2026-01-01T00:00:00Z" });
  await store.writeJsonAtomic(store.jobFile(id(2)), { jobId: id(2), createdAt: "2026-03-01T00:00:00Z" });
  await store.writeJsonAtomic(store.jobFile(id(3)), { jobId: id(3) }); // no createdAt sorts last
  await store.writeJsonAtomic(store.jobFile(id(4)), { jobId: id(1), createdAt: "2026-02-01T00:00:00Z" }); // wrong id inside
  await writeFile(store.jobFile(id(5)), "{ broken");
  await writeFile(path.join(store.JOBS_DIR, "notes.json"), "{}");
  await writeFile(path.join(store.JOBS_DIR, "readme.txt"), "x");
  await mkdir(path.join(store.JOBS_DIR, `${id(6)}.json`));
  assert.deepEqual(
    (await store.listJobs()).map(job => job.jobId),
    [id(2), id(1), id(3)]
  );
  await reset();
  assert.deepEqual(await store.listJobs(), [], "no jobs folder is an empty list");
});

test("updateJob applies concurrent changes one at a time and stamps updatedAt", async () => {
  await reset();
  await store.writeJsonAtomic(store.jobFile(id(1)), { jobId: id(1), count: 0, updatedAt: "old" });
  await Promise.all(
    Array.from({ length: 12 }, () =>
      store.updateJob(id(1), async job => {
        const seen = job.count;
        await store.sleep(1);
        job.count = seen + 1;
      })
    )
  );
  const job = await store.readJson(store.jobFile(id(1)));
  assert.equal(job.count, 12, "no update was lost");
  assert.notEqual(job.updatedAt, "old");
});

test("updateJob can replace the job, ignores a missing job, and survives a failing mutation", async () => {
  await reset();
  assert.equal(await store.updateJob(id(1), () => assert.fail("never called")), null);
  await store.writeJsonAtomic(store.jobFile(id(1)), { jobId: id(1), status: "queued" });
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
  await store.writeJsonAtomic(store.jobFile(id(1)), { jobId: id(1), status: "running" });
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
    await store.writeJsonAtomic(store.jobFile(id(n)), {
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
  assert.equal(result.dir, store.JOBS_DIR);
  assert.deepEqual((await store.listJobs()).map(job => job.jobId).sort(), [id(3), id(4), id(6)]);
  assert.deepEqual((await readdir(logs)).sort(), ["folder", "new.log"]);
  assert.deepEqual(await prune.prune(now), { jobs: 0, logs: 0, dir: store.JOBS_DIR });
  assert.ok(prune.JOB_RETENTION_MS > prune.LOG_RETENTION_MS);
  assert.equal(prune.PRUNE_EVERY_MS, 3600_000);
});

test("prune copes with no folders at all and jobs with unparsable dates", async () => {
  await reset();
  assert.deepEqual(await prune.prune(), { jobs: 0, logs: 0, dir: store.JOBS_DIR });
  await store.writeJsonAtomic(store.jobFile(id(1)), {
    jobId: id(1),
    url: "u",
    status: "complete",
    createdAt: "2020-01-01",
    updatedAt: "garbage"
  });
  await store.writeJsonAtomic(store.jobFile(id(2)), {
    jobId: id(2),
    url: "u",
    status: "complete",
    createdAt: "2026-06-01"
  });
  const expired = prune.expiredJobs(await store.listJobs(), Date.parse("2026-11-09")).map(job => job.jobId);
  assert.deepEqual(expired, [], "the newest job of a URL stays, and a date that cannot be read is never old");
  assert.ok((await stat(store.jobFile(id(1)))).isFile());
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
