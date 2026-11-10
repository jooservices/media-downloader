// The extension's own job queue, kept in chrome.storage.local. It offers the same few operations the
// CLI's job files do (list, update, create, remove), so the shared queue engine can run on either.
const QUEUE_JOBS_KEY = "queueJobs";
const RATE_LIMIT_BACKOFFS_KEY = "rateLimitBackoffs";

function createJobStore(area, newId = () => crypto.randomUUID(), now = () => Date.now()) {
  // Updates are applied one at a time so two callers can never overwrite each other's change.
  let chain = Promise.resolve();
  const serial = work => {
    const run = chain.then(work);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };

  const readAll = async () => (await area.get({ [QUEUE_JOBS_KEY]: {} }))[QUEUE_JOBS_KEY] || {};
  const writeAll = jobs => area.set({ [QUEUE_JOBS_KEY]: jobs });

  return {
    async loadBackoffState() {
      return (await area.get({ [RATE_LIMIT_BACKOFFS_KEY]: null }))[RATE_LIMIT_BACKOFFS_KEY];
    },

    async saveBackoffState(state) {
      await area.set({ [RATE_LIMIT_BACKOFFS_KEY]: state });
    },

    async listJobs() {
      return Object.values(await readAll()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    },

    // Mutates the job in place (or returns a replacement) and stores it; null when there is no such job.
    updateJob: (jobId, mutate) =>
      serial(async () => {
        const jobs = await readAll();
        const job = jobs[jobId];
        if (!job) {
          return null;
        }
        const next = (await mutate(job)) || job;
        next.updatedAt = new Date(now()).toISOString();
        jobs[jobId] = next;
        await writeAll(jobs);
        return next;
      }),

    // One new waiting job per profile URL that is not queued yet; returns { created, skipped }.
    addUrls: (urls, { limit = null } = {}) =>
      serial(async () => {
        const jobs = await readAll();
        const known = new Set(Object.values(jobs).map(job => PageMediaLib.urls.comparableUrl(job.url)));
        const result = { created: [], skipped: [] };
        for (const raw of urls) {
          let pages;
          try {
            pages = PageMediaLib.urls.accountPages(String(raw).trim());
          } catch {
            pages = [raw];
          }
          for (const page of pages) {
            const outcome = newJobFor(page, limit, known, newId, now);
            if (outcome.job) {
              jobs[outcome.job.jobId] = outcome.job;
              result.created.push(outcome.job);
            } else {
              result.skipped.push({ raw: page, reason: outcome.reason });
            }
          }
        }
        await writeAll(jobs);
        return result;
      }),

    removeWhere: predicate =>
      serial(async () => {
        const jobs = await readAll();
        const removed = Object.values(jobs).filter(predicate);
        for (const job of removed) {
          delete jobs[job.jobId];
        }
        await writeAll(jobs);
        return removed;
      })
  };
}

// A waiting job for `raw`, or the reason there is none. Adds the URL to `known` when it creates one.
function newJobFor(raw, limit, known, newId, now) {
  let normalized;
  try {
    normalized = PageMediaLib.urls.normalizeProfileUrl(String(raw).trim());
  } catch (error) {
    return { reason: error?.message || "This is not a supported profile link." };
  }
  const key = PageMediaLib.urls.comparableUrl(normalized.url);
  if (known.has(key)) {
    return { reason: "Already in the list." };
  }
  known.add(key);
  const createdAt = new Date(now()).toISOString();
  return {
    job: {
      jobId: newId(),
      url: normalized.url,
      platform: normalized.platform,
      account: normalized.account,
      mediaPage: normalized.mediaPage,
      limit,
      status: "queued",
      message: "Waiting to start.",
      createdAt,
      updatedAt: createdAt,
      started: 0,
      skipped: 0,
      failed: 0,
      pending: 0,
      videoStarted: 0,
      videoSkipped: 0,
      rounds: 0,
      attempts: 0,
      openedAt: null,
      tabId: null,
      source: "extension"
    }
  };
}
