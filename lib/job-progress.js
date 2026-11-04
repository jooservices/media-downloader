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

  // `report` is { type: "JOB_PROGRESS" | "JOB_DONE", state }. Mutates and returns `job`.
  function applyProgress(job, report) {
    const state = report.state || {};
    for (const key of PROGRESS_COUNTERS) {
      job[key] = Number(state[key] || 0);
    }
    job.message = String(state.message || "Scanning profile grid.").slice(0, MAX_MESSAGE_LENGTH);
    if (job.mediaPage && state.account) {
      job.account = String(state.account);
    }
    if (Array.isArray(state.repairFound)) {
      job.repairFound = state.repairFound;
    }
    if (Array.isArray(state.repairFiles)) {
      job.repairFiles = state.repairFiles;
    }
    if (report.type === "JOB_DONE") {
      job.status = isTerminal(state.status) ? state.status : "incomplete";
    } else {
      job.status = "running";
    }
    return job;
  }

  function applyError(job, message) {
    job.status = "error";
    job.message = String(message || "The page scan could not start.").slice(0, MAX_MESSAGE_LENGTH);
    return job;
  }

  const api = Object.freeze({ TERMINAL_STATES, PROGRESS_COUNTERS, isTerminal, applyProgress, applyError });

  global.PageMediaLib ??= {};
  global.PageMediaLib.jobProgress = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
