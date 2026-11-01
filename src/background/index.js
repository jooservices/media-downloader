// Service worker entry point. The files below are loaded in order and share one
// global scope; this file only routes messages from pages and the popup.
importScripts(
  "../../lib/platforms.js",
  "../../lib/paths.js",
  "../../lib/urls.js",
  "../../lib/keys.js",
  "core.js",
  "ledger.js",
  "download-queue.js",
  "media-cache.js",
  "menu-video.js",
  "bridge-client.js"
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "CLI_PAGE_READY") {
    if (!Number.isInteger(_sender?.tab?.id)) {
      sendResponse({ ok: false, error: "The page tab could not be identified." });
      return false;
    }
    postBridgeMessage({
      type: "PAGE_READY",
      tabId: _sender.tab.id,
      pageUrl: message.pageUrl || _sender.tab.url,
      platform: message.platform,
      account: message.account
    }).then(async result => {
      if (result?.type) await handleBridgeResponse(result);
      sendResponse({ ok: true, waiting: result?.type !== "START_JOB" });
    }).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "AUTO_PROGRESS" || message?.type === "AUTO_DONE") {
    if (message.state?.jobId) {
      if (message.type === "AUTO_DONE") chrome.storage.local.remove("activeCliJob").catch(() => {});
      postBridgeMessage({
        type: message.type === "AUTO_DONE" ? "JOB_DONE" : "JOB_PROGRESS",
        jobId: message.state.jobId,
        state: message.state
      }).then(() => {
        bridgeLostSince = null;
        sendResponse({ ok: true });
      }).catch(error => {
        // The CLI was closed: let `resume` reconnect for a while, then stop the
        // scan so an abandoned tab cannot keep downloading unattended.
        bridgeLostSince ??= Date.now();
        if (message.type === "AUTO_PROGRESS" && Date.now() - bridgeLostSince >= BRIDGE_LOST_STOP_MS
          && Number.isInteger(_sender?.tab?.id)) {
          chrome.tabs.sendMessage(_sender.tab.id, { type: "AUTO_STOP" }).catch(() => {});
        }
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
      return true;
    }
    return false;
  }
  if (message?.type === "MEDIA_FOUND") {
    cacheMedia(message.media).then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "DOWNLOAD_CACHED_MEDIA") {
    queueBatch(() => downloadCachedMedia(message)).then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "SET_NATIVE_VIDEO_TARGET") {
    queueBatch(() => setNativeVideoTarget(message.target)).then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (message?.type === "DOWNLOAD_ITEMS") {
    queueBatch(() => downloadBatch(message.items)).then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "RETRY_FAILED_DOWNLOADS") {
    queueBatch(() => retryFailedDownloads(message.platform, message.account)).then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "DRAIN_DOWNLOADS") {
    queueBatch(() => drainDownloads(message.platform, message.account, message.timeoutMs)).then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "DOWNLOAD_STATUS") {
    queueBatch(() => getDownloadStatus(message.platform, message.account)).then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  return false;
});
