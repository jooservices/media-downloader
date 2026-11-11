import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { isSignedIn, SIGN_IN_URL, SITE_LABEL, SESSION_COOKIES } = require("../../lib/login.js");
const { applyProgress, applyError, isTerminal } = require("../../lib/job-progress.js");

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
