import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../../cli/config.mjs";
import { pickJobsToOpen } from "../../cli/scheduler.mjs";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const job = (id, platform, extra = {}) => ({
  jobId: id,
  platform,
  status: "queued",
  createdAt: `2026-01-01T00:00:0${id}Z`,
  ...extra
});
const config = (workers, delay = { min: 0, max: 0 }) => parseConfig({ workers, delaySeconds: delay });
const ids = result => result.picked.map(item => item.jobId);
const pick = (jobs, cfg, extra = {}) => pickJobsToOpen({ jobs, config: cfg, now: NOW, random: () => 0, ...extra });

test("one worker per site: a second Instagram job waits while the first runs", () => {
  const jobs = [job("1", "Instagram", { status: "running" }), job("2", "Instagram")];
  assert.deepEqual(ids(pick(jobs, config({}))), []);
});

test("different sites run side by side", () => {
  const jobs = [job("1", "Instagram", { status: "running" }), job("2", "Twitter"), job("3", "Facebook")];
  assert.deepEqual(ids(pick(jobs, config({}))), ["2", "3"]);
});

test("a site with two workers opens two jobs, oldest first, and no more", () => {
  const jobs = [job("3", "Instagram"), job("1", "Instagram"), job("2", "Instagram")];
  assert.deepEqual(ids(pick(jobs, config({ instagram: 2 }))), ["1", "2"]);
});

test("a job that is open but not yet answered still holds its worker", () => {
  const jobs = [job("1", "Twitter", { openedAt: "2026-01-01T00:00:00Z" }), job("2", "Twitter")];
  assert.deepEqual(ids(pick(jobs, config({}))), []);
  assert.deepEqual(ids(pick(jobs, config({ x: 2 }))), ["2"]);
});

test("finished jobs hold no worker", () => {
  const jobs = ["complete", "error", "incomplete", "paused"].map((status, i) =>
    job(String(i + 1), "Twitter", { status })
  );
  assert.deepEqual(ids(pick([...jobs, job("9", "Twitter")], config({}))), ["9"]);
});

test("the pause between accounts spaces out two openings on one site", () => {
  const cfg = config({ instagram: 2 }, { min: 30, max: 30 });
  const jobs = [job("1", "Instagram"), job("2", "Instagram")];
  const first = pick(jobs, cfg);
  assert.deepEqual(ids(first), ["1"], "the second waits out the pause");
  const early = pick(jobs, cfg, { now: NOW + 10_000, lastOpenedAt: first.lastOpenedAt });
  assert.deepEqual(ids(early), []);
  const later = pick(jobs, cfg, { now: NOW + 31_000, lastOpenedAt: first.lastOpenedAt });
  assert.deepEqual(ids(later), ["1"], "only one job is opened per pause, even with a free worker");
});

test("the pause is picked at random between min and max", () => {
  const cfg = config({}, { min: 10, max: 50 });
  const last = { Instagram: NOW - 20_000 };
  const jobs = [job("1", "Instagram")];
  assert.deepEqual(ids(pick(jobs, cfg, { lastOpenedAt: last, random: () => 0 })), ["1"], "10 s pause has passed");
  assert.deepEqual(ids(pick(jobs, cfg, { lastOpenedAt: last, random: () => 1 })), [], "50 s pause has not");
});

test("a retry waits until its notBefore time", () => {
  const jobs = [job("1", "Twitter", { notBefore: new Date(NOW + 60_000).toISOString() })];
  assert.deepEqual(ids(pick(jobs, config({}))), []);
  assert.deepEqual(ids(pick(jobs, config({}), { now: NOW + 61_000 })), ["1"]);
});

test("a blocked site starts nothing while other sites are unaffected", () => {
  const jobs = [job("1", "Instagram"), job("2", "Twitter")];
  assert.deepEqual(ids(pick(jobs, config({}), { blocked: ["Instagram"] })), ["2"]);
  assert.deepEqual(ids(pick(jobs, config({}), { blocked: [] })), ["1", "2"]);
});

test("the caller's lastOpenedAt is not modified", () => {
  const last = {};
  pick([job("1", "Twitter")], config({}), { lastOpenedAt: last });
  assert.deepEqual(last, {});
});
