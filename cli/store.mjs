// Where the CLI keeps its files, and how it reads and writes them.
import { createRequire } from "node:module";
import { createJobStore } from "./jobstore.mjs";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Rules shared with the extension live in lib/ so the CLI and Edge never disagree.
export const { normalizeProfileUrl, accountPages, cliTabMarker, isSignInPage } = require("../lib/urls.js");
export const { cleanPart: cleanPathPart } = require("../lib/paths.js");
export const EXTENSION_ROOT = path.resolve(HERE, "..");
// PMS_DATA_DIR wins (a container volume, for instance); otherwise %LOCALAPPDATA% on Windows and the home folder
// elsewhere, so `help` and the "Windows only" messages still work.
export const APP_DIR =
  process.env.PMS_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || os.homedir(), "PageMediaSaver");
export const JOBS_DIR = path.join(APP_DIR, "jobs");

// Job ids are random UUIDs made by this CLI. Anything else (a bridge message, a command-line
// argument, an edited queue file) must never reach the database or a file path.
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isJobId = value => typeof value === "string" && JOB_ID.test(value);
export const QUEUE_FILE = path.join(APP_DIR, "active-job.json");
export const CONFIG_FILE = path.join(APP_DIR, "config.json");
export const DAEMON_FILE = path.join(APP_DIR, "daemon.json");
export const LOGS_DIR = path.join(APP_DIR, "logs");
export const EDGE_PROFILE_FILE = path.join(APP_DIR, "edge-profile.json");
export const BRIDGE_CONFIG_FILE = path.join(APP_DIR, "bridge-config.json");
export const REPAIR_MANIFEST_FILE = path.join(APP_DIR, "repair-root-manifest.json");
export const EXPECTED_VERSION_FILE = path.join(APP_DIR, "expected-extension-version");
export const API_TOKEN_FILE = path.join(APP_DIR, "api-token");
// PMS_BRIDGE_PORT lets tests run beside a live queue without touching its port.
export const BRIDGE_PORT = Number(process.env.PMS_BRIDGE_PORT) || 38541;
export const TERMINAL_STATES = new Set(["complete", "incomplete", "paused", "error"]);
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Windows briefly locks a file that an antivirus scanner or an indexer is reading, which makes
// the final rename fail with EPERM/EBUSY/EACCES. Those clear within moments, so retry a few times.
const TRANSIENT_RENAME_ERRORS = new Set(["EPERM", "EBUSY", "EACCES"]);
const RENAME_ATTEMPTS = 8;

async function renameWithRetry(from, to) {
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (!TRANSIENT_RENAME_ERRORS.has(error?.code) || attempt >= RENAME_ATTEMPTS) {
        await unlink(from).catch(() => {});
        throw error;
      }
      await sleep(25 * attempt);
    }
  }
}

export async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await renameWithRetry(tempPath, filePath);
}

export async function readJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

// The jobs live in queue.db (SQLite). Jobs saved by an older version, one JSON file each in jobs/, are imported
// the first time the database is opened.
export const JOBS_DB_FILE = path.join(APP_DIR, "queue.db");
let jobStore = null;
export function jobs() {
  jobStore ??= createJobStore({ file: JOBS_DB_FILE, legacyDir: JOBS_DIR });
  return jobStore;
}

// Every saved job, newest first.
export const listJobs = () => Promise.resolve().then(() => jobs().list());

export const readJob = jobId => Promise.resolve().then(() => (isJobId(jobId) ? jobs().read(jobId) : null));

export const writeJob = job =>
  Promise.resolve().then(() => {
    if (!isJobId(job?.jobId)) {
      throw new Error(`Invalid job id: ${String(job?.jobId).slice(0, 40)}`);
    }
    return jobs().write(job);
  });

export const deleteJob = jobId => Promise.resolve().then(() => (isJobId(jobId) ? jobs().remove(jobId) : false));

// Changes to one job are applied one at a time, so two writers (the bridge answering the extension and the
// supervisor timing a job out) can never overwrite each other's update.
export function updateJob(jobId, mutate) {
  if (!isJobId(jobId)) {
    throw new Error(`Invalid job id: ${String(jobId).slice(0, 40)}`);
  }
  return jobs().update(jobId, mutate);
}

export async function getActiveJob() {
  const queue = await readJson(QUEUE_FILE);
  if (!queue?.jobId) {
    return null;
  }
  if (!isJobId(queue.jobId)) {
    throw new Error(`Invalid job id: ${String(queue.jobId).slice(0, 40)}`);
  }
  return readJob(queue.jobId);
}

// The secret every API call except /health must carry. Created once, readable only by this user.
export async function ensureApiToken() {
  try {
    const existing = (await readFile(API_TOKEN_FILE, "utf8")).trim();
    if (existing) {
      return existing;
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
  const token = randomBytes(32).toString("hex");
  await mkdir(APP_DIR, { recursive: true });
  await writeFile(
    API_TOKEN_FILE,
    `${token}
`,
    { encoding: "utf8", mode: 0o600 }
  );
  return token;
}

// Releases the database file (tests remove the folder it lives in between runs).
export function closeJobStore() {
  jobStore?.close();
  jobStore = null;
}

// Removes everything the CLI keeps (used by tests and by a full uninstall).
export async function removeAppData() {
  closeJobStore();
  await rm(APP_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
