// Keeps a long-running queue small: finished jobs and old logs are removed after a retention period.
// The newest job of every URL is always kept, because `watch` uses it to decide when to scan again.
import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { JOBS_DIR, LOGS_DIR, TERMINAL_STATES, jobFile, listJobs } from "./store.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
export const JOB_RETENTION_MS = 30 * DAY_MS;
export const LOG_RETENTION_MS = 14 * DAY_MS;
export const PRUNE_EVERY_MS = 60 * 60 * 1000;

export function expiredJobs(jobs, now, retentionMs = JOB_RETENTION_MS) {
  const newest = new Map();
  for (const job of jobs) {
    const seen = newest.get(job.url);
    if (!seen || String(job.createdAt) > String(seen.createdAt)) {
      newest.set(job.url, job);
    }
  }
  return jobs.filter(job => {
    const touched = Date.parse(job.updatedAt || job.createdAt || 0);
    return (
      TERMINAL_STATES.has(job.status) &&
      newest.get(job.url) !== job &&
      Number.isFinite(touched) &&
      now - touched > retentionMs
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
    if (
      await unlink(jobFile(job.jobId)).then(
        () => true,
        () => false
      )
    ) {
      jobs++;
    }
  }
  return { jobs, logs: await removeOldLogs(now, LOG_RETENTION_MS), dir: JOBS_DIR };
}
