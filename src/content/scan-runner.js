// The automatic scan: state, the scroll loop, the file limit, and one pass over the page.
// Loaded as a content script before src/content/index.js; modules share the
// PageMediaSaver namespace and are safe to load twice.
globalThis.PageMediaSaver ??= {};
(function initScan(ns) {
  const { pause } = ns.core;
  const { isProfileGrid, isMediaPostPage, getAccount, platformForPage } = ns.page;
  const { addImageSizes } = ns.imageSize;
  const { collectX } = ns.collectors;
  const { collectPageMedia } = ns.videoSources;

  const SUPPORTED_PLATFORMS = ["Facebook", "Instagram", "Twitter"];
  const MAX_ROUNDS = 10000;
  const VIDEO_WAIT_MS = 12000;
  const END_CHECKS = 4;
  const LAZY_LOAD_POLL_MS = 500;
  const LAZY_LOAD_POLLS = 12;
  const STALL_CHECKS = 8;

  let autoRunning = false;
  let autoStopRequested = false;
  let autoState = {
    running: false,
    status: "idle",
    jobId: null,
    started: 0,
    skipped: 0,
    videoStarted: 0,
    videoSkipped: 0,
    failed: 0,
    unavailable: 0,
    pending: 0,
    rounds: 0,
    message: "",
    repairMode: false,
    repairTargets: [],
    repairFound: [],
    repairFiles: []
  };

  function pageHeight() {
    return Math.max(document.documentElement?.scrollHeight || 0, document.body?.scrollHeight || 0);
  }

  function pageTop() {
    return document.scrollingElement?.scrollTop || window.scrollY || 0;
  }

  function publishAutoState(type = "AUTO_PROGRESS") {
    chrome.storage.local.set({ autoDownloadStatus: autoState }).catch(() => {});
    chrome.runtime.sendMessage({ type, state: autoState }).catch(() => {});
  }

  const skippedCount = () => autoState.skipped + autoState.videoSkipped;
  const hasOutstanding = () => Boolean(autoState.pending || autoState.failed);

  function updateAutoMessage() {
    const { repairFound, repairTargets, pending, failed, rounds, started, videoStarted } = autoState;
    autoState.message = autoState.repairMode
      ? `Repair download running · ${repairFound.length}/${repairTargets.length} source images matched · ${pending} pending · ${failed} failed · ${rounds} passes.`
      : `Automatic download running · ${started} photos and ${videoStarted} page-data files started · ${pending} pending · ${failed} failed · ${skippedCount()} skipped · ${rounds} passes. Use Stop automatic download to pause.`;
    publishAutoState();
  }

  // Adds one batch's counters to the scan totals.
  function accumulate(batch) {
    autoState.started += batch.started || 0;
    autoState.skipped += batch.skipped || 0;
    autoState.failed += batch.failed || 0;
    autoState.pending = batch.pending || 0;
    autoState.videoStarted += batch.videoStarted || 0;
    autoState.videoSkipped += batch.videoSkipped || 0;
    autoState.rounds++;
  }

  const batchStartedFiles = batch => (batch.started || 0) > 0 || (batch.videoStarted || 0) > 0;

  // Files this scan may still start when the CLI job set `--limit`; Infinity otherwise.
  function limitRemaining() {
    if (!autoState.limit) {
      return Infinity;
    }
    return Math.max(0, autoState.limit - autoState.started - autoState.videoStarted);
  }

  const limitReached = () => limitRemaining() === 0;

  async function finishDownloads() {
    let status;
    let retries = 0;
    let drains = 0;
    while (drains < 10) {
      status = await chrome.runtime.sendMessage({
        type: "DRAIN_DOWNLOADS",
        platform: autoState.platform,
        account: autoState.account,
        timeoutMs: 60000
      });
      drains++;
      autoState.pending = status.pending || 0;
      autoState.failed = status.failed || 0;
      autoState.unavailable = status.unavailable || 0;
      updateAutoMessage();
      if (autoState.pending > 0) {
        continue;
      }
      if (!status.retryable || retries >= 2) {
        break;
      }

      const retry = await chrome.runtime.sendMessage({
        type: "RETRY_FAILED_DOWNLOADS",
        platform: autoState.platform,
        account: autoState.account
      });
      if (!retry?.ok) {
        break;
      }
      autoState.started += retry.started || 0;
      retries++;
      if (!retry.started) {
        break;
      }
    }
    status = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_STATUS",
      platform: autoState.platform,
      account: autoState.account
    });
    return status || { pending: autoState.pending, failed: autoState.failed };
  }

  // Waits for the downloads to end, then records what is still pending or failed.
  async function settleDownloads() {
    const finalStatus = await finishDownloads();
    autoState.pending = finalStatus.pending || 0;
    autoState.failed = finalStatus.failed || 0;
    autoState.unavailable = finalStatus.unavailable || 0;
  }

  function endScan(status, message) {
    autoState.running = false;
    autoState.status = status;
    autoState.message = message;
    publishAutoState("AUTO_DONE");
  }

  async function finishAtLimit() {
    await settleDownloads();
    const { limit, started, videoStarted, pending, failed } = autoState;
    endScan(
      hasOutstanding() ? "incomplete" : "complete",
      `Limit of ${limit} file(s) reached: ${started} photo request(s) and ${videoStarted} page-data file(s) started; ${pending} pending and ${failed} failed.`
    );
  }

  const lowerName = name => String(name).toLowerCase();

  function repairBasename(url) {
    try {
      return decodeURIComponent(new URL(url).pathname.split("/").pop() || "");
    } catch {
      return null;
    }
  }

  // Repair mode only downloads the images it was asked to find, once each, over their old copies.
  function repairItemsFrom(allItems) {
    const targetNames = new Set(autoState.repairTargets.map(lowerName));
    const seen = new Set(autoState.repairFound.map(lowerName));
    const matched = [];
    for (const item of allItems) {
      const basename = repairBasename(item.url);
      if (basename !== null && targetNames.has(lowerName(basename)) && !seen.has(lowerName(basename))) {
        matched.push({
          ...item,
          key: `repair:${autoState.jobId}:${lowerName(basename)}`,
          overwrite: true,
          repairBasename: basename
        });
      }
    }
    return matched;
  }

  function noteRepairMatches(items) {
    for (const item of items) {
      const basename = lowerName(item.repairBasename || "");
      const known = autoState.repairFound.some(name => lowerName(name) === basename);
      if (basename && !known) {
        autoState.repairFound.push(item.repairBasename);
        autoState.repairFiles.push({
          basename: item.repairBasename,
          filename: item.filename,
          account: item.account,
          platform: item.platform
        });
      }
    }
  }

  const emptyBatch = result => ({
    started: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
    errors: [],
    videoStarted: result.videoDownloadsClicked || 0,
    videoSkipped: result.videoDownloadsSkipped || 0
  });

  async function downloadVisibleBatch() {
    const result = await collect();
    if (!result?.ok) {
      throw new Error(result?.error || "Could not read this page.");
    }
    if (!SUPPORTED_PLATFORMS.includes(result.platform)) {
      throw new Error("Automatic scrolling supports Instagram/Facebook grids and X profile timelines.");
    }
    if (!result.items.length) {
      return emptyBatch(result);
    }
    const clicked = result.videoDownloadsClicked || 0;
    const allowed = result.items.slice(0, Math.max(0, limitRemaining() - clicked));
    if (!allowed.length) {
      return emptyBatch(result);
    }
    // Repair mode keeps the original file names so the old copies can be matched.
    const items = autoState.repairMode ? repairItemsFrom(result.items) : await addImageSizes(allowed);
    if (!items.length) {
      return { started: 0, skipped: 0, failed: 0, pending: 0, errors: [] };
    }
    const response = await chrome.runtime.sendMessage({ type: "DOWNLOAD_ITEMS", items });
    if (!response?.ok) {
      throw new Error(response?.error || "The download request failed.");
    }
    if (autoState.repairMode) {
      noteRepairMatches(items);
    }
    return { ...response, videoStarted: clicked, videoSkipped: result.videoDownloadsSkipped || 0 };
  }

  // A single post: wait briefly for its player, read the page once, then finish.
  async function runSinglePage() {
    const deadline = Date.now() + VIDEO_WAIT_MS;
    while (Date.now() < deadline && !globalThis.PageMediaDetection.hasVisibleVideoPost(document)) {
      await pause(400);
    }
    accumulate(await downloadVisibleBatch());
    updateAutoMessage();
    await settleDownloads();
    const { pending, failed, started, videoStarted } = autoState;
    endScan(
      hasOutstanding() ? "incomplete" : "complete",
      hasOutstanding()
        ? `Post scan ended with ${pending} pending and ${failed} failed item(s); ${videoStarted} page-data file download(s) started.`
        : `Post scan complete: ${started} photo request(s), ${videoStarted} page-data file download(s) started, and ${skippedCount()} saved or unavailable item(s) skipped.`
    );
  }

  // Files the site no longer serves (taken down, blocked) are skipped for good, not counted as failures.
  const unavailableNote = () =>
    autoState.unavailable ? ` (${autoState.unavailable} of them the site no longer serves)` : "";

  // The scroll loop ended because four checks found no older rows.
  async function finishGrid() {
    await settleDownloads();
    const { repairFound, repairTargets, started, videoStarted, pending, failed } = autoState;
    const repairShort = autoState.repairMode && repairFound.length !== repairTargets.length;
    let message;
    if (repairShort) {
      message = `Repair incomplete: matched ${repairFound.length} of ${repairTargets.length} source images. Original files were left in Downloads.`;
    } else if (hasOutstanding()) {
      message = `Grid scan ended after four checks found no older rows. ${started} download request(s) started; ${pending} remain pending and ${failed} failed after retries.`;
    } else {
      message = `Download finished: ${started} photo request(s) and ${videoStarted} page-data file(s) completed with no pending or failed files; ${skippedCount()} saved or unavailable items skipped${unavailableNote()}. Four end checks found no older rows.`;
    }
    endScan(hasOutstanding() || repairShort ? "incomplete" : "complete", message);
  }

  // Lazy rows can take several seconds on a slow connection: poll until the page grows or the wait runs out.
  async function waitForMoreRows(heightBefore) {
    await pause(1800);
    for (let polls = 0; polls < LAZY_LOAD_POLLS && pageHeight() <= heightBefore + 40; polls++) {
      await pause(LAZY_LOAD_POLL_MS);
    }
  }

  // At the bottom of the grid: wait for lazy rows, nudge the page, and count a stall when nothing new came.
  // Returns true when the scan has ended.
  async function runBottomPass(scroll, heightBefore) {
    await waitForMoreRows(heightBefore);
    window.scrollBy({ top: Math.max(250, Math.floor(window.innerHeight * 0.55)), left: 0, behavior: "instant" });
    await waitForMoreRows(pageHeight());
    const endBatch = await downloadVisibleBatch();
    accumulate(endBatch);
    if (limitReached()) {
      await finishAtLimit();
      return true;
    }
    const heightAfter = pageHeight();
    scroll.idle = batchStartedFiles(endBatch) || heightAfter > heightBefore + 40 ? 0 : scroll.idle + 1;
    updateAutoMessage();
    if (scroll.idle >= END_CHECKS) {
      await finishGrid();
      return true;
    }
    scroll.lastHeight = heightAfter;
    scroll.lastTop = pageTop();
    return false;
  }

  // Mid-page: scroll down a screen; give up if the page stops moving or loading.
  async function runMidPass(scroll, batch) {
    window.scrollBy({ top: Math.max(600, Math.floor(window.innerHeight * 0.78)), left: 0, behavior: "instant" });
    await pause(1600);
    const heightAfter = pageHeight();
    const topAfter = pageTop();
    const progressed =
      batchStartedFiles(batch) || heightAfter > scroll.lastHeight + 40 || topAfter > scroll.lastTop + 20;
    scroll.idle = progressed ? 0 : scroll.idle + 1;
    scroll.lastHeight = heightAfter;
    scroll.lastTop = topAfter;
    if (scroll.idle >= STALL_CHECKS) {
      throw new Error(
        "The page stopped scrolling or loading photos. Automatic mode paused so it does not loop forever."
      );
    }
    return false;
  }

  // One pass over the visible rows, then scroll. Returns true when the scan has ended.
  async function runGridPass(scroll) {
    const batch = await downloadVisibleBatch();
    accumulate(batch);
    updateAutoMessage();
    if (limitReached()) {
      await finishAtLimit();
      return true;
    }
    const heightBefore = pageHeight();
    const maxTop = Math.max(0, heightBefore - window.innerHeight);
    const atBottom = pageTop() >= maxTop - 60;
    return atBottom ? runBottomPass(scroll, heightBefore) : runMidPass(scroll, batch);
  }

  async function runAutoDownload() {
    const scroll = { idle: 0, lastHeight: pageHeight(), lastTop: pageTop() };
    try {
      if (autoState.singlePage) {
        await runSinglePage();
        return;
      }
      while (!autoStopRequested && autoState.rounds < MAX_ROUNDS) {
        if (await runGridPass(scroll)) {
          return;
        }
      }
      if (autoStopRequested) {
        const { started, videoStarted } = autoState;
        endScan(
          "paused",
          `Automatic download paused: ${started} photo request(s) and ${videoStarted} page-data file(s) started; ${skippedCount()} saved or unavailable items skipped. You can resume it later.`
        );
      } else {
        endScan("paused", "Automatic download stopped at its safety limit of 10,000 scroll passes.");
      }
    } catch (error) {
      endScan("paused", `Automatic download paused: ${error?.message || String(error)}`);
    } finally {
      autoRunning = false;
      autoStopRequested = false;
    }
  }

  function startAutoScan(jobId = null, repairTargets = [], limit = null) {
    if (autoRunning) {
      if (jobId && autoState.jobId !== jobId) {
        return { ok: false, error: "Another automatic download is already running in this tab." };
      }
      return { ok: true, state: autoState };
    }
    const platform = platformForPage();
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      return { ok: false, error: "Automatic mode supports Instagram/Facebook grids and X profile timelines." };
    }
    const singlePage = !isProfileGrid(platform) && isMediaPostPage(platform);
    if (!isProfileGrid(platform) && !singlePage) {
      return {
        ok: false,
        error: "Open a supported Instagram/Facebook profile grid, X timeline, or direct media post URL."
      };
    }
    autoStopRequested = false;
    autoRunning = true;
    autoState = {
      running: true,
      status: "running",
      jobId,
      account: getAccount(platform),
      platform,
      started: 0,
      skipped: 0,
      videoStarted: 0,
      videoSkipped: 0,
      failed: 0,
      unavailable: 0,
      pending: 0,
      rounds: 0,
      limit: Number.isInteger(limit) && limit > 0 ? limit : null,
      singlePage,
      message: "Automatic download starting…",
      repairMode: Array.isArray(repairTargets) && repairTargets.length > 0,
      repairTargets: Array.isArray(repairTargets) ? repairTargets.map(value => String(value)) : [],
      repairFound: [],
      repairFiles: []
    };
    publishAutoState();
    runAutoDownload();
    return { ok: true, state: autoState };
  }

  async function collect() {
    const platform = platformForPage();
    if (!platform) {
      return { ok: false, error: "Open an Instagram, Facebook, or X page first." };
    }
    const account = getAccount(platform);
    if (platform === "Twitter") {
      return { ok: true, platform, account, ...(await collectX(account)) };
    }
    return { ok: true, platform, account, items: [], ...(await collectPageMedia(platform, account)) };
  }

  ns.scan = {
    get state() {
      return autoState;
    },
    get stopRequested() {
      return autoStopRequested;
    },
    requestStop() {
      autoStopRequested = true;
    },
    limitRemaining,
    publishAutoState,
    startAutoScan,
    collect
  };
})(globalThis.PageMediaSaver);
