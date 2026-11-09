import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const { RESCAN_MS, JITTER, MAX_BACKOFF, intervalFor, urlsDue } = createRequire(import.meta.url)("../../lib/watch.js");
const url = "https://www.instagram.com/disleft/";

test("a profile is due when it has never run, and not while a scan is still open", () => {
  assert.deepEqual(urlsDue([], [url], 0), [url]);
  assert.deepEqual(urlsDue([{ url, status: "running", updatedAt: "2026-11-05T00:00:00.000Z" }], [url], Date.now()), []);
  assert.deepEqual(urlsDue([{ url, status: "queued", updatedAt: "2026-11-05T00:00:00.000Z" }], [url], Date.now()), []);
});

test("a finished profile is due again only after the rescan interval, plus a little of its own", () => {
  const updatedAt = "2026-11-05T00:00:00.000Z";
  const finished = [{ url, status: "complete", updatedAt, createdAt: updatedAt }];
  const doneAt = Date.parse(updatedAt);
  const wait = intervalFor(url, finished);
  assert.ok(
    wait >= RESCAN_MS && wait <= RESCAN_MS * (1 + JITTER),
    "between the interval and the interval plus the jitter"
  );
  assert.deepEqual(urlsDue(finished, [url], doneAt + RESCAN_MS - 1), []);
  assert.deepEqual(urlsDue(finished, [url], doneAt + wait - 1), []);
  assert.deepEqual(urlsDue(finished, [url], doneAt + wait), [url]);
});

test("the extra wait is fixed for an account and differs between accounts", () => {
  const waits = ["a", "b", "c", "d", "e", "f"].map(name => intervalFor(`https://x.com/${name}/`, []));
  assert.equal(intervalFor("https://x.com/a/", []), waits[0], "the same account always waits the same");
  assert.ok(new Set(waits).size > 3, "accounts are spread out, not all due at once");
  assert.ok(waits.every(wait => wait >= RESCAN_MS && wait < RESCAN_MS * (1 + JITTER)));
});

test("an account that keeps running into trouble is visited less often, up to a limit, and recovers", () => {
  const job = (n, status, extra = {}) => ({
    url,
    status,
    createdAt: `2026-11-0${n}T00:00:00.000Z`,
    updatedAt: `2026-11-0${n}T00:00:00.000Z`,
    ...extra
  });
  const base = intervalFor(url, [job(1, "complete")]);
  const near = (actual, expected, why) =>
    assert.ok(Math.abs(actual - expected) <= 2, `${why ?? ""} ${actual} vs ${expected}`);
  near(intervalFor(url, [job(1, "complete"), job(2, "incomplete")]), base * 2);
  near(intervalFor(url, [job(1, "error"), job(2, "incomplete")]), base * 4);
  near(intervalFor(url, [job(1, "error"), job(2, "error"), job(3, "incomplete")]), base * MAX_BACKOFF, "capped");
  near(intervalFor(url, [job(1, "incomplete"), job(2, "complete")]), base, "one good run starts over");
  near(
    intervalFor(url, [job(1, "complete"), job(2, "error", { noRetry: true })]),
    base,
    "a cancelled job is not trouble"
  );
  near(intervalFor(url, [job(1, "paused")]), base);
});
