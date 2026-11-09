// Where the CLI keeps its files, and how it reads and writes them.
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
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
// %LOCALAPPDATA% on Windows; the home folder elsewhere, so `help` and the "Windows only" messages still work.
export const APP_DIR = path.join(process.env.LOCALAPPDATA || process.env.USERPROFILE || os.homedir(), "PageMediaSaver");
export const JOBS_DIR = path.join(APP_DIR, "jobs");

// Job ids are random UUIDs made by this CLI. Anything else (a bridge message, a command-line
// argument, an edited queue file) must never reach a file path, so "../x" cannot leave JOBS_DIR.
const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isJobId = value => typeof value === "string" && JOB_ID.test(value);
export function jobFile(jobId) {
  if (!isJobId(jobId)) {
    throw new Error(`Invalid job id: ${String(jobId).slice(0, 40)}`);
  }
  return path.join(JOBS_DIR, `${jobId}.json`);
}
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

// Every saved job, newest first. A job file that cannot be read is skipped, not fatal.
export async function listJobs() {
  const entries = await readdir(JOBS_DIR, { withFileTypes: true }).catch(() => []);
  const jobs = [];
  for (const entry of entries) {
    const id = entry.name.replace(/\.json$/, "");
    if (!entry.isFile() || !entry.name.endsWith(".json") || !isJobId(id)) {
      continue;
    }
    const job = await readJson(path.join(JOBS_DIR, entry.name)).catch(() => null);
    if (job?.jobId === id) {
      jobs.push(job);
    }
  }
  return jobs.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

// Changes to one job file are applied one at a time, so two writers (the bridge answering the
// extension and the supervisor timing a job out) can never overwrite each other's update.
const jobLocks = new Map();

export function updateJob(jobId, mutate) {
  const file = jobFile(jobId);
  const previous = jobLocks.get(jobId) || Promise.resolve();
  const run = previous.then(async () => {
    const job = await readJson(file);
    if (!job) {
      return null;
    }
    const next = (await mutate(job)) || job;
    next.updatedAt = new Date().toISOString();
    await writeJsonAtomic(file, next);
    return next;
  });
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  jobLocks.set(jobId, settled);
  settled.then(() => {
    if (jobLocks.get(jobId) === settled) {
      jobLocks.delete(jobId);
    }
  });
  return run;
}

export async function getActiveJob() {
  const queue = await readJson(QUEUE_FILE);
  if (!queue?.jobId) {
    return null;
  }
  return readJson(jobFile(queue.jobId));
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
