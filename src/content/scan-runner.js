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

  const supported = () => PageMediaLib.sites.names();
  const MAX_ROUNDS = 10000;
  const VIDEO_WAIT_MS = 12000;
  const END_CHECKS = 4;
  const LAZY_LOAD_POLL_MS = 500;
  const LAZY_LOAD_POLLS = 12;
  const STALL_CHECKS = 8;
  const HEARTBEAT_MS = 30_000;
  let pendingMessages = 0;

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
    gridSaved: 0,
    postOpened: 0,
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

  // This timer reports liveness independently of scrolling, downloads, or scan progress.
  window.setInterval(() => {
    if (autoState.running && autoState.jobId && pendingMessages === 0) {
      chrome.runtime.sendMessage({ type: "AUTO_HEARTBEAT", jobId: autoState.jobId }).catch(() => {});
    }
  }, HEARTBEAT_MS);

  async function sendScanMessage(message) {
    pendingMessages++;
    try {
      return await chrome.runtime.sendMessage(message);
    } finally {
      pendingMessages--;
    }
  }

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

  /** Builds the progress text, including counts for grid files and opened posts. */
  function updateAutoMessage() {
    const { repairFound, repairTargets, repairExpectedCount, pending, failed, rounds, started, videoStarted } =
      autoState;
    const repairTargetCount = repairExpectedCount || repairTargets.length;
    autoState.message = autoState.repairMode
      ? `Repair download running · ${repairFound.length}/${repairTargetCount} source images matched · ${pending} pending · ${failed} failed · ${rounds} passes.`
      : `Automatic download running · ${started} photos and ${videoStarted} page-data files started · ${autoState.gridSaved} from the grid, ${autoState.postOpened} opened · ${pending} pending · ${failed} failed · ${skippedCount()} skipped · ${rounds} passes. Use Stop automatic download to pause.`;
    // Nothing seen after a few passes: say what the page looks like, so the cause can be read from the job.
    const seen = started + videoStarted + skippedCount() + pending + failed;
    if (!autoState.repairMode && rounds >= 3 && seen === 0) {
      const signIn = document.querySelector('input[type="password"]') ? " A password box is on the page." : "";
      autoState.message += ` Nothing found yet. Page: ${location.href}.${signIn} ${hookDiagnostics()} Cache: ${JSON.stringify(ns.videoSources.cacheDiagnostics?.() ?? null)}`;
    }
    publishAutoState();
  }

  /** Adds one pass's file, grid, opened-post and outcome counters to the scan totals. */
  function accumulate(batch) {
    autoState.started += batch.started || 0;
    autoState.skipped += batch.skipped || 0;
    autoState.failed += batch.failed || 0;
    autoState.pending = batch.pending || 0;
    autoState.videoStarted += batch.videoStarted || 0;
    autoState.videoSkipped += batch.videoSkipped || 0;
    autoState.gridSaved += batch.gridSaved || 0;
    autoState.postOpened += batch.postOpened || 0;
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
      status = await sendScanMessage({
        type: "DRAIN_DOWNLOADS",
        platform: autoState.platform,
        account: autoState.account,
        timeoutMs: 60000
      });
      drains++;
      autoState.pending = status.pending || 0;
      autoState.failed = status.failed || 0;
      autoState.unavailable = status.unavailable || 0;
      autoState.rejectedFiles = status.rejectedFiles || [];
      updateAutoMessage();
      if (autoState.pending > 0) {
        continue;
      }
      if (!status.retryable || retries >= 2) {
        break;
      }

      const retry = await sendScanMessage({
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
    status = await sendScanMessage({
      type: "DOWNLOAD_STATUS",
      platform: autoState.platform,
      account: autoState.account
    });
    autoState.rejectedFiles = status?.rejectedFiles || [];
    updateAutoMessage();
    return status || { pending: autoState.pending, failed: autoState.failed };
  }

  // Waits for the downloads to end, then records what is still pending or failed.
  async function settleDownloads() {
    const finalStatus = await finishDownloads();
    autoState.pending = finalStatus.pending || 0;
    autoState.failed = finalStatus.failed || 0;
    autoState.unavailable = finalStatus.unavailable || 0;
    autoState.rejectedFiles = finalStatus.rejectedFiles || [];
    const outputs = await sendScanMessage({
      type: "GET_VERIFIED_OUTPUTS",
      platform: autoState.platform,
      account: autoState.account,
      jobId: autoState.jobId
    }).catch(() => []);
    if (Array.isArray(outputs) && outputs.length) {
      autoState.outputFiles = outputs.map(({ filename, size }) => ({ filename, size }));
    }
  }

  function endScan(status, message) {
    autoState.running = false;
    autoState.status = status;
    autoState.message = autoState.repairMode
      ? message
      : `${message} ${autoState.gridSaved} from the grid, ${autoState.postOpened} opened.`;
    publishAutoState("AUTO_DONE");
  }

  function emptyPageReason() {
    const url = String(location.href || "");
    const pathname = (() => {
      try {
        return new URL(url).pathname;
      } catch {
        return "";
      }
    })();
    const bodyText = String(document.body?.innerText || document.body?.textContent || "").toLowerCase();
    const loginText = /\b(sign in|log in|login|enter your password)\b/.test(bodyText);
    const loginUrl = /\/(?:login|log-in|signin|sign-in|checkpoint|challenge)(?:\/|$)/i.test(pathname);
    if (
      loginUrl ||
      document.querySelector('input[type="password"]') ||
      (loginText && /password|email|phone|username/.test(bodyText))
    ) {
      return "login_required";
    }
    if (!document.body || !url) {
      return "unknown";
    }
    const privateNotice =
      /\b(private account|this account is private|account is private|content isn't available|content is unavailable|page isn't available|page is unavailable|user not found)\b/i.test(
        bodyText
      );
    const pageEvidence = /\b(profile|posts|photos|videos|followers|following|reels|timeline)\b/i.test(bodyText);
    return privateNotice || (pageEvidence && (isProfileGrid() || isMediaPostPage())) ? "empty_or_private" : "unknown";
  }

  function emptyScanOutcome() {
    const seen =
      autoState.started +
      autoState.videoStarted +
      skippedCount() +
      autoState.pending +
      autoState.failed +
      autoState.unavailable;
    if (seen || (hookStats()?.found ?? 0) > 0) {
      return null;
    }
    autoState.reason = emptyPageReason();
    if (autoState.reason === "login_required") {
      autoState.noRetry = true;
      return "No photos or videos were found because the site is asking for a sign-in. Sign in to the site in this browser, then retry this job.";
    }
    if (autoState.reason === "empty_or_private") {
      return `No photos or videos were found on this page. It loaded without accessible media; it may be empty, private, or unavailable. ${hookDiagnostics()}`;
    }
    return `No photos or videos were found, and the page state could not be classified. ${hookDiagnostics()}`;
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
    const repairAll = targetNames.has("*");
    const seen = new Set(autoState.repairFound.map(lowerName));
    const seenItems = new Set(autoState.repairSeenItems || []);
    const matched = [];
    for (const item of allItems) {
      const identity = String(item.key || item.url || "");
      if (identity && seenItems.has(identity)) {
        continue;
      }
      const basename = repairBasename(item.url);
      const filename = String(item.filename || "")
        .split(/[\\/]/)
        .pop();
      const resolved = PageMediaLib.paths.cleanPart(
        PageMediaLib.paths.withResolution(filename, item.width, item.height),
        `photo.${PageMediaLib.paths.imageExtension(item.url)}`
      );
      const candidates = [resolved, filename, basename].filter(Boolean);
      const alreadyMatched = candidates.some(name => seen.has(lowerName(name)));
      const target = alreadyMatched ? null : candidates.find(name => repairAll || targetNames.has(lowerName(name)));
      if (target) {
        if (identity) {
          seenItems.add(identity);
        }
        matched.push({
          ...item,
          key: `repair:${autoState.jobId}:${lowerName(target)}`,
          filename: target,
          width: undefined,
          height: undefined,
          overwrite: true,
          repairBasename: target
        });
      }
    }
    autoState.repairSeenItems = [...seenItems];
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

  async function prepareDownloadItems(items) {
    const sized = await addImageSizes(items);
    return autoState.repairMode ? repairItemsFrom(sized) : sized;
  }

  function recordOutputFiles(items) {
    autoState.outputFiles ??= [];
    for (const item of items) {
      const inputName = String(item.filename || "")
        .split(/[\\/]/)
        .pop();
      const filename = autoState.repairMode
        ? inputName
        : PageMediaLib.paths.cleanPart(
            PageMediaLib.paths.withResolution(inputName, item.width, item.height),
            `photo.${PageMediaLib.paths.imageExtension(item.url)}`
          );
      if (filename && !autoState.outputFiles.some(output => output.filename.toLowerCase() === filename.toLowerCase())) {
        autoState.outputFiles.push({ filename });
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
    videoSkipped: result.videoDownloadsSkipped || 0,
    gridSaved: result.gridSaved || 0,
    postOpened: result.postOpened || 0
  });

  const itemsFromResult = result => (Array.isArray(result?.items) ? result.items : []);

  async function downloadVisibleBatch() {
    const result = await collect();
    if (!result?.ok) {
      throw new Error(result?.error || "Could not read this page.");
    }
    if (!supported().includes(result.platform)) {
      throw new Error("Automatic scrolling supports Instagram, Facebook, X, and TikTok profiles.");
    }
    const items = itemsFromResult(result);
    if (!items.length) {
      return emptyBatch(result);
    }
    const clicked = result.videoDownloadsClicked || 0;
    const allowed = items.slice(0, Math.max(0, limitRemaining() - clicked));
    if (!allowed.length) {
      return emptyBatch(result);
    }
    // Repair mode keeps the original file names so the old copies can be matched.
    const preparedItems = await prepareDownloadItems(autoState.repairMode ? items : allowed);
    if (!preparedItems.length) {
      return { started: 0, skipped: 0, failed: 0, pending: 0, errors: [] };
    }
    for (const item of preparedItems) {
      item.jobId = autoState.jobId;
    }
    recordOutputFiles(preparedItems);
    const response = await sendScanMessage({ type: "DOWNLOAD_ITEMS", items: preparedItems });
    if (!response?.ok) {
      throw new Error(response?.error || "The download request failed.");
    }
    if (autoState.repairMode) {
      noteRepairMatches(preparedItems);
    }
    return {
      ...response,
      videoStarted: clicked,
      videoSkipped: result.videoDownloadsSkipped || 0,
      gridSaved: result.gridSaved || 0,
      postOpened: result.postOpened || 0
    };
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
    const emptyOutcome = emptyScanOutcome();
    endScan(
      hasOutstanding() || emptyOutcome ? "incomplete" : "complete",
      emptyOutcome ||
        (hasOutstanding()
          ? `Post scan ended with ${pending} pending and ${failed} failed item(s); ${videoStarted} page-data file download(s) started.`
          : `Post scan complete: ${started} photo request(s), ${videoStarted} page-data file download(s) started, and ${skippedCount()} saved or unavailable item(s) skipped.`)
    );
  }

  // Files the site no longer serves (taken down, blocked) are skipped for good, not counted as failures.
  const unavailableNote = () =>
    autoState.unavailable ? ` (${autoState.unavailable} of them the site no longer serves)` : "";

  // What the page-world hook reports about the data it could read, or null when it never reported in.
  function hookStats() {
    try {
      return JSON.parse(document.documentElement.getAttribute("data-pms-hook"));
    } catch {
      return null;
    }
  }

  function hookDiagnostics() {
    const stats = hookStats();
    return stats
      ? `The page's data hook read ${stats.documents} response(s) and found ${stats.found} photo(s) or video(s) in them.`
      : "The page's data hook did not report in, so the page's data could not be read.";
  }

  // The scroll loop ended because four checks found no older rows.
  async function finishGrid() {
    await settleDownloads();
    const { repairFound, repairTargets, repairExpectedCount, started, videoStarted, pending, failed } = autoState;
    const repairShort = autoState.repairMode && repairFound.length < (repairExpectedCount || repairTargets.length);
    // A page with nothing on it is not a success: the user may be signed out, or the site changed its data.
    const nothingFound =
      !autoState.repairMode &&
      started + videoStarted + skippedCount() + pending + failed + autoState.unavailable === 0 &&
      (hookStats()?.found ?? 0) === 0;
    let message;
    if (nothingFound) {
      message = emptyScanOutcome();
    } else if (repairShort) {
      message = `Repair incomplete: matched ${repairFound.length} of ${repairExpectedCount || repairTargets.length} source images. Original files were left in Downloads.`;
    } else if (hasOutstanding()) {
      message = `Grid scan ended after four checks found no older rows. ${started} download request(s) started; ${pending} remain pending and ${failed} failed after retries.`;
    } else {
      message = `Download finished: ${started} photo request(s) and ${videoStarted} page-data file(s) completed with no pending or failed files; ${skippedCount()} saved or unavailable items skipped${unavailableNote()}. Four end checks found no older rows.`;
    }
    endScan(hasOutstanding() || repairShort || nothingFound ? "incomplete" : "complete", message);
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
      // A page that already gave up its files and now neither moves nor grows has reached its end (a reels or
      // photos tab whose scroller is not the window looks exactly like this); only an empty one is a stuck page.
      if (autoState.started + autoState.videoStarted + skippedCount() + autoState.unavailable > 0) {
        await finishGrid();
        return true;
      }
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
      // A profile link means the whole account: posts, reels, and the current stories.
      if (PageMediaLib.sites.get(autoState.platform)?.opensStories && !autoState.repairMode) {
        autoState.videoStarted += await ns.videoSources.saveAccountStories(autoState.account);
        updateAutoMessage();
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

  function startAutoScan(jobId = null, repairTargets = [], limit = null, repairExpectedCount = null) {
    if (autoRunning) {
      if (jobId && autoState.jobId !== jobId) {
        return { ok: false, error: "Another automatic download is already running in this tab." };
      }
      return { ok: true, state: autoState };
    }
    const platform = platformForPage();
    if (!supported().includes(platform)) {
      return { ok: false, error: "Automatic mode supports Instagram, Facebook, X, and TikTok profiles." };
    }
    const singlePage = !isProfileGrid(platform) && isMediaPostPage(platform);
    if (!isProfileGrid(platform) && !singlePage) {
      return {
        ok: false,
        error: "Open a supported Instagram, Facebook, X, or TikTok profile, or a direct media post URL."
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
      gridSaved: 0,
      postOpened: 0,
      failed: 0,
      unavailable: 0,
      pending: 0,
      rounds: 0,
      limit: Number.isInteger(limit) && limit > 0 ? limit : null,
      singlePage,
      message: "Automatic download starting…",
      repairMode: Array.isArray(repairTargets) && repairTargets.length > 0,
      repairTargets: Array.isArray(repairTargets) ? repairTargets.map(value => String(value)) : [],
      repairExpectedCount:
        Number.isInteger(repairExpectedCount) && repairExpectedCount > 0 ? repairExpectedCount : null,
      repairFound: [],
      repairSeenItems: [],
      repairFiles: [],
      reason: null,
      noRetry: false,
      rejectedFiles: [],
      outputFiles: []
    };
    publishAutoState();
    runAutoDownload();
    return { ok: true, state: autoState };
  }

  async function collect() {
    const platform = platformForPage();
    if (!platform) {
      return { ok: false, error: "Open an Instagram, Facebook, X, or TikTok page first." };
    }
    const account = getAccount(platform);
    if (PageMediaLib.sites.get(platform)?.photos) {
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
