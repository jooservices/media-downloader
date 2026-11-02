// Content script entry: answers messages from the popup and background, and tells
// the CLI bridge when a profile or post page is ready.
globalThis.PageMediaSaver ??= {};
(function initContent(ns) {
  if (globalThis.__pageMediaSaverInstalled) {
    return;
  }
  globalThis.__pageMediaSaverInstalled = true;

  const { scan } = ns;
  const { platformForPage, isProfileGrid, isMediaPostPage, getAccount } = ns.page;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "AUTO_STATUS") {
      sendResponse({ ok: true, state: scan.state });
      return false;
    }
    if (message?.type === "AUTO_STOP") {
      scan.requestStop();
      scan.state.message = "Stopping after the current batch…";
      scan.publishAutoState();
      sendResponse({ ok: true, state: scan.state });
      return false;
    }
    if (message?.type === "AUTO_START") {
      // A scan started from the popup follows the limit saved there.
      const { STORAGE_KEY, DEFAULTS, effectiveScanLimit } = PageMediaLib.settings;
      chrome.storage.local
        .get({ [STORAGE_KEY]: DEFAULTS })
        .then(stored => sendResponse(scan.startAutoScan(null, [], effectiveScanLimit(stored[STORAGE_KEY]))))
        .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message?.type === "AUTO_START_CLI") {
      if (!message.job?.jobId || !PageMediaLib.urls.samePage(message.job.url, location.href)) {
        sendResponse({ ok: false, error: "The CLI job does not match this profile page." });
        return false;
      }
      // The CLI decides the limit itself: a number, or null for no limit.
      sendResponse(scan.startAutoScan(message.job.jobId, message.job.repairTargets || [], message.job.limit));
      return false;
    }
    if (message?.type !== "COLLECT_VISIBLE_MEDIA") {
      return false;
    }
    scan
      .collect()
      .then(sendResponse)
      .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  });

  const initialPlatform = platformForPage();
  // A tab the CLI opened carries its job id in the URL fragment. It announces itself even when it
  // is not a profile page (a sign-in wall, a redirect), so the extension can close it.
  const cliJobId = PageMediaLib.urls.cliJobIdFromHash(location.hash);
  if (cliJobId || isProfileGrid(initialPlatform) || isMediaPostPage(initialPlatform)) {
    const announceCliPage = () =>
      chrome.runtime
        .sendMessage({
          type: "CLI_PAGE_READY",
          pageUrl: location.href,
          platform: initialPlatform,
          account: getAccount(initialPlatform),
          cliJobId
        })
        .catch(() => {});
    announceCliPage();
    window.setInterval(() => {
      if (scan.state.running && scan.state.jobId) {
        announceCliPage();
      }
    }, 15000);
  }
})(globalThis.PageMediaSaver);
