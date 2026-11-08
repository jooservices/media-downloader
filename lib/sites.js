// One record per site. Hosts, URL shapes, sign-in cookies and the small page rules live here.
// The scanners ask this list what to do; adding a site adds a record, not a new branch in each scanner.
(function initSites(global) {
  "use strict";

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

  const lower = value => String(value ?? "").toLowerCase();
  const isNumeric = value => /^\d+$/.test(String(value ?? ""));
  const endsWithDot = (host, domain) => host.endsWith(`.${domain}`);

  function pathAccount(url, clean, excluded, { queryFile, singleSegment, fallback }) {
    const parts = url.pathname.split("/").filter(Boolean);
    if (queryFile && lower(parts[0]) === "profile.php") {
      return clean(url.searchParams.get("id"), fallback);
    }
    if (!parts.length || excluded.has(lower(parts[0])) || (singleSegment && parts.length !== 1)) {
      return null;
    }
    return clean(parts[0], "account");
  }

  function classifyInstagram(segments) {
    const path = segments.map(String);
    if (path.length === 2 && lower(path[0]) === "reels") {
      path[0] = "reel";
    }
    const head = lower(path[0]);
    if (head === "stories" && path.length >= 2 && path.length <= 3 && !RESERVED.has(lower(path[1]))) {
      const storyId = path.length === 3 ? path[2] : null;
      if (storyId && !isNumeric(storyId)) {
        return null;
      }
      const pathname = storyId ? `/stories/${path[1]}/${storyId}/` : `/stories/${path[1]}/`;
      return { kind: "story", account: path[1], mediaPage: true, pathname, expand: false };
    }
    if (path.length === 2 && ["p", "reel", "tv"].includes(head)) {
      return {
        kind: "post",
        account: "instagram-post",
        mediaPage: true,
        pathname: `/${path.join("/")}/`,
        expand: false
      };
    }
    if (path.length === 1 && !RESERVED.has(head)) {
      return { kind: "profile", account: path[0], mediaPage: false, pathname: `/${path[0]}/`, expand: false };
    }
    return null;
  }

  function classifyFacebook(segments, url) {
    const head = lower(segments[0]);
    const second = lower(segments[1]);
    const direct = segments.length === 2 && ["reel", "video", "videos"].includes(head);
    const ownerVideos = segments.length >= 3 && second === "videos";
    const watchId = head === "watch" ? url.searchParams.get("v") : null;
    if (direct || ownerVideos || isNumeric(watchId)) {
      return {
        kind: "post",
        account: ownerVideos ? segments[0] : "facebook-post",
        mediaPage: true,
        pathname: `/${segments.join("/")}/`,
        watchId: isNumeric(watchId) ? watchId : null,
        expand: false
      };
    }
    if (segments.length === 2 && ["photos", "reels", "videos"].includes(second) && !RESERVED.has(head)) {
      return {
        kind: "tab",
        account: segments[0],
        mediaPage: false,
        pathname: `/${segments[0]}/${second}/`,
        expand: false
      };
    }
    if (segments.length === 1 && !RESERVED.has(head)) {
      return {
        kind: "profile",
        account: segments[0],
        mediaPage: false,
        pathname: `/${segments[0]}/`,
        expand: segments[0] !== "profile.php"
      };
    }
    return null;
  }

  function classifyTwitter(segments) {
    const head = lower(segments[0]);
    const second = lower(segments[1]);
    if (segments.length === 3 && second === "status" && isNumeric(segments[2])) {
      return {
        kind: "post",
        account: segments[0],
        mediaPage: true,
        pathname: `/${segments.join("/")}/`,
        expand: false
      };
    }
    if (segments.length === 2 && second === "media" && !RESERVED.has(head)) {
      return { kind: "tab", account: segments[0], mediaPage: false, pathname: `/${segments[0]}/media/`, expand: false };
    }
    if (segments.length === 1 && !RESERVED.has(head)) {
      return { kind: "profile", account: segments[0], mediaPage: false, pathname: `/${segments[0]}/`, expand: false };
    }
    return null;
  }

  function instagramPageAccount(ctx) {
    const { pathName, pathname, clean, excluded, authorFromLinks } = ctx;
    if (!excluded.has(lower(pathName))) {
      return clean(pathName, "account");
    }
    const segments = String(pathname || "")
      .split("/")
      .filter(Boolean);
    if (lower(segments[0]) === "stories" && segments[1] && !excluded.has(lower(segments[1]))) {
      return clean(segments[1], "instagram-account");
    }
    const author = authorFromLinks();
    return author ? clean(author, "instagram-account") : "instagram-account";
  }

  function facebookPageAccount(ctx) {
    const { pathName, href, clean, excluded, authorFromLinks } = ctx;
    if (pathName === "profile.php") {
      return clean(new URL(href).searchParams.get("id"), "facebook-profile");
    }
    if (!excluded.has(lower(pathName))) {
      return clean(pathName, "facebook-profile");
    }
    return authorFromLinks() || "facebook-profile";
  }

  function tiktokHandle(segment) {
    const name = String(segment || "");
    if (!name.startsWith("@")) {
      return null;
    }
    const handle = name.slice(1);
    return /^[\w.]{2,24}$/.test(handle) ? handle : null;
  }

  function classifyTikTok(segments) {
    const handle = tiktokHandle(segments[0]);
    if (!handle) {
      return null;
    }
    const kind = lower(segments[1]);
    if (segments.length === 3 && (kind === "video" || kind === "photo") && isNumeric(segments[2])) {
      return {
        kind: "post",
        account: handle,
        mediaPage: true,
        pathname: `/@${handle}/${kind}/${segments[2]}/`,
        expand: false
      };
    }
    if (segments.length === 1) {
      return { kind: "profile", account: handle, mediaPage: false, pathname: `/@${handle}/`, expand: false };
    }
    return null;
  }

  function tiktokPageAccount(ctx) {
    const { pathName, clean, authorFromLinks } = ctx;
    const handle = tiktokHandle(pathName);
    if (handle) {
      return clean(handle, "tiktok-account");
    }
    const author = authorFromLinks();
    return author ? clean(String(author).replace(/^@/, ""), "tiktok-account") : "tiktok-account";
  }

  function tiktokMediaHost(host) {
    const cdn = ["tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokv.com", "ibyteimg.com"];
    return cdn.some(domain => host === domain || endsWithDot(host, domain)) || /^v\d[\w.-]*\.tiktok\.com$/.test(host);
  }

  function twitterPageAccount(ctx) {
    const { pathName, clean, excluded, authorFromLinks, container, document } = ctx;
    if (!excluded.has(lower(pathName))) {
      return clean(pathName, "account");
    }
    const statusLink = container
      ? container.querySelector('a[href*="/status/"]')
      : document.querySelector('article a[href*="/status/"], [role="article"] a[href*="/status/"]');
    const owner = statusLink ? new URL(statusLink.href).pathname.split("/").filter(Boolean)[0] : null;
    if (owner && !excluded.has(lower(owner))) {
      return clean(owner, "account");
    }
    const author = authorFromLinks();
    return author ? clean(author, "account") : "twitter-account";
  }

  const instagramDownloadLabels = [
    "download",
    "download reel",
    "save to device",
    "tải xuống",
    "tải reel",
    "tải video",
    "tải xuống video",
    "tải video xuống",
    "lưu vào thiết bị"
  ];
  const facebookDownloadLabels = [
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
  ];

  const SITES = [
    {
      name: "Instagram",
      label: "Instagram",
      formKey: "instagram",
      formOrder: 1,
      aliases: ["instagram"],
      pageDomains: ["instagram.com"],
      cdnDomains: ["cdninstagram.com", "fbcdn.net"],
      session: { domain: "instagram.com", names: ["sessionid"] },
      signInUrl: "https://www.instagram.com/accounts/login/",
      dataUrl: /\/graphql(?:[/?]|$)|\/api\/v1\//,
      embeddedBootstrap: true,
      wholeAccountTabs: [],
      fileHost: host => endsWithDot(host, "cdninstagram.com") || endsWithDot(host, "fbcdn.net"),
      videoHost: host => endsWithDot(host, "cdninstagram.com") || endsWithDot(host, "fbcdn.net"),
      classify: classifyInstagram,
      comparablePath: pathname => pathname.replace(/^\/reels\/([^/]+)$/, "/reel/$1"),
      accountFromLink: (url, clean, excluded) =>
        pathAccount(url, clean, excluded, { singleSegment: true, fallback: "account" }),
      pageAccount: instagramPageAccount,
      idFromUrl: url => url.pathname.match(/\/(?:p|reel|tv)\/([^/?#]+)/i)?.[1] ?? null,
      idsFromUrl: url =>
        [
          url.pathname.match(/\/(?:p|reel|reels|tv)\/([^/?#]+)/i)?.[1],
          url.pathname.match(/\/stories\/[^/]+\/(\d+)\/?$/i)?.[1]
        ].filter(Boolean),
      downloadLabels: instagramDownloadLabels,
      shareMenu: true,
      opensGridPosts: true,
      opensStories: true,
      gridLinks: 'a[href*="/reel/"], a[href*="/p/"]',
      postId: /\/(?:reel|p)\/([^/?#]+)/i,
      storyTray: pathname => /\/stories\/[^/]+\/?$/i.test(pathname)
    },
    {
      name: "Facebook",
      label: "Facebook",
      formKey: "facebook",
      formOrder: 2,
      aliases: ["facebook"],
      pageDomains: ["facebook.com"],
      cdnDomains: ["fbcdn.net", "fbsbx.com"],
      session: { domain: "facebook.com", names: ["c_user", "xs"] },
      signInUrl: "https://www.facebook.com/login/",
      dataUrl: /\/api\/graphql\/|\/ajax\/bulk-route-definitions|\/video\/video_data/,
      embeddedBootstrap: true,
      wholeAccountTabs: ["photos", "reels", "videos"],
      fileHost: host => endsWithDot(host, "fbcdn.net"),
      videoHost: host => endsWithDot(host, "fbcdn.net"),
      classify: classifyFacebook,
      watchParam: url => (url.pathname.toLowerCase().startsWith("/watch") ? url.searchParams.get("v") : null),
      accountFromLink: (url, clean, excluded) =>
        pathAccount(url, clean, excluded, { queryFile: true, fallback: "facebook-profile" }),
      pageAccount: facebookPageAccount,
      idFromUrl(url) {
        const queryId = url.searchParams.get("v") || url.searchParams.get("story_fbid") || url.searchParams.get("fbid");
        const pathId = url.pathname.match(/\/(?:reel|videos?)\/([^/?#]+)(?:\/([^/?#]+))?/i);
        return queryId || (pathId ? pathId[2] || pathId[1] : null);
      },
      idsFromUrl: url =>
        [
          url.searchParams.get("v"),
          url.searchParams.get("fbid"),
          url.pathname.match(/\/(?:reel|videos?)\/(?:[^/?#]+\/)?(\d+)/i)?.[1]
        ].filter(Boolean),
      downloadLabels: facebookDownloadLabels
    },
    {
      name: "Twitter",
      label: "X",
      formKey: "x",
      formOrder: 0,
      aliases: ["twitter", "x"],
      pageDomains: ["x.com", "twitter.com"],
      cdnDomains: ["twimg.com"],
      session: { domain: "x.com", names: ["auth_token"] },
      signInUrl: "https://x.com/i/flow/login",
      dataUrl: /\/i\/api\/graphql\//,
      wholeAccountTabs: [],
      fileHost: host => host === "pbs.twimg.com" || host === "video.twimg.com",
      videoHost: host => host === "video.twimg.com",
      classify: classifyTwitter,
      accountFromLink: (url, clean, excluded) => pathAccount(url, clean, excluded, { fallback: "account" }),
      pageAccount: twitterPageAccount,
      idFromUrl: url => url.pathname.match(/\/status\/(\d+)/i)?.[1] ?? null,
      idsFromUrl: url => [url.pathname.match(/\/status\/(\d+)/i)?.[1]].filter(Boolean),
      downloadLabels: ["download video", "tải video", "tải xuống video", "tải video xuống"],
      caretMenu: true,
      matchByAccount: true,
      skipForeignPosts: true,
      photos: {
        selector: 'img[src*="pbs.twimg.com/media"], img[srcset*="pbs.twimg.com/media"]'
      },
      preferOriginal(url) {
        if (url.hostname === "pbs.twimg.com" && url.pathname.includes("/media/")) {
          url.searchParams.set("name", "orig");
        }
        return url;
      }
    },
    {
      name: "TikTok",
      label: "TikTok",
      formKey: "tiktok",
      formOrder: 3,
      aliases: ["tiktok"],
      pageDomains: ["tiktok.com"],
      cdnDomains: ["tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokv.com", "ibyteimg.com"],
      session: { domain: "tiktok.com", names: ["sessionid"] },
      signInUrl: "https://www.tiktok.com/login",
      dataUrl: /\/api\/(?:post\/item_list|item\/detail)\b/,
      embeddedBootstrap: true,
      embeddedHint: /downloadAddr|playAddr|bitrateInfo|imagePost/,
      embeddedSelector: 'script[type="application/json"], script#__UNIVERSAL_DATA_FOR_REHYDRATION__',
      wholeAccountTabs: [],
      fileHost: tiktokMediaHost,
      videoHost: tiktokMediaHost,
      classify: classifyTikTok,
      accountFromLink(url, clean) {
        const handle = tiktokHandle(url.pathname.split("/").filter(Boolean)[0]);
        return handle ? clean(handle, "tiktok-account") : null;
      },
      pageAccount: tiktokPageAccount,
      idFromUrl: url => url.pathname.match(/\/(?:video|photo)\/(\d+)/i)?.[1] ?? null,
      idsFromUrl: url => [url.pathname.match(/\/(?:video|photo)\/(\d+)/i)?.[1]].filter(Boolean),
      downloadLabels: ["download", "download video", "tải xuống", "tải video", "lưu video"],
      matchByAccount: true
    }
  ];

  const underDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

  function forHost(host) {
    const name = lower(host);
    return SITES.find(site => site.pageDomains.some(domain => underDomain(name, domain))) || null;
  }

  function formSites() {
    return [...SITES].sort((a, b) => a.formOrder - b.formOrder).map(site => [site.formKey, site.name]);
  }

  function aliasHint() {
    const keys = formSites().map(([key]) => key);
    return `${keys.slice(0, -1).join(", ")} or ${keys.at(-1)}`;
  }

  const api = Object.freeze({
    list: () => SITES,
    names: () => SITES.map(site => site.name),
    get: name => SITES.find(site => site.name === name) || null,
    forHost,
    reserved: () => RESERVED,
    formSites,
    aliasHint,
    aliases() {
      const map = new Map();
      for (const site of SITES) {
        for (const alias of site.aliases) {
          map.set(alias, site.name);
        }
      }
      return map;
    }
  });

  global.PageMediaLib ??= {};
  global.PageMediaLib.sites = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
