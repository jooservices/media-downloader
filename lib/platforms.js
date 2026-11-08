// Which site a host belongs to and which CDN hosts may serve its files.
// The site list itself is lib/sites.js. This is the lookup the page, the worker and the CLI already call.
(function initPlatforms(global) {
  "use strict";

  const sites = typeof require === "function" ? require("./sites.js") : global.PageMediaLib.sites;
  const lower = host => String(host || "").toLowerCase();
  const underDomain = (host, domain) => host === domain || host.endsWith(`.${domain}`);

  function platformForHost(host) {
    return sites.forHost(host)?.name ?? null;
  }

  function domainsOf(platform) {
    const site = sites.get(platform);
    return [...(site?.pageDomains || []), ...(site?.cdnDomains || [])];
  }

  const api = Object.freeze({
    PLATFORMS: sites.names(),
    platformForHost,
    isFileHost: (platform, host) => Boolean(sites.get(platform)?.fileHost(lower(host))),
    isVideoHost: (platform, host) => Boolean(sites.get(platform)?.videoHost(lower(host))),
    isPlatformDomain: (platform, host) => domainsOf(platform).some(domain => underDomain(lower(host), domain))
  });

  global.PageMediaLib ??= {};
  global.PageMediaLib.platforms = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
