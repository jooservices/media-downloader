// The CLI's settings file. The rules themselves live in lib/config.js, shared with the extension.
import { createRequire } from "node:module";
import { CONFIG_FILE, readJson, writeJsonAtomic } from "./store.mjs";

const require = createRequire(import.meta.url);
export const { PLATFORM_NAMES, MAX_WORKERS, DEFAULT_CONFIG, parseConfig } = require("../lib/config.js");

export async function loadConfig() {
  return parseConfig(await readJson(CONFIG_FILE));
}

// Writes a config.json with the defaults so the options are discoverable, but never overwrites one.
export async function ensureConfigFile() {
  if (await readJson(CONFIG_FILE).catch(() => null)) {
    return false;
  }
  await writeJsonAtomic(CONFIG_FILE, DEFAULT_CONFIG);
  return true;
}
