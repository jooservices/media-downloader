// Videos: saves what the page already received, opens grid reels, and falls back to the platform's own menu.
// Loaded as a content script before src/content/index.js; modules share the
// PageMediaSaver namespace and are safe to load twice.
globalThis.PageMediaSaver ??= {};
(function initVideo(ns) {
  const { pause } = ns.core;
  const { clean, getAccount } = ns.page;
  // The scan state lives in scan-runner.js, which loads after this file.
  const limitRemaining = () => ns.scan.limitRemaining();
  const scanState = () => ns.scan.state;

  const MAX_NATIVE_VIDEOS_PER_SCAN = 12;
  const MAX_HIGHLIGHTS = 40;
  const MENU_BUTTONS_TRIED = 2;
  const MAX_POSTS_OPENED_PER_PASS = 3;
  const startedCount = value => (Number.isSafeInteger(value) && value > 0 ? value : 0);
  const POST_DATA_ATTEMPTS = 5;
  const MAX_PAGE_DATA_FILES_PER_PASS = 8;
  const CACHE_MESSAGE_TIMEOUT_MS = 1000;

  // A whole number in [0, max) from the platform's random source.
  function randomBelow(max) {
    const buffer = new Uint32Array(1);
    crypto.getRandomValues(buffer);
    return buffer[0] % max;
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  // The post id a link inside a video post points at, if it points at one.
  const siteOf = platform => PageMediaLib.sites.get(platform);

  function tokenFromUrl(platform, url) {
    return siteOf(platform)?.idFromUrl(url) ?? null;
  }

  // With no link to read an id from, the video's own address stands in for it.
  function mediaFallbackToken(video, index) {
    const media = video?.poster || video?.currentSrc || video?.src || `${location.pathname}:${index}`;
    try {
      const url = new URL(media, location.href);
      return `media-${hashString(url.origin + url.pathname)}`;
    } catch {
      return `media-${hashString(media)}`;
    }
  }

  function videoPostToken(platform, container, video, index) {
    for (const link of container.querySelectorAll("a[href]")) {
      let token = null;
      try {
        token = tokenFromUrl(platform, new URL(link.href, location.href));
      } catch {
        /* ignore unrelated links */
      }
      if (token) {
        return clean(token, `video-${index}`);
      }
    }
    return mediaFallbackToken(video, index);
  }

  function actionButtons(container, platform) {
    const candidates = [
      ...container.querySelectorAll('button[aria-label], [role="button"][aria-label], button[data-testid="caret"]')
    ];
    return candidates.filter(button => {
      const label =
        `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.getAttribute("data-testid") || ""}`.toLowerCase();
      const site = siteOf(platform);
      if (site?.caretMenu && button.getAttribute("data-testid") === "caret") {
        return true;
      }
      if (/more|options|actions|tùy chọn|thêm|opciones|altre opzioni|plus d’options/i.test(label)) {
        return true;
      }
      return Boolean(site?.shareMenu) && /(?:^|\s)(?:share|share post|share reel)(?:\s|$)/i.test(label);
    });
  }

  const MENU_ENTRIES = '[role="menuitem"], button, [role="button"]';

  const isVisible = node => node.getClientRects().length > 0;

  // The entries of whichever menu, or else dialog, is open.
  function openMenuEntries() {
    const menus = [...document.querySelectorAll('[role="menu"]')].filter(isVisible);
    if (menus.length) {
      return menus.flatMap(menu => [...menu.querySelectorAll(MENU_ENTRIES)]);
    }
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(isVisible);
    if (dialogs.length) {
      return dialogs.flatMap(dialog => [...dialog.querySelectorAll(MENU_ENTRIES)]);
    }
    return [...document.querySelectorAll('[role="menuitem"]')].filter(isVisible);
  }

  const entryLabel = node =>
    (node.innerText || node.textContent || node.getAttribute("aria-label") || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  function nativeDownloadMenuItem(platform) {
    const allowed = new Set(siteOf(platform)?.downloadLabels || []);
    const entry = openMenuEntries()
      .filter(node => isVisible(node) && node.getAttribute("aria-disabled") !== "true")
      .find(node => allowed.has(entryLabel(node)));
    return entry ?? null;
  }

  function closeOpenMenu() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  // Opens the post's menu through its first buttons until a download entry shows up.
  async function findDownloadMenuItem(buttons, platform) {
    for (const button of buttons.slice(0, MENU_BUTTONS_TRIED)) {
      button.click();
      await pause(300);
      const menuItem = nativeDownloadMenuItem(platform);
      if (menuItem) {
        return menuItem;
      }
      closeOpenMenu();
      await pause(100);
    }
    closeOpenMenu();
    return null;
  }

  // Tells the background which video the next browser download belongs to.
  async function armNativeVideo({ platform, owner, key, token, video }) {
    const target = await chrome.runtime.sendMessage({
      type: "SET_NATIVE_VIDEO_TARGET",
      target: {
        platform,
        account: owner,
        key,
        filename: `video_${token}.mp4`,
        width: video?.videoWidth || 0,
        height: video?.videoHeight || 0,
        sourceUrl: location.href
      }
    });
    return Boolean(target?.ok) && !target.skip;
  }

  // Promoted, suggested and reposted X posts on a profile belong to someone else.
  function isForeignXPost(platform, owner, account) {
    return (
      Boolean(siteOf(platform)?.skipForeignPosts) &&
      !scanState().singlePage &&
      owner.toLowerCase() !== String(account).toLowerCase()
    );
  }

  async function collectNativeVideoDownloads(platform, account, budget = limitRemaining(), coveredIds = []) {
    const allContainers = globalThis.PageMediaDetection.collectVideoContainers(document, platform);
    const cacheCoverage = new Set(coveredIds.map(String));
    const containers = allContainers
      .map(({ container, video }, index) => ({ container, video, index }))
      .filter(
        ({ container, video, index }) =>
          !cacheCoverage.has(String(videoPostToken(platform, container, video, index + 1)))
      );
    const maxPerScan = Math.min(MAX_NATIVE_VIDEOS_PER_SCAN, budget);
    let videoDownloadsClicked = 0;
    let videoDownloadsSkipped = 0;
    for (const { container, video, index } of containers) {
      if (videoDownloadsClicked >= maxPerScan) {
        break;
      }
      const owner = getAccount(platform, container) || account;
      if (scanState().singlePage && owner) {
        scanState().account = owner;
      }
      if (isForeignXPost(platform, owner, account)) {
        videoDownloadsSkipped++;
        continue;
      }
      const token = videoPostToken(platform, container, video, index + 1);
      const key = PageMediaLib.keys.videoKey(platform, token, 1);
      const buttons = actionButtons(container, platform);
      const menuItem = buttons.length ? await findDownloadMenuItem(buttons, platform) : null;
      if (!menuItem || !(await armNativeVideo({ platform, owner, key, token, video }))) {
        if (menuItem) {
          closeOpenMenu();
        }
        videoDownloadsSkipped++;
        continue;
      }
      menuItem.click();
      videoDownloadsClicked++;
      await pause(500);
    }
    return { videoArticlesSeen: allContainers.length, videoDownloadsClicked, videoDownloadsSkipped };
  }

  function collectNativeVideosUnlessDeferred(platform, account, budget, cached) {
    return collectNativeVideoDownloads(platform, account, budget, cached?.coveredIds);
  }

  // The post, photo or video ids a link points at (none for links to anything else).
  // Instagram and Facebook responses do not reliably name the account, so the ids in
  // this page's own links pick which cached media belongs to what is being scanned.
  function idsInHref(platform, href) {
    let url;
    try {
      url = new URL(href, location.href);
    } catch {
      return [];
    }
    return siteOf(platform)?.idsFromUrl(url) || [];
  }

  function domVideoIds(platform) {
    const ids = new Set(idsInHref(platform, location.href));
    for (const link of document.querySelectorAll("a[href]")) {
      for (const id of idsInHref(platform, link.href)) {
        if (ids.size < 1000) {
          ids.add(id);
        }
      }
    }
    return [...ids];
  }

  // A single post or reel page also links to related posts; only the page's own
  // id counts there. On a profile, every post linked from the grid counts, and X
  // is matched by account (no ids).
  function pageVideoIds(platform) {
    if (scanState().singlePage) {
      const ids = idsInHref(platform, location.href);
      // A stories tray has no single frame id in the URL. The cache is filtered by the account instead.
      const tray = siteOf(platform)?.storyTray?.(location.pathname);
      return tray && !ids.length ? undefined : ids;
    }
    return siteOf(platform)?.matchByAccount ? undefined : domVideoIds(platform);
  }

  const openedGridPosts = new Set();

  function closePostOverlay() {
    const close = document.querySelector('[role="dialog"] svg[aria-label="Close"]')?.closest('button, [role="button"]');
    if (close) {
      close.click();
    } else {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    }
  }

  const pageSite = () => PageMediaLib.sites.forHost(location.hostname);

  function shouldOpenGridPosts(platform) {
    if (!siteOf(platform)?.opensGridPosts) {
      return false;
    }
    return platform !== "Facebook" || /\/(?:photos|reels|videos)\/?$/i.test(location.pathname);
  }

  const gridLinks = () => {
    const selector = pageSite()?.gridLinks;
    if (!selector) {
      return [];
    }
    return [...document.querySelectorAll(selector)].filter(
      link => link.getClientRects().length && !link.closest('[role="dialog"]')
    );
  };

  const postIdOf = link => idsInHref(pageSite()?.name, link.href || link.getAttribute("href"))[0] || null;

  // The opened post makes the page request its data; give the hook a few seconds to cache it, then save it.
  async function saveOpenedPost(platform, account, id, remaining) {
    for (let attempt = 0; attempt < POST_DATA_ATTEMPTS; attempt++) {
      await pause(900);
      const response = await chrome.runtime
        .sendMessage({
          type: "DOWNLOAD_CACHED_MEDIA",
          platform,
          account,
          ids: [id],
          limit: Number.isFinite(remaining) ? remaining : null
        })
        .catch(() => null);
      if (response?.cached) {
        return (response.started || 0) + (response.queued || 0);
      }
    }
    return 0;
  }

  // Back to the grid, then a human-like pause before the next post.
  async function leavePost(gridUrl) {
    closePostOverlay();
    await pause(700);
    if (location.href !== gridUrl) {
      history.back();
      await pause(900);
    }
    await pause(800 + randomBelow(700));
  }

  /** Opens uncovered posts, keeping file starts separate from the number of posts opened. */
  async function openGridPosts(account, budget, alreadyCovered = []) {
    if (scanState().singlePage || budget <= 0) {
      return { started: 0, opened: 0 };
    }
    for (const id of Array.isArray(alreadyCovered) ? alreadyCovered.slice(0, 4000) : []) {
      openedGridPosts.add(id);
    }
    let started = 0;
    let opened = 0;
    for (const link of gridLinks()) {
      if (opened >= MAX_POSTS_OPENED_PER_PASS || started >= budget || ns.scan.stopRequested || !link.isConnected) {
        break;
      }
      const id = postIdOf(link);
      if (!id || openedGridPosts.has(id)) {
        continue;
      }
      openedGridPosts.add(id);
      opened++;
      const gridUrl = location.href;
      link.click();
      started += await saveOpenedPost(pageSite()?.name, account, id, budget - started);
      await leavePost(gridUrl);
    }
    return { started, opened };
  }

  let lastCacheDiag = null;

  async function requestCachedMedia(message) {
    if (["Facebook", "TikTok"].includes(message.platform)) {
      let timeoutId;
      let response = await Promise.race([
        chrome.runtime.sendMessage(message).catch(error => ({ error: String(error?.message || error).slice(0, 120) })),
        new Promise(resolve => {
          timeoutId = setTimeout(
            () => resolve({ error: "Cached media request timed out; the profile scan will continue." }),
            CACHE_MESSAGE_TIMEOUT_MS
          );
        })
      ]);
      clearTimeout(timeoutId);
      if (response?.requestId) {
        response = await Promise.race([
          chrome.runtime.sendMessage({ type: "CACHED_MEDIA_RESULT", requestId: response.requestId }).catch(error => ({
            error: String(error?.message || error).slice(0, 120)
          })),
          new Promise(resolve => {
            timeoutId = setTimeout(
              () => resolve({ error: "Cached media did not start in time; the profile scan will continue." }),
              CACHE_MESSAGE_TIMEOUT_MS
            );
          })
        ]);
        clearTimeout(timeoutId);
      }
      return response;
    }
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      return { error: String(error?.message || error).slice(0, 120) };
    }
  }

  function cacheDiagnostic(platform, cached, asked, ids) {
    if (cached?.error) {
      return { asked, ids: ids ? ids.length : null, error: cached.error };
    }
    if (!cached && asked && ["Facebook", "TikTok"].includes(platform)) {
      return {
        asked,
        ids: ids ? ids.length : null,
        error: "The cache handler returned no response; the profile scan will continue."
      };
    }
    return cached?.diag || { asked, ids: ids ? ids.length : null, noReply: true };
  }

  /** Saves full-size cached media first, then falls back to opening uncovered grid posts. */
  async function collectPageMedia(platform, account) {
    const budget = limitRemaining();
    const ids = pageVideoIds(platform);
    const asked = budget > 0 && !(ids && !ids.length);
    const cacheBudget = ["Facebook", "TikTok"].includes(platform)
      ? Math.min(budget, MAX_PAGE_DATA_FILES_PER_PASS)
      : budget;
    const cached = asked
      ? await requestCachedMedia({
          type: "DOWNLOAD_CACHED_MEDIA",
          platform,
          account,
          ids,
          limit: Number.isFinite(cacheBudget) ? cacheBudget : null
        })
      : null;
    lastCacheDiag = cacheDiagnostic(platform, cached, asked, ids);
    const pageDataStarted = startedCount(cached?.started);
    const pageDataQueued = startedCount(cached?.queued);
    let cachedStarted = pageDataStarted;
    const cachedQueued = pageDataQueued;
    let openedResult = { started: 0, opened: 0 };
    if (shouldOpenGridPosts(platform)) {
      openedResult = await openGridPosts(
        account,
        Math.max(0, budget - cachedStarted - cachedQueued),
        cached?.coveredIds
      );
      cachedStarted += startedCount(openedResult.started);
    }
    const videos = await collectNativeVideosUnlessDeferred(
      platform,
      account,
      Math.max(0, budget - cachedStarted - cachedQueued),
      cached
    );
    return {
      ...videos,
      videoDownloadsClicked: videos.videoDownloadsClicked + cachedStarted + cachedQueued,
      ...(!scanState().singlePage && pageDataStarted > 0 ? { gridSaved: pageDataStarted } : {}),
      ...(openedResult.opened ? { postOpened: openedResult.opened } : {}),
      // Files the page delivered that were saved earlier count as seen, so a rescan with nothing new is not "empty".
      videoDownloadsSkipped: (videos.videoDownloadsSkipped || 0) + (cached?.skipped || 0)
    };
  }

  // The profile header links to the current story tray. Opening it makes Instagram
  // deliver the story files; the scan then returns to the grid.
  function storyLink(account) {
    const needle = `/stories/${String(account || "").toLowerCase()}`;
    for (const link of document.querySelectorAll('a[href*="/stories/"]')) {
      try {
        if (new URL(link.href, location.href).pathname.toLowerCase().startsWith(needle)) {
          return link;
        }
      } catch {
        /* a broken href is not the tray */
      }
    }
    return null;
  }

  const openedHighlights = new Set();

  function highlightLinks() {
    return [...document.querySelectorAll('a[href*="/stories/highlights/"]')].filter(
      link => link.getClientRects?.().length && !openedHighlights.has(link.href)
    );
  }

  // Opens one story or highlight link, saves the account's cached files, then returns to the profile.
  async function saveOpenedTray(link, account) {
    const home = location.href;
    link.click();
    let started = 0;
    // The tray's own files arrive a moment after the page's earlier ones, so stop only after two looks in a row
    // find nothing new to save.
    let quiet = 0;
    for (let attempt = 0; attempt < 6 && limitRemaining() > 0 && quiet < 2; attempt++) {
      await pause(700);
      const remaining = limitRemaining();
      const response = await chrome.runtime
        .sendMessage({
          type: "DOWNLOAD_CACHED_MEDIA",
          platform: pageSite()?.name,
          account,
          limit: Number.isFinite(remaining) ? remaining : null
        })
        .catch(() => null);
      const accepted = (response?.started || 0) + (response?.queued || 0);
      started += accepted;
      quiet = accepted ? 0 : quiet + 1;
    }
    if (location.href !== home) {
      history.back();
      await pause(900);
    }
    return started;
  }

  async function saveAccountStories(account) {
    if (limitRemaining() <= 0) {
      return 0;
    }
    let started = 0;
    // Stories can take minutes on an account with many highlights; say where the scan is so the job does not look stuck.
    const report = text => {
      scanState().message = text;
      ns.scan.publishAutoState();
    };
    const tray = storyLink(account);
    if (tray) {
      report("Saving the current stories…");
      started += await saveOpenedTray(tray, account);
    }
    let opened = 0;
    const highlights = highlightLinks();
    for (const link of highlights) {
      if (opened >= MAX_HIGHLIGHTS || limitRemaining() <= 0 || ns.scan.stopRequested) {
        break;
      }
      openedHighlights.add(link.href);
      opened++;
      report(`Saving highlights (${opened} of ${Math.min(highlights.length, MAX_HIGHLIGHTS)})…`);
      started += await saveOpenedTray(link, account);
    }
    return started;
  }

  ns.videoSources = {
    collectPageMedia,
    cacheDiagnostics: () => lastCacheDiag,
    collectNativeVideoDownloads,
    domVideoIds,
    pageVideoIds,
    openGridPosts,
    saveAccountStories
  };
})(globalThis.PageMediaSaver);
