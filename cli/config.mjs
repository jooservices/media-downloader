// User settings: how many pages each site may scan at once, the pause between accounts, and
// where finished files are moved. Read from %LOCALAPPDATA%\PageMediaSaver\config.json.
import path from "node:path";
import { CONFIG_FILE, readJson, writeJsonAtomic } from "./store.mjs";

export const PLATFORM_NAMES = ["Twitter", "Instagram", "Facebook"];
export const MAX_WORKERS = 8;

export const DEFAULT_CONFIG = Object.freeze({
  workers: Object.freeze({ Twitter: 1, Instagram: 1, Facebook: 1 }),
  delaySeconds: Object.freeze({ min: 15, max: 60 }),
  maxAttempts: 3,
  downloadDir: null
});

// "x" and "twitter" name the same site; the extension and the job files call it Twitter.
const PLATFORM_ALIASES = new Map([
  ["twitter", "Twitter"],
  ["x", "Twitter"],
  ["instagram", "Instagram"],
  ["facebook", "Facebook"]
]);

const isWholeNumber = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

function parseWorkers(raw) {
  const workers = { ...DEFAULT_CONFIG.workers };
  for (const [key, value] of Object.entries(raw ?? {})) {
    const platform = PLATFORM_ALIASES.get(key.toLowerCase());
    if (!platform) {
      throw new Error(`workers: unknown site “${key}”. Use x, instagram or facebook.`);
    }
    if (!isWholeNumber(value, 1, MAX_WORKERS)) {
      throw new Error(`workers.${key} must be a whole number from 1 to ${MAX_WORKERS}.`);
    }
    workers[platform] = value;
  }
  return workers;
}

function parseDelay(raw) {
  const delay = { ...DEFAULT_CONFIG.delaySeconds, ...(raw ?? {}) };
  const valid = [delay.min, delay.max].every(value => Number.isFinite(value) && value >= 0 && value <= 3600);
  if (!valid || delay.min > delay.max) {
    throw new Error("delaySeconds needs min and max between 0 and 3600, with min not above max.");
  }
  return { min: delay.min, max: delay.max };
}

// A drive root or the Windows folder would be a dangerous place to move files into.
function parseDownloadDir(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return null;
  }
  if (typeof raw !== "string" || !path.win32.isAbsolute(raw) || raw.includes("\0")) {
    throw new Error("downloadDir must be a full path such as D:\\Media or \\\\nas\\share\\Media.");
  }
  const normalized = trimTrailingSeparators(path.win32.normalize(raw));
  if (normalized.length === 2 && normalized[1] === ":") {
    throw new Error("downloadDir cannot be the root of a drive; choose a folder such as D:\\Media.");
  }
  const system = [`${normalized.slice(0, 3)}windows`, `${normalized.slice(0, 3)}program files`].map(name =>
    name.toLowerCase()
  );
  const lower = normalized.toLowerCase();
  if (
    normalized[1] === ":" &&
    system.some(name => lower === name || lower.startsWith(`${name}\\`) || lower.startsWith(`${name} (x86)`))
  ) {
    throw new Error("downloadDir cannot be inside the Windows or Program Files folders.");
  }
  return normalized;
}

function trimTrailingSeparators(value) {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "\\" || value[end - 1] === "/")) {
    end--;
  }
  return value.slice(0, end);
}

// Turns whatever the user wrote into a complete, valid config, or explains exactly what is wrong.
export function parseConfig(raw) {
  if (raw !== null && raw !== undefined && (typeof raw !== "object" || Array.isArray(raw))) {
    throw new Error("config.json must contain a JSON object.");
  }
  const input = raw ?? {};
  const maxAttempts = input.maxAttempts ?? DEFAULT_CONFIG.maxAttempts;
  if (!isWholeNumber(maxAttempts, 1, 20)) {
    throw new Error("maxAttempts must be a whole number from 1 to 20.");
  }
  return {
    workers: parseWorkers(input.workers),
    delaySeconds: parseDelay(input.delaySeconds),
    maxAttempts,
    downloadDir: parseDownloadDir(input.downloadDir)
  };
}

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
