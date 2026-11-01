// Where the CLI keeps its files, and how it reads and writes them.
import { createRequire } from "node:module";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Rules shared with the extension live in lib/ so the CLI and Edge never disagree.
export const { normalizeProfileUrl } = require("../lib/urls.js");
export const { cleanPart: cleanPathPart } = require("../lib/paths.js");
export const EXTENSION_ROOT = path.resolve(HERE, "..");
export const APP_DIR = path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE, "PageMediaSaver");
export const JOBS_DIR = path.join(APP_DIR, "jobs");

// Job ids are random UUIDs made by this CLI. Anything else (a bridge message, a command-line
// argument, an edited queue file) must never reach a file path, so "../x" cannot leave JOBS_DIR.
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isJobId = value => typeof value === "string" && JOB_ID.test(value);
export function jobFile(jobId) {
  if (!isJobId(jobId)) throw new Error(`Invalid job id: ${String(jobId).slice(0, 40)}`);
  return path.join(JOBS_DIR, `${jobId}.json`);
}
export const QUEUE_FILE = path.join(APP_DIR, "active-job.json");
export const EDGE_PROFILE_FILE = path.join(APP_DIR, "edge-profile.json");
export const BRIDGE_CONFIG_FILE = path.join(APP_DIR, "bridge-config.json");
export const REPAIR_MANIFEST_FILE = path.join(APP_DIR, "repair-root-manifest.json");
export const BRIDGE_PORT = 38541;
export const TERMINAL_STATES = new Set(["complete", "incomplete", "paused", "error"]);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tempPath, filePath);
}

export async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

export async function getActiveJob() {
  const queue = await readJson(QUEUE_FILE);
  if (!queue?.jobId) return null;
  return readJson(jobFile(queue.jobId));
}
