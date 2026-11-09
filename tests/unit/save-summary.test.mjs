import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const { saveSummary } = createRequire(import.meta.url)("../../lib/job-progress.js");

test("a finished pass names the account folder and counts new files against skipped ones", () => {
  const job = {
    platform: "Facebook",
    account: "TieuHyOfficial",
    started: 2,
    videoStarted: 1,
    skipped: 4,
    videoSkipped: 3
  };
  assert.equal(
    saveSummary(job, "Z:\\Claude\\MediaDownloader"),
    "Z:\\Claude\\MediaDownloader\\Facebook\\TieuHyOfficial: 3 new, 7 already saved or unavailable."
  );
  assert.equal(saveSummary(job, null), "Downloads/Facebook/TieuHyOfficial: 3 new, 7 already saved or unavailable.");
});
