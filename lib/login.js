// How the extension tells whether the user is signed in to a site, from the names of the cookies the
// browser holds for it. Only the names are looked at: a cookie's value is never read or stored.
(function initLogin(global) {
  "use strict";

  // Every listed cookie must be present for the visitor to count as signed in.
  const SESSION_COOKIES = Object.freeze({
    Twitter: Object.freeze({ domain: "x.com", names: Object.freeze(["auth_token"]) }),
    Instagram: Object.freeze({ domain: "instagram.com", names: Object.freeze(["sessionid"]) }),
    Facebook: Object.freeze({ domain: "facebook.com", names: Object.freeze(["c_user", "xs"]) })
  });

  const SIGN_IN_URL = Object.freeze({
    Twitter: "https://x.com/i/flow/login",
    Instagram: "https://www.instagram.com/accounts/login/",
    Facebook: "https://www.facebook.com/login/"
  });

  const SITE_LABEL = Object.freeze({ Twitter: "X", Instagram: "Instagram", Facebook: "Facebook" });

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
