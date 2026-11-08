// Which saved profile links are due for another scan. The ledger still skips files already
// saved; this only decides when a profile is worth opening again. Shared by the CLI watch command.
(function initWatch(global) {
  "use strict";

  const ACTIVE = new Set(["queued", "running"]);
  const RESCAN_MS = 6 * 60 * 60 * 1000;

  function urlsDue(jobs, urls, now, intervalMs = RESCAN_MS) {
    const due = [];
    for (const url of urls) {
      const related = jobs.filter(job => job.url === url);
      if (related.some(job => ACTIVE.has(job.status))) {
        continue;
      }
      if (!related.length) {
        due.push(url);
        continue;
      }
      const newest = Math.max(...related.map(job => Date.parse(job.updatedAt || job.createdAt || 0)));
      if (Number.isFinite(newest) && newest + intervalMs <= now) {
        due.push(url);
      }
    }
    return due;
  }

  const api = Object.freeze({ RESCAN_MS, urlsDue });

  global.PageMediaLib ??= {};
  global.PageMediaLib.watch = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
