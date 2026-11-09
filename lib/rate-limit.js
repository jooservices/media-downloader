// Recognizes platform responses that mean the account should stop making requests for a while.
(function initRateLimit(global) {
  "use strict";

  const SIGNALS = [
    /\b429\b/,
    /\b420\b/,
    /too many requests/,
    /rate[ -]?limit(?:ed|ing)?/,
    /throttl(?:e|ed|ing)/,
    /slow down/,
    /try again later/,
    /checkpoint/,
    /challenge/,
    /login wall/,
    /asked to sign in/,
    /asks? (?:you )?to sign in/,
    /sign[ -]?in (?:page|redirect)/,
    /log[ -]?in required/,
    /sign[ -]?in required/,
    /verify (?:your|it'?s) (?:account|identity|you)/,
    /unusual activity/,
    /suspicious activity/,
    /temporarily blocked/,
    /action blocked/
  ];

  function isRateLimitOutcome(job) {
    if (!job || !["error", "incomplete"].includes(job.status)) {
      return false;
    }
    if (Number(job.rateLimitStatus) === 429 || Number(job.rateLimitStatus) === 420) {
      return true;
    }
    const message = String(job.message || job.lastProblem || "").toLowerCase();
    return SIGNALS.some(signal => signal.test(message));
  }

  const api = Object.freeze({ isRateLimitOutcome });

  global.PageMediaLib ??= {};
  global.PageMediaLib.rateLimit = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
