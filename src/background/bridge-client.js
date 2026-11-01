// Talks to the local CLI bridge: reports page readiness and progress, starts
// jobs, and stops an abandoned scan when the CLI has been gone too long.
const CLI_BRIDGE_URL = "http://127.0.0.1:38541/message";
const BRIDGE_LOST_STOP_MS = 45000;
let bridgeLostSince = null;
let nativeBridgeState = { state: "idle", message: "Start a CLI download to connect the local bridge.", updatedAt: null };

function updateNativeBridgeState(state, message) {
  nativeBridgeState = { state, message, updatedAt: new Date().toISOString() };
  chrome.storage.local.set({ nativeBridgeState }).catch(() => {});
}

async function postBridgeMessage(message) {
  try {
    const response = await fetch(CLI_BRIDGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      cache: "no-store",
      credentials: "omit"
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || result?.ok === false) throw new Error(result?.error || `Local CLI bridge returned HTTP ${response.status}.`);
    updateNativeBridgeState("connected", "Connected to the local CLI bridge.");
    return result;
  } catch (error) {
    const messageText = error?.message || String(error);
    const isOffline = /failed to fetch|networkerror|refused|load failed/i.test(messageText);
    updateNativeBridgeState(isOffline ? "idle" : "error", isOffline
      ? "CLI bridge is offline. Start or resume a job from the CLI."
      : `CLI bridge error: ${messageText}`);
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
  if (message?.type !== "START_JOB" || !message.job || !Number.isInteger(message.tabId)) return;
  try {
    const tab = await chrome.tabs.get(message.tabId);
    if (!samePage(tab.url, message.job.url)) {
      await postBridgeMessage({ type: "JOB_ERROR", jobId: message.job.jobId, error: "The tab URL changed before the download started." });
      return;
    }
    const response = await chrome.tabs.sendMessage(message.tabId, {
      type: "AUTO_START_CLI",
      job: { ...message.job, repairTargets: message.job.repairBasenames || [] }
    });
    if (!response?.ok) {
      await postBridgeMessage({ type: "JOB_ERROR", jobId: message.job.jobId, error: response?.error || "The page could not start the automatic scan." });
    } else if (response.state?.running) {
      await chrome.storage.local.set({ activeCliJob: { jobId: message.job.jobId, tabId: message.tabId } });
    }
  } catch (error) {
    await postBridgeMessage({ type: "JOB_ERROR", jobId: message.job.jobId, error: error?.message || String(error) }).catch(() => {});
  }
}

chrome.tabs.onRemoved.addListener(async tabId => {
  try {
    const { activeCliJob } = await chrome.storage.local.get({ activeCliJob: null });
    if (activeCliJob?.tabId !== tabId) return;
    await chrome.storage.local.remove("activeCliJob");
    postBridgeMessage({
      type: "JOB_ERROR",
      jobId: activeCliJob.jobId,
      error: "The Edge profile tab was closed before the scan finished. Use the CLI resume command to continue."
    }).catch(() => {});
  } catch { /* a later CLI status check will expose any unfinished job */ }
});
