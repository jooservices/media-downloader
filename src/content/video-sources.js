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
  const MENU_BUTTONS_TRIED = 2;
  const MAX_POSTS_OPENED_PER_PASS = 3;
  const POST_DATA_ATTEMPTS = 5;

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
  function tokenFromUrl(platform, url) {
    if (platform === "Instagram") {
      return url.pathname.match(/\/(?:p|reel|tv)\/([^/?#]+)/i)?.[1] ?? null;
    }
    if (platform === "Facebook") {
      const queryId = url.searchParams.get("v") || url.searchParams.get("story_fbid") || url.searchParams.get("fbid");
      const pathId = url.pathname.match(/\/(?:reel|videos?)\/([^/?#]+)(?:\/([^/?#]+))?/i);
      return queryId || (pathId ? pathId[2] || pathId[1] : null);
    }
    return url.pathname.match(/\/status\/(\d+)/i)?.[1] ?? null;
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
      if (platform === "Twitter" && button.getAttribute("data-testid") === "caret") {
        return true;
      }
      if (/more|options|actions|tùy chọn|thêm|opciones|altre opzioni|plus d’options/i.test(label)) {
        return true;
      }
      return platform === "Instagram" && /(?:^|\s)(?:share|share post|share reel)(?:\s|$)/i.test(label);
    });
  }

  // The menu entries that mean "download this video", per platform and language.
  const DOWNLOAD_LABELS = {
    Twitter: new Set(["download video", "tải video", "tải xuống video", "tải video xuống"]),
    Instagram: new Set([
      "download",
      "download reel",
      "save to device",
      "tải xuống",
      "tải reel",
      "tải video",
      "tải xuống video",
      "tải video xuống",
      "lưu vào thiết bị"
    ]),
    Facebook: new Set([
      "download video",
      "download reel",
      "download",
      "save to device",
      "tải video",
      "tải reel",
      "tải xuống",
      "tải xuống video",
      "tải video xuống",
      "lưu video",
      "lưu vào thiết bị"
    ])
  };
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
    const allowed = DOWNLOAD_LABELS[platform] ?? DOWNLOAD_LABELS.Facebook;
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

  async function collectNativeVideoDownloads(platform, account, budget = limitRemaining()) {
    const containers = globalThis.PageMediaDetection.collectVideoContainers(document, platform);
    const maxPerScan = Math.min(MAX_NATIVE_VIDEOS_PER_SCAN, budget);
    let videoDownloadsClicked = 0;
    let videoDownloadsSkipped = 0;
    for (let i = 0; i < containers.length && videoDownloadsClicked < maxPerScan; i++) {
      const { container, video } = containers[i];
      const owner = getAccount(platform, container) || account;
      if (scanState().singlePage && owner) {
        scanState().account = owner;
      }
      const token = videoPostToken(platform, container, video, i + 1);
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
    return { videoArticlesSeen: containers.length, videoDownloadsClicked, videoDownloadsSkipped };
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
    if (platform === "Instagram") {
      return [url.pathname.match(/\/(?:p|reel|reels|tv)\/([^/?#]+)/i)?.[1]].filter(Boolean);
    }
    if (platform === "Facebook") {
      return [
        url.searchParams.get("v"),
        url.searchParams.get("fbid"),
        url.pathname.match(/\/(?:reel|videos?)\/(?:[^/?#]+\/)?(\d+)/i)?.[1]
      ].filter(Boolean);
    }
    return [url.pathname.match(/\/status\/(\d+)/i)?.[1]].filter(Boolean);
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
      return idsInHref(platform, location.href);
    }
    return platform === "Twitter" ? undefined : domVideoIds(platform);
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

  const gridLinks = () =>
    [...document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]')].filter(
      link => link.getClientRects().length && !link.closest('[role="dialog"]')
    );

  const postIdOf = link => link.getAttribute("href").match(/\/(?:reel|p)\/([^/?#]+)/i)?.[1];

  // The opened post makes the page request its data; give the hook a few seconds to cache it, then save it.
  async function saveOpenedPost(account, id, remaining) {
    for (let attempt = 0; attempt < POST_DATA_ATTEMPTS; attempt++) {
      await pause(900);
      const response = await chrome.runtime
        .sendMessage({
          type: "DOWNLOAD_CACHED_MEDIA",
          platform: "Instagram",
          account,
          ids: [id],
          limit: Number.isFinite(remaining) ? remaining : null
        })
        .catch(() => null);
      if (response?.cached) {
        return response.started || 0;
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

  // An Instagram profile grid only carries thumbnails. Opening a post (a reel or a
  // photo post) makes the page request that post's own data, which the page-world
  // hook caches, so open a few unseen posts per pass (like a person clicking
  // through) and save each one's cached files. `alreadyCovered` are ids the cache
  // already answered for.
  async function openGridPosts(account, budget, alreadyCovered = []) {
    if (scanState().singlePage || budget <= 0) {
      return 0;
    }
    for (const id of alreadyCovered) {
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
      started += await saveOpenedPost(account, id, budget - started);
      await leavePost(gridUrl);
    }
    return started;
  }

  // Saves the photos and videos the platform already delivered to this page in its own
  // data responses first; the on-page menu flow only handles videos the cache missed.
  async function collectPageMedia(platform, account) {
    const budget = limitRemaining();
    const ids = pageVideoIds(platform);
    const asked = budget > 0 && !(ids && !ids.length);
    const cached = asked
      ? await chrome.runtime
          .sendMessage({
            type: "DOWNLOAD_CACHED_MEDIA",
            platform,
            account,
            ids,
            limit: Number.isFinite(budget) ? budget : null
          })
          .catch(() => null)
      : null;
    let cachedStarted = cached?.started || 0;
    if (platform === "Instagram") {
      cachedStarted += await openGridPosts(account, budget - cachedStarted, cached?.coveredIds);
    }
    const videos = await collectNativeVideoDownloads(platform, account, budget - cachedStarted);
    return { ...videos, videoDownloadsClicked: videos.videoDownloadsClicked + cachedStarted };
  }

  ns.videoSources = { collectPageMedia, collectNativeVideoDownloads, domVideoIds, pageVideoIds, openGridPosts };
})(globalThis.PageMediaSaver);
