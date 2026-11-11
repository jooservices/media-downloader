import assert from "node:assert/strict";
import test from "node:test";
import { renderReport, runMatrix, summarize } from "../../tools/live-matrix.mjs";

const job = (id, platform, account, status, counts = {}, message = "") => ({
  id,
  platform,
  account,
  status,
  message,
  counts: { started: 0, videoStarted: 0, skipped: 0, videoSkipped: 0, failed: 0, ...counts }
});

test("summarize adds up the pages of one account and keeps the reasons it did not finish", () => {
  const rows = summarize([
    job("1", "Facebook", "Bob", "complete", {
      started: 2,
      videoStarted: 3,
      skipped: 5,
      videoSkipped: 7
    }),
    job(
      "2",
      "Facebook",
      "bob",
      "incomplete",
      { started: 1, failed: 1 },
      "No photos or videos were found on this page."
    ),
    job("3", "Instagram", "alice", "complete", { skipped: 9 }),
    { id: "4", platform: "Twitter", account: "x", status: "error" }
  ]);
  assert.deepEqual(
    rows.map(row => [row.platform, row.account, row.pages, row.started, row.skipped, row.failed]),
    [
      ["Facebook", "Bob", 2, 6, 12, 1],
      ["Instagram", "alice", 1, 0, 9, 0],
      ["Twitter", "x", 1, 0, 0, 0]
    ]
  );
  assert.deepEqual([...rows[0].statuses].sort(), ["complete", "incomplete"]);
  assert.equal([...rows[0].notes][0], "No photos or videos were found on this page.");
});

test("the report is a table with a notes section only when something needs explaining", () => {
  const rows = summarize([job("1", "Instagram", "a", "complete", { skipped: 4 })]);
  const plain = renderReport(rows, { startedAt: "s", finishedAt: "f", extensionVersion: "0.5.1" });
  assert.match(plain, /\| Site \| Account \| Pages \| New files \| Skipped \| Failed \| Result \|/);
  assert.doesNotMatch(plain, /Already saved/);
  assert.match(plain, /\| Instagram \| a \| 1 \| 0 \| 4 \| 0 \| complete \|/);
  assert.match(plain, /reported version 0\.5\.1/);
  assert.doesNotMatch(plain, /## Notes/);
  const withNotes = renderReport(summarize([job("2", "TikTok", "t", "error", {}, "asked to sign in")]), {
    startedAt: "s",
    finishedAt: "f",
    extensionVersion: null
  });
  assert.match(withNotes, /version unknown/);
  assert.match(withNotes, /- TikTok\/t: asked to sign in/);
});

test("runMatrix queues every account, waits until all jobs finish, and reports", async () => {
  let polls = 0;
  let clock = 0;
  const queued = [];
  const api = {
    queue: async url => {
      queued.push(url);
      const id = String(queued.length);
      return { items: [{ id }] };
    },
    jobs: async () => {
      polls++;
      const status = polls < 3 ? "running" : "complete";
      return queued.map((_, index) => job(String(index + 1), "Instagram", `a${index}`, status, { skipped: 1 }));
    },
    status: async () => ({ extension: { version: "0.5.12" } })
  };
  const result = await runMatrix({
    accounts: { Instagram: ["https://www.instagram.com/a0/", "https://www.instagram.com/a1/"] },
    api,
    sleep: async () => {
      clock += 1000;
    },
    now: () => new Date(Date.UTC(2026, 0, 1) + clock)
  });
  assert.deepEqual(queued, ["https://www.instagram.com/a0/", "https://www.instagram.com/a1/"]);
  assert.equal(polls, 3);
  assert.equal(result.complete, true);
  assert.equal(result.extensionVersion, "0.5.12");
  assert.equal(result.rows.length, 2);
});

test("runMatrix gives up at its time limit and says it did not finish", async () => {
  let clock = 0;
  const api = {
    queue: async () => ({ items: [{ id: "1" }] }),
    jobs: async () => [job("1", "TikTok", "t", "running")],
    status: async () => ({})
  };
  const result = await runMatrix({
    accounts: { TikTok: ["https://www.tiktok.com/@t/"] },
    api,
    sleep: async () => {
      clock += 60_000;
    },
    now: () => new Date(Date.UTC(2026, 0, 1) + clock),
    maxMs: 120_000
  });
  assert.equal(result.complete, false);
  assert.equal(result.extensionVersion, null);
});
