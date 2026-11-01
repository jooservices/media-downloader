// Page URL rules shared by the CLI (which builds a job from a URL) and the
// extension (which checks that a tab is still on that job's page).
(function initUrls(global) {
  "use strict";

  const platforms = typeof require === "function" ? require("./platforms.js") : global.PageMediaLib.platforms;

  const RESERVED = new Set([
    "home", "explore", "search", "notifications", "messages", "i", "settings", "accounts",
    "direct", "p", "reel", "reels", "stories", "about", "help", "watch", "video", "videos", "photo", "photos",
    "groups", "marketplace", "events", "gaming", "login"
  ]);

  // Turns a profile or post URL into { url, platform, account, mediaPage }.
  function normalizeProfileUrl(rawUrl) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error("Enter a complete https:// Instagram/Facebook/X profile URL or supported post URL.");
    }
    if (url.protocol !== "https:") throw new Error("Only HTTPS profile URLs are supported.");

    const platform = platforms.platformForHost(url.hostname);
    if (!platform) throw new Error("Automatic URL downloads support Instagram/Facebook profile grids, X profiles, and supported direct post URLs.");

    const segments = url.pathname.split("/").filter(Boolean);
    // Instagram redirects /reel/<code> to /reels/<code>; treat both as one reel URL.
    if (platform === "Instagram" && segments.length === 2 && segments[0].toLowerCase() === "reels") segments[0] = "reel";
    let mediaPage = false;
    let account;
    // Profile tabs that list media: /<profile>/photos, /<profile>/reels and /<profile>/videos.
    const facebookTab = platform === "Facebook" && segments.length === 2 && !RESERVED.has(segments[0].toLowerCase())
      && ["photos", "reels", "videos"].includes(segments[1].toLowerCase())
      ? segments[1].toLowerCase()
      : null;
    const twitterMediaPage = platform === "Twitter" && segments.length === 2
      && segments[1].toLowerCase() === "media" && !RESERVED.has(segments[0]?.toLowerCase());
    const facebookWatchId = platform === "Facebook" && segments[0]?.toLowerCase() === "watch"
      ? url.searchParams.get("v")
      : null;
    const facebookWatchPage = /^\d+$/.test(facebookWatchId || "");
    if (platform === "Instagram" && segments.length === 2 && ["p", "reel", "tv"].includes(segments[0].toLowerCase())) {
      mediaPage = true;
      account = "instagram-post";
    } else if (platform === "Facebook") {
      const directVideoPath = segments.length === 2 && ["reel", "video", "videos"].includes(segments[0].toLowerCase());
      const ownerVideosPath = segments.length >= 3 && segments[1].toLowerCase() === "videos";
      if (directVideoPath || ownerVideosPath || facebookWatchPage) {
        mediaPage = true;
        account = ownerVideosPath ? segments[0] : "facebook-post";
      }
    } else if (platform === "Twitter" && segments.length === 3 && segments[1].toLowerCase() === "status" && /^\d+$/.test(segments[2])) {
      mediaPage = true;
      account = segments[0];
    }

    if (!mediaPage) {
      if ((!facebookTab && !twitterMediaPage && segments.length !== 1) || !segments.length || RESERVED.has(segments[0].toLowerCase())) {
        throw new Error("Use an Instagram/Facebook/X profile URL or a direct Instagram reel/post, Facebook video/reel, or X status URL.");
      }
      account = segments[0];
    }

    url.search = "";
    url.hash = "";
    if (facebookTab) url.pathname = `/${segments[0]}/${facebookTab}/`;
    else if (twitterMediaPage) url.pathname = `/${segments[0]}/media/`;
    else url.pathname = `/${segments.join("/")}/`;
    if (facebookWatchPage) url.searchParams.set("v", facebookWatchId);
    return { url: url.href, platform, account, mediaPage };
  }

  // A string that is equal for two URLs pointing at the same page: query and hash
  // dropped, trailing slash and case ignored, /reels/<code> folded into /reel/<code>,
  // and Facebook's /watch kept apart by its ?v= id.
  function comparableUrl(value) {
    try {
      const url = new URL(value);
      const videoId = url.pathname.toLowerCase().startsWith("/watch") ? url.searchParams.get("v") : null;
      let pathname = (url.pathname.replace(/\/+$/, "") || "/").toLowerCase();
      if (platforms.platformForHost(url.hostname) === "Instagram") pathname = pathname.replace(/^\/reels\/([^/]+)$/, "/reel/$1");
      return `${url.origin.toLowerCase()}${pathname}${videoId ? `?v=${encodeURIComponent(videoId)}` : ""}`;
    } catch {
      return null;
    }
  }

  const samePage = (a, b) => {
    const left = comparableUrl(a);
    return left !== null && left === comparableUrl(b);
  };

  const api = Object.freeze({ normalizeProfileUrl, comparableUrl, samePage });

  (global.PageMediaLib ||= {}).urls = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
