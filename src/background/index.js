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

// message.type -> handler. A handler returns a promise of the response, or null when
// the message needs no answer.
const handlers = {
  CLI_PAGE_READY: handleCliPageReady,
  AUTO_PROGRESS: handleAutoProgress,
  AUTO_DONE: handleAutoProgress,
  MEDIA_FOUND: message => cacheMedia(message.media),
  DOWNLOAD_CACHED_MEDIA: message => queueBatch(() => downloadCachedMedia(message)),
  SET_NATIVE_VIDEO_TARGET: message => queueBatch(() => setNativeVideoTarget(message.target)),
  DOWNLOAD_ITEMS: message => queueBatch(() => downloadBatch(message.items)),
  RETRY_FAILED_DOWNLOADS: message => queueBatch(() => retryFailedDownloads(message.platform, message.account)),
  DRAIN_DOWNLOADS: message => queueBatch(() => drainDownloads(message.platform, message.account, message.timeoutMs)),
  DOWNLOAD_STATUS: message => queueBatch(() => getDownloadStatus(message.platform, message.account))
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const handler = Object.hasOwn(handlers, message?.type) ? handlers[message.type] : null;
  const pending = handler?.(message, sender);
  if (!pending) {
    return false;
  }
  pending.then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
