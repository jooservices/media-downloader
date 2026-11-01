// What this page is: platform, account, and whether it is a profile grid or a single post.
// Loaded as a content script before src/content/index.js; modules share the
// PageMediaSaver namespace and are safe to load twice.
(function initPage(ns) {

  const clean = PageMediaLib.paths.cleanPart;

  const firstPathPart = () => location.pathname.split("/").filter(Boolean)[0] || "account";
  const excludedPathNames = new Set([
    "home", "explore", "search", "notifications", "messages", "i", "settings",
    "accounts", "direct", "p", "reel", "reels", "stories", "about", "help",
    "watch", "video", "videos", "photo", "photos", "groups", "marketplace", "events", "gaming"
  ]);

  function isProfileGrid(platform = platformForPage()) {
    const segments = location.pathname.split("/").filter(Boolean);
    const accountPath = segments.length === 1 && !excludedPathNames.has((segments[0] || "").toLowerCase());
    const twitterMediaPath = platform === "Twitter" && segments.length === 2
      && segments[1].toLowerCase() === "media"
      && !excludedPathNames.has((segments[0] || "").toLowerCase());
    const facebookPhotosPath = platform === "Facebook" && segments.length === 2
      && ["photos", "reels", "videos"].includes(segments[1].toLowerCase())
      && !excludedPathNames.has((segments[0] || "").toLowerCase());
    if (platform === "Twitter") return accountPath || twitterMediaPath;
    return (platform === "Instagram" || platform === "Facebook") && (accountPath || facebookPhotosPath);
  }

  function isMediaPostPage(platform = platformForPage()) {
    const segments = location.pathname.split("/").filter(Boolean).map(segment => segment.toLowerCase());
    if (platform === "Instagram") return segments.length === 2 && ["p", "reel", "reels", "tv"].includes(segments[0]);
    if (platform === "Facebook") {
      return (segments.length === 2 && ["reel", "video", "videos"].includes(segments[0]))
        || (segments.length >= 3 && segments[1] === "videos")
        || (segments[0] === "watch" && /^\d+$/.test(new URL(location.href).searchParams.get("v") || ""));
    }
    if (platform === "Twitter") return segments.length === 3 && segments[1] === "status" && /^\d+$/.test(segments[2]);
    return false;
  }


  function accountFromLink(link, platform) {
    try {
      const url = new URL(link.href, location.href);
      const parts = url.pathname.split("/").filter(Boolean);
      if (platform === "Facebook" && parts[0]?.toLowerCase() === "profile.php") {
        return clean(url.searchParams.get("id"), "facebook-profile");
      }
      if (!parts.length || excludedPathNames.has(parts[0].toLowerCase())) return null;
      if (platform === "Instagram" && parts.length !== 1) return null;
      return clean(parts[0], "account");
    } catch { return null; }
  }

  function getAccount(platform, container = null) {
    if (platform === "Facebook") {
      const pathName = firstPathPart();
      if (pathName === "profile.php") return clean(new URL(location.href).searchParams.get("id"), "facebook-profile");
      if (!excludedPathNames.has(pathName.toLowerCase())) return clean(pathName, "facebook-profile");
      const candidates = [...(container || document).querySelectorAll('a[href]')];
      for (const link of candidates) {
        const account = accountFromLink(link, platform);
        if (account) return account;
      }
      return "facebook-profile";
    }
    const pathName = firstPathPart();
    if (excludedPathNames.has(pathName.toLowerCase())) {
      if (platform === "Instagram") {
        const author = [...(container || document).querySelectorAll('a[href]')]
          .map(link => accountFromLink(link, platform))
          .find(Boolean);
        if (author) return clean(author, "instagram-account");
        return "instagram-account";
      }
      const statusLink = container
        ? container.querySelector('a[href*="/status/"]')
        : document.querySelector('article a[href*="/status/"], [role="article"] a[href*="/status/"]');
      if (statusLink) {
        const statusOwner = new URL(statusLink.href).pathname.split("/").filter(Boolean)[0];
        if (statusOwner && !excludedPathNames.has(statusOwner.toLowerCase())) return clean(statusOwner, "account");
      }
      if (platform === "Twitter") {
        const author = [...(container || document).querySelectorAll('a[href]')]
          .map(link => accountFromLink(link, platform))
          .find(Boolean);
        if (author) return clean(author, "account");
      }
      return "twitter-account";
    }
    return clean(pathName, "account");
  }

  function platformForPage() {
    return PageMediaLib.platforms.platformForHost(location.hostname);
  }

  ns.page = { clean, getAccount, isProfileGrid, isMediaPostPage, platformForPage };
})(globalThis.PageMediaSaver ||= {});
