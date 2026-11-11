// Folds a progress report from a page into the job it belongs to. Shared by the CLI bridge (which
// receives the report over HTTP) and the extension's own queue (which receives it as a message).
(function initJobProgress(global) {
  "use strict";

  const TERMINAL_STATES = Object.freeze(["complete", "incomplete", "paused", "error"]);
  const PROGRESS_COUNTERS = [
    "started",
    "skipped",
    "videoStarted",
    "videoSkipped",
    "failed",
    "unavailable",
    "pending",
    "rounds"
  ];
  const MAX_MESSAGE_LENGTH = 500;

  const isTerminal = status => TERMINAL_STATES.includes(status);

  function mergeOutputFiles(job, incoming) {
    const outputs = new Map((job.outputFiles || []).map(file => [String(file.filename || file).toLowerCase(), file]));
    const renamed = job.outputRenames || {};
    for (const file of incoming) {
      const originalName = String(file.filename || file)
        .split(/[\\/]/)
        .pop();
      const filename = renamed[originalName.toLowerCase()] || originalName;
      outputs.set(filename.toLowerCase(), { ...file, filename });
    }
    return [...outputs.values()];
  }

  // `report` is { type: "JOB_PROGRESS" | "JOB_DONE", state }. Mutates and returns `job`.
  function applyProgress(job, report) {
    const state = report.state || {};
    for (const key of PROGRESS_COUNTERS) {
      job[key] = Number(state[key] || 0);
    }
    job.message = String(state.message || "Scanning profile grid.").slice(0, MAX_MESSAGE_LENGTH);
    if (["login_required", "empty_or_private", "unknown"].includes(state.reason)) {
      job.reason = state.reason;
    }
    if (state.noRetry === true) {
      job.noRetry = true;
    }
    if (job.mediaPage && state.account) {
      job.account = String(state.account);
    }
    if (Array.isArray(state.repairFound)) {
      job.repairFound = state.repairFound;
    }
    if (Array.isArray(state.repairFiles)) {
      job.repairFiles = state.repairFiles;
    }
    if (Array.isArray(state.rejectedFiles)) {
      job.rejectedFiles = state.rejectedFiles;
    }
    if (Array.isArray(state.outputFiles)) {
      job.outputFiles = mergeOutputFiles(job, state.outputFiles);
    }
    if (report.type === "JOB_DONE") {
      job.status = isTerminal(state.status) ? state.status : "incomplete";
      job.outcomeAt = state.outcomeAt || new Date().toISOString();
      if (job.rateLimitStatus === 429 || job.rateLimitStatus === 420) {
        job.status = "incomplete";
        job.message = `The platform returned HTTP ${job.rateLimitStatus}; the scan was paused to protect the account.`;
      }
    } else {
      job.status = "running";
    }
    return job;
  }

  // Where this account's files land, and how many this pass started versus skipped.
  function saveSummary(job, downloadDir) {
    const platform = job?.platform || "Site";
    const account = job?.account || "account";
    const folder = downloadDir ? `${downloadDir}\\${platform}\\${account}` : `Downloads/${platform}/${account}`;
    const fresh = Number(job?.started || 0) + Number(job?.videoStarted || 0);
    const skipped = Number(job?.skipped || 0) + Number(job?.videoSkipped || 0);
    return `${folder}: ${fresh} new, ${skipped} already saved or unavailable.`;
  }

  function applyError(job, message) {
    job.status = "error";
    job.message = String(message || "The page scan could not start.").slice(0, MAX_MESSAGE_LENGTH);
    return job;
  }

  const api = Object.freeze({
    TERMINAL_STATES,
    PROGRESS_COUNTERS,
    isTerminal,
    applyProgress,
    applyError,
    saveSummary
  });

  global.PageMediaLib ??= {};
  global.PageMediaLib.jobProgress = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
