// Downloads the extension starts itself: the persisted queue state, reconciling
// finished downloads, retries, and the per-download file name targets.
const STORAGE_DEFAULTS = {
  pendingDownloads: {},
  pendingItems: {},
  downloadAttempts: {},
  failedDownloads: {},
  downloadTargets: {},
  nativeVideoTarget: null,
  nativeVideoPending: {},
  nativeVideoFailures: {},
  nativeVideoAttempts: {}
};

async function enqueueDownloadTarget(url, target) {
  return queueFilenameOperation(async () => {
    const { downloadTargets = {} } = await chrome.storage.local.get({ downloadTargets: {} });
    downloadTargets[url] = [...(downloadTargets[url] || []), target];
    await chrome.storage.local.set({ downloadTargets });
  });
}

async function removeDownloadTarget(url, filename) {
  return queueFilenameOperation(async () => {
    const { downloadTargets = {} } = await chrome.storage.local.get({ downloadTargets: {} });
    const queuedTargets = downloadTargets[url] || [];
    const targetIndex = queuedTargets.map(target => typeof target === "string" ? target : target?.filename).lastIndexOf(filename);
    if (targetIndex >= 0) queuedTargets.splice(targetIndex, 1);
    if (queuedTargets.length) downloadTargets[url] = queuedTargets;
    else delete downloadTargets[url];
    await chrome.storage.local.set({ downloadTargets });
  });
}

async function takeDownloadTarget(url) {
  return queueFilenameOperation(async () => {
    const { downloadTargets = {} } = await chrome.storage.local.get({ downloadTargets: {} });
    const queuedTargets = downloadTargets[url] || [];
    const target = queuedTargets.shift();
    if (queuedTargets.length) downloadTargets[url] = queuedTargets;
    else delete downloadTargets[url];
    await chrome.storage.local.set({ downloadTargets });
    return target;
  });
}

async function readDownloadState() {
  const stored = await chrome.storage.local.get(STORAGE_DEFAULTS);
  return {
    pending: { ...stored.pendingDownloads },
    pendingItems: { ...stored.pendingItems },
    attempts: { ...stored.downloadAttempts },
    failed: { ...stored.failedDownloads },
    nativePending: { ...stored.nativeVideoPending },
    nativeFailures: { ...stored.nativeVideoFailures },
    nativeAttempts: { ...stored.nativeVideoAttempts },
    nativeTarget: stored.nativeVideoTarget || null
  };
}

async function writeDownloadState(state) {
  await chrome.storage.local.set({
    pendingDownloads: state.pending,
    pendingItems: state.pendingItems,
    downloadAttempts: state.attempts,
    failedDownloads: state.failed,
    nativeVideoPending: state.nativePending,
    nativeVideoFailures: state.nativeFailures,
    nativeVideoAttempts: state.nativeAttempts,
    nativeVideoTarget: state.nativeTarget || null
  });
}

async function reconcileDownloads() {
  const state = await readDownloadState();
  for (const [key, downloadId] of Object.entries(state.pending)) {
    let download;
    try {
      [download] = await chrome.downloads.search({ id: downloadId });
    } catch { /* keep entries that the browser cannot inspect yet */ }
    if (!download || !["complete", "interrupted"].includes(download.state)) continue;

    const item = state.pendingItems[key];
    const attemptCount = Number(state.attempts[key] || 1);
    delete state.pending[key];
    delete state.pendingItems[key];
    if (download.state === "complete") {
      await ledgerAdd(key);
      delete state.failed[key];
    } else if (item) {
      state.failed[key] = {
        item,
        attempts: attemptCount,
        error: download.error || "The browser interrupted this download."
      };
    }
  }
  for (const [downloadId, entry] of Object.entries(state.nativePending)) {
    let download;
    try {
      [download] = await chrome.downloads.search({ id: Number(downloadId) });
    } catch { /* keep entries that the browser cannot inspect yet */ }
    if (!download || !["complete", "interrupted"].includes(download.state)) continue;
    delete state.nativePending[downloadId];
    if (download.state === "complete") {
      await ledgerAdd(entry.key);
      delete state.nativeFailures[entry.key];
    } else {
      state.nativeFailures[entry.key] = {
        platform: entry.platform,
        account: entry.account,
        error: download.error || "The browser interrupted this official video download."
      };
    }
  }
  if (state.nativeTarget && state.nativeTarget.expiresAt < Date.now()) {
    state.nativeFailures[state.nativeTarget.key] = {
      platform: state.nativeTarget.platform,
      account: state.nativeTarget.account,
      error: "The site did not start a browser download after its official video action."
    };
    state.nativeTarget = null;
  }
  await writeDownloadState(state);
  return state;
}

function matchesFilter(item, platform, account) {
  if (!item) return false;
  return (!platform || item.platform === platform) && (!account || item.account === account);
}

function statusFor(state, platform, account) {
  const pending = Object.entries(state.pending).filter(([key]) => matchesFilter(state.pendingItems[key], platform, account)).length
    + Object.values(state.nativePending).filter(entry => matchesFilter(entry, platform, account)).length
    + (state.nativeTarget && state.nativeTarget.expiresAt >= Date.now() && matchesFilter(state.nativeTarget, platform, account) ? 1 : 0);
  const failedItems = Object.values(state.failed).filter(entry => matchesFilter(entry.item, platform, account));
  const nativeFailedItems = Object.values(state.nativeFailures).filter(entry => matchesFilter(entry, platform, account));
  return {
    ok: true,
    pending,
    failed: failedItems.length + nativeFailedItems.length,
    retryable: failedItems.filter(entry => entry.attempts < MAX_ATTEMPTS).length
  };
}

async function getDownloadStatus(platform, account) {
  return statusFor(await reconcileDownloads(), platform, account);
}

async function drainDownloads(platform, account, timeoutMs) {
  const timeout = Math.max(1000, Math.min(Number(timeoutMs) || 60000, 120000));
  const deadline = Date.now() + timeout;
  let status;
  do {
    status = await getDownloadStatus(platform, account);
    if (!status.pending || Date.now() >= deadline) return status;
    await pause(750);
  } while (Date.now() < deadline);
  return status;
}

async function retryFailedDownloads(platform, account) {
  const state = await reconcileDownloads();
  const items = Object.values(state.failed)
    .filter(entry => entry.attempts < MAX_ATTEMPTS && matchesFilter(entry.item, platform, account))
    .map(entry => entry.item);
  if (!items.length) return statusFor(state, platform, account);
  const result = await downloadBatch(items);
  return { ...result, ...statusFor(await reconcileDownloads(), platform, account) };
}

async function downloadBatch(inputItems) {
  if (!Array.isArray(inputItems)) return { ok: false, error: "No media list was provided." };
  const items = inputItems.slice(0, 300);
  let state = await reconcileDownloads();
  let started = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (const item of items) {
    if (!item || !platforms.PLATFORMS.includes(item.platform) || !item.url || !item.key) {
      skipped++;
      continue;
    }
    let parsedUrl;
    try {
      parsedUrl = new URL(item.url);
    } catch {
      skipped++;
      continue;
    }
    if (parsedUrl.protocol !== "https:" || !platforms.isFileHost(item.platform, parsedUrl.hostname)) {
      skipped++;
      continue;
    }
    if (await ledgerHas(item.key) || Object.hasOwn(state.pending, item.key)
      || Object.values(state.nativePending).some(entry => entry?.key === item.key)) {
      skipped++;
      continue;
    }

    const previousAttempts = Number(state.attempts[item.key] || state.failed[item.key]?.attempts || 0);
    if (previousAttempts >= MAX_ATTEMPTS) {
      skipped++;
      failed++;
      continue;
    }

    const slotDeadline = Date.now() + 60000;
    while (Object.keys(state.pending).length >= MAX_ACTIVE_DOWNLOADS && Date.now() < slotDeadline) {
      await pause(500);
      state = await reconcileDownloads();
      if (await ledgerHas(item.key) || Object.hasOwn(state.pending, item.key)) break;
    }
    if (await ledgerHas(item.key) || Object.hasOwn(state.pending, item.key)) {
      skipped++;
      continue;
    }
    if (Object.keys(state.pending).length >= MAX_ACTIVE_DOWNLOADS) {
      failed++;
      errors.push("Too many downloads are still pending; this item will be retried on the next scan.");
      continue;
    }

    const account = cleanPart(item.account);
    const filename = withResolution(
      cleanPart(item.filename || `photo.${imageExtension(item.url)}`, `photo.${imageExtension(item.url)}`),
      item.width,
      item.height
    );
    const targetFilename = buildSavePath(item.platform, account, filename);
    const attemptCount = previousAttempts + 1;
    try {
      // Keep the per-URL target for the filename listener; on a URL mismatch it
      // can preserve the requested path supplied to downloads.download.
      state.attempts[item.key] = attemptCount;
      await writeDownloadState(state);
      const conflictAction = item.overwrite === true ? "overwrite" : "uniquify";
      await enqueueDownloadTarget(item.url, { filename: targetFilename, conflictAction });
      const downloadId = await chrome.downloads.download({
        url: item.url,
        filename: targetFilename,
        conflictAction,
        saveAs: false
      });
      state.pending[item.key] = downloadId;
      state.pendingItems[item.key] = item;
      delete state.failed[item.key];
      await writeDownloadState(state);
      started++;
    } catch (error) {
      await removeDownloadTarget(item.url, targetFilename);
      state.failed[item.key] = { item, attempts: attemptCount, error: error?.message || String(error) };
      failed++;
      errors.push(`${filename}: ${error?.message || String(error)}`);
      await writeDownloadState(state);
    }
  }

  state = await reconcileDownloads();
  return { ok: true, started, skipped, failed, pending: Object.keys(state.pending).length, errors: errors.slice(0, 10) };
}

chrome.downloads.onChanged.addListener(async delta => {
  if (!delta.state || !["complete", "interrupted"].includes(delta.state.current)) return;
  try { await queueBatch(() => reconcileDownloads()); } catch { /* a later status check will reconcile */ }
});
