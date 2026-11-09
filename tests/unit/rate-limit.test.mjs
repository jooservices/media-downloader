import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { isRateLimitOutcome } = require("../../lib/rate-limit.js");

test("classifies throttling, rate limits, challenges, checkpoints and login walls", () => {
  for (const message of [
    "HTTP 429 Too Many Requests",
    "The account is rate limited",
    "Request throttled; try again later",
    "Instagram checkpoint required",
    "Security challenge detected",
    "Login wall",
    "Instagram asked to sign in. Sign in with Edge's profile; the queue continues by itself.",
    "Verify your identity",
    "Temporarily blocked due to unusual activity"
  ]) {
    assert.equal(isRateLimitOutcome({ status: "error", message }), true, message);
  }
  assert.equal(isRateLimitOutcome({ status: "error", message: "The platform showed a login wall." }), true);
});

test("ignores ordinary outcomes and only classifies failed or incomplete jobs", () => {
  for (const status of ["queued", "running", "complete", "paused"]) {
    assert.equal(isRateLimitOutcome({ status, message: "HTTP 429" }), false);
  }
  assert.equal(isRateLimitOutcome({ status: "error", message: "Page did not answer" }), false);
  assert.equal(isRateLimitOutcome(null), false);
});
