// Service worker entry point. The files below are loaded in order and share one
// global scope; this file only routes messages from pages and the popup.
importScripts(
  "../../lib/sites.js",
  "../../lib/platforms.js",
  "../../lib/paths.js",
  "../../lib/urls.js",
  "../../lib/keys.js",
  "../../lib/config.js",
  "../../lib/scheduler.js",
  "../../lib/supervisor.js",
  "../../lib/login.js",
  "../../lib/job-progress.js",
  "core.js",
  "ledger.js",
  "download-queue.js",
  "media-cache.js",
  "menu-video.js",
  "queue-store.js",
  "queue-settings.js",
  "queue-login.js",
  "queue-engine.js",
  "queue-service.js",
  "bridge-client.js"
);

// message.type -> handler. A handler returns a promise of the response, or null when
// the message needs no answer.
const handlers = {
  ...queueHandlers,
  CLI_PAGE_READY: handleCliPageReady,
  AUTO_PROGRESS: handleAutoProgress,
  AUTO_DONE: handleAutoProgress,
  MEDIA_FOUND: message => cacheMedia(message.media),
  DOWNLOAD_CACHED_MEDIA: message => downloadCachedMedia(message),
  SET_NATIVE_VIDEO_TARGET: message => queueBatch(() => setNativeVideoTarget(message.target)),
  DOWNLOAD_ITEMS: message => queueBatch(() => downloadBatch(message.items)),
  RETRY_FAILED_DOWNLOADS: message => queueBatch(() => retryFailedDownloads(message.platform, message.account)),
  DRAIN_DOWNLOADS: message =>
    drainDownloads(message.platform, message.account, message.timeoutMs, (platform, account) =>
      queueBatch(() => getDownloadStatus(platform, account))
    ),
  DOWNLOAD_STATUS: message => queueBatch(() => getDownloadStatus(message.platform, message.account))
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = Object.hasOwn(handlers, message?.type) ? handlers[message.type] : null;
  const pending = handler?.(message, sender);
  if (!pending) {
    return false;
  }
  if (typeof pending.then !== "function") {
    sendResponse(pending);
    return false;
  }
  pending.then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
