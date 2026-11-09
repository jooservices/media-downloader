// The queue engine. It decides when each waiting job opens its page, retries jobs that failed for a
// transient reason, holds a whole site back while the user is not signed in, and recovers jobs left by
// a crashed run. It touches the outside world only through the ports it is given (job storage, opening
// a page, the clock), so the same engine runs inside the extension and inside the CLI, and is tested
// without either.
(function initSupervisor(global) {
  "use strict";

  const { pickJobsToOpen } = typeof require === "function" ? require("./scheduler.js") : global.PageMediaLib.scheduler;

  const ACK_TIMEOUT_MS = 90_000;
  const STALE_RUNNING_MS = 15 * 60_000;
  const RETRY_BACKOFF_MS = 60_000;
  const SIGN_IN_RECHECK_MS = 10 * 60_000;
  const MOVE_EVERY_MS = 20_000;
  const PROGRESS_KEYS = ["started", "videoStarted"];

  const isActive = job => job.status === "queued" || job.status === "running";
  const madeProgress = job => PROGRESS_KEYS.some(key => Number(job[key] || 0) > 0);
  const JOB_PAGE_SIZE = 500;

  async function* jobPages(listJobs, status) {
    let after = null;
    let firstJobId = null;
    for (;;) {
      const jobs = await listJobs({ status, limit: JOB_PAGE_SIZE, ...(after ? { after } : {}) });
      if (after && jobs[0]?.jobId === firstJobId) {
        return; // A non-SQLite port may ignore paging and return its complete in-memory list.
      }
      firstJobId ??= jobs[0]?.jobId;
      yield jobs;
      if (jobs.length < JOB_PAGE_SIZE) {
        return;
      }
      if (jobs.at(-1)?.jobId === after) {
        return;
      }
      const last = jobs.at(-1);
      after = { createdAt: String(last?.createdAt ?? ""), jobId: last?.jobId };
    }
  }

  // An error (the page never answered, the tab was closed) is worth another try; so is a scan that
  // ended incomplete after saving something. An incomplete scan that saved nothing has nothing to gain.
  function shouldRetry(job, maxAttempts) {
    if (job.noRetry || Number(job.attempts || 0) >= maxAttempts) {
      return false;
    }
    return job.status === "error" || (job.status === "incomplete" && madeProgress(job));
  }

  // When a run starts, a job still "running" belongs to a process that died. Park it for review because
  // its last browser-side save may have succeeded; reopen jobs that were launched but never acknowledged.
  async function recoverInterrupted({ listJobs, updateJob }) {
    let recovered = 0;
    while (true) {
      const page = await listJobs({ status: "running", limit: JOB_PAGE_SIZE, offset: 0 });
      const running = page.filter(job => job.status === "running");
      if (!running.length) {
        break;
      }
      for (const job of running) {
        await updateJob(job.jobId, current => {
          current.status = "incomplete";
          // A dead supervisor cannot tell whether the browser finished its last save. Keep the job
          // visible for an explicit retry instead of reopening a scan that may still be running.
          current.noRetry = true;
          current.message = "The previous run was interrupted before this scan finished.";
        });
        recovered++;
      }
    }
    for await (const page of jobPages(listJobs, "queued")) {
      for (const job of page) {
        if (job.openedAt) {
          await updateJob(job.jobId, current => {
            current.openedAt = null;
          });
          recovered++;
        }
      }
    }
    return recovered;
  }

  function createSupervisor(ports) {
    const lastOpenedAt = {};
    const signInBlocks = new Map(); // site -> time (ms) at which one job may probe again
    let lastMoveAt = 0;
    let config = null;

    async function readConfig() {
      try {
        config = await ports.loadConfig();
      } catch (error) {
        if (!config) {
          throw error;
        }
        ports.log(`The settings are invalid, keeping the previous ones: ${error.message}`);
      }
      return config;
    }

    async function expire(job, now) {
      let expired = false;
      await ports.updateJob(job.jobId, current => {
        const waited = now - Date.parse(current.openedAt || current.updatedAt || 0);
        const noAnswer = current.status === "queued" && current.openedAt && waited > ACK_TIMEOUT_MS;
        const stale = current.status === "running" && now - Date.parse(current.updatedAt || 0) > STALE_RUNNING_MS;
        if (!noAnswer && !stale) {
          return current;
        }
        expired = true;
        current.status = noAnswer ? "error" : "incomplete";
        if (stale) {
          current.noRetry = true;
        }
        current.message = noAnswer
          ? "Edge did not acknowledge the job within 90 seconds."
          : "The page stopped reporting progress; the scan was ended.";
      });
      return expired;
    }

    // A job that stopped because the site wants a sign-in goes back to waiting, without using up an
    // attempt, and the whole site is held back so the rest of its queue is not burned through.
    async function holdForSignIn(job, now) {
      await ports.updateJob(job.jobId, current => {
        current.status = "queued";
        current.openedAt = null;
        current.needsLogin = false;
        current.noRetry = false;
        current.attempts = Math.max(0, Number(current.attempts || 0) - 1);
        current.message = `Waiting for you to sign in to ${current.platform}.`;
      });
      if (!signInBlocks.has(job.platform)) {
        ports.log(`${job.platform}: sign-in needed. Nothing will start there until you sign in.`);
      }
      signInBlocks.set(job.platform, now + SIGN_IN_RECHECK_MS);
    }

    async function requeue(job, now) {
      if (!shouldRetry(job, config.maxAttempts) || job.requeued === job.attempts) {
        return false;
      }
      await ports.updateJob(job.jobId, current => {
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
      await ports.updateJob(job.jobId, current => {
        current.openedAt = new Date(now).toISOString();
        current.attempts = Number(current.attempts || 0) + 1;
        current.notBefore = null;
      });
      try {
        await ports.openJob(job);
        ports.log(`Opened ${job.platform}/${job.account} (job ${job.jobId}).`);
      } catch (error) {
        await ports.updateJob(job.jobId, current => {
          current.status = "error";
          current.message = `Could not open the page: ${error?.message || error}`;
        });
      }
    }

    async function relocate(now) {
      if (!ports.moveFiles || !config.downloadDir || now - lastMoveAt < MOVE_EVERY_MS) {
        return null;
      }
      lastMoveAt = now;
      const result = await ports.moveFiles(config.downloadDir).catch(error => {
        ports.log(`Moving files failed: ${error?.message || error}`);
        return null;
      });
      if (result && (result.moved || result.failed)) {
        ports.log(`Moved ${result.moved} file(s) to ${config.downloadDir}; ${result.failed} failed.`);
      }
      return result;
    }

    const blockedSites = now => [...signInBlocks].filter(([, until]) => now < until).map(([site]) => site);

    async function sweepForExpiredJobs(now, summary) {
      for (const status of ["error", "queued", "running"]) {
        for await (const page of jobPages(ports.listJobs, status)) {
          for (const job of page) {
            if (job.status === "error" && job.needsLogin) {
              await holdForSignIn(job, now);
              summary.heldForSignIn++;
            } else if (isActive(job) && (await expire(job, now))) {
              summary.expired++;
            }
          }
        }
      }
    }

    async function sweepForRetries(now, summary) {
      for (const status of ["error", "incomplete"]) {
        for await (const page of jobPages(ports.listJobs, status)) {
          for (const job of page) {
            if (await requeue(job, now)) {
              summary.requeued++;
              ports.log(`Will retry ${job.platform}/${job.account} later.`);
            }
          }
        }
      }
    }

    async function sweep(now, summary) {
      await sweepForExpiredJobs(now, summary);
      await sweepForRetries(now, summary);
    }

    // Sites checked before anything starts (for example, no session cookie): their waiting jobs say why.
    async function preflightBlocked(jobs) {
      const sites = (await ports.blockedSites?.()) ?? [];
      for (const job of jobs) {
        const label = ports.siteLabel?.(job.platform) ?? job.platform;
        const message = `Waiting for you to sign in to ${label}.`;
        if (sites.includes(job.platform) && job.status === "queued" && !job.openedAt && job.message !== message) {
          await ports.updateJob(job.jobId, current => {
            current.message = message;
          });
        }
      }
      return sites;
    }

    // One pass: returns what it did, for the log, the screen and the tests.
    async function tick() {
      const now = ports.now();
      await readConfig();
      const summary = { opened: 0, expired: 0, requeued: 0, heldForSignIn: 0, moved: 0 };
      await sweep(now, summary);
      const jobs = ports.listWorkJobs ? await ports.listWorkJobs() : await ports.listJobs();
      const preflight = await preflightBlocked(jobs);
      const paused = Boolean(await ports.isPaused?.());
      const { picked, lastOpenedAt: updated } = pickJobsToOpen({
        jobs: paused ? [] : jobs,
        config,
        now,
        lastOpenedAt,
        blocked: [...blockedSites(now), ...preflight],
        random: ports.random
      });
      Object.assign(lastOpenedAt, updated);
      for (const job of picked) {
        if (await ports.isStopping?.()) {
          break;
        }
        await open(job, now);
        summary.opened++;
      }
      summary.moved = (await relocate(now))?.moved || 0;
      return summary;
    }

    return {
      tick,
      // The user says they signed in: let the site's queue start right away.
      clearSignIn: site => {
        signInBlocks.delete(site);
        delete lastOpenedAt[site]; // no pause to wait out: the user has just done the waiting
      },
      signInNeeded: () => blockedSites(ports.now())
    };
  }

  const api = Object.freeze({
    ACK_TIMEOUT_MS,
    STALE_RUNNING_MS,
    SIGN_IN_RECHECK_MS,
    shouldRetry,
    recoverInterrupted,
    createSupervisor
  });

  global.PageMediaLib ??= {};
  global.PageMediaLib.supervisor = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
