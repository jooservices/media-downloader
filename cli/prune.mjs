// Keeps a long-running queue small: finished jobs and old logs are removed after a retention period.
// The newest job of every URL is always kept, because `watch` uses it to decide when to scan again.
import { readdir, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { JOBS_DB_FILE, LOGS_DIR, TERMINAL_STATES, deleteJob, listJobs } from "./store.mjs";

const { mediaFound } = createRequire(import.meta.url)("../lib/platform-health.js");
const HEALTH_FINISHED_STATES = new Set(["complete", "incomplete", "error"]);
const canaryKey = job =>
  `${String(job.platform || "").toLowerCase()}|${String(job.account || "unknown").toLowerCase()}`;

const DAY_MS = 24 * 60 * 60 * 1000;
export const JOB_RETENTION_MS = 30 * DAY_MS;
export const LOG_RETENTION_MS = 14 * DAY_MS;
export const PRUNE_EVERY_MS = 60 * 60 * 1000;

export function expiredJobs(jobs, now, retentionMs = JOB_RETENTION_MS) {
  const newest = new Map();
  const newestProductive = new Map();
  const recentCanaryJobs = new Map();
  const touchedAt = job => String(job.updatedAt || job.createdAt || "");
  for (const job of jobs) {
    const seen = newest.get(job.url);
    if (!seen || String(job.createdAt) > String(seen.createdAt)) {
      newest.set(job.url, job);
    }
    if (HEALTH_FINISHED_STATES.has(job.status) && mediaFound(job) > 0) {
      const key = canaryKey(job);
      const productive = newestProductive.get(key);
      if (!productive || touchedAt(job) > touchedAt(productive)) {
        newestProductive.set(key, job);
      }
    }
    if (HEALTH_FINISHED_STATES.has(job.status) && job.platform && job.account) {
      const key = canaryKey(job);
      const recent = recentCanaryJobs.get(key) || [];
      recent.push(job);
      recentCanaryJobs.set(key, recent);
    }
  }
  const canaryHistory = [...recentCanaryJobs.entries()].flatMap(([key, accountJobs]) =>
    newestProductive.has(key) ? accountJobs.sort((a, b) => touchedAt(b).localeCompare(touchedAt(a))).slice(0, 3) : []
  );
  const retained = new Set([...newest.values(), ...newestProductive.values(), ...canaryHistory]);
  return jobs.filter(job => {
    const touched = Date.parse(job.updatedAt || job.createdAt || 0);
    return (
      TERMINAL_STATES.has(job.status) && !retained.has(job) && Number.isFinite(touched) && now - touched > retentionMs
    );
  });
}

async function removeOldLogs(now, retentionMs) {
  let removed = 0;
  for (const name of await readdir(LOGS_DIR).catch(() => [])) {
    const file = path.join(LOGS_DIR, name);
    const info = await stat(file).catch(() => null);
    if (
      info?.isFile() &&
      now - info.mtimeMs > retentionMs &&
      (await unlink(file).then(
        () => true,
        () => false
      ))
    ) {
      removed++;
    }
  }
  return removed;
}

export async function prune(now = Date.now()) {
  let jobs = 0;
  for (const job of expiredJobs(await listJobs(), now)) {
    if (await deleteJob(job.jobId)) {
      jobs++;
    }
  }
  return { jobs, logs: await removeOldLogs(now, LOG_RETENTION_MS), dir: JOBS_DB_FILE };
}
