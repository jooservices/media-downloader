// What the dashboard shows, worked out from the queue's state. Pure functions with no DOM, so every
// rule here (how a job reads, which buttons it gets, what a form means) is tested on its own.
(function initOptionsModel(global) {
  "use strict";

  const TONES = Object.freeze({
    running: "busy",
    queued: "wait",
    complete: "ok",
    error: "bad",
    paused: "wait",
    incomplete: "bad"
  });

  // Each state offers only the actions that make sense for it.
  const ACTIONS = Object.freeze({
    running: ["stop"],
    queued: ["remove"],
    complete: ["remove"],
    error: ["retry", "remove"],
    incomplete: ["retry", "remove"],
    paused: ["retry", "remove"]
  });

  // Every http(s) link in the pasted text, once each, in the order written. Anything else is ignored.
  function parseLinks(text) {
    const seen = new Set();
    const links = [];
    for (const piece of String(text || "").split(/[\s,;]+/)) {
      const link = piece.trim();
      if (/^https?:\/\//i.test(link) && !seen.has(link.toLowerCase())) {
        seen.add(link.toLowerCase());
        links.push(link);
      }
    }
    return links;
  }

  const filesSaved = job => Number(job.started || 0) + Number(job.videoStarted || 0);

  // A job as one row: who, which site, how it is going, and what can be done with it.
  function describeJob(job, siteLabels = {}) {
    const state = Object.hasOwn(TONES, job.status) ? job.status : "queued";
    return {
      id: job.jobId,
      account: job.account || "",
      site: siteLabels[job.platform] || job.platform || "",
      state,
      tone: TONES[state],
      needsSignIn: Boolean(job.needsLogin) || /sign in/i.test(job.message || ""),
      files: filesSaved(job),
      detail: String(job.message || ""),
      actions: ACTIONS[state]
    };
  }

  // The numbers for the headline above the list.
  function summarize(jobs) {
    const count = state => jobs.filter(job => job.status === state).length;
    return {
      total: jobs.length,
      running: count("running"),
      waiting: count("queued"),
      done: count("complete"),
      problems: count("error") + count("incomplete"),
      files: jobs.reduce((sum, job) => sum + filesSaved(job), 0)
    };
  }

  // The sites the user must sign in to: signed out, and either something waits for it or it is in use.
  function signInNeeded(login, jobs) {
    return Object.entries(login || {})
      .filter(([site, info]) => !info.signedIn && jobs.some(job => job.platform === site && job.status !== "complete"))
      .map(([site, info]) => ({ site, label: info.label, url: info.signInUrl }));
  }

  const sites = globalThis.PageMediaLib.sites;
  const FORM_SITES = Object.freeze(sites.formSites());

  // The settings as the form's text fields.
  function settingsToForm(settings) {
    return {
      workers: Object.fromEntries(FORM_SITES.map(([key, site]) => [key, String(settings.workers[site])])),
      delayMin: String(settings.delaySeconds.min),
      delayMax: String(settings.delaySeconds.max),
      maxAttempts: String(settings.maxAttempts),
      unlimited: settings.limit === null,
      limit: settings.limit === null ? "" : String(settings.limit)
    };
  }

  const toNumber = text => (String(text).trim() === "" ? Number.NaN : Number(text));

  // The form's text fields as the settings object the extension validates. Nothing is checked here:
  // the extension's own validator is the single judge of what is allowed.
  function formToSettings(form) {
    return {
      workers: Object.fromEntries(FORM_SITES.map(([key]) => [key, toNumber(form.workers[key])])),
      delaySeconds: { min: toNumber(form.delayMin), max: toNumber(form.delayMax) },
      maxAttempts: toNumber(form.maxAttempts),
      limit: form.unlimited ? null : toNumber(form.limit)
    };
  }

  const api = Object.freeze({
    parseLinks,
    describeJob,
    summarize,
    signInNeeded,
    settingsToForm,
    formToSettings,
    FORM_SITES
  });

  global.PageMediaOptions = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
