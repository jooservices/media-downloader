import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Only temp folders are read or written; the real Downloads folder and queue are never touched.
const home = await mkdtemp(path.join(os.tmpdir(), "pms-mover2-"));
process.env.LOCALAPPDATA = home;
const { edgeDownloadsDir, firefoxDownloadDir, moveFinishedFiles } = await import("../../cli/mover.mjs");

after(() => rm(home, { recursive: true, force: true }));

const fallback = path.join(os.homedir(), "Downloads");
const prefs = async (name, value, profile = "Default") => {
  const file = path.join(home, "edge", profile, name);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
};
const userData = () => path.join(home, "edge");

test("Edge's download folder comes from Preferences, then Secure Preferences", async () => {
  await rm(userData(), { recursive: true, force: true });
  await prefs("Preferences", { download: { default_directory: "D:\\Saved" } });
  assert.equal(await edgeDownloadsDir(userData(), "Default"), "D:\\Saved");

  await rm(userData(), { recursive: true, force: true });
  await prefs("Preferences", { download: {} });
  await prefs("Secure Preferences", { download: { default_directory: "E:\\Secure" } });
  assert.equal(await edgeDownloadsDir(userData(), "Default"), "E:\\Secure");
});

test("Edge's download folder ignores a relative or odd setting and falls back to Downloads", async () => {
  await rm(userData(), { recursive: true, force: true });
  assert.equal(await edgeDownloadsDir(userData(), "Default"), fallback, "no profile at all");
  await prefs("Preferences", { download: { default_directory: "relative\\path" } });
  await prefs("Secure Preferences", { download: { default_directory: 42 } });
  assert.equal(await edgeDownloadsDir(userData(), "Default"), fallback);
});

test("Edge's download folder is an error when a preferences file cannot be read and no other says where", async () => {
  await rm(userData(), { recursive: true, force: true });
  await prefs("Preferences", "{ broken");
  await assert.rejects(edgeDownloadsDir(userData(), "Default"), /Cannot tell where the browser saves downloads/);
  // The other file still answers.
  await prefs("Secure Preferences", { download: { default_directory: "F:\\Fine" } });
  assert.equal(await edgeDownloadsDir(userData(), "Default"), "F:\\Fine");
});

test("Firefox's download folder comes from prefs.js, with escapes decoded", async () => {
  const profile = path.join(home, "ff");
  await mkdir(profile, { recursive: true });
  const folder = "C:\\Users\\me\\My Downloads";
  await writeFile(
    path.join(profile, "prefs.js"),
    `user_pref("a.b", 1);\nuser_pref("browser.download.dir", ${JSON.stringify(folder)});\n`
  );
  assert.equal(await firefoxDownloadDir(profile), folder);
  await writeFile(path.join(profile, "prefs.js"), 'user_pref("a.b", 1);\n');
  assert.equal(await firefoxDownloadDir(profile), fallback, "no custom folder");
  assert.equal(await firefoxDownloadDir(path.join(home, "no-profile")), fallback, "no prefs file");
  await writeFile(path.join(profile, "prefs.js"), 'user_pref("browser.download.dir", "bad \\q escape");\n');
  assert.equal(await firefoxDownloadDir(profile), fallback, "an undecodable value");
});

async function area() {
  const root = await mkdtemp(path.join(home, "area-"));
  return { source: path.join(root, "Downloads"), dest: path.join(root, "Media") };
}
const OLD = new Date(Date.now() - 60_000);
async function put(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
  await utimes(file, OLD, OLD);
}

test("a file that cannot be moved is reported by name and the rest still move", async () => {
  const { source, dest } = await area();
  await put(path.join(source, "Instagram", "alice", "a.jpg"), "photo");
  await put(path.join(source, "Instagram", "bob", "b.jpg"), "photo2");
  // alice's destination is a file, so a folder cannot be made there.
  await mkdir(path.join(dest, "Instagram"), { recursive: true });
  await writeFile(path.join(dest, "Instagram", "alice"), "in the way");

  const result = await moveFinishedFiles({ sourceRoot: source, destRoot: dest });
  assert.equal(result.moved, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^a\.jpg: /);
  assert.equal(await readFile(path.join(source, "Instagram", "alice", "a.jpg"), "utf8"), "photo", "the original stays");
  assert.equal(await readFile(path.join(dest, "Instagram", "bob", "b.jpg"), "utf8"), "photo2");
});

test("a name clash that cannot be resolved fails that file and keeps it", async () => {
  const { source, dest } = await area();
  await put(path.join(source, "Twitter", "bob", "v.mp4"), "new video");
  const target = path.join(dest, "Twitter", "bob");
  await mkdir(target, { recursive: true });
  await writeFile(path.join(target, "v.mp4"), "different video");
  for (let n = 1; n < 1000; n++) {
    await writeFile(path.join(target, `v (${n}).mp4`), "x");
  }
  const result = await moveFinishedFiles({ sourceRoot: source, destRoot: dest });
  assert.equal(result.moved, 0);
  assert.equal(result.failed, 1);
  assert.match(result.errors[0], /No free file name for v\.mp4/);
  assert.equal(await readFile(path.join(source, "Twitter", "bob", "v.mp4"), "utf8"), "new video");
  assert.equal((await readdir(target)).length, 1000);
});

test("a destination under a plain file is refused without moving anything", async () => {
  const { source, dest } = await area();
  await put(path.join(source, "Instagram", "alice", "a.jpg"), "photo");
  await mkdir(path.dirname(dest), { recursive: true });
  await writeFile(dest, "not a folder");
  const outcome = await moveFinishedFiles({ sourceRoot: source, destRoot: path.join(dest, "inner") }).then(
    result => result,
    error => error
  );
  // Where the OS cannot tell, the move is attempted and fails per file; either way the original survives.
  assert.equal(await readFile(path.join(source, "Instagram", "alice", "a.jpg"), "utf8"), "photo");
  assert.ok(outcome instanceof Error || outcome.failed === 1, "refused or reported, never silently lost");
});
