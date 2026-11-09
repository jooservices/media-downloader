// Moves finished downloads out of Edge's Downloads folder into the folder the user chose.
// A browser extension may only save inside the browser's own Downloads folder, so the CLI
// relocates the files afterwards. Nothing is deleted until its copy has been checked.
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  stat,
  unlink
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { readJson } from "./store.mjs";

const require = createRequire(import.meta.url);
export const SITE_FOLDERS = require("../lib/sites.js").names();
const UNFINISHED = /\.(crdownload|tmp|part|download)$/i;
const DEFAULT_SETTLE_MS = 15_000;
const ORPHAN_AGE_MS = 60 * 60_000;
const OWNED_PARTIAL = /^\.pms-mover-[0-9a-f-]{36}\.part$/i;
const COMPARE_CHUNK = 1024 * 1024;
const OVERLAP_MESSAGE = "The download folder must not be the browser's Downloads folder or sit inside it.";
const moveLocks = new Map();

// At startup, no mover copy from this queue is active, so any remaining temporary file is orphaned.
export async function cleanOrphanedPartials(root, { now = Date.now(), maxAgeMs = ORPHAN_AGE_MS } = {}) {
  let removed = 0;
  const visit = async directory => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile() && OWNED_PARTIAL.test(entry.name)) {
        const info = await stat(file);
        if (maxAgeMs === 0 || now - info.mtimeMs >= maxAgeMs) {
          await unlink(file);
          removed++;
        }
      }
    }
  };
  await visit(root);
  return removed;
}

// Where Edge saves downloads for this profile (its setting, else the standard Downloads folder).
// A preferences file that cannot be read is an error only when no folder was found in the other one: guessing the
// standard Downloads folder then would send the mover to the wrong place.
export async function edgeDownloadsDir(userDataDir, profileDirectory) {
  let unreadable = null;
  for (const file of ["Preferences", "Secure Preferences"]) {
    let prefs = null;
    try {
      prefs = await readJson(path.join(userDataDir, profileDirectory, file));
    } catch (error) {
      unreadable ??= error;
    }
    const dir = prefs?.download?.default_directory;
    if (typeof dir === "string" && path.win32.isAbsolute(dir)) {
      return dir;
    }
  }
  if (unreadable) {
    throw new Error(`Cannot tell where the browser saves downloads: ${unreadable.message}`);
  }
  return path.join(os.homedir(), "Downloads");
}

// Firefox stores the chosen folder in prefs.js. Otherwise it uses the normal Downloads folder.
export async function firefoxDownloadDir(profilePath) {
  try {
    const text = await readFile(path.join(profilePath, "prefs.js"), "utf8");
    const match = text.match(/user_pref\("browser\.download\.dir", "(.*)"\);/);
    if (match) {
      return JSON.parse(`"${match[1]}"`);
    }
  } catch {
    /* no prefs file, or no custom folder */
  }
  return path.join(os.homedir(), "Downloads");
}

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const isInside = (child, parent) => {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};
const overlaps = (a, b) => samePath(a, b) || isInside(a, b) || isInside(b, a);

// The real location of a path that may not exist yet: links resolved on its deepest existing ancestor.
async function realLocation(target) {
  const pending = [];
  let current = path.resolve(target);
  for (;;) {
    try {
      return path.join(await realpath(current), ...pending);
    } catch (error) {
      const parent = path.dirname(current);
      if (error?.code !== "ENOENT" || parent === current) {
        throw error;
      }
      pending.unshift(path.basename(current));
      current = parent;
    }
  }
}

// True when both files hold the same bytes.
async function sameContents(a, b) {
  const [first, second] = [await open(a, "r"), await open(b, "r")];
  try {
    const one = Buffer.allocUnsafe(COMPARE_CHUNK);
    const two = Buffer.allocUnsafe(COMPARE_CHUNK);
    for (;;) {
      const [x, y] = [await first.read(one, 0, COMPARE_CHUNK, null), await second.read(two, 0, COMPARE_CHUNK, null)];
      if (x.bytesRead !== y.bytesRead || !one.subarray(0, x.bytesRead).equals(two.subarray(0, y.bytesRead))) {
        return false;
      }
      if (x.bytesRead === 0) {
        return true;
      }
    }
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
}

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

async function moveOne(from, toDirectory, name, result, copyFileImpl) {
  await mkdir(toDirectory, { recursive: true });
  const size = (await stat(from)).size;
  let target = path.join(toDirectory, name);
  const existing = await stat(target).catch(() => null);
  // Same name and size is not proof of a copy: different media can share a fallback name.
  if (existing?.size === size && (await sameContents(from, target))) {
    await unlink(from);
    result.duplicates++;
    return;
  }
  if (existing) {
    target = await freeName(toDirectory, name);
  }
  const temporary = path.join(toDirectory, `.pms-mover-${randomUUID()}.part`);
  try {
    await copyFileImpl(from, temporary, constants.COPYFILE_EXCL);
    if ((await stat(temporary)).size !== size || !(await sameContents(from, temporary))) {
      throw new Error(`Copy of ${name} is not the same as the original.`);
    }
    await rename(temporary, target);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  await unlink(from);
  result.moved++;
}

async function moveAccountFolder(source, destination, { now, settleMs, copyFileImpl }, result) {
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
      await moveOne(from, destination, entry.name, result, copyFileImpl);
    } catch (error) {
      result.failed++;
      result.errors.push(`${entry.name}: ${error?.message || error}`);
      const sourceStillExists = await stat(from).then(
        () => true,
        () => false
      );
      if (
        error &&
        ["EACCES", "EHOSTUNREACH", "ENETUNREACH", "ENODEV", "EIO", "ENOENT", "EPERM", "ETIMEDOUT"].includes(
          error.code
        ) &&
        (error.code !== "ENOENT" || sourceStillExists)
      ) {
        result.destinationAvailable = false;
      }
    }
  }
  await rmdir(source).catch(() => {});
}

// Moves every settled file in <sourceRoot>/<Site>/<account>/ to <destRoot>/<Site>/<account>/.
// A site folder that is a link (for example to a network share) already points elsewhere and is left alone.
async function moveFinishedFilesUnlocked({
  sourceRoot,
  destRoot,
  now = Date.now(),
  settleMs = DEFAULT_SETTLE_MS,
  copyFileImpl = copyFile,
  resolveDestination = realLocation
}) {
  const result = { moved: 0, duplicates: 0, skipped: 0, failed: 0, errors: [], destinationAvailable: true };
  if (overlaps(sourceRoot, destRoot)) {
    throw new Error(OVERLAP_MESSAGE);
  }
  // A junction or symlink can make the destination another name for the source: compare where they really are.
  const realSource = await realLocation(sourceRoot);
  let realDestination;
  try {
    realDestination = await resolveDestination(destRoot);
  } catch (error) {
    return {
      moved: 0,
      duplicates: 0,
      skipped: 0,
      failed: 1,
      errors: [
        `${destRoot}: destination is unavailable; the source files were left in place (${error?.message || error}).`
      ],
      destinationAvailable: false
    };
  }
  if (overlaps(realSource, realDestination)) {
    throw new Error(OVERLAP_MESSAGE);
  }
  for (const site of SITE_FOLDERS) {
    const siteDir = path.join(sourceRoot, site);
    const info = await lstat(siteDir).catch(() => null);
    if (!info?.isDirectory()) {
      continue;
    }
    const accounts = await readdir(siteDir, { withFileTypes: true });
    for (const account of accounts.filter(entry => entry.isDirectory())) {
      const destination = path.join(destRoot, site, account.name);
      let realAccountDestination;
      try {
        realAccountDestination = await resolveDestination(destination);
      } catch (error) {
        result.failed++;
        result.errors.push(
          `${site}/${account.name}: destination is unavailable; files remain in Downloads (${error?.message || error}).`
        );
        result.destinationAvailable = false;
        continue;
      }
      if (overlaps(realSource, realAccountDestination)) {
        result.failed++;
        result.errors.push(`${site}/${account.name}: the destination folder is a link into the Downloads folder.`);
        continue;
      }
      await moveAccountFolder(path.join(siteDir, account.name), destination, { now, settleMs, copyFileImpl }, result);
    }
  }
  return result;
}

// A manual `move` can overlap a queue pass. Serialize the same source/destination pair so two
// workers cannot both choose and publish the same final filename.
export function moveFinishedFiles(options) {
  const key = path.resolve(options.destRoot).toLowerCase();
  const previous = moveLocks.get(key) || Promise.resolve();
  const run = previous.then(() => moveFinishedFilesUnlocked(options));
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  moveLocks.set(key, settled);
  settled.then(() => {
    if (moveLocks.get(key) === settled) {
      moveLocks.delete(key);
    }
  });
  return run;
}
