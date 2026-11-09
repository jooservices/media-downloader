import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { platformHealth, mediaFound, errorClass } = require("../../lib/platform-health.js");

const job = (id, options = {}) => ({
  jobId: String(id),
  platform: "Instagram",
  status: "complete",
  started: 1,
  updatedAt: `2026-01-0${id}T00:00:00Z`,
  ...options
});

test("platform health uses finished history and distinguishes a healthy platform with no data", () => {
  const result = platformHealth([job(1), job(2, { platform: "TikTok", status: "running" })]);
  assert.equal(result.find(item => item.platform === "Instagram").state, "ok");
  assert.equal(result.find(item => item.platform === "Facebook").reason, "No finished jobs yet.");
  assert.equal(result.find(item => item.platform === "TikTok").jobs, 0);
});

test("two then three consecutive zero media jobs degrade then break only after prior media", () => {
  const history = [job(1), job(2, { started: 0 }), job(3, { started: 0 })];
  assert.equal(platformHealth(history).find(item => item.platform === "Instagram").state, "degraded");
  history.push(job(4, { started: 0 }));
  const item = platformHealth(history).find(entry => entry.platform === "Instagram");
  assert.equal(item.state, "broken");
  assert.equal(item.consecutiveZeros, 3);
  assert.equal(item.mediaFound, 1);
  assert.equal(item.mediaJobs, 1);
  assert.match(item.reason, /3 consecutive jobs/);
});

test("strong hook and selector diagnostics break immediately and error classes are summarized", () => {
  const items = platformHealth([
    job(1),
    job(2, { status: "error", started: 0, message: "Selector failed to find media" })
  ]);
  const item = items.find(entry => entry.platform === "Instagram");
  assert.equal(item.state, "broken");
  assert.equal(item.errors.diagnostic, 1);
  assert.equal(errorClass({ message: "The site asked to sign in." }), "authentication");
});

test("a later successful job clears old hook and selector diagnostics", () => {
  const item = platformHealth([
    job(1, { started: 0, status: "error", message: "Selector failed to find media" }),
    job(2, { started: 2 })
  ]).find(entry => entry.platform === "Instagram");
  assert.equal(item.state, "ok");
  assert.match(item.reason, /found media/);
});

test("media found honours explicit count and otherwise combines discovered media counters", () => {
  assert.equal(mediaFound({ mediaFound: 4, started: 0 }), 4);
  assert.equal(mediaFound({ started: 1, skipped: 2, videoStarted: 1, videoSkipped: 1 }), 5);
});

test("health reports total media found rather than only counting productive jobs", () => {
  const item = platformHealth([job(1, { started: 4 }), job(2, { started: 2 })]).find(
    entry => entry.platform === "Instagram"
  );
  assert.equal(item.mediaFound, 6);
  assert.equal(item.mediaJobs, 2);
});

test("zero-media runs on a different account do not inherit another account's media history", () => {
  const history = [
    job(1, { account: "alice", started: 2 }),
    job(2, { account: "bob", started: 0 }),
    job(3, { account: "bob", started: 0 }),
    job(4, { account: "bob", started: 0 })
  ];
  const item = platformHealth(history).find(entry => entry.platform === "Instagram");
  assert.equal(item.state, "ok");
  assert.equal(item.consecutiveZeros, 0);
});
