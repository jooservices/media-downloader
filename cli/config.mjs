// The CLI's settings file. The rules themselves live in lib/config.js, shared with the extension.
import { createRequire } from "node:module";
import { CONFIG_FILE, readJson, writeJsonAtomic } from "./store.mjs";

const require = createRequire(import.meta.url);
export const { PLATFORM_NAMES, MAX_WORKERS, DEFAULT_CONFIG, parseConfig } = require("../lib/config.js");

// PMS_DOWNLOAD_DIR is the download folder when config.json does not name one (a container's media volume).
export async function loadConfig() {
  const raw = await readJson(CONFIG_FILE);
  const fallback = process.env.PMS_DOWNLOAD_DIR;
  return parseConfig(fallback && !raw?.downloadDir ? { ...raw, downloadDir: fallback } : raw);
}

// Writes a config.json with the defaults so the options are discoverable, but never overwrites one.
export async function ensureConfigFile() {
  // A file that exists but cannot be parsed or read is the user's to fix: the error surfaces instead of the defaults replacing it.
  if (await readJson(CONFIG_FILE)) {
    return false;
  }
  await writeJsonAtomic(CONFIG_FILE, DEFAULT_CONFIG);
  return true;
}
