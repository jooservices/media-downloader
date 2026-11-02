// Page URL rules shared by the CLI (which builds a job from a URL) and the
// extension (which checks that a tab is still on that job's page).
(function initUrls(global) {
  "use strict";

  const platforms = typeof require === "function" ? require("./platforms.js") : global.PageMediaLib.platforms;

  const RESERVED = new Set([
    "home",
    "explore",
    "search",
    "notifications",
    "messages",
    "i",
    "settings",
    "accounts",
    "direct",
    "p",
    "reel",
    "reels",
    "stories",
    "about",
    "help",
    "watch",
    "video",
    "videos",
    "photo",
    "photos",
    "groups",
    "marketplace",
    "events",
    "gaming",
    "login"
  ]);

  const lowerAt = (segments, index) => String(segments[index] ?? "").toLowerCase();
  const isReserved = segment => RESERVED.has(String(segment ?? "").toLowerCase());
  const isNumeric = value => /^\d+$/.test(String(value ?? ""));

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

  // One classifier per platform: is this path a single post, and whose is it?
  const POST_CLASSIFIERS = {
    Instagram(segments) {
      const isPost = segments.length === 2 && ["p", "reel", "tv"].includes(lowerAt(segments, 0));
      return isPost ? { account: "instagram-post" } : null;
    },
    Facebook(segments, url) {
      const direct = segments.length === 2 && ["reel", "video", "videos"].includes(lowerAt(segments, 0));
      const ownerVideos = segments.length >= 3 && lowerAt(segments, 1) === "videos";
      const watchId = lowerAt(segments, 0) === "watch" ? url.searchParams.get("v") : null;
      if (!direct && !ownerVideos && !isNumeric(watchId)) {
        return null;
      }
      return { account: ownerVideos ? segments[0] : "facebook-post", watchId: isNumeric(watchId) ? watchId : null };
    },
    Twitter(segments) {
      const isStatus = segments.length === 3 && lowerAt(segments, 1) === "status" && isNumeric(segments[2]);
      return isStatus ? { account: segments[0] } : null;
    }
  };

  // Profile tabs that list media: /<profile>/photos|reels|videos on Facebook, /<profile>/media on X.
  const PROFILE_TABS = { Facebook: ["photos", "reels", "videos"], Twitter: ["media"] };

  function profileTab(platform, segments) {
    if (segments.length !== 2 || isReserved(segments[0])) {
      return null;
    }
    const tab = lowerAt(segments, 1);
    return (PROFILE_TABS[platform] ?? []).includes(tab) ? tab : null;
  }

  // Turns a profile or post URL into { url, platform, account, mediaPage }.
  function normalizeProfileUrl(rawUrl) {
    const url = parseHttpsUrl(rawUrl);
    const platform = platforms.platformForHost(url.hostname);
    if (!platform) {
      throw new Error(
        "Automatic URL downloads support Instagram/Facebook profile grids, X profiles, and supported direct post URLs."
      );
    }

    const segments = url.pathname.split("/").filter(Boolean);
    // Instagram redirects /reel/<code> to /reels/<code>; treat both as one reel URL.
    if (platform === "Instagram" && segments.length === 2 && lowerAt(segments, 0) === "reels") {
      segments[0] = "reel";
    }

    const post = POST_CLASSIFIERS[platform](segments, url);
    const tab = post ? null : profileTab(platform, segments);
    if (!post && ((!tab && segments.length !== 1) || segments.length === 0 || isReserved(segments[0]))) {
      throw new Error(
        "Use an Instagram/Facebook/X profile URL or a direct Instagram reel/post, Facebook video/reel, or X status URL."
      );
    }

    url.search = "";
    url.hash = "";
    url.pathname = tab ? `/${segments[0]}/${tab}/` : `/${segments.join("/")}/`;
    if (post?.watchId) {
      url.searchParams.set("v", post.watchId);
    }
    return { url: url.href, platform, account: post ? post.account : segments[0], mediaPage: Boolean(post) };
  }

  // A string that is equal for two URLs pointing at the same page: query and hash
  // dropped, trailing slash and case ignored, /reels/<code> folded into /reel/<code>,
  // and Facebook's /watch kept apart by its ?v= id.
  function comparableUrl(value) {
    try {
      const url = new URL(value);
      const videoId = url.pathname.toLowerCase().startsWith("/watch") ? url.searchParams.get("v") : null;
      let pathname = (stripTrailingSlashes(url.pathname) || "/").toLowerCase();
      if (platforms.platformForHost(url.hostname) === "Instagram") {
        pathname = pathname.replace(/^\/reels\/([^/]+)$/, "/reel/$1");
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
