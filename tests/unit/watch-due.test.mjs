import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const { RESCAN_MS, urlsDue } = createRequire(import.meta.url)("../../lib/watch.js");
const url = "https://www.instagram.com/disleft/";

test("a profile is due when it has never run, and not while a scan is still open", () => {
  assert.deepEqual(urlsDue([], [url], 0), [url]);
  assert.deepEqual(urlsDue([{ url, status: "running", updatedAt: "2026-11-05T00:00:00.000Z" }], [url], Date.now()), []);
  assert.deepEqual(urlsDue([{ url, status: "queued", updatedAt: "2026-11-05T00:00:00.000Z" }], [url], Date.now()), []);
});

test("a finished profile is due again only after the rescan interval", () => {
  const updatedAt = "2026-11-05T00:00:00.000Z";
  const finished = [{ url, status: "complete", updatedAt }];
  const doneAt = Date.parse(updatedAt);
  assert.deepEqual(urlsDue(finished, [url], doneAt + RESCAN_MS - 1), []);
  assert.deepEqual(urlsDue(finished, [url], doneAt + RESCAN_MS), [url]);
});
