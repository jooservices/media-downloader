// The accounts that are scanned again from time to time. One URL per line in watch.txt, shared by
// `serve`, the loopback API and the MCP server, so an account is added the same way from any of them.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { APP_DIR, accountPages, listJobs } from "./store.mjs";

const require = createRequire(import.meta.url);
const { RESCAN_MS, urlsDue } = require("../lib/watch.js");

export const DEFAULT_WATCH = path.join(APP_DIR, "watch.txt");

const sameUrl = (a, b) => a.toLowerCase() === b.toLowerCase();

export async function readWatchList(file = DEFAULT_WATCH) {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith("https://"));
}

// Adds every page of each account that is not listed yet. Returns what was added and what was already there.
export async function addWatch(urls, file = DEFAULT_WATCH) {
  const known = await readWatchList(file);
  const added = [];
  const existing = [];
  for (const page of urls.flatMap(url => accountPages(url))) {
    const bucket = [...known, ...added].some(item => sameUrl(item, page)) ? existing : added;
    bucket.push(page);
  }
  if (added.length) {
    await mkdir(path.dirname(file), { recursive: true });
    await appendFile(file, `${added.join("\n")}\n`);
  }
  return { added, existing };
}

// Stops watching an account (all its pages). Returns the pages that were removed.
export async function removeWatch(url, file = DEFAULT_WATCH) {
  const drop = accountPages(url);
  const kept = [];
  const removed = [];
  for (const line of await readWatchList(file)) {
    (drop.some(page => sameUrl(page, line)) ? removed : kept).push(line);
  }
  if (removed.length) {
    await writeFile(file, kept.length ? `${kept.join("\n")}\n` : "");
  }
  return removed;
}

// Watched pages whose last scan is old enough to run again.
export async function watchDue(file = DEFAULT_WATCH, now = Date.now()) {
  return urlsDue(await listJobs(), await readWatchList(file), now, RESCAN_MS);
}
