// A read-only view over finished queue jobs. No network or scraper access belongs here.
(function initPlatformHealth(global) {
  "use strict";

  const sites = typeof require === "function" ? require("./sites.js") : global.PageMediaLib.sites;
  const TERMINAL = new Set(["complete", "incomplete", "error"]);
  const DIAGNOSTIC_TERMS = /hook|selector|parser|collector/i;
  const FAILURE_TERMS = /fail|missing|not found|inactive|empty|error/i;
  const isMediaDiagnostic = message => DIAGNOSTIC_TERMS.test(message) && FAILURE_TERMS.test(message);
  const ERROR_CLASSES = [
    ["authentication", /sign[ -]?in|log[ -]?in|asked to sign|session expired/i],
    ["diagnostic", /hook|selector|parser|collector|nothing found/i],
    ["network", /network|timeout|timed out|fetch|connection/i],
    ["download", /download|file|pending|failed/i]
  ];

  const mediaFound = job =>
    Number(
      job.mediaFound ??
        Number(job.started || 0) +
          Number(job.skipped || 0) +
          Number(job.videoStarted || 0) +
          Number(job.videoSkipped || 0)
    );
  const errorClass = job =>
    ERROR_CLASSES.find(([, pattern]) => pattern.test(String(job.message || "")))?.[0] || "other";

  function platformHealth(jobs, platforms = sites.names()) {
    return platforms.map(platform => {
      const history = jobs
        .filter(job => job.platform?.toLowerCase() === platform.toLowerCase() && TERMINAL.has(job.status))
        .sort((a, b) =>
          String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""))
        );
      const successes = history.filter(job => job.status === "complete").length;
      const withMedia = history.filter(job => mediaFound(job) > 0).length;
      const mediaItemsFound = history.reduce((sum, job) => sum + mediaFound(job), 0);
      const zeroMedia = history.filter(job => mediaFound(job) === 0).length;
      const errors = history.reduce((counts, job) => {
        if (job.status !== "complete" || isMediaDiagnostic(String(job.message || ""))) {
          const kind = errorClass(job);
          counts[kind] = (counts[kind] || 0) + 1;
        }
        return counts;
      }, {});
      const accounts = new Map();
      for (const job of history) {
        const account = String(job.account || "unknown").toLowerCase();
        const jobsForAccount = accounts.get(account) || [];
        jobsForAccount.push(job);
        accounts.set(account, jobsForAccount);
      }
      const zeroStreaks = [...accounts.entries()].map(([account, jobsForAccount]) => {
        let count = 0;
        for (const job of jobsForAccount) {
          if (mediaFound(job) > 0) {
            break;
          }
          count++;
        }
        return { account, count: jobsForAccount.some(job => mediaFound(job) > 0) ? count : 0 };
      });
      const zeroStreak = zeroStreaks.sort((a, b) => b.count - a.count)[0] || { account: "unknown", count: 0 };
      const consecutiveZeros = zeroStreak.count;
      const diagnostic = history.find(job => isMediaDiagnostic(String(job.message || "")));
      let state = "ok";
      let reason = history.length
        ? `${history.length} finished job(s); ${withMedia} found media.`
        : "No finished jobs yet.";
      if (diagnostic) {
        state = "broken";
        reason = `Job diagnostics for ${diagnostic.account || "unknown"} indicate a hook or selector problem: ${String(diagnostic.message).slice(0, 240)}`;
      } else if (withMedia > 0 && consecutiveZeros >= 3) {
        state = "broken";
        reason = `${consecutiveZeros} consecutive jobs for ${zeroStreak.account} found no media after earlier jobs did.`;
      } else if (withMedia > 0 && consecutiveZeros >= 2) {
        state = "degraded";
        reason = `${consecutiveZeros} consecutive jobs for ${zeroStreak.account} found no media after earlier jobs did.`;
      } else if (history.length && history[0].status !== "complete") {
        state = "degraded";
        reason = `Latest job ended ${history[0].status} (${errorClass(history[0])}).`;
      }
      return {
        platform,
        state,
        reason,
        jobs: history.length,
        successes,
        mediaFound: mediaItemsFound,
        mediaJobs: withMedia,
        zeroMedia,
        consecutiveZeros,
        errors
      };
    });
  }

  const api = Object.freeze({ platformHealth, mediaFound, errorClass });
  global.PageMediaLib ??= {};
  global.PageMediaLib.platformHealth = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
