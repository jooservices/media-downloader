// Moves finished downloads out of Edge's Downloads folder into the folder the user chose.
// A browser extension may only save inside the browser's own Downloads folder, so the CLI
// relocates the files afterwards. Nothing is deleted until its copy has been checked.
import { copyFile, lstat, mkdir, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson } from "./store.mjs";

export const SITE_FOLDERS = ["Instagram", "Facebook", "Twitter"];
const UNFINISHED = /\.(crdownload|tmp|part|download)$/i;
const DEFAULT_SETTLE_MS = 15_000;

// Where Edge saves downloads for this profile (its setting, else the standard Downloads folder).
export async function edgeDownloadsDir(userDataDir, profileDirectory) {
  for (const file of ["Preferences", "Secure Preferences"]) {
    const prefs = await readJson(path.join(userDataDir, profileDirectory, file)).catch(() => null);
    const dir = prefs?.download?.default_directory;
    if (typeof dir === "string" && path.win32.isAbsolute(dir)) {
      return dir;
    }
  }
  return path.join(os.homedir(), "Downloads");
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isInside = (child, parent) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

// "name.jpg" -> "name (1).jpg", "name (2).jpg", ... until a free name is found.
async function freeName(directory, name) {
  const { name: stem, ext } = path.parse(name);
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(directory, `${stem} (${n})${ext}`);
    if (!(await stat(candidate).catch(() => null))) {
      return candidate;
    }
  }
  throw new Error(`No free file name for ${name}`);
}

async function moveOne(from, toDirectory, name, result) {
  await mkdir(toDirectory, { recursive: true });
  const size = (await stat(from)).size;
  let target = path.join(toDirectory, name);
  const existing = await stat(target).catch(() => null);
  if (existing?.size === size) {
    await unlink(from);
    result.duplicates++;
    return;
  }
  if (existing) {
    target = await freeName(toDirectory, name);
  }
  await copyFile(from, target, constants.COPYFILE_EXCL);
  if ((await stat(target)).size !== size) {
    await unlink(target).catch(() => {});
    throw new Error(`Copy of ${name} is not the same size as the original.`);
  }
  await unlink(from);
  result.moved++;
}

async function moveAccountFolder(source, destination, { now, settleMs }, result) {
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    if (!entry.isFile() || UNFINISHED.test(entry.name)) {
      continue;
    }
    if (now - (await stat(from)).mtimeMs < settleMs) {
      result.skipped++;
      continue;
    }
    try {
      await moveOne(from, destination, entry.name, result);
    } catch (error) {
      result.failed++;
      result.errors.push(`${entry.name}: ${error?.message || error}`);
    }
  }
  await rmdir(source).catch(() => {});
}

// Moves every settled file in <sourceRoot>/<Site>/<account>/ to <destRoot>/<Site>/<account>/.
// A site folder that is a link (for example to a network share) already points elsewhere and is left alone.
export async function moveFinishedFiles({ sourceRoot, destRoot, now = Date.now(), settleMs = DEFAULT_SETTLE_MS }) {
  const result = { moved: 0, duplicates: 0, skipped: 0, failed: 0, errors: [] };
  if (samePath(sourceRoot, destRoot) || isInside(destRoot, sourceRoot) || isInside(sourceRoot, destRoot)) {
    throw new Error("The download folder must not be the browser's Downloads folder or sit inside it.");
  }
  for (const site of SITE_FOLDERS) {
    const siteDir = path.join(sourceRoot, site);
    const info = await lstat(siteDir).catch(() => null);
    if (!info?.isDirectory()) {
      continue;
    }
    const accounts = await readdir(siteDir, { withFileTypes: true });
    for (const account of accounts.filter(entry => entry.isDirectory())) {
      await moveAccountFolder(
        path.join(siteDir, account.name),
        path.join(destRoot, site, account.name),
        { now, settleMs },
        result
      );
    }
  }
  return result;
}
