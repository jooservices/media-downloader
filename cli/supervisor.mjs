// The long-running part of the CLI: opens pages for waiting jobs (within the worker limits),
// retries jobs that failed for a transient reason, and moves finished files. All outside effects
// are passed in, so the rules can be tested without Edge.
import { pickJobsToOpen } from "./scheduler.mjs";

export const ACK_TIMEOUT_MS = 90_000;
export const STALE_RUNNING_MS = 15 * 60_000;
const RETRY_BACKOFF_MS = 60_000;
const MOVE_EVERY_MS = 20_000;
const NO_PROGRESS = ["started", "videoStarted"];

const isActive = job => job.status === "queued" || job.status === "running";
const madeProgress = job => NO_PROGRESS.some(key => Number(job[key] || 0) > 0);

// An error (the page never answered, the tab was closed) is worth another try; so is a scan that
// ended incomplete after saving something. An incomplete scan that saved nothing has nothing to gain.
export function shouldRetry(job, maxAttempts) {
  if (job.noRetry || Number(job.attempts || 0) >= maxAttempts) {
    return false;
  }
  return job.status === "error" || (job.status === "incomplete" && madeProgress(job));
}

// When `serve` starts, any job it finds "running" was left by a process that died: nothing is
// reporting for it any more (the extension stops an abandoned scan by itself). End those so the
// retry rules can pick them up, and let jobs that were opened but never answered be opened again.
export async function recoverInterrupted({ listJobs, updateJob }) {
  let recovered = 0;
  for (const job of await listJobs()) {
    if (job.status === "running") {
      await updateJob(job.jobId, current => {
        current.status = "incomplete";
        current.message = "The previous run was interrupted before this scan finished.";
      });
      recovered++;
    } else if (job.status === "queued" && job.openedAt) {
      await updateJob(job.jobId, current => {
        current.openedAt = null;
      });
      recovered++;
    }
  }
  return recovered;
}

export function createSupervisor(deps) {
  const lastOpenedAt = {};
  let lastMoveAt = 0;
  let config = null;

  async function readConfig() {
    try {
      config = await deps.loadConfig();
    } catch (error) {
      if (!config) {
        throw error;
      }
      deps.log(`config.json is invalid, keeping the previous settings: ${error.message}`);
    }
    return config;
  }

  async function expire(job, now) {
    const waited = now - Date.parse(job.openedAt || job.updatedAt || 0);
    const noAnswer = job.status === "queued" && job.openedAt && waited > ACK_TIMEOUT_MS;
    const stale = job.status === "running" && now - Date.parse(job.updatedAt || 0) > STALE_RUNNING_MS;
    if (!noAnswer && !stale) {
      return false;
    }
    await deps.updateJob(job.jobId, current => {
      current.status = noAnswer ? "error" : "incomplete";
      current.message = noAnswer
        ? "Edge did not acknowledge the job within 90 seconds."
        : "The page stopped reporting progress; the scan was ended.";
    });
    return true;
  }

  async function requeue(job, now, maxAttempts) {
    if (!shouldRetry(job, maxAttempts) || job.requeued === job.attempts) {
      return false;
    }
    await deps.updateJob(job.jobId, current => {
      current.status = "queued";
      current.openedAt = null;
      current.requeued = current.attempts;
      current.notBefore = new Date(now + RETRY_BACKOFF_MS * Math.max(1, current.attempts)).toISOString();
      current.lastProblem = String(current.message || current.status).slice(0, 300);
      current.message = `Waiting to retry (attempt ${Number(current.attempts || 0) + 1}): ${current.lastProblem}`;
    });
    return true;
  }

  async function open(job, now) {
    await deps.updateJob(job.jobId, current => {
      current.openedAt = new Date(now).toISOString();
      current.attempts = Number(current.attempts || 0) + 1;
      current.notBefore = null;
    });
    try {
      await deps.openJob(job);
      deps.log(`Opened ${job.platform}/${job.account} (job ${job.jobId}).`);
    } catch (error) {
      await deps.updateJob(job.jobId, current => {
        current.status = "error";
        current.message = `Could not open Edge: ${error?.message || error}`;
      });
    }
  }

  async function relocate(now) {
    if (!config.downloadDir || now - lastMoveAt < MOVE_EVERY_MS) {
      return null;
    }
    lastMoveAt = now;
    const result = await deps.moveFiles(config.downloadDir).catch(error => {
      deps.log(`Moving files failed: ${error?.message || error}`);
      return null;
    });
    if (result && (result.moved || result.failed)) {
      deps.log(`Moved ${result.moved} file(s) to ${config.downloadDir}; ${result.failed} failed.`);
    }
    return result;
  }

  // One pass: returns what it did, for the log and for tests.
  async function tick() {
    const now = deps.now();
    await readConfig();
    const summary = { opened: 0, expired: 0, requeued: 0, moved: 0 };

    for (const job of await deps.listJobs()) {
      if (isActive(job) && (await expire(job, now))) {
        summary.expired++;
      }
    }
    for (const job of await deps.listJobs()) {
      if (await requeue(job, now, config.maxAttempts)) {
        summary.requeued++;
        deps.log(`Will retry ${job.platform}/${job.account} later.`);
      }
    }
    const { picked, lastOpenedAt: updated } = pickJobsToOpen({
      jobs: await deps.listJobs(),
      config,
      now,
      lastOpenedAt,
      random: deps.random
    });
    Object.assign(lastOpenedAt, updated);
    for (const job of picked) {
      await open(job, now);
      summary.opened++;
    }
    summary.moved = (await relocate(now))?.moved || 0;
    return summary;
  }

  return { tick };
}
