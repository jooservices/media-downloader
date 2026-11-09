// What this page is: platform, account, and whether it is a profile grid or a single post.
// Loaded as a content script before src/content/index.js; modules share the
// PageMediaSaver namespace and are safe to load twice.
globalThis.PageMediaSaver ??= {};
(function initPage(ns) {
  const clean = PageMediaLib.paths.cleanPart;
  const sites = PageMediaLib.sites;

  const firstPathPart = () => location.pathname.split("/").filter(Boolean)[0] || "account";

  function classified(platform) {
    const site = sites.get(platform);
    if (!site) {
      return null;
    }
    return site.classify(location.pathname.split("/").filter(Boolean), new URL(location.href));
  }

  function isProfileGrid(platform = platformForPage()) {
    const found = classified(platform);
    return found?.kind === "profile" || found?.kind === "tab";
  }

  function isMediaPostPage(platform = platformForPage()) {
    const found = classified(platform);
    return found?.kind === "post" || found?.kind === "story";
  }

  function accountFromLink(link, platform) {
    try {
      const url = new URL(link.href, location.href);
      return sites.get(platform)?.accountFromLink(url, clean, sites.reserved()) ?? null;
    } catch {
      return null;
    }
  }

  // The first account any link inside `container` (or the page) points at.
  function authorFromLinks(platform, container) {
    return [...(container || document).querySelectorAll("a[href]")]
      .map(link => accountFromLink(link, platform))
      .find(Boolean);
  }

  function getAccount(platform, container = null) {
    const site = sites.get(platform);
    if (!site) {
      return "account";
    }
    return site.pageAccount({
      pathName: firstPathPart(),
      pathname: location.pathname,
      href: location.href,
      container,
      document,
      clean,
      excluded: sites.reserved(),
      authorFromLinks: () => authorFromLinks(platform, container)
    });
  }

  function platformForPage() {
    return PageMediaLib.platforms.platformForHost(location.hostname);
  }

  ns.page = { clean, getAccount, isProfileGrid, isMediaPostPage, platformForPage };
})(globalThis.PageMediaSaver);
