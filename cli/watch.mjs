// `watch`: the same queue as `serve`, plus a list of accounts that are scanned again after a few
// hours so new stories, highlights, reels and photos are picked up. Files already saved stay skipped.
import { appendFile, mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { APP_DIR, accountPages, listJobs } from "./store.mjs";
import { readUrlFile, serve } from "./serve.mjs";

const require = createRequire(import.meta.url);
const { RESCAN_MS, urlsDue } = require("../lib/watch.js");

export const DEFAULT_WATCH = path.join(APP_DIR, "watch.txt");

export async function addToWatch(urls) {
  if (!urls.length) {
    throw new Error("Give at least one profile URL: node cli/mediasaver.mjs watch add <url> [<url>...]");
  }
  const pages = urls.flatMap(url => accountPages(url));
  await mkdir(path.dirname(DEFAULT_WATCH), { recursive: true });
  await appendFile(DEFAULT_WATCH, `${pages.join("\n")}\n`);
  process.stdout.write(`Watching ${pages.length} page(s). Start the loop with: node cli/mediasaver.mjs watch\n`);
  for (const page of pages) {
    process.stdout.write(`  ${page}\n`);
  }
}

export function watch() {
  return serve({
    inbox: DEFAULT_WATCH,
    dueUrls: async () => urlsDue(await listJobs(), await readUrlFile(DEFAULT_WATCH), Date.now(), RESCAN_MS)
  });
}
