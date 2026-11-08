// Page URL rules shared by the CLI (which builds a job from a URL) and the
// extension (which checks that a tab is still on that job's page).
(function initUrls(global) {
  "use strict";

  const sites = typeof require === "function" ? require("./sites.js") : global.PageMediaLib.sites;

  function stripTrailingSlashes(pathname) {
    let end = pathname.length;
    while (end > 0 && pathname[end - 1] === "/") {
      end--;
    }
    return pathname.slice(0, end);
  }

  function parseHttpsUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error("Enter a complete https:// Instagram/Facebook/X profile URL or supported post URL.");
    }
    if (url.protocol !== "https:") {
      throw new Error("Only HTTPS profile URLs are supported.");
    }
    return url;
  }

  // Turns a profile or post URL into { url, platform, account, mediaPage }.
  function normalizeProfileUrl(rawUrl) {
    const url = parseHttpsUrl(rawUrl);
    const site = sites.forHost(url.hostname);
    if (!site) {
      throw new Error(
        "Automatic URL downloads support Instagram/Facebook profile grids, X profiles, and supported direct post URLs."
      );
    }

    const found = site.classify(url.pathname.split("/").filter(Boolean), url);
    if (!found) {
      throw new Error(
        "Use an Instagram/Facebook/X profile URL or a direct Instagram reel/post, Facebook video/reel, or X status URL."
      );
    }

    url.search = "";
    url.hash = "";
    url.pathname = found.pathname;
    if (found.watchId) {
      url.searchParams.set("v", found.watchId);
    }
    return {
      url: url.href,
      platform: site.name,
      account: found.account,
      mediaPage: found.mediaPage,
      expand: found.expand
    };
  }

  // One profile link stands for the whole account. A site that keeps media on extra tabs
  // (Facebook photos, reels and videos) lists those tabs on its record. A tab or a single post stays one page.
  function accountPages(rawUrl) {
    const normalized = normalizeProfileUrl(rawUrl);
    const site = sites.get(normalized.platform);
    const url = new URL(normalized.url);
    const segments = url.pathname.split("/").filter(Boolean);
    if (!normalized.expand || !site.wholeAccountTabs.length) {
      return [normalized.url];
    }
    const base = `${url.origin}/${segments[0]}`;
    return [normalized.url, ...site.wholeAccountTabs.map(tab => `${base}/${tab}/`)];
  }

  // A string that is equal for two URLs pointing at the same page: query and hash
  // dropped, trailing slash and case ignored, /reels/<code> folded into /reel/<code>,
  // and Facebook's /watch kept apart by its ?v= id.
  function comparableUrl(value) {
    try {
      const url = new URL(value);
      const site = sites.forHost(url.hostname);
      const videoId = site?.watchParam?.(url) || null;
      let pathname = (stripTrailingSlashes(url.pathname) || "/").toLowerCase();
      if (site?.comparablePath) {
        pathname = site.comparablePath(pathname);
      }
      const query = videoId ? `?v=${encodeURIComponent(videoId)}` : "";
      return `${url.origin.toLowerCase()}${pathname}${query}`;
    } catch {
      return null;
    }
  }

  const samePage = (a, b) => {
    const left = comparableUrl(a);
    return left !== null && left === comparableUrl(b);
  };

  // The CLI opens each job's page as <profile URL>#pms=<job id>. Sites ignore the fragment, and the
  // extension uses it to tell a tab the CLI opened (which it may close) from one the user opened.
  const CLI_TAB_HASH = /^#pms=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
  const cliTabMarker = jobId => `#pms=${jobId}`;
  const cliJobIdFromHash = hash => CLI_TAB_HASH.exec(String(hash || ""))?.[1]?.toLowerCase() ?? null;

  // A page that asks the visitor to sign in or pass a security check, where no profile is shown.
  const SIGN_IN_PATH = /^\/(accounts\/login|login|i\/flow\/(login|signup)|checkpoint|challenge)(\/|\.|$)/i;
  function isSignInPage(value) {
    try {
      return SIGN_IN_PATH.test(new URL(value).pathname);
    } catch {
      return false;
    }
  }

  const api = Object.freeze({
    normalizeProfileUrl,
    accountPages,
    comparableUrl,
    samePage,
    cliTabMarker,
    cliJobIdFromHash,
    isSignInPage
  });

  global.PageMediaLib ??= {};
  global.PageMediaLib.urls = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
