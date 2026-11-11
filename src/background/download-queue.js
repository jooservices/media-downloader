// Downloads the extension starts itself: the persisted queue state, reconciling
// finished downloads, retries, and the per-download file name targets.
const STORAGE_DEFAULTS = {
  pendingDownloads: {},
  pendingItems: {},
  deferredDownloads: [],
  downloadAttempts: {},
  failedDownloads: {},
  unavailableDownloads: {},
  downloadTargets: {},
  nativeVideoTarget: null,
  nativeVideoPending: {},
  nativeVideoFailures: {},
  nativeVideoAttempts: {},
  verifiedOutputs: {},
  queueSettings: null
};

// Errors that mean the site will never serve this file (taken down, blocked or private), unlike a network
// hiccup. Retrying them only wastes time, so such a file is settled: skipped now and on every later scan.
const UNAVAILABLE_ERRORS = new Set(["SERVER_FORBIDDEN", "SERVER_BAD_CONTENT", "SERVER_UNAUTHORIZED"]);
const isUnavailableError = error => UNAVAILABLE_ERRORS.has(error);

const FINISHED_STATES = ["complete", "interrupted"];
const MAX_BATCH_ITEMS = 300;
const SUPPORTED_VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp"]);

// Runs `update` on the stored url -> [file name targets] map, one operation at a time.
const withDownloadTargets = update =>
  queueFilenameOperation(async () => {
    const { downloadTargets = {} } = await chrome.storage.local.get({ downloadTargets: {} });
    const result = update(downloadTargets);
    await chrome.storage.local.set({ downloadTargets });
    return result;
  });

function storeTargetQueue(downloadTargets, url, queue) {
  if (queue.length) {
    downloadTargets[url] = queue;
  } else {
    delete downloadTargets[url];
  }
}

const targetFilename = target => (typeof target === "string" ? target : target?.filename);

const enqueueDownloadTarget = (url, target) =>
  withDownloadTargets(downloadTargets => {
    downloadTargets[url] = [...(downloadTargets[url] || []), target];
  });

const removeDownloadTarget = (url, filename) =>
  withDownloadTargets(downloadTargets => {
    const queue = downloadTargets[url] || [];
    const index = queue.map(targetFilename).lastIndexOf(filename);
    if (index >= 0) {
      queue.splice(index, 1);
    }
    storeTargetQueue(downloadTargets, url, queue);
  });

const takeDownloadTarget = url =>
  withDownloadTargets(downloadTargets => {
    const queue = downloadTargets[url] || [];
    const target = queue.shift();
    storeTargetQueue(downloadTargets, url, queue);
    return target;
  });

async function readDownloadState() {
  const stored = await chrome.storage.local.get(STORAGE_DEFAULTS);
  const configuredAttempts = Number(stored.queueSettings?.maxAttempts);
  return {
    pending: { ...stored.pendingDownloads },
    pendingItems: { ...stored.pendingItems },
    deferred: Array.isArray(stored.deferredDownloads) ? [...stored.deferredDownloads] : [],
    attempts: { ...stored.downloadAttempts },
    failed: { ...stored.failedDownloads },
    unavailable: { ...stored.unavailableDownloads },
    nativePending: { ...stored.nativeVideoPending },
    nativeFailures: { ...stored.nativeVideoFailures },
    nativeAttempts: { ...stored.nativeVideoAttempts },
    outputs: { ...stored.verifiedOutputs },
    nativeTarget: stored.nativeVideoTarget || null,
    maxAttempts:
      Number.isInteger(configuredAttempts) && configuredAttempts >= 1 && configuredAttempts <= 20
        ? configuredAttempts
        : MAX_ATTEMPTS
  };
}

async function writeDownloadState(state) {
  await chrome.storage.local.set({
    pendingDownloads: state.pending,
    pendingItems: state.pendingItems,
    deferredDownloads: state.deferred,
    downloadAttempts: state.attempts,
    failedDownloads: state.failed,
    unavailableDownloads: state.unavailable,
    nativeVideoPending: state.nativePending,
    nativeVideoFailures: state.nativeFailures,
    nativeVideoAttempts: state.nativeAttempts,
    verifiedOutputs: state.outputs,
    nativeVideoTarget: state.nativeTarget || null
  });
}

function downloadedOutput(download, item) {
  const filename = downloadBasename(download.filename);
  return filename && Number(download.fileSize) > 0
    ? {
        filename,
        size: Number(download.fileSize),
        platform: item.platform,
        account: item.account,
        jobId: item.jobId || null
      }
    : null;
}

const downloadBasename = filename =>
  String(filename || "")
    .split(/[\\/]/)
    .pop();

async function getVerifiedOutputs(platform, account, jobId) {
  const { verifiedOutputs = {} } = await chrome.storage.local.get({ verifiedOutputs: {} });
  return Object.values(verifiedOutputs).filter(
    output =>
      (!platform || output.platform === platform) &&
      (!account || output.account?.toLowerCase() === account.toLowerCase()) &&
      (!jobId || output.jobId === jobId)
  );
}

// The browser's record of a download once it has ended; null while it is still running
// or when the browser cannot inspect it yet (the entry is then kept).
async function findFinishedDownload(id) {
  try {
    const [download] = await chrome.downloads.search({ id });
    return download && FINISHED_STATES.includes(download.state) ? download : null;
  } catch {
    return null;
  }
}

async function discardRejectedDownload(download) {
  if (download?.state === "complete" && Number.isInteger(download.id) && chrome.downloads.removeFile) {
    try {
      await chrome.downloads.removeFile(download.id);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

function downloadIntegrityError(download, expectedType) {
  const received = Number(download.bytesReceived);
  const total = Number(download.totalBytes);
  const actual = Number(download.fileSize);
  const hasKnownTotal = Number.isFinite(total) && total >= 0;
  const hasKnownFileSize = Number.isFinite(actual) && actual >= 0;
  if (
    !Number.isFinite(received) ||
    received <= 0 ||
    !hasKnownFileSize ||
    actual <= 0 ||
    received !== actual ||
    (hasKnownTotal && received !== total)
  ) {
    return "The downloaded file was empty or its size did not match the response.";
  }
  const mime = String(download.mime || "").toLowerCase();
  if (expectedType && mime && mime !== "application/octet-stream" && !mime.startsWith(`${expectedType}/`)) {
    return `The response type ${mime} did not match the expected ${expectedType} media.`;
  }
  const extension = downloadFileExtension(download.filename);
  if (!extension || (expectedType === "image" && !["jpg", "jpeg", "png", "webp", "gif", "avif"].includes(extension))) {
    return "The completed download did not have a supported media file extension.";
  }
  if (expectedType === "video" && !["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp"].includes(extension)) {
    return "The completed download did not have a supported video extension.";
  }
  return null;
}

function downloadFileExtension(filename) {
  return (
    String(filename || "")
      .split(/[\\/]/)
      .pop()
      .match(/\.([a-z0-9]+)$/i)?.[1]
      ?.toLowerCase() || ""
  );
}

function expectedMediaType(item) {
  const extension = downloadFileExtension(item?.filename);
  if (SUPPORTED_VIDEO_EXTENSIONS.has(extension)) {
    return "video";
  }
  try {
    if (SUPPORTED_VIDEO_EXTENSIONS.has(downloadFileExtension(new URL(item?.url).pathname))) {
      return "video";
    }
  } catch {
    /* An invalid URL is rejected before a download starts. */
  }
  return "image";
}

// A file the site will not serve: remember it as settled so no scan tries it again, and keep a count
// for the job's summary. `who` carries the platform and account the file belongs to.
async function settleUnavailable(state, key, who) {
  await ledgerAdd(key);
  delete state.failed[key];
  delete state.nativeFailures[key];
  state.unavailable[key] = { platform: who.platform, account: who.account };
}

// Failures recorded by an earlier version (or an earlier pass) that turn out to be permanent are settled too.
async function settleKnownUnavailable(state) {
  for (const [key, entry] of Object.entries(state.failed)) {
    if (isUnavailableError(entry.error)) {
      await settleUnavailable(state, key, entry.item);
    }
  }
  for (const [key, entry] of Object.entries(state.nativeFailures)) {
    if (isUnavailableError(entry.error)) {
      await settleUnavailable(state, key, entry);
    }
  }
}

async function reconcileFinishedDownload(state, { key, item, download, expectedType, native = false }) {
  const integrityError = download.state === "complete" ? downloadIntegrityError(download, expectedType) : null;
  const failures = native ? state.nativeFailures : state.failed;
  if (download.state === "complete" && !integrityError) {
    await ledgerAdd(key);
    const output = downloadedOutput(download, item);
    if (output) {
      state.outputs[key] = output;
    }
    delete failures[key];
    return;
  }
  if (isUnavailableError(download.error)) {
    await settleUnavailable(state, key, item);
    return;
  }
  const removed = await discardRejectedDownload(download);
  failures[key] = {
    ...(native ? {} : { item, attempts: Number(state.attempts[key] || 1) }),
    platform: item.platform,
    account: item.account,
    error:
      integrityError ||
      download.error ||
      (native ? "The browser interrupted this official video download." : "The browser interrupted this download."),
    ...(!removed && integrityError ? { rejectedFilename: downloadBasename(download.filename) } : {})
  };
}

async function reconcilePending(state) {
  for (const [key, downloadId] of Object.entries(state.pending)) {
    const download = await findFinishedDownload(downloadId);
    if (!download) {
      continue;
    }
    const item = state.pendingItems[key];
    delete state.pending[key];
    delete state.pendingItems[key];
    if (item) {
      await reconcileFinishedDownload(state, { key, item, download, expectedType: expectedMediaType(item) });
    }
  }
}

async function reconcileNative(state) {
  for (const [downloadId, entry] of Object.entries(state.nativePending)) {
    const download = await findFinishedDownload(Number(downloadId));
    if (!download) {
      continue;
    }
    delete state.nativePending[downloadId];
    await reconcileFinishedDownload(state, {
      key: entry.key,
      item: entry,
      download,
      expectedType: "video",
      native: true
    });
  }
}

// The armed menu target lives 30 seconds; one the site never answered is a failure.
function expireNativeTarget(state) {
  const target = state.nativeTarget;
  if (target && target.expiresAt < Date.now()) {
    state.nativeFailures[target.key] = {
      platform: target.platform,
      account: target.account,
      error: "The site did not start a browser download after its official video action."
    };
    state.nativeTarget = null;
  }
}

async function reconcileDownloads() {
  const state = await readDownloadState();
  await reconcilePending(state);
  await reconcileNative(state);
  expireNativeTarget(state);
  await settleKnownUnavailable(state);
  await writeDownloadState(state);
  await startDeferredDownloads(state);
  return state;
}

function matchesFilter(item, platform, account) {
  if (!item) {
    return false;
  }
  return (!platform || item.platform === platform) && (!account || item.account === account);
}

function countPending(state, platform, account) {
  const direct = Object.entries(state.pending).filter(([key]) =>
    matchesFilter(state.pendingItems[key], platform, account)
  ).length;
  const native = Object.values(state.nativePending).filter(entry => matchesFilter(entry, platform, account)).length;
  const deferred = state.deferred.filter(item => matchesFilter(item, platform, account)).length;
  const armed = state.nativeTarget?.expiresAt >= Date.now() && matchesFilter(state.nativeTarget, platform, account);
  return direct + native + deferred + (armed ? 1 : 0);
}

function statusFor(state, platform, account) {
  const failedItems = Object.values(state.failed).filter(entry => matchesFilter(entry.item, platform, account));
  const nativeFailedItems = Object.values(state.nativeFailures).filter(entry =>
    matchesFilter(entry, platform, account)
  );
  const rejectedFiles = [
    ...failedItems.map(entry => entry.rejectedFilename),
    ...nativeFailedItems.map(entry => entry.rejectedFilename)
  ].filter(Boolean);
  return {
    ok: true,
    pending: countPending(state, platform, account),
    failed: failedItems.length + nativeFailedItems.length,
    unavailable: Object.values(state.unavailable).filter(entry => matchesFilter(entry, platform, account)).length,
    ...(rejectedFiles.length ? { rejectedFiles } : {}),
    retryable: failedItems.filter(entry => entry.attempts < state.maxAttempts).length
  };
}

async function getDownloadStatus(platform, account) {
  return statusFor(await reconcileDownloads(), platform, account);
}

async function drainDownloads(platform, account, timeoutMs, getStatus = getDownloadStatus) {
  const timeout = Math.max(1000, Math.min(Number(timeoutMs) || 60000, 120000));
  const deadline = Date.now() + timeout;
  let status = await getStatus(platform, account);
  while (status.pending && Date.now() < deadline) {
    await pause(750);
    status = await getStatus(platform, account);
  }
  return status;
}

async function retryFailedDownloads(platform, account) {
  const state = await reconcileDownloads();
  const items = Object.values(state.failed)
    .filter(entry => entry.attempts < state.maxAttempts && matchesFilter(entry.item, platform, account))
    .map(entry => entry.item);
  if (!items.length) {
    return statusFor(state, platform, account);
  }
  const result = await downloadBatch(items);
  return { ...result, ...statusFor(await reconcileDownloads(), platform, account) };
}

// An item is downloadable when it names a known platform, a key, and an https file on that platform's CDN.
function isDownloadable(item) {
  if (!item || !platforms.PLATFORMS.includes(item.platform) || !item.url || !item.key) {
    return false;
  }
  try {
    const url = new URL(item.url);
    return url.protocol === "https:" && platforms.isFileHost(item.platform, url.hostname);
  } catch {
    return false;
  }
}

async function isSaved(state, key) {
  return (await ledgerHas(key)) || Object.hasOwn(state.pending, key) || state.deferred.some(item => item.key === key);
}

const isInNativeFlow = (state, key) =>
  state.nativeTarget?.key === key || Object.values(state.nativePending).some(entry => entry?.key === key);

function saveTarget(item) {
  const fallback = `photo.${imageExtension(item.url)}`;
  const filename = cleanPart(
    withResolution(cleanPart(item.filename || fallback, fallback), item.width, item.height),
    fallback
  );
  return { filename, path: buildSavePath(item.platform, cleanPart(item.account), filename) };
}

// Keeps the per-URL target for the filename listener; on a URL mismatch it can preserve
// the requested path supplied to downloads.download.
async function startItemDownload(state, item, attemptCount) {
  const target = saveTarget(item);
  try {
    state.attempts[item.key] = attemptCount;
    await writeDownloadState(state);
    const conflictAction = item.overwrite === true ? "overwrite" : "uniquify";
    await enqueueDownloadTarget(item.url, { filename: target.path, conflictAction });
    const downloadId = await chrome.downloads.download({
      url: item.url,
      filename: target.path,
      conflictAction,
      saveAs: false
    });
    state.pending[item.key] = downloadId;
    state.pendingItems[item.key] = item;
    delete state.failed[item.key];
    await writeDownloadState(state);
    return { state, started: 1 };
  } catch (error) {
    const reason = error?.message || String(error);
    await removeDownloadTarget(item.url, target.path);
    state.failed[item.key] = { item, attempts: attemptCount, error: reason };
    await writeDownloadState(state);
    return { state, failed: 1, error: `${target.filename}: ${reason}` };
  }
}

// One item of a batch: { state, started?, skipped?, failed?, error? }.
async function processBatchItem(initialState, item) {
  if (!isDownloadable(item)) {
    return { state: initialState, skipped: 1 };
  }
  if ((await isSaved(initialState, item.key)) || isInNativeFlow(initialState, item.key)) {
    return { state: initialState, skipped: 1 };
  }
  const previousAttempts = Number(initialState.attempts[item.key] || initialState.failed[item.key]?.attempts || 0);
  if (previousAttempts >= initialState.maxAttempts) {
    return { state: initialState, skipped: 1, failed: 1 };
  }
  if (Object.keys(initialState.pending).length >= MAX_ACTIVE_DOWNLOADS) {
    return { state: initialState, full: true };
  }
  return startItemDownload(initialState, item, previousAttempts + 1);
}

async function startDeferredDownloads(state) {
  while (state.deferred.length && Object.keys(state.pending).length < MAX_ACTIVE_DOWNLOADS) {
    const [item, ...remaining] = state.deferred;
    state.deferred = remaining;
    const result = await processBatchItem(state, item);
    state = result.state;
    if (result.full) {
      state.deferred.unshift(item);
      break;
    }
  }
  await writeDownloadState(state);
  return state;
}

function enqueueDeferredItems(state, items) {
  const queued = new Set(state.deferred.map(item => item.key));
  for (const item of items) {
    if (item?.key && !queued.has(item.key)) {
      state.deferred.push(item);
      queued.add(item.key);
    }
  }
  return state.deferred.length;
}

async function downloadBatch(inputItems, { reconcile = true } = {}) {
  if (!Array.isArray(inputItems)) {
    return { ok: false, error: "No media list was provided." };
  }
  const total = { started: 0, skipped: 0, failed: 0 };
  const errors = [];
  let state = reconcile ? await reconcileDownloads() : await readDownloadState();
  const batch = inputItems.slice(0, MAX_BATCH_ITEMS);
  const batchKeys = new Set(inputItems.map(item => item?.key).filter(Boolean));
  for (let index = 0; index < batch.length; index++) {
    const item = batch[index];
    const result = await processBatchItem(state, item);
    if (result.full) {
      enqueueDeferredItems(state, inputItems.slice(index));
      break;
    }
    state = result.state;
    total.started += result.started ?? 0;
    total.skipped += result.skipped ?? 0;
    total.failed += result.failed ?? 0;
    if (result.error) {
      errors.push(result.error);
    }
  }
  if (batch.length < inputItems.length) {
    enqueueDeferredItems(state, inputItems.slice(batch.length));
  }
  await writeDownloadState(state);
  const queued = state.deferred.filter(item => batchKeys.has(item.key)).length;
  return {
    ok: true,
    ...total,
    queued,
    pending: Object.keys(state.pending).length + state.deferred.length,
    errors: errors.slice(0, 10)
  };
}

chrome.downloads.onChanged.addListener(async delta => {
  if (!delta.state || !FINISHED_STATES.includes(delta.state.current)) {
    return;
  }
  try {
    await queueBatch(() => reconcileDownloads());
  } catch {
    /* a later status check will reconcile */
  }
});
