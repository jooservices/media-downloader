// Talks to the local CLI bridge: reports page readiness and progress, starts
// jobs, and stops an abandoned scan when the CLI has been gone too long.
const CLI_BRIDGE_URL = "http://127.0.0.1:38541/message";
const BRIDGE_LOST_STOP_MS = 45000;
let bridgeLostSince = null;
let nativeBridgeState = {
  state: "idle",
  message: "Start a CLI download to connect the local bridge.",
  updatedAt: null
};

function updateNativeBridgeState(state, message) {
  nativeBridgeState = { state, message, updatedAt: new Date().toISOString() };
  chrome.storage.local.set({ nativeBridgeState }).catch(() => {});
}

async function postBridgeMessage(message) {
  try {
    // The bridge is the CLI on this machine (127.0.0.1); it is never reachable from the network.
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
    const response = await fetch(CLI_BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      cache: "no-store",
      credentials: "omit"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.ok === false) {
      throw new Error(result?.error || `Local CLI bridge returned HTTP ${response.status}.`);
    }
    updateNativeBridgeState("connected", "Connected to the local CLI bridge.");
    return result;
  } catch (error) {
    const messageText = error?.message || String(error);
    const isOffline = /failed to fetch|networkerror|refused|load failed/i.test(messageText);
    updateNativeBridgeState(
      isOffline ? "idle" : "error",
      isOffline ? "CLI bridge is offline. Start or resume a job from the CLI." : `CLI bridge error: ${messageText}`
    );
    throw error;
  }
}

async function handleBridgeResponse(message) {
  if (message?.type === "JOB_CONNECTED") {
    updateNativeBridgeState("connected", "Connected to the running CLI job.");
    return;
  }
  if (message?.type === "NO_JOB") {
    updateNativeBridgeState("idle", "The CLI bridge has no active job.");
    return;
  }
  if (message?.type !== "START_JOB" || !message.job || !Number.isInteger(message.tabId)) {
    return;
  }
  try {
    const tab = await chrome.tabs.get(message.tabId);
    if (!samePage(tab.url, message.job.url)) {
      await postBridgeMessage({
        type: "JOB_ERROR",
        jobId: message.job.jobId,
        error: "The tab URL changed before the download started."
      });
      return;
    }
    const response = await chrome.tabs.sendMessage(message.tabId, {
      type: "AUTO_START_CLI",
      job: { ...message.job, repairTargets: message.job.repairBasenames || [] }
    });
    if (!response?.ok) {
      await postBridgeMessage({
        type: "JOB_ERROR",
        jobId: message.job.jobId,
        error: response?.error || "The page could not start the automatic scan."
      });
    } else if (response.state?.running) {
      await rememberCliJob(message.tabId, message.job.jobId);
    }
  } catch (error) {
    await postBridgeMessage({
      type: "JOB_ERROR",
      jobId: message.job.jobId,
      error: error?.message || String(error)
    }).catch(() => {});
  }
}

// The CLI was closed: let `resume` reconnect for a while, then stop the scan so an
// abandoned tab cannot keep downloading unattended.
function noteBridgeFailure(tabId, isProgress) {
  bridgeLostSince ??= Date.now();
  const goneTooLong = Date.now() - bridgeLostSince >= BRIDGE_LOST_STOP_MS;
  if (isProgress && goneTooLong && Number.isInteger(tabId)) {
    chrome.tabs.sendMessage(tabId, { type: "AUTO_STOP" }).catch(() => {});
  }
}

// Several pages can run a job at once (one per worker), so each tab's job is remembered separately.
// The map survives the service worker being stopped and restarted by the browser.
async function readCliJobs() {
  const { activeCliJobs } = await chrome.storage.local.get({ activeCliJobs: {} });
  return activeCliJobs && typeof activeCliJobs === "object" ? activeCliJobs : {};
}

async function rememberCliJob(tabId, jobId) {
  const jobs = await readCliJobs();
  jobs[String(tabId)] = jobId;
  await chrome.storage.local.set({ activeCliJobs: jobs });
}

// Forgets the tab's job and returns its id, or null when the tab had none.
async function takeCliJob(tabId) {
  if (!Number.isInteger(tabId)) {
    return null;
  }
  const jobs = await readCliJobs();
  const jobId = jobs[String(tabId)] || null;
  if (jobId) {
    delete jobs[String(tabId)];
    await chrome.storage.local.set({ activeCliJobs: jobs });
  }
  return jobId;
}

const failureResponse = error => ({ ok: false, error: error?.message || String(error) });

// A tab the extension's own queue opened is handled there; any other tab belongs to the CLI.
async function handleCliPageReady(message, sender) {
  if (!Number.isInteger(sender?.tab?.id)) {
    return { ok: false, error: "The page tab could not be identified." };
  }
  const local = await queueEngine.pageReady(sender.tab.id, message);
  return local.handled ? { ok: true, waiting: false } : handleBridgePageReady(message, sender);
}

function handleBridgePageReady(message, sender) {
  return postBridgeMessage({
    type: "PAGE_READY",
    tabId: sender.tab.id,
    pageUrl: message.pageUrl || sender.tab.url,
    platform: message.platform,
    account: message.account,
    cliJobId: message.cliJobId || null
  })
    .then(async result => {
      if (result?.close) {
        closeFinishedTab(sender.tab.id);
        return { ok: true, waiting: false };
      }
      if (result?.type) {
        await handleBridgeResponse(result);
      }
      return { ok: true, waiting: result?.type !== "START_JOB" };
    })
    .catch(failureResponse);
}

// The CLI opened this tab for one job; once the job has reported its end the tab has no use.
function closeFinishedTab(tabId) {
  if (Number.isInteger(tabId)) {
    Promise.resolve(chrome.tabs.remove?.(tabId)).catch(() => {});
  }
}

async function handleAutoProgress(message, sender) {
  if (!message.state?.jobId) {
    return null;
  }
  if (await queueEngine.progress(message)) {
    return { ok: true };
  }
  return handleBridgeProgress(message, sender);
}

function handleBridgeProgress(message, sender) {
  const finished = message.type === "AUTO_DONE";
  if (finished) {
    takeCliJob(sender?.tab?.id).catch(() => {});
  }
  return postBridgeMessage({
    type: finished ? "JOB_DONE" : "JOB_PROGRESS",
    jobId: message.state.jobId,
    state: message.state
  })
    .then(() => {
      bridgeLostSince = null;
      if (finished) {
        closeFinishedTab(sender?.tab?.id);
      }
      return { ok: true };
    })
    .catch(error => {
      noteBridgeFailure(sender?.tab?.id, !finished);
      return failureResponse(error);
    });
}

chrome.tabs.onRemoved.addListener(async tabId => {
  try {
    const jobId = await takeCliJob(tabId);
    if (!jobId) {
      return;
    }
    postBridgeMessage({
      type: "JOB_ERROR",
      jobId,
      error: "The Edge profile tab was closed before the scan finished. Use the CLI resume command to continue."
    }).catch(() => {});
  } catch {
    /* a later CLI status check will expose any unfinished job */
  }
});
