// The automatic scan: state, the scroll loop, the file limit, and one pass over the page.
// Loaded as a content script before src/content/index.js; modules share the
// PageMediaSaver namespace and are safe to load twice.
(function initScan(ns) {
  const { pause } = ns.core;
  const { isProfileGrid, isMediaPostPage, getAccount, platformForPage } = ns.page;
  const { addImageSizes } = ns.imageSize;
  const { collectX } = ns.collectors;
  const { collectPageMedia } = ns.videoSources;

  let autoRunning = false;
  let autoStopRequested = false;
  let autoState = { running: false, status: "idle", jobId: null, started: 0, skipped: 0, videoStarted: 0, videoSkipped: 0, failed: 0, pending: 0, rounds: 0, message: "", repairMode: false, repairTargets: [], repairFound: [], repairFiles: [] };


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

  function updateAutoMessage() {
    autoState.message = autoState.repairMode
      ? `Repair download running · ${autoState.repairFound.length}/${autoState.repairTargets.length} source images matched · ${autoState.pending} pending · ${autoState.failed} failed · ${autoState.rounds} passes.`
      : `Automatic download running · ${autoState.started} photos and ${autoState.videoStarted} page-data files started · ${autoState.pending} pending · ${autoState.failed} failed · ${autoState.skipped + autoState.videoSkipped} skipped · ${autoState.rounds} passes. Use Stop automatic download to pause.`;
    publishAutoState();
  }


  // Files this scan may still start when the CLI job set `--limit`; Infinity otherwise.
  function limitRemaining() {
    if (!autoState.limit) return Infinity;
    return Math.max(0, autoState.limit - autoState.started - autoState.videoStarted);
  }

  function limitReached() {
    return limitRemaining() === 0;
  }

  async function finishAtLimit() {
    const finalStatus = await finishDownloads();
    autoState.running = false;
    autoState.pending = finalStatus.pending || 0;
    autoState.failed = finalStatus.failed || 0;
    autoState.status = autoState.pending || autoState.failed ? "incomplete" : "complete";
    autoState.message = `Limit of ${autoState.limit} file(s) reached: ${autoState.started} photo request(s) and ${autoState.videoStarted} page-data file(s) started; ${autoState.pending} pending and ${autoState.failed} failed.`;
    publishAutoState("AUTO_DONE");
  }

  async function downloadVisibleBatch() {
    const result = await collect();
    if (!result?.ok) throw new Error(result?.error || "Could not read this page.");
    if (!["Facebook", "Instagram", "Twitter"].includes(result.platform)) {
      throw new Error("Automatic scrolling supports Instagram/Facebook grids and X profile timelines.");
    }
    if (!result.items.length) return {
      started: 0,
      skipped: 0,
      failed: 0,
      pending: 0,
      errors: [],
      videoStarted: result.videoDownloadsClicked || 0,
      videoSkipped: result.videoDownloadsSkipped || 0
    };
    let items = result.items.slice(0, Math.max(0, limitRemaining() - (result.videoDownloadsClicked || 0)));
    if (!items.length && result.items.length) return {
      started: 0, skipped: 0, failed: 0, pending: 0, errors: [],
      videoStarted: result.videoDownloadsClicked || 0,
      videoSkipped: result.videoDownloadsSkipped || 0
    };
    if (autoState.repairMode) {
      const targetNames = new Set(autoState.repairTargets.map(name => String(name).toLowerCase()));
      const seen = new Set(autoState.repairFound.map(name => String(name).toLowerCase()));
      items = result.items.filter(item => {
        try {
          const basename = decodeURIComponent(new URL(item.url).pathname.split("/").pop() || "").toLowerCase();
          return targetNames.has(basename) && !seen.has(basename);
        } catch { return false; }
      }).map(item => {
        const basename = decodeURIComponent(new URL(item.url).pathname.split("/").pop() || "");
        return {
          ...item,
          key: `repair:${autoState.jobId}:${basename.toLowerCase()}`,
          overwrite: true,
          repairBasename: basename
        };
      });
      if (!items.length) return { started: 0, skipped: 0, failed: 0, pending: 0, errors: [] };
    } else {
      // Repair mode keeps the original file names so the old copies can be matched.
      items = await addImageSizes(items);
    }
    const response = await chrome.runtime.sendMessage({ type: "DOWNLOAD_ITEMS", items });
    if (!response?.ok) throw new Error(response?.error || "The download request failed.");
    if (autoState.repairMode) {
      for (const item of items) {
        const basename = String(item.repairBasename || "").toLowerCase();
        if (basename && !autoState.repairFound.some(name => String(name).toLowerCase() === basename)) {
          autoState.repairFound.push(item.repairBasename);
          autoState.repairFiles.push({ basename: item.repairBasename, filename: item.filename, account: item.account, platform: item.platform });
        }
      }
    }
    return { ...response, videoStarted: result.videoDownloadsClicked || 0, videoSkipped: result.videoDownloadsSkipped || 0 };
  }

  async function finishDownloads() {
    let status = { pending: 0, failed: 0, retryable: 0 };
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
      updateAutoMessage();
      if (autoState.pending > 0) continue;
      if (!status.retryable || retries >= 2) break;

      const retry = await chrome.runtime.sendMessage({
        type: "RETRY_FAILED_DOWNLOADS",
        platform: autoState.platform,
        account: autoState.account
      });
      if (!retry?.ok) break;
      autoState.started += retry.started || 0;
      retries++;
      if (!retry.started) break;
    }
    status = await chrome.runtime.sendMessage({
      type: "DOWNLOAD_STATUS",
      platform: autoState.platform,
      account: autoState.account
    });
    return status || { pending: autoState.pending, failed: autoState.failed };
  }

  async function runAutoDownload() {
    let idleAtEnd = 0;
    let lastHeight = pageHeight();
    let lastTop = pageTop();
    const maxRounds = 10000;

    try {
      if (autoState.singlePage) {
        const videoDeadline = Date.now() + 12000;
        while (Date.now() < videoDeadline) {
          const visibleVideo = globalThis.PageMediaDetection.hasVisibleVideoPost(document);
          if (visibleVideo) break;
          await pause(400);
        }
        const batch = await downloadVisibleBatch();
        autoState.started += batch.started || 0;
        autoState.skipped += batch.skipped || 0;
        autoState.failed += batch.failed || 0;
        autoState.pending = batch.pending || 0;
        autoState.videoStarted += batch.videoStarted || 0;
        autoState.videoSkipped += batch.videoSkipped || 0;
        autoState.rounds++;
        updateAutoMessage();
        const finalStatus = await finishDownloads();
        autoState.running = false;
        autoState.pending = finalStatus.pending || 0;
        autoState.failed = finalStatus.failed || 0;
        autoState.status = autoState.pending || autoState.failed ? "incomplete" : "complete";
        autoState.message = autoState.pending || autoState.failed
          ? `Post scan ended with ${autoState.pending} pending and ${autoState.failed} failed item(s); ${autoState.videoStarted} page-data file download(s) started.`
          : `Post scan complete: ${autoState.started} photo request(s), ${autoState.videoStarted} page-data file download(s) started, and ${autoState.skipped + autoState.videoSkipped} saved or unavailable item(s) skipped.`;
        publishAutoState("AUTO_DONE");
        return;
      }

      while (!autoStopRequested && autoState.rounds < maxRounds) {
        const batch = await downloadVisibleBatch();
        autoState.started += batch.started || 0;
        autoState.skipped += batch.skipped || 0;
        autoState.failed += batch.failed || 0;
        autoState.pending = batch.pending || 0;
        autoState.videoStarted += batch.videoStarted || 0;
        autoState.videoSkipped += batch.videoSkipped || 0;
        autoState.rounds++;
        updateAutoMessage();
        if (limitReached()) {
          await finishAtLimit();
          return;
        }

        const heightBeforeScroll = pageHeight();
        const topBeforeScroll = pageTop();
        const maxTop = Math.max(0, heightBeforeScroll - window.innerHeight);
        const atBottom = topBeforeScroll >= maxTop - 60;

        if (atBottom) {
          // Wait for the site to append lazy-loaded rows at the end of the grid.
          await pause(1800);
          window.scrollBy({ top: Math.max(250, Math.floor(window.innerHeight * 0.55)), left: 0, behavior: "instant" });
          await pause(1800);
          const endBatch = await downloadVisibleBatch();
          autoState.started += endBatch.started || 0;
          autoState.skipped += endBatch.skipped || 0;
          autoState.failed += endBatch.failed || 0;
          autoState.pending = endBatch.pending || 0;
          autoState.videoStarted += endBatch.videoStarted || 0;
          autoState.videoSkipped += endBatch.videoSkipped || 0;
          autoState.rounds++;
          if (limitReached()) {
            await finishAtLimit();
            return;
          }

          const heightAfter = pageHeight();
          if ((endBatch.started || 0) > 0 || (endBatch.videoStarted || 0) > 0 || heightAfter > heightBeforeScroll + 40) {
            idleAtEnd = 0;
          } else {
            idleAtEnd++;
          }
          updateAutoMessage();
          if (idleAtEnd >= 4) {
            const finalStatus = await finishDownloads();
            autoState.running = false;
            autoState.status = (finalStatus.pending || finalStatus.failed) ? "incomplete" : "complete";
            autoState.pending = finalStatus.pending || 0;
            autoState.failed = finalStatus.failed || 0;
            if (autoState.repairMode && autoState.repairFound.length !== autoState.repairTargets.length) {
              autoState.status = "incomplete";
            }
            autoState.message = autoState.repairMode && autoState.repairFound.length !== autoState.repairTargets.length
              ? `Repair incomplete: matched ${autoState.repairFound.length} of ${autoState.repairTargets.length} source images. Original files were left in Downloads.`
              : autoState.pending || autoState.failed
              ? `Grid scan ended after four checks found no older rows. ${autoState.started} download request(s) started; ${autoState.pending} remain pending and ${autoState.failed} failed after retries.`
              : `Download finished: ${autoState.started} photo request(s) and ${autoState.videoStarted} page-data file(s) completed with no pending or failed files; ${autoState.skipped + autoState.videoSkipped} saved or unavailable items skipped. Four end checks found no older rows.`;
            publishAutoState("AUTO_DONE");
            autoRunning = false;
            return;
          }
          lastHeight = heightAfter;
          lastTop = pageTop();
        } else {
          window.scrollBy({ top: Math.max(600, Math.floor(window.innerHeight * 0.78)), left: 0, behavior: "instant" });
          await pause(1600);
          const heightAfter = pageHeight();
          const topAfter = pageTop();
          if ((batch.started || 0) > 0 || (batch.videoStarted || 0) > 0 || heightAfter > lastHeight + 40 || topAfter > lastTop + 20) {
            idleAtEnd = 0;
          } else {
            idleAtEnd++;
          }
          lastHeight = heightAfter;
          lastTop = topAfter;
          if (idleAtEnd >= 8) {
            throw new Error("The page stopped scrolling or loading photos. Automatic mode paused so it does not loop forever.");
          }
        }
      }

      if (autoStopRequested) {
        autoState.running = false;
        autoState.status = "paused";
        autoState.message = `Automatic download paused: ${autoState.started} photo request(s) and ${autoState.videoStarted} page-data file(s) started; ${autoState.skipped + autoState.videoSkipped} saved or unavailable items skipped. You can resume it later.`;
        publishAutoState("AUTO_DONE");
      } else {
        autoState.running = false;
        autoState.status = "paused";
        autoState.message = "Automatic download stopped at its safety limit of 10,000 scroll passes.";
        publishAutoState("AUTO_DONE");
      }
    } catch (error) {
      autoState.running = false;
      autoState.status = "paused";
      autoState.message = `Automatic download paused: ${error?.message || String(error)}`;
      publishAutoState("AUTO_DONE");
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
    if (!["Facebook", "Instagram", "Twitter"].includes(platform)) {
      return { ok: false, error: "Automatic mode supports Instagram/Facebook grids and X profile timelines." };
    }
    const singlePage = !isProfileGrid(platform) && isMediaPostPage(platform);
    if (!isProfileGrid(platform) && !singlePage) {
      return { ok: false, error: "Open a supported Instagram/Facebook profile grid, X timeline, or direct media post URL." };
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
    if (!platform) return { ok: false, error: "Open an Instagram, Facebook, or X page first." };
    const account = getAccount(platform);
    if (platform === "Instagram") {
      const videos = await collectPageMedia(platform, account);
      return { ok: true, platform, account, items: [], ...videos };
    }
    if (platform === "Facebook") {
      const videos = await collectPageMedia(platform, account);
      return { ok: true, platform, account, items: [], ...videos };
    }
    const result = await collectX(account);
    return { ok: true, platform, account, ...result };
  }

  ns.scan = {
    get state() { return autoState; },
    get stopRequested() { return autoStopRequested; },
    requestStop() { autoStopRequested = true; },
    limitRemaining,
    publishAutoState,
    startAutoScan,
    collect
  };
})(globalThis.PageMediaSaver ||= {});
