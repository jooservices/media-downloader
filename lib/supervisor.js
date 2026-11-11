// The queue engine. It decides when each waiting job opens its page, retries jobs that failed for a
// transient reason, holds a whole site back while the user is not signed in, and recovers jobs left by
// a crashed run. It touches the outside world only through the ports it is given (job storage, opening
// a page, the clock), so the same engine runs inside the extension and inside the CLI, and is tested
// without either.
(function initSupervisor(global) {
  "use strict";

  const { pickJobsToOpen } = typeof require === "function" ? require("./scheduler.js") : global.PageMediaLib.scheduler;
  const { isRateLimitOutcome } =
    typeof require === "function" ? require("./rate-limit.js") : global.PageMediaLib.rateLimit;
  const sites = typeof require === "function" ? require("./sites.js") : global.PageMediaLib.sites;

  const ACK_TIMEOUT_MS = 90_000;
  const STALE_RUNNING_MS = 15 * 60_000;
  const RETRY_BACKOFF_MS = 60_000;
  const SIGN_IN_RECHECK_MS = 10 * 60_000;
  const MOVE_EVERY_MS = 20_000;
  const RATE_LIMIT_COOLDOWN_MS = 15 * 60_000;
  const MAX_RATE_LIMIT_COOLDOWN_MS = 2 * 60 * 60_000;
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

  function restoreStringMap(source, target, onRestore) {
    for (const [key, value] of Object.entries(source || {})) {
      if (typeof value === "string") {
        target.set(key, value);
        onRestore?.(key);
      }
    }
  }

  const outcomeFingerprint = job =>
    String(job.rateLimitOutcomeId || job.openingId || `legacy:${Number(job.attempts || 0)}`);

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
      let progressed = false;
      for (const job of running) {
        let changed = false;
        await updateJob(job.jobId, current => {
          // A bridge completion can arrive after the page was read. Only park the row if it is
          // still running inside the store's serialized update.
          if (current.status !== "running") {
            return;
          }
          current.status = "incomplete";
          // A dead supervisor cannot tell whether the browser finished its last save. Keep the job
          // visible for an explicit retry instead of reopening a scan that may still be running.
          current.noRetry = true;
          current.message = "The previous run was interrupted before this scan finished.";
          changed = true;
        });
        recovered += Number(changed);
        progressed ||= changed;
      }
      if (!progressed) {
        break;
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
    const rateLimitBackoffs = new Map(); // site -> { until, level }
    const seenRateLimitOutcomes = new Map(); // job id -> latest observed outcome fingerprint
    const countedRateLimitOpenings = new Map(); // job id -> opening identity already counted
    let backoffsLoaded = false;
    let outcomesBootstrapped = false;
    const previouslySeenOutcomes = new Set();
    let lastMoveAt = -MOVE_EVERY_MS;
    let destinationUnavailable = false;
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

    async function loadBackoffs() {
      if (backoffsLoaded) {
        return;
      }
      let saved = null;
      try {
        saved = await ports.loadBackoffState?.();
      } catch (error) {
        ports.log(`The saved back-off state is unreadable and was ignored: ${error?.message || error}`);
      }
      for (const [platform, state] of Object.entries(saved?.platforms || {})) {
        if (sites.names().includes(platform) && Number.isFinite(state?.until) && Number.isInteger(state?.level)) {
          rateLimitBackoffs.set(platform, {
            until: state.until,
            level: Math.max(0, state.level),
            lastBackoffAt: Number.isFinite(state.lastBackoffAt) ? state.lastBackoffAt : 0
          });
        }
      }
      restoreStringMap(saved?.seenOutcomes, seenRateLimitOutcomes, jobId => previouslySeenOutcomes.add(jobId));
      restoreStringMap(saved?.countedOpenings, countedRateLimitOpenings);
      outcomesBootstrapped = saved?.outcomesBootstrapped === true;
      backoffsLoaded = true;
    }

    async function saveBackoffs() {
      if (!ports.saveBackoffState) {
        return;
      }
      await ports.saveBackoffState({
        platforms: Object.fromEntries(rateLimitBackoffs),
        seenOutcomes: Object.fromEntries(seenRateLimitOutcomes),
        countedOpenings: Object.fromEntries(countedRateLimitOpenings),
        outcomesBootstrapped
      });
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
        const challengeMessage = isRateLimitOutcome(current) ? ` ${current.message}` : "";
        current.status = "queued";
        current.openedAt = null;
        current.needsLogin = false;
        current.noRetry = false;
        current.attempts = Math.max(0, Number(current.attempts || 0) - 1);
        current.message = `Waiting for you to sign in to ${current.platform}.${challengeMessage}`;
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
        current.openSequence = Number(current.openSequence || 0) + 1;
        current.openingId = `${now}-${current.openSequence}`;
        current.openedAt = new Date(now).toISOString();
        current.attempts = Number(current.attempts || 0) + 1;
        current.notBefore = null;
        current.rateLimitStatus = null;
        current.rateLimitOutcomeId = null;
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

    function platformStatus(now = ports.now()) {
      return Object.fromEntries(
        sites.names().map(platform => {
          const state = rateLimitBackoffs.get(platform);
          const active = state && now < state.until;
          return [
            platform.toLowerCase(),
            {
              configuredWorkers: config?.workers[platform] ?? 1,
              effectiveWorkers: active ? 1 : (config?.workers[platform] ?? 1),
              backoffUntil: active ? new Date(state.until).toISOString() : null,
              backoffLevel: state?.level ?? 0
            }
          ];
        })
      );
    }

    async function startRateLimitBackoff(job, now) {
      const fingerprint = outcomeFingerprint(job);
      if (seenRateLimitOutcomes.get(job.jobId) === fingerprint) {
        return false;
      }
      seenRateLimitOutcomes.set(job.jobId, fingerprint);
      const openingIdentity = String(job.openingId || fingerprint);
      if (countedRateLimitOpenings.get(job.jobId) === openingIdentity) {
        await saveBackoffs();
        return false;
      }
      countedRateLimitOpenings.set(job.jobId, openingIdentity);
      const previous = rateLimitBackoffs.get(job.platform);
      const level = (previous?.level ?? 0) + 1;
      const duration = Math.min(RATE_LIMIT_COOLDOWN_MS * 2 ** (level - 1), MAX_RATE_LIMIT_COOLDOWN_MS);
      const until = now + duration;
      rateLimitBackoffs.set(job.platform, { until, level, lastBackoffAt: now });
      await saveBackoffs();
      const event = { platform: job.platform, until: new Date(until).toISOString(), level };
      ports.log(
        `${job.platform}: rate limit or challenge detected; pausing new jobs until ${event.until} (back-off ${level}).`
      );
      await ports.onBackoff?.({ ...event, kind: "backoff-start" });
      return true;
    }

    async function endExpiredBackoffs(now) {
      for (const [platform, state] of rateLimitBackoffs) {
        if (state.until && now >= state.until) {
          state.until = 0;
          await saveBackoffs();
          ports.log(`${platform}: rate-limit cool-down ended; configured worker count restored.`);
          await ports.onBackoff?.({ platform, until: null, level: state.level, kind: "backoff-end" });
        }
      }
    }

    const blockedSites = now => [...signInBlocks].filter(([, until]) => now < until).map(([site]) => site);

    async function processOutcome(job, now) {
      if (isRateLimitOutcome(job)) {
        await startRateLimitBackoff(job, now);
        return;
      }
      if (job.status !== "complete") {
        return;
      }
      const state = rateLimitBackoffs.get(job.platform);
      const completedAt = Date.parse(job.outcomeAt || job.completedAt || 0);
      if (state?.level && now >= state.until && completedAt > state.lastBackoffAt) {
        state.level = 0;
        await saveBackoffs();
      }
    }

    async function processJobStatus(job, now, summary) {
      if (job.status === "error" && job.needsLogin) {
        await holdForSignIn(job, now);
        summary.heldForSignIn++;
        return;
      }
      if (isActive(job) && (await expire(job, now))) {
        summary.expired++;
      }
    }

    async function bootstrapOutcomes(now) {
      if (outcomesBootstrapped) {
        return;
      }
      const latest = new Map();
      for (const status of ["complete", "error", "incomplete"]) {
        for await (const page of jobPages(ports.listJobs, status)) {
          recordOutcomePage(page, latest);
        }
      }
      outcomesBootstrapped = true;
      for (const { job, occurredAt } of latest.values()) {
        if (
          isRateLimitOutcome(job) &&
          !previouslySeenOutcomes.has(job.jobId) &&
          now - occurredAt <= RATE_LIMIT_COOLDOWN_MS
        ) {
          seenRateLimitOutcomes.delete(job.jobId);
          await startRateLimitBackoff(job, now);
        }
      }
      await saveBackoffs();
    }

    function recordOutcomePage(page, latest) {
      for (const job of page) {
        if (!["complete", "error", "incomplete"].includes(job.status)) {
          continue;
        }
        const occurredAt = Date.parse(job.outcomeAt || job.completedAt || job.updatedAt || job.createdAt || 0);
        if (!latest.has(job.platform) || occurredAt > latest.get(job.platform).occurredAt) {
          latest.set(job.platform, { job, occurredAt });
        }
        seenRateLimitOutcomes.set(job.jobId, outcomeFingerprint(job));
      }
    }

    async function sweepOutcomes(now) {
      for (const status of ["complete", "error", "incomplete"]) {
        for await (const page of jobPages(ports.listJobs, status)) {
          for (const job of page) {
            await processOutcome(job, now);
          }
        }
      }
    }

    async function sweepForExpiredJobs(now, summary) {
      for (const status of ["error", "queued", "running"]) {
        for await (const page of jobPages(ports.listJobs, status)) {
          for (const job of page) {
            await processJobStatus(job, now, summary);
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
      await loadBackoffs();
      await endExpiredBackoffs(now);
      await bootstrapOutcomes(now);
      await sweepOutcomes(now);
      await sweepForExpiredJobs(now, summary);
      await sweepForRetries(now, summary);
    }

    // Sites checked before anything starts (for example, no session cookie): their waiting jobs say why.
    async function preflightBlocked(jobs) {
      const blockedPlatforms = (await ports.blockedSites?.()) ?? [];
      for (const job of jobs) {
        const label = ports.siteLabel?.(job.platform) ?? job.platform;
        const message = `Waiting for you to sign in to ${label}.`;
        if (
          blockedPlatforms.includes(job.platform) &&
          job.status === "queued" &&
          !job.openedAt &&
          job.message !== message
        ) {
          await ports.updateJob(job.jobId, current => {
            current.message = message;
          });
        }
      }
      return blockedPlatforms;
    }

    // One pass: returns what it did, for the log, the screen and the tests.
    async function tick() {
      const now = ports.now();
      await readConfig();
      const summary = { opened: 0, expired: 0, requeued: 0, heldForSignIn: 0, moved: 0 };
      await sweep(now, summary);
      const relocation = await relocate(now);
      if (relocation?.destinationAvailable === false) {
        destinationUnavailable = true;
      } else if (relocation?.destinationAvailable === true) {
        destinationUnavailable = false;
      }
      if (destinationUnavailable) {
        ports.log(`Downloads are paused until ${config.downloadDir} is available.`);
      }
      const jobs = ports.listWorkJobs ? await ports.listWorkJobs() : await ports.listJobs();
      const preflight = await preflightBlocked(jobs);
      const paused = Boolean(await ports.isPaused?.());
      const adjustedConfig = { ...config, workers: { ...config.workers } };
      const rateLimited = [];
      for (const [platform, state] of rateLimitBackoffs) {
        if (now < state.until) {
          adjustedConfig.workers[platform] = 1;
          rateLimited.push(platform);
        }
      }
      const { picked, lastOpenedAt: updated } = pickJobsToOpen({
        jobs: paused || destinationUnavailable ? [] : jobs,
        config: adjustedConfig,
        now,
        lastOpenedAt,
        blocked: [...blockedSites(now), ...preflight, ...rateLimited],
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
      summary.moved = relocation?.moved || 0;
      return summary;
    }

    return {
      tick,
      platformStatus,
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
    RATE_LIMIT_COOLDOWN_MS,
    MAX_RATE_LIMIT_COOLDOWN_MS,
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
