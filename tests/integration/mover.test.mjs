import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parseConfig } from "../../cli/config.mjs";
import { cleanOrphanedPartials, moveFinishedFiles } from "../../cli/mover.mjs";
import { createSupervisor } from "../../cli/supervisor.mjs";

const NOW = Date.now();
const OLD = new Date(NOW - 60_000);

async function area() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pms-mover-"));
  return { source: path.join(root, "Downloads"), dest: path.join(root, "Media"), root };
}

async function put(file, text, when = OLD) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  await utimes(file, when, when);
}

const names = async directory => (await readdir(directory).catch(() => [])).sort();

test("moves settled files to <dest>/<site>/<account>/ and removes the empty folder", async () => {
  const { source, dest } = await area();
  await put(path.join(source, "Instagram", "alice", "a.jpg"), "photo");
  await put(path.join(source, "Twitter", "bob", "v.mp4"), "video");

  const result = await moveFinishedFiles({ sourceRoot: source, destRoot: dest, now: NOW });
  assert.equal(result.moved, 2);
  assert.equal(await readFile(path.join(dest, "Instagram", "alice", "a.jpg"), "utf8"), "photo");
  assert.equal(await readFile(path.join(dest, "Twitter", "bob", "v.mp4"), "utf8"), "video");
  assert.deepEqual(await names(path.join(source, "Instagram")), [], "the empty account folder is gone");
});

test("leaves files that are still being written or downloaded", async () => {
  const { source, dest } = await area();
  await put(path.join(source, "Instagram", "alice", "fresh.jpg"), "x", new Date(NOW - 1000));
  await put(path.join(source, "Instagram", "alice", "big.mp4.crdownload"), "partial");
  await put(path.join(source, "Instagram", "alice", "ok.jpg"), "done");

  const result = await moveFinishedFiles({ sourceRoot: source, destRoot: dest, now: NOW });
  assert.equal(result.moved, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual(await names(path.join(source, "Instagram", "alice")), ["big.mp4.crdownload", "fresh.jpg"]);
});

test("startup cleanup removes only stale mover partials and preserves unrelated or active files", async () => {
  const { dest } = await area();
  const account = path.join(dest, "Instagram", "alice");
  await put(
    path.join(account, ".pms-mover-123e4567-e89b-12d3-a456-426614174000.part"),
    "stale",
    new Date(NOW - 2 * 60 * 60 * 1000)
  );
  await put(path.join(account, ".pms-mover-123e4567-e89b-12d3-a456-426614174001.part"), "active", new Date(NOW - 1000));
  await put(path.join(account, "project.tmp"), "user data");
  await put(path.join(account, "video.mp4.crdownload"), "browser download");
  await put(path.join(account, "complete.jpg"), "media");
  assert.equal(await cleanOrphanedPartials(dest, { now: NOW }), 1);
  assert.deepEqual(await names(account), [
    ".pms-mover-123e4567-e89b-12d3-a456-426614174001.part",
    "complete.jpg",
    "project.tmp",
    "video.mp4.crdownload"
  ]);
});

test("a destination share that disappears leaves the source in place for a later pass", async () => {
  const { source, dest } = await area();
  const original = path.join(source, "Instagram", "alice", "photo.jpg");
  await put(original, "photo");
  const paused = await moveFinishedFiles({
    sourceRoot: source,
    destRoot: dest,
    now: NOW,
    resolveDestination: async () => {
      const error = new Error("network path was not found");
      error.code = "ENOENT";
      throw error;
    }
  });
  assert.equal(paused.failed, 1);
  assert.equal(await readFile(original, "utf8"), "photo");

  const resumed = await moveFinishedFiles({ sourceRoot: source, destRoot: dest, now: NOW });
  assert.equal(resumed.moved, 1);
  assert.equal(await readFile(path.join(dest, "Instagram", "alice", "photo.jpg"), "utf8"), "photo");
});

test("a destination that disappears during a copy is reported unavailable to the supervisor", async () => {
  const { source, dest } = await area();
  const original = path.join(source, "Instagram", "alice", "photo.jpg");
  await put(original, "photo");
  const result = await moveFinishedFiles({
    sourceRoot: source,
    destRoot: dest,
    now: NOW,
    copyFileImpl: async () => {
      const error = new Error("share went away");
      error.code = "EIO";
      throw error;
    }
  });
  assert.equal(result.destinationAvailable, false);
  assert.equal(await readFile(original, "utf8"), "photo");
});

test("the supervisor holds queued jobs when the real mover reports a missing destination", async () => {
  const { source, dest } = await area();
  const job = { jobId: "job-1", platform: "Instagram", account: "alice", status: "queued", attempts: 0 };
  const opened = [];
  const supervisor = createSupervisor({
    now: () => Date.now(),
    random: () => 0,
    log: () => {},
    loadConfig: async () => parseConfig({ delaySeconds: { min: 0, max: 0 }, downloadDir: dest }),
    listJobs: async () => [job],
    updateJob: async (id, mutate) => mutate(job),
    openJob: async current => opened.push(current.jobId),
    moveFiles: async destRoot =>
      moveFinishedFiles({
        sourceRoot: source,
        destRoot,
        resolveDestination: async () => {
          const error = new Error("share unavailable");
          error.code = "ENODEV";
          throw error;
        }
      })
  });
  await supervisor.tick();
  assert.deepEqual(opened, []);
  assert.equal(job.status, "queued");
});

test("disk-full errors remove the temporary copy and preserve the original for retry", async () => {
  const { source, dest } = await area();
  const original = path.join(source, "Instagram", "alice", "photo.jpg");
  await put(original, "photo");
  const full = await moveFinishedFiles({
    sourceRoot: source,
    destRoot: dest,
    now: NOW,
    copyFileImpl: async () => {
      const error = new Error("no space left on device");
      error.code = "ENOSPC";
      throw error;
    }
  });
  assert.equal(full.failed, 1);
  assert.equal(await readFile(original, "utf8"), "photo");
  assert.deepEqual(await names(path.join(dest, "Instagram", "alice")), []);

  const retried = await moveFinishedFiles({ sourceRoot: source, destRoot: dest, now: NOW });
  assert.equal(retried.moved, 1);
});

test("the final filename stays absent until a verified temporary copy is renamed", async () => {
  const { source, dest } = await area();
  const original = path.join(source, "Instagram", "alice", "photo.jpg");
  const final = path.join(dest, "Instagram", "alice", "photo.jpg");
  await put(original, "complete photo");
  let copyReady;
  const ready = new Promise(resolve => {
    copyReady = resolve;
  });
  let finishCopy;
  const blocked = new Promise(resolve => {
    finishCopy = resolve;
  });
  const moving = moveFinishedFiles({
    sourceRoot: source,
    destRoot: dest,
    now: NOW,
    copyFileImpl: async (_from, temporary) => {
      await writeFile(temporary, "partial");
      copyReady();
      await blocked;
      await writeFile(temporary, "complete photo");
    }
  });
  await ready;
  await assert.rejects(() => stat(final), { code: "ENOENT" });
  finishCopy();
  assert.equal((await moving).moved, 1);
  assert.equal(await readFile(final, "utf8"), "complete photo");
});

test("a file already in the destination with the same size is a duplicate: the source is dropped", async () => {
  const { source, dest } = await area();
  await put(path.join(dest, "Instagram", "alice", "a.jpg"), "same!");
  await put(path.join(source, "Instagram", "alice", "a.jpg"), "same!");

  const result = await moveFinishedFiles({ sourceRoot: source, destRoot: dest, now: NOW });
  assert.equal(result.duplicates, 1);
  assert.equal(result.moved, 0);
  assert.deepEqual(await names(path.join(dest, "Instagram", "alice")), ["a.jpg"]);
});

test("a different file with the same name is kept under a new name, never overwritten", async () => {
  const { source, dest } = await area();
  await put(path.join(dest, "Instagram", "alice", "a.jpg"), "original");
  await put(path.join(source, "Instagram", "alice", "a.jpg"), "a different photo");

  const result = await moveFinishedFiles({ sourceRoot: source, destRoot: dest, now: NOW });
  assert.equal(result.moved, 1);
  assert.deepEqual(await names(path.join(dest, "Instagram", "alice")), ["a (1).jpg", "a.jpg"]);
  assert.equal(await readFile(path.join(dest, "Instagram", "alice", "a.jpg"), "utf8"), "original");
});

test("overlapping mover passes serialize filename selection and preserve both files", async () => {
  const first = await area();
  const second = await area();
  await put(path.join(first.source, "Instagram", "alice", "photo.jpg"), "first");
  await put(path.join(second.source, "Instagram", "alice", "photo.jpg"), "second");
  await Promise.all([
    moveFinishedFiles({ sourceRoot: first.source, destRoot: first.dest, now: NOW }),
    moveFinishedFiles({ sourceRoot: second.source, destRoot: first.dest, now: NOW })
  ]);
  assert.deepEqual(await names(path.join(first.dest, "Instagram", "alice")), ["photo (1).jpg", "photo.jpg"]);
  assert.deepEqual(
    await Promise.all([
      readFile(path.join(first.dest, "Instagram", "alice", "photo.jpg"), "utf8"),
      readFile(path.join(first.dest, "Instagram", "alice", "photo (1).jpg"), "utf8")
    ]).then(values => values.sort()),
    ["first", "second"]
  );
});

test("an unavailable destination keeps the source for a later mover pass", async () => {
  const { source, dest } = await area();
  const original = path.join(source, "Instagram", "alice", "photo.jpg");
  await put(original, "photo");
  await mkdir(path.join(dest, "Instagram"), { recursive: true });
  await writeFile(path.join(dest, "Instagram", "alice"), "blocks the share folder");

  const paused = await moveFinishedFiles({ sourceRoot: source, destRoot: dest, now: NOW });
  assert.equal(paused.failed, 1);
  assert.equal(await readFile(original, "utf8"), "photo");

  await rm(path.join(dest, "Instagram", "alice"));
  const resumed = await moveFinishedFiles({ sourceRoot: source, destRoot: dest, now: NOW });
  assert.equal(resumed.moved, 1);
  assert.equal(await readFile(path.join(dest, "Instagram", "alice", "photo.jpg"), "utf8"), "photo");
});

test("refuses a destination that is, contains or sits inside the Downloads folder", async () => {
  const { source } = await area();
  for (const dest of [source, path.join(source, "Moved"), path.dirname(source)]) {
    await assert.rejects(() => moveFinishedFiles({ sourceRoot: source, destRoot: dest, now: NOW }), /must not be/);
  }
});

test("same name and size but different bytes is not a duplicate: the source is moved under a new name", async () => {
  const { source, dest } = await area();
  await put(path.join(dest, "Instagram", "alice", "photo.jpg"), "AAAAA");
  await put(path.join(source, "Instagram", "alice", "photo.jpg"), "BBBBB");

  const result = await moveFinishedFiles({ sourceRoot: source, destRoot: dest, now: NOW });
  assert.equal(result.duplicates, 0);
  assert.equal(result.moved, 1);
  assert.deepEqual(await names(path.join(dest, "Instagram", "alice")), ["photo (1).jpg", "photo.jpg"]);
  assert.equal(await readFile(path.join(dest, "Instagram", "alice", "photo (1).jpg"), "utf8"), "BBBBB");
});

test("a destination that is a link to the Downloads folder is refused before anything is deleted", async t => {
  const { source, root } = await area();
  await put(path.join(source, "Instagram", "alice", "a.jpg"), "data");
  const alias = path.join(root, "Alias");
  try {
    await symlink(source, alias, "junction");
  } catch {
    t.skip("this system does not allow creating links");
    return;
  }
  await assert.rejects(() => moveFinishedFiles({ sourceRoot: source, destRoot: alias, now: NOW }), /must not be/);
  assert.equal(await readFile(path.join(source, "Instagram", "alice", "a.jpg"), "utf8"), "data");
});

test("an account folder in the destination that links into the Downloads folder is reported, not moved into", async t => {
  const { source, dest } = await area();
  await put(path.join(source, "Instagram", "alice", "a.jpg"), "data");
  await mkdir(path.join(dest, "Instagram"), { recursive: true });
  try {
    await symlink(path.join(source, "Instagram", "alice"), path.join(dest, "Instagram", "alice"), "junction");
  } catch {
    t.skip("this system does not allow creating links");
    return;
  }
  const result = await moveFinishedFiles({ sourceRoot: source, destRoot: dest, now: NOW });
  assert.equal(result.moved + result.duplicates, 0);
  assert.equal(result.failed, 1);
  assert.equal(await readFile(path.join(source, "Instagram", "alice", "a.jpg"), "utf8"), "data");
});

test("only the three site folders are touched", async () => {
  const { source, dest } = await area();
  await put(path.join(source, "Documents", "x", "keep.txt"), "mine");
  await put(path.join(source, "report.pdf"), "mine");
  await put(path.join(source, "Facebook", "carol", "p.jpg"), "p");

  const result = await moveFinishedFiles({ sourceRoot: source, destRoot: dest, now: NOW });
  assert.equal(result.moved, 1);
  assert.deepEqual(await names(source), ["Documents", "Facebook", "report.pdf"], "only Facebook was emptied");
  assert.deepEqual(await names(path.join(source, "Documents", "x")), ["keep.txt"]);
});

test("a site folder that is a link (already redirected elsewhere) is left alone", async t => {
  const { source, dest, root } = await area();
  const elsewhere = path.join(root, "Elsewhere");
  await put(path.join(elsewhere, "alice", "a.jpg"), "data");
  await mkdir(source, { recursive: true });
  try {
    await symlink(elsewhere, path.join(source, "Instagram"), "junction");
  } catch {
    t.skip("this system does not allow creating links");
    return;
  }
  const result = await moveFinishedFiles({ sourceRoot: source, destRoot: dest, now: NOW });
  assert.equal(result.moved, 0);
  assert.equal((await stat(path.join(elsewhere, "alice", "a.jpg"))).size, 4);
});
