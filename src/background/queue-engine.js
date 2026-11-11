// The extension's own download queue: it opens a tab for each waiting profile (within the worker limits
// and only for sites the user is signed in to), starts the scan in it, follows its progress, and closes
// the tab when the job is over. The scheduling rules are the shared engine's (lib/supervisor.js); this
// file supplies what is specific to a browser extension: tabs, storage and messages from the pages.
function createQueueEngine({ store, settings, login, tabs, now, random, log }) {
  const { isTerminal, applyProgress, applyError } = PageMediaLib.jobProgress;
  const { isSignInPage, samePage } = PageMediaLib.urls;

  const supervisor = PageMediaLib.supervisor.createSupervisor({
    now,
    random,
    log,
    loadConfig: settings.load,
    loadBackoffState: async () => (await store.loadBackoffState?.()) ?? null,
    saveBackoffState: state => store.saveBackoffState?.(state),
    listJobs: store.listJobs,
    updateJob: store.updateJob,
    isPaused: settings.isPaused,
    blockedSites: login.signedOutSites,
    siteLabel: platform => PageMediaLib.login.SITE_LABEL[platform],
    openJob: async job => {
      const tab = await tabs.create({ url: job.url, active: false });
      openingTabs.set(tab.id, job.jobId);
      await store.updateJob(job.jobId, current => {
        current.tabId = tab.id;
      });
      await flushPendingQueueRateLimit(tab.id);
    }
  });

  const openingTabs = new Map();

  const findByTab = async tabId => {
    const jobs = await store.listJobs();
    return jobs.find(job => job.tabId === tabId) || jobs.find(job => job.jobId === openingTabs.get(tabId));
  };

  // A tab is dead weight once its job is over, or when its job went back to waiting for another try.
  const tabIsSpent = job =>
    Number.isInteger(job.tabId) && (isTerminal(job.status) || (job.status === "queued" && !job.openedAt));

  async function closeSpentTabs() {
    for (const job of (await store.listJobs()).filter(tabIsSpent)) {
      await tabs.remove(job.tabId).catch(() => undefined);
      await store.updateJob(job.jobId, current => {
        current.completedTabId = current.tabId;
        current.completedTabAt = new Date(now()).toISOString();
        current.tabId = null;
      });
    }
  }

  let running = null;
  let rerunRequested = false;
  // One pass at a time: a second request while one is running simply shares its result.
  function tick() {
    if (running) {
      rerunRequested = true;
      return running;
    }
    running = (async () => {
      let summary;
      do {
        rerunRequested = false;
        summary = await supervisor.tick();
        await closeSpentTabs();
      } while (rerunRequested);
      return summary;
    })().finally(() => {
      running = null;
    });
    return running;
  }

  async function failJob(jobId, text, extra = {}) {
    await store.updateJob(jobId, job => {
      applyError(job, text);
      Object.assign(job, extra);
    });
  }

  // The page of a tab we opened has loaded: start the scan in it.
  async function pageReady(tabId, message) {
    const job = await findByTab(tabId);
    if (!job || job.status !== "queued" || !job.openedAt) {
      return { handled: Boolean(job) };
    }
    if (!samePage(message.pageUrl, job.url)) {
      return { handled: true };
    }
    const started = await store.updateJob(job.jobId, current => {
      current.status = "running";
      current.message = "Scanning the profile.";
    });
    const response = await tabs
      .sendMessage(tabId, { type: "AUTO_START_CLI", job: { ...started, repairTargets: [] } })
      .catch(() => null);
    if (!response?.ok) {
      await failJob(job.jobId, response?.error || "The page could not start the scan.");
    }
    return { handled: true };
  }

  // A progress or completion report from the scan running in a tab. Returns false for a job that is not ours.
  async function progress(report) {
    const jobId = report?.state?.jobId;
    const job = jobId ? (await store.listJobs()).find(item => item.jobId === jobId) : null;
    if (!job) {
      return false;
    }
    const finished = report.type === "AUTO_DONE";
    // The page says AUTO_*; the shared progress rules use the bridge's JOB_* names.
    await store.updateJob(jobId, current =>
      applyProgress(current, { type: finished ? "JOB_DONE" : "JOB_PROGRESS", state: report.state })
    );
    if (finished) {
      tick().catch(() => undefined);
    }
    return true;
  }

  async function heartbeat(jobId) {
    const job = (await store.listJobs()).find(item => item.jobId === jobId);
    if (!job) {
      return false;
    }
    await store.updateJob(jobId, current => {
      if (current.status === "running") {
        current.lastHeartbeatAt = new Date(now()).toISOString();
      }
    });
    return true;
  }

  // The address of a tab we opened changed: a sign-in page ends the job and holds the site.
  async function tabNavigated(tabId, url) {
    const job = await findByTab(tabId);
    if (job && !isTerminal(job.status) && isSignInPage(url)) {
      const pathname = new URL(url).pathname;
      const securityCheck = /\/(checkpoint|challenge)(\/|$)/i.test(pathname);
      const message = securityCheck
        ? "The site showed a checkpoint or security challenge. Sign in to continue."
        : "The site asked to sign in.";
      await failJob(job.jobId, message, { needsLogin: true });
      tick().catch(() => undefined);
    }
  }

  async function tabClosed(tabId) {
    const job = await findByTab(tabId);
    if (job?.status === "running") {
      await failJob(job.jobId, "The page was closed before the scan finished.", { tabId: null });
    }
  }

  async function rateLimitSignal(tabId, status) {
    const jobs = await store.listJobs();
    const job =
      jobs.find(item => item.tabId === tabId) ||
      jobs.find(item => item.completedTabId === tabId && now() - Date.parse(item.completedTabAt || 0) <= 60_000);
    if (!job || ![420, 429].includes(Number(status)) || !job.openingId) {
      return false;
    }
    await store.updateJob(job.jobId, current => {
      current.rateLimitStatus = Number(status);
      current.rateLimitOutcomeId = `${current.openingId}:rate-limit:${status}`;
      const requeuedOpening = current.status === "queued" && !current.openedAt && current.requeued === current.attempts;
      if (current.status === "complete" || requeuedOpening) {
        current.status = "incomplete";
        current.outcomeAt = new Date(now()).toISOString();
        current.message = `The platform returned HTTP ${status}; the scan was paused to protect the account.`;
      }
    });
    return true;
  }

  const reset = job => {
    job.status = "queued";
    job.attempts = 0;
    job.openedAt = null;
    job.notBefore = null;
    job.requeued = null;
    job.message = "Waiting to start.";
  };

  const ACTIONS = {
    retry: jobId => store.updateJob(jobId, reset),
    stop: async jobId => {
      const job = (await store.listJobs()).find(item => item.jobId === jobId);
      if (job?.status === "running" && Number.isInteger(job.tabId)) {
        await tabs.sendMessage(job.tabId, { type: "AUTO_STOP" }).catch(() => undefined);
      }
      await store.updateJob(jobId, current => {
        current.status = "paused";
        current.message = "Stopped.";
      });
    },
    remove: async jobId => {
      const removed = await store.removeWhere(job => job.jobId === jobId);
      for (const job of removed.filter(item => Number.isInteger(item.tabId))) {
        await tabs.remove(job.tabId).catch(() => undefined);
      }
    },
    "clear-finished": () => store.removeWhere(job => job.status === "complete")
  };

  return {
    tick,
    pageReady,
    progress,
    heartbeat,
    tabNavigated,
    tabClosed,
    rateLimitSignal,
    recover: () => PageMediaLib.supervisor.recoverInterrupted({ listJobs: store.listJobs, updateJob: store.updateJob }),

    async add(urls) {
      const { limit } = await settings.load();
      const result = await store.addUrls(urls, { limit });
      tick().catch(() => undefined);
      return result;
    },

    async act(action, jobId) {
      if (!Object.hasOwn(ACTIONS, action)) {
        throw new Error(`Unknown action: ${action}`);
      }
      await ACTIONS[action](jobId);
      tick().catch(() => undefined);
    },

    async saveSettings(raw) {
      const saved = await settings.save(raw);
      tick().catch(() => undefined);
      return saved;
    },

    async setPaused(paused) {
      await settings.setPaused(paused);
      tick().catch(() => undefined);
    },

    // The user says they have signed in: let held sites start right away.
    signedIn() {
      for (const site of supervisor.signInNeeded()) {
        supervisor.clearSignIn(site);
      }
      return tick();
    },

    // Everything the dashboard shows, in one read.
    async snapshot() {
      return {
        jobs: await store.listJobs(),
        settings: await settings.load(),
        paused: await settings.isPaused(),
        login: await login.status()
      };
    }
  };
}
