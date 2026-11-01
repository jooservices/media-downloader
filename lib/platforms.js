// Which site a host belongs to and which CDN hosts may serve its files. This is
// the single source of truth for the page scripts, the service worker and the CLI.
(function initPlatforms(global) {
  "use strict";

  const PAGE_DOMAINS = {
    Instagram: ["instagram.com"],
    Facebook: ["facebook.com"],
    Twitter: ["x.com", "twitter.com"]
  };
  // Registrable CDN domains that belong to each platform (used to trust a download's origin).
  const CDN_DOMAINS = {
    Instagram: ["cdninstagram.com", "fbcdn.net"],
    Facebook: ["fbcdn.net", "fbsbx.com"],
    Twitter: ["twimg.com"]
  };
  // Exact rules for the files the extension itself asks the browser to download.
  const FILE_HOSTS = {
    Instagram: host => host.endsWith(".cdninstagram.com") || host.endsWith(".fbcdn.net"),
    Facebook: host => host.endsWith(".fbcdn.net"),
    Twitter: host => host === "pbs.twimg.com" || host === "video.twimg.com"
  };
  const VIDEO_HOSTS = {
    Instagram: FILE_HOSTS.Instagram,
    Facebook: FILE_HOSTS.Facebook,
    Twitter: host => host === "video.twimg.com"
  };

  const PLATFORMS = Object.keys(PAGE_DOMAINS);
  const underDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);
  const lower = host => String(host || "").toLowerCase();

  function platformForHost(host) {
    const name = lower(host);
    return PLATFORMS.find(platform => PAGE_DOMAINS[platform].some(domain => underDomain(name, domain))) || null;
  }

  const api = Object.freeze({
    PLATFORMS,
    platformForHost,
    // A host the extension may download an image or video file from.
    isFileHost: (platform, host) => Boolean(FILE_HOSTS[platform]?.(lower(host))),
    // A host a video file may come from.
    isVideoHost: (platform, host) => Boolean(VIDEO_HOSTS[platform]?.(lower(host))),
    // A page or CDN host that belongs to the platform.
    isPlatformDomain: (platform, host) => [...(PAGE_DOMAINS[platform] || []), ...(CDN_DOMAINS[platform] || [])]
      .some(domain => underDomain(lower(host), domain))
  });

  (global.PageMediaLib ||= {}).platforms = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
