// Videos: saves what the page already received, opens grid reels, and falls back to the platform's own menu.
// Loaded as a content script before src/content/index.js; modules share the
// PageMediaSaver namespace and are safe to load twice.
(function initVideo(ns) {
  const { pause } = ns.core;
  const { clean, getAccount } = ns.page;
  // The scan state lives in scan-runner.js, which loads after this file.
  const limitRemaining = () => ns.scan.limitRemaining();
  const scanState = () => ns.scan.state;

  function videoPostToken(platform, container, video, index) {
    const links = [...container.querySelectorAll('a[href]')];
    for (const link of links) {
      try {
        const url = new URL(link.href, location.href);
        if (platform === "Instagram") {
          const match = url.pathname.match(/\/(?:p|reel|tv)\/([^/?#]+)/i);
          if (match) return clean(match[1], `video-${index}`);
        } else if (platform === "Facebook") {
          const queryId = url.searchParams.get("v") || url.searchParams.get("story_fbid") || url.searchParams.get("fbid");
          const pathId = url.pathname.match(/\/(?:reel|videos?)\/([^/?#]+)(?:\/([^/?#]+))?/i);
          if (queryId || pathId) return clean(queryId || pathId[2] || pathId[1], `video-${index}`);
        } else {
          const match = url.pathname.match(/\/status\/(\d+)/i);
          if (match) return clean(match[1], `video-${index}`);
        }
      } catch { /* ignore unrelated links */ }
    }

    const media = video?.poster || video?.currentSrc || video?.src || `${location.pathname}:${index}`;
    try {
      const url = new URL(media, location.href);
      return `media-${hashString(`${url.origin}${url.pathname}`)}`;
    } catch { return `media-${hashString(media)}`; }
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i++) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function actionButtons(container, platform) {
    const candidates = [...container.querySelectorAll('button[aria-label], [role="button"][aria-label], button[data-testid="caret"]')];
    return candidates.filter(button => {
      const label = `${button.getAttribute("aria-label") || ""} ${button.getAttribute("title") || ""} ${button.getAttribute("data-testid") || ""}`.toLowerCase();
      if (platform === "Twitter" && button.getAttribute("data-testid") === "caret") return true;
      if (/more|options|actions|tùy chọn|thêm|opciones|altre opzioni|plus d’options/i.test(label)) return true;
      return platform === "Instagram" && /(?:^|\s)(?:share|share post|share reel)(?:\s|$)/i.test(label);
    });
  }

  function nativeDownloadMenuItem(platform) {
    const visible = node => node.getClientRects().length > 0;
    const menus = [...document.querySelectorAll('[role="menu"]')].filter(visible);
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
    const scope = menus.length ? menus.flatMap(menu => [...menu.querySelectorAll('[role="menuitem"], button, [role="button"]')])
      : dialogs.length ? dialogs.flatMap(dialog => [...dialog.querySelectorAll('[role="menuitem"], button, [role="button"]')])
        : [...document.querySelectorAll('[role="menuitem"]')].filter(visible);
    const labels = scope
      .filter(node => visible(node) && node.getAttribute("aria-disabled") !== "true")
      .map(node => ({ node, label: (node.innerText || node.textContent || node.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim().toLowerCase() }));
    const allowed = platform === "Twitter"
      ? new Set(["download video", "tải video", "tải xuống video", "tải video xuống"])
      : platform === "Instagram"
        ? new Set(["download", "download reel", "save to device", "tải xuống", "tải reel", "tải video", "tải xuống video", "tải video xuống", "lưu vào thiết bị"])
        : new Set(["download video", "download reel", "download", "save to device", "tải video", "tải reel", "tải xuống", "tải xuống video", "tải video xuống", "lưu video", "lưu vào thiết bị"]);
    return labels.find(entry => allowed.has(entry.label))?.node || null;
  }

  function closeOpenMenu() {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  async function collectNativeVideoDownloads(platform, account, budget = limitRemaining()) {
    const containers = globalThis.PageMediaDetection.collectVideoContainers(document, platform);

    let videoDownloadsClicked = 0;
    let videoDownloadsSkipped = 0;
    const maxPerScan = Math.min(12, budget);
    for (let i = 0; i < containers.length && videoDownloadsClicked < maxPerScan; i++) {
      const { container, video } = containers[i];
      const owner = getAccount(platform, container) || account;
      if (scanState().singlePage && owner) scanState().account = owner;
      const token = videoPostToken(platform, container, video, i + 1);
      const key = PageMediaLib.keys.videoKey(platform, token, 1);
      const buttons = actionButtons(container, platform);
      if (!buttons.length) {
        videoDownloadsSkipped++;
        continue;
      }

      let menuItem = null;
      for (const button of buttons.slice(0, 2)) {
        button.click();
        await pause(300);
        menuItem = nativeDownloadMenuItem(platform);
        if (menuItem) break;
        closeOpenMenu();
        await pause(100);
      }
      if (!menuItem) {
        closeOpenMenu();
        videoDownloadsSkipped++;
        continue;
      }

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
      if (!target?.ok || target.skip) {
        closeOpenMenu();
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
    try { url = new URL(href, location.href); } catch { return []; }
    if (platform === "Instagram") return [url.pathname.match(/\/(?:p|reel|reels|tv)\/([^/?#]+)/i)?.[1]].filter(Boolean);
    if (platform === "Facebook") {
      return [url.searchParams.get("v"), url.searchParams.get("fbid"), url.pathname.match(/\/(?:reel|videos?)\/(?:[^/?#]+\/)?(\d+)/i)?.[1]].filter(Boolean);
    }
    return [url.pathname.match(/\/status\/(\d+)/i)?.[1]].filter(Boolean);
  }

  function domVideoIds(platform) {
    const ids = new Set(idsInHref(platform, location.href));
    for (const link of document.querySelectorAll("a[href]")) {
      for (const id of idsInHref(platform, link.href)) if (ids.size < 1000) ids.add(id);
    }
    return [...ids];
  }

  // A single post or reel page also links to related posts; only the page's own
  // id counts there. On a profile, every post linked from the grid counts, and X
  // is matched by account (no ids).
  function pageVideoIds(platform) {
    if (scanState().singlePage) return idsInHref(platform, location.href);
    return platform === "Twitter" ? undefined : domVideoIds(platform);
  }

  const openedGridPosts = new Set();
  const MAX_POSTS_OPENED_PER_PASS = 3;

  function closePostOverlay() {
    const close = document.querySelector('[role="dialog"] svg[aria-label="Close"]')?.closest('button, [role="button"]');
    if (close) close.click();
    else document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  }

  // An Instagram profile grid only carries thumbnails. Opening a post (a reel or a
  // photo post) makes the page request that post's own data, which the page-world
  // hook caches, so open a few unseen posts per pass (like a person clicking
  // through) and save each one's cached files. A pause between posts keeps the pace
  // human-like. `alreadyCovered` are ids the cache already answered for.
  async function openGridPosts(account, budget, alreadyCovered = []) {
    if (scanState().singlePage || budget <= 0) return 0;
    for (const id of alreadyCovered) openedGridPosts.add(id);
    const links = [...document.querySelectorAll('a[href*="/reel/"], a[href*="/p/"]')]
      .filter(link => link.getClientRects().length && !link.closest('[role="dialog"]'));
    let started = 0;
    let opened = 0;
    for (const link of links) {
      if (opened >= MAX_POSTS_OPENED_PER_PASS || started >= budget || ns.scan.stopRequested || !link.isConnected) break;
      const id = link.getAttribute("href").match(/\/(?:reel|p)\/([^/?#]+)/i)?.[1];
      if (!id || openedGridPosts.has(id)) continue;
      openedGridPosts.add(id);
      opened++;
      const gridUrl = location.href;
      link.click();
      for (let attempt = 0; attempt < 5; attempt++) {
        await pause(900);
        const response = await chrome.runtime.sendMessage({
          type: "DOWNLOAD_CACHED_MEDIA", platform: "Instagram", account, ids: [id],
          limit: Number.isFinite(budget) ? budget - started : null
        }).catch(() => null);
        if (response?.cached) {
          started += response.started || 0;
          break;
        }
      }
      closePostOverlay();
      await pause(700);
      if (location.href !== gridUrl) {
        history.back();
        await pause(900);
      }
      await pause(800 + Math.floor(Math.random() * 700));
    }
    return started;
  }

  // Saves the photos and videos the platform already delivered to this page in its own
  // data responses first; the on-page menu flow only handles videos the cache missed.
  async function collectPageMedia(platform, account) {
    const budget = limitRemaining();
    const ids = pageVideoIds(platform);
    const cached = budget > 0 && !(ids && !ids.length)
      ? await chrome.runtime.sendMessage({
        type: "DOWNLOAD_CACHED_MEDIA", platform, account, ids, limit: Number.isFinite(budget) ? budget : null
      }).catch(() => null)
      : null;
    let cachedStarted = cached?.started || 0;
    if (platform === "Instagram") cachedStarted += await openGridPosts(account, budget - cachedStarted, cached?.coveredIds);
    const videos = await collectNativeVideoDownloads(platform, account, budget - cachedStarted);
    return { ...videos, videoDownloadsClicked: videos.videoDownloadsClicked + cachedStarted };
  }

  ns.videoSources = { collectPageMedia, collectNativeVideoDownloads, domVideoIds, pageVideoIds, openGridPosts };
})(globalThis.PageMediaSaver ||= {});
