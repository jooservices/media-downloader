import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { isSignedIn, SIGN_IN_URL, SITE_LABEL, SESSION_COOKIES } = require("../../lib/login.js");
const {
  applyProgress,
  applyError,
  isTerminal,
  isFailureReason,
  countFailures,
  FAILURE_REASONS
} = require("../../lib/job-progress.js");

test("a site counts as signed in only when every session cookie it needs is present", () => {
  assert.equal(isSignedIn("Twitter", ["auth_token", "ct0"]), true);
  assert.equal(isSignedIn("Twitter", ["ct0"]), false);
  assert.equal(isSignedIn("Instagram", ["sessionid", "csrftoken"]), true);
  assert.equal(isSignedIn("Instagram", ["csrftoken"]), false);
  assert.equal(isSignedIn("Facebook", ["c_user", "xs"]), true);
  assert.equal(isSignedIn("Facebook", ["c_user"]), false, "both cookies are needed");
});

test("an unknown site, or no cookies at all, is never signed in", () => {
  assert.equal(isSignedIn("TikTok", ["sessionid"]), true);
  assert.equal(isSignedIn("Snapchat", ["sessionid"]), false);
  assert.equal(isSignedIn("Twitter", []), false);
  assert.equal(isSignedIn("Twitter", null), false);
  assert.equal(isSignedIn("Twitter", undefined), false);
});

test("every site has a sign-in page on its own domain and a readable name", () => {
  for (const [site, rule] of Object.entries(SESSION_COOKIES)) {
    assert.ok(new URL(SIGN_IN_URL[site]).hostname.endsWith(rule.domain), site);
    assert.ok(SITE_LABEL[site], site);
  }
  assert.equal(SITE_LABEL.Twitter, "X");
});

test("progress counters, message and status are copied from the page's report", () => {
  const job = { status: "queued", platform: "Twitter" };
  applyProgress(job, { type: "JOB_PROGRESS", state: { started: 4, videoStarted: 2, pending: 1, message: "scanning" } });
  assert.deepEqual(
    [job.status, job.started, job.videoStarted, job.pending, job.skipped, job.message],
    ["running", 4, 2, 1, 0, "scanning"]
  );
});

test("progress preserves a classified empty-page reason and non-retryable login result", () => {
  const job = applyProgress(
    {},
    {
      type: "JOB_DONE",
      state: { status: "incomplete", reason: "login_required", noRetry: true, message: "Sign in first." }
    }
  );
  assert.deepEqual(
    [job.status, job.reason, job.noRetry, job.message],
    ["incomplete", "login_required", true, "Sign in first."]
  );
});

test("progress keeps a collision-renamed output identity when the page reports its original name later", () => {
  const job = { outputRenames: { "a.jpg": "a (1).jpg" } };
  applyProgress(job, {
    type: "JOB_PROGRESS",
    state: { outputFiles: [{ filename: "a.jpg", size: 13 }] }
  });
  assert.deepEqual(job.outputFiles, [{ filename: "a (1).jpg", size: 13 }]);
});

test("a finished report sets the status it carries, or incomplete when it carries none", () => {
  assert.equal(applyProgress({}, { type: "JOB_DONE", state: { status: "complete" } }).status, "complete");
  assert.equal(applyProgress({}, { type: "JOB_DONE", state: { status: "paused" } }).status, "paused");
  assert.equal(applyProgress({}, { type: "JOB_DONE", state: { status: "running" } }).status, "incomplete");
  assert.equal(applyProgress({}, { type: "JOB_DONE", state: {} }).status, "incomplete");
});

test("a media-post job takes the account the page reports", () => {
  assert.equal(
    applyProgress({ mediaPage: true, account: "x" }, { type: "JOB_PROGRESS", state: { account: "real" } }).account,
    "real"
  );
  assert.equal(
    applyProgress({ mediaPage: false, account: "x" }, { type: "JOB_PROGRESS", state: { account: "real" } }).account,
    "x"
  );
});

test("a long message is cut and an error report ends the job", () => {
  const job = applyProgress({}, { type: "JOB_PROGRESS", state: { message: "m".repeat(900) } });
  assert.equal(job.message.length, 500);
  const failed = applyError({ status: "running" }, "boom");
  assert.deepEqual([failed.status, failed.message], ["error", "boom"]);
  assert.match(applyError({}, "").message, /could not start/);
});

test("terminal states are exactly the four final ones", () => {
  for (const status of ["complete", "incomplete", "paused", "error"]) {
    assert.equal(isTerminal(status), true, status);
  }
  for (const status of ["queued", "running", undefined]) {
    assert.equal(isTerminal(status), false, String(status));
  }
});

test("a failure carries one of the known reasons, and an unknown word is ignored", () => {
  assert.equal(applyError({}, "tab closed", "tab_closed").reason, "tab_closed");
  assert.equal(applyError({}, "x", "made-up").reason, undefined);
  assert.equal(applyError({}, "x").reason, undefined);
  const paused = applyProgress({}, { type: "JOB_DONE", state: { status: "paused", reason: "page_stalled" } });
  assert.equal(paused.reason, "page_stalled");
  assert.equal(applyProgress({}, { type: "JOB_DONE", state: { reason: "nonsense" } }).reason, undefined);
  for (const reason of FAILURE_REASONS) {
    assert.equal(isFailureReason(reason), true, reason);
  }
  assert.equal(isFailureReason(null), false);
});

test("failures are counted by reason and anything unexplained counts as unknown", () => {
  const counts = countFailures([
    { status: "error", reason: "tab_closed" },
    { status: "incomplete", reason: "page_silent" },
    { status: "incomplete", reason: "page_silent" },
    { status: "error" },
    { status: "error", reason: "made-up" },
    { status: "complete", reason: "tab_closed" },
    { status: "paused", reason: "page_stalled" },
    { status: "paused", reason: "tab_closed" },
    { status: "paused" }
  ]);
  assert.deepEqual(counts, {
    login_required: 0,
    empty_or_private: 0,
    no_acknowledgement: 0,
    page_silent: 2,
    tab_closed: 1,
    browser_restarted: 0,
    page_stalled: 1,
    unknown: 2
  });
  assert.equal(Object.keys(countFailures(undefined)).length, FAILURE_REASONS.length);
});

test("an attempt that a later run of the same link replaced is not counted as a failure", () => {
  const counts = countFailures([
    { url: "https://x.com/a/", status: "error", reason: "tab_closed", createdAt: "2026-11-01T00:00:00Z" },
    { url: "https://x.com/a/", status: "complete", createdAt: "2026-11-02T00:00:00Z" },
    { url: "https://x.com/b/", status: "incomplete", reason: "page_silent", createdAt: "2026-11-01T00:00:00Z" },
    { url: "https://x.com/b/", status: "error", reason: "login_required", createdAt: "2026-11-03T00:00:00Z" },
    { url: "https://x.com/b/", status: "complete", createdAt: "2026-11-02T00:00:00Z" }
  ]);
  assert.equal(counts.tab_closed, 0, "a/ finished later");
  assert.equal(counts.page_silent, 0, "b/ was replaced");
  assert.equal(counts.login_required, 1, "b/ newest attempt failed");
});
