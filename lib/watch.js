// Which saved profile links are due for another scan. The ledger still skips files already
// saved; this only decides when a profile is worth opening again. Shared by the CLI watch command.
(function initWatch(global) {
  "use strict";

  const ACTIVE = new Set(["queued", "running"]);
  const PROBLEM = new Set(["incomplete", "error"]);
  const RESCAN_MS = 6 * 60 * 60 * 1000;
  // Each account waits a little longer than the base interval, by a fixed amount of its own, so a long list of
  // accounts does not wake up together; an account that keeps running into trouble is visited less and less.
  const JITTER = 0.2;
  const MAX_BACKOFF = 4;

  // The same text always gives the same number from 0 up to (not including) 1.
  function unitFrom(text) {
    let hash = 2166136261;
    for (const char of String(text)) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash / 4294967296;
  }

  function intervalFor(url, related, baseMs = RESCAN_MS) {
    const newestFirst = [...related].sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt)));
    let problems = 0;
    for (const job of newestFirst) {
      if (!PROBLEM.has(job.status) || job.noRetry) {
        break;
      }
      problems++;
    }
    const backoff = Math.min(2 ** problems, MAX_BACKOFF);
    return Math.round(baseMs * backoff * (1 + unitFrom(url) * JITTER));
  }

  function urlsDue(jobs, urls, now, intervalMs = RESCAN_MS) {
    const due = [];
    for (const url of urls) {
      const related = jobs.filter(job => job.url === url);
      if (related.some(job => ACTIVE.has(job.status))) {
        continue;
      }
      const latest = [...related].sort((x, y) =>
        String(y.updatedAt || y.createdAt).localeCompare(String(x.updatedAt || x.createdAt))
      )[0];
      if (latest?.status === "incomplete" && latest.noRetry) {
        continue; // A possibly active scan needs an explicit review before the watch list can retry it.
      }
      if (!related.length) {
        due.push(url);
        continue;
      }
      const newest = Math.max(...related.map(job => Date.parse(job.updatedAt || job.createdAt || 0)));
      if (Number.isFinite(newest) && newest + intervalFor(url, related, intervalMs) <= now) {
        due.push(url);
      }
    }
    return due;
  }

  const api = Object.freeze({ RESCAN_MS, JITTER, MAX_BACKOFF, intervalFor, urlsDue });

  global.PageMediaLib ??= {};
  global.PageMediaLib.watch = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
