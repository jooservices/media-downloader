const saveButton = document.querySelector("#save");
const autoStartButton = document.querySelector("#auto-start");
const autoStopButton = document.querySelector("#auto-stop");
const statusBox = document.querySelector("#status");
const bridgeStatusBox = document.querySelector("#bridge-status");
const limitCount = document.querySelector("#limit-count");
const limitUnlimited = document.querySelector("#limit-unlimited");

const { platforms, settings } = PageMediaLib;

// The dashboard is where lists of profiles are managed; the popup only points to it and says how it is going.
const t = PageMediaStrings.translator(chrome.i18n?.getUILanguage?.() || navigator.language);
const dashboardButton = document.querySelector("#open-dashboard");
const queueSummary = document.querySelector("#queue-summary");
dashboardButton.textContent = t("openDashboard");
dashboardButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
  window.close();
});

async function showQueueSummary() {
  const reply = await chrome.runtime.sendMessage({ type: "QUEUE_STATE" }).catch(() => null);
  if (!reply?.ok) {
    return;
  }
  const needed = PageMediaOptions.signInNeeded(reply.login, reply.jobs);
  if (needed.length) {
    queueSummary.textContent = t("signInNeeded", { site: needed[0].label });
  } else if (reply.jobs.length) {
    queueSummary.textContent = t("summary", PageMediaOptions.summarize(reply.jobs));
  }
}
showQueueSummary();

function setStatus(message) {
  statusBox.textContent = message;
}

async function showBridgeStatus() {
  const { nativeBridgeState } = await chrome.storage.local.get({ nativeBridgeState: null });
  bridgeStatusBox.textContent = `CLI bridge: ${nativeBridgeState?.message || "Waiting for an Edge profile page."}`;
}

async function getActivePage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("No active browser page was found.");
  }
  return tab;
}

// A tab opened before the extension was installed has none of the content scripts yet,
// so inject the same ordered list the manifest declares.
async function ensureContentScript(tab) {
  const files = chrome.runtime
    .getManifest()
    .content_scripts.find(entry => entry.js.includes("src/content/index.js")).js;
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
}

function requireSupportedPage(tab, message) {
  if (!platforms.platformForHost(new URL(tab.url).hostname)) {
    throw new Error(message);
  }
}

function describeVideoResult(result) {
  if (result.videoDownloadsClicked) {
    return `\nStarted ${result.videoDownloadsClicked} file download(s) from the page's data or menus.`;
  }
  if (result.videoArticlesSeen) {
    return `\nChecked ${result.videoArticlesSeen} visible video player(s); none started because a supported download action was unavailable, already saved, or pending.`;
  }
  return "\nNo video player is currently loaded on this page.";
}

function showAutoState(state) {
  if (!state) {
    return;
  }
  autoStartButton.disabled = Boolean(state.running);
  autoStopButton.disabled = !state.running;
  if (state.message) {
    setStatus(state.message);
  }
}

async function loadLimit() {
  const stored = await chrome.storage.local.get({ [settings.STORAGE_KEY]: settings.DEFAULTS });
  const { limit, unlimited } = settings.normalizeScanLimit(stored[settings.STORAGE_KEY]);
  limitCount.value = String(limit);
  limitUnlimited.checked = unlimited;
  limitCount.disabled = unlimited;
}

async function saveLimit() {
  const value = settings.normalizeScanLimit({ limit: limitCount.value, unlimited: limitUnlimited.checked });
  limitCount.value = String(value.limit);
  limitCount.disabled = value.unlimited;
  await chrome.storage.local.set({ [settings.STORAGE_KEY]: value });
}

limitCount.addEventListener("change", () => saveLimit().catch(() => {}));
limitUnlimited.addEventListener("change", () => saveLimit().catch(() => {}));

saveButton.addEventListener("click", async () => {
  saveButton.disabled = true;
  setStatus("Reading media currently loaded on this page…");

  try {
    const tab = await getActivePage();
    requireSupportedPage(tab, "Open an Instagram, Facebook, or X page first.");

    await ensureContentScript(tab);
    const result = await chrome.tabs.sendMessage(tab.id, { type: "COLLECT_VISIBLE_MEDIA" });
    if (!result?.ok) {
      throw new Error(result?.error || "Could not read media from this page.");
    }

    const videoText = describeVideoResult(result);

    if (!result.items.length) {
      setStatus(`No new photos found. Scroll to load more and try again.${videoText}`);
      return;
    }

    setStatus(`Found ${result.items.length} photo(s). Starting downloads…`);
    const downloadResult = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_ITEMS",
      items: result.items
    });
    if (!downloadResult?.ok) {
      throw new Error(downloadResult?.error || "The download request failed.");
    }

    setStatus(
      `Started ${downloadResult.started} request(s); ${downloadResult.pending || 0} pending; ${downloadResult.failed || 0} failed; skipped ${downloadResult.skipped} saved or unavailable items.${videoText}\nFiles go to Downloads/<platform>/<account>.`
    );
  } catch (error) {
    setStatus(error?.message || String(error));
  } finally {
    saveButton.disabled = false;
  }
});

autoStartButton.addEventListener("click", async () => {
  autoStartButton.disabled = true;
  setStatus("Starting automatic scroll and download…");
  try {
    const tab = await getActivePage();
    requireSupportedPage(tab, "Automatic mode supports Instagram/Facebook grids and X profile timelines.");
    await saveLimit();
    await ensureContentScript(tab);
    const result = await chrome.tabs.sendMessage(tab.id, { type: "AUTO_START" });
    if (!result?.ok) {
      throw new Error(result?.error || "Could not start automatic downloading.");
    }
    showAutoState(result.state);
  } catch (error) {
    autoStartButton.disabled = false;
    setStatus(error?.message || String(error));
  }
});

autoStopButton.addEventListener("click", async () => {
  autoStopButton.disabled = true;
  try {
    const tab = await getActivePage();
    const result = await chrome.tabs.sendMessage(tab.id, { type: "AUTO_STOP" });
    if (!result?.ok) {
      throw new Error(result?.error || "Could not stop automatic downloading.");
    }
    showAutoState(result.state);
  } catch (error) {
    setStatus(error?.message || String(error));
  }
});

chrome.runtime.onMessage.addListener(message => {
  if (message?.type === "AUTO_PROGRESS" || message?.type === "AUTO_DONE") {
    showAutoState(message.state);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes.nativeBridgeState) {
    showBridgeStatus().catch(() => {});
  }
});

(async () => {
  await loadLimit().catch(() => {});
  try {
    await showBridgeStatus();
    const tab = await getActivePage();
    const state = await chrome.tabs.sendMessage(tab.id, { type: "AUTO_STATUS" });
    showAutoState(state?.state);
  } catch {
    /* there is no active downloader on this tab */
  }
})();
