// How the extension tells whether the user is signed in to a site, from the names of the cookies the
// browser holds for it. Only the names are looked at: a cookie's value is never read or stored.
(function initLogin(global) {
  "use strict";

  const sites = typeof require === "function" ? require("./sites.js") : global.PageMediaLib.sites;
  // Every listed cookie must be present for the visitor to count as signed in.
  const SESSION_COOKIES = Object.freeze(
    Object.fromEntries(
      sites
        .list()
        .map(site => [
          site.name,
          Object.freeze({ domain: site.session.domain, names: Object.freeze(site.session.names) })
        ])
    )
  );
  const SIGN_IN_URL = Object.freeze(Object.fromEntries(sites.list().map(site => [site.name, site.signInUrl])));
  const SITE_LABEL = Object.freeze(Object.fromEntries(sites.list().map(site => [site.name, site.label])));

  // `cookieNames` is the list of cookie names found for the site's domain.
  function isSignedIn(platform, cookieNames) {
    const rule = SESSION_COOKIES[platform];
    if (!rule) {
      return false;
    }
    const present = new Set(cookieNames || []);
    return rule.names.every(name => present.has(name));
  }

  const api = Object.freeze({ SESSION_COOKIES, SIGN_IN_URL, SITE_LABEL, isSignedIn });

  global.PageMediaLib ??= {};
  global.PageMediaLib.login = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
