import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, stat, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { moveFinishedFiles } from "../../cli/mover.mjs";

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
