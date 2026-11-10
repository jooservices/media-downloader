import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { classify, createNotifier, describe, sendNotification } from "../../cli/notify.mjs";

const job = (extra = {}) => ({
  jobId: "11111111-1111-4111-8111-111111111111",
  platform: "Instagram",
  account: "alice",
  url: "https://www.instagram.com/alice/",
  status: "complete",
  started: 0,
  videoStarted: 0,
  message: "",
  ...extra
});

test("a finished scan that saved something is new content; one that stopped short is a problem; the rest are quiet", () => {
  assert.equal(classify(job({ started: 2 })), "new-content");
  assert.equal(classify(job({ videoStarted: 1 })), "new-content");
  assert.equal(classify(job()), null, "nothing new is no news");
  assert.equal(classify(job({ status: "incomplete" })), "problem");
  assert.equal(classify(job({ status: "error" })), "problem");
  assert.equal(classify(job({ status: "error", noRetry: true })), null, "a job the user cancelled is not a problem");
  assert.equal(classify(job({ status: "paused" })), null);
  assert.equal(classify(job({ status: "running", started: 5 })), null);
});

test("the message names the account and keeps long reasons short", () => {
  assert.deepEqual(describe("new-content", job({ started: 3 })), {
    title: "New from Instagram/alice",
    text: "3 new file(s) saved."
  });
  const problem = describe("problem", job({ status: "incomplete", message: "x".repeat(500) }));
  assert.equal(problem.title, "Problem with Instagram/alice");
  assert.equal(problem.text.length, 300);
  assert.equal(describe("problem", job({ status: "error" })).text, "The scan did not finish.");
  assert.deepEqual(describe("backoff-start", { platform: "Instagram", backoffUntil: "later", backoffLevel: 2 }), {
    title: "Back-off started for Instagram",
    text: "New jobs are paused until later (back-off level 2)."
  });
  assert.equal(describe("backoff-end", { platform: "Instagram" }).title, "Back-off ended for Instagram");
});

test("a JSON notification carries the facts; a text one is ntfy-style with a Title header", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url, init });
    return { ok: true };
  };
  const now = () => new Date("2026-01-01T00:00:00Z");
  await sendNotification({ url: "https://hook.example/x", format: "json" }, "new-content", job({ started: 4 }), {
    fetchImpl,
    now
  });
  await sendNotification(
    { url: "https://ntfy.example/t", format: "text" },
    "problem",
    job({ message: "asked to sign in" }),
    { fetchImpl }
  );
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(seen[0].init.body), {
    event: "new-content",
    title: "New from Instagram/alice",
    text: "4 new file(s) saved.",
    platform: "Instagram",
    account: "alice",
    url: "https://www.instagram.com/alice/",
    files: 4,
    jobId: "11111111-1111-4111-8111-111111111111",
    at: "2026-01-01T00:00:00.000Z"
  });
  assert.equal(seen[1].init.headers.Title, "Problem with Instagram/alice");
  assert.equal(seen[1].init.body, "asked to sign in");
  await assert.rejects(
    sendNotification({ url: "https://hook.example/x", format: "json" }, "problem", job(), {
      fetchImpl: async () => ({ ok: false, status: 503 })
    }),
    /answered HTTP 503/
  );
});

test("a notification really reaches a local web server", async () => {
  const bodies = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString());
      response.writeHead(204);
      response.end();
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await sendNotification(
      { url: `http://127.0.0.1:${server.address().port}/hook`, format: "json" },
      "new-content",
      job({ started: 1 })
    );
    assert.equal(JSON.parse(bodies[0]).event, "new-content");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

function notifierWith({ notify, jobs, now = () => new Date("2026-01-01T00:00:00Z") }) {
  const sent = [];
  const marked = [];
  const logs = [];
  const notifier = createNotifier({
    loadConfig: async () => ({ notify }),
    pendingNotifications: () => jobs,
    markNotified: async id => {
      marked.push(id);
    },
    fetchImpl: async (url, init) => {
      sent.push(JSON.parse(init.body));
      return { ok: true };
    },
    now,
    log: line => logs.push(line)
  });
  return { notifier, sent, marked, logs };
}

const NOTIFY = { url: "https://hook.example/x", format: "json", events: ["new-content", "problem"] };
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

test("each finished job is announced once and marked, whatever it was", async () => {
  const { notifier, sent, marked } = notifierWith({
    notify: NOTIFY,
    jobs: [
      job({ jobId: id(1), started: 2 }),
      job({ jobId: id(2) }),
      job({ jobId: id(3), notifiedAt: "earlier", started: 9 }),
      job({ jobId: id(4), status: "running", started: 1 }),
      job({ jobId: id(5), status: "paused" })
    ]
  });
  await notifier.tick();
  assert.deepEqual(
    sent.map(item => item.event),
    ["new-content"]
  );
  assert.deepEqual(marked, [id(1), id(2)], "quiet jobs are marked too, so they are not looked at again");
});

test("trouble on one site is repeated only after the cool-down; another site is not held back", async () => {
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const { notifier, sent } = notifierWith({
    notify: NOTIFY,
    now: () => new Date(clock),
    jobs: [
      job({ jobId: id(1), status: "incomplete", message: "a" }),
      job({ jobId: id(2), status: "incomplete", message: "b" }),
      job({ jobId: id(3), status: "error", platform: "TikTok", message: "c" })
    ]
  });
  await notifier.tick();
  assert.deepEqual(
    sent.map(item => item.platform),
    ["Instagram", "TikTok"]
  );
  clock += 7 * 3600_000;
  await notifier.tick();
  assert.equal(sent.length, 4, "after the cool-down each site may be reported once more, not twice");
});

test("only the chosen kinds of news are sent, and nothing is sent without a notify setting", async () => {
  const jobs = [job({ jobId: id(1), started: 1 }), job({ jobId: id(2), status: "incomplete" })];
  const onlyProblems = notifierWith({ notify: { ...NOTIFY, events: ["problem"] }, jobs });
  await onlyProblems.notifier.tick();
  assert.deepEqual(
    onlyProblems.sent.map(item => item.event),
    ["problem"]
  );
  const off = notifierWith({ notify: null, jobs });
  await off.notifier.tick();
  assert.equal(off.sent.length, 0);
  assert.equal(off.marked.length, 0, "with notifications off nothing is marked, so turning them on later works");
});

test("the configured webhook reports platform back-off start and end", async () => {
  const { notifier, sent } = notifierWith({
    notify: { ...NOTIFY, events: ["backoff-start", "backoff-end"] },
    jobs: []
  });
  await notifier.backoff({
    kind: "backoff-start",
    platform: "Instagram",
    until: "2026-01-01T00:15:00.000Z",
    level: 1
  });
  await notifier.backoff({ kind: "backoff-end", platform: "Instagram", until: null, level: 1 });
  assert.deepEqual(
    sent.map(item => item.event),
    ["backoff-start", "backoff-end"]
  );
  assert.equal(sent[0].backoffLevel, 1);
  assert.equal(sent[0].backoffUntil, "2026-01-01T00:15:00.000Z");
  assert.match(sent[1].text, /worker count has been restored/);
});

test("a broken settings file or a failing web address is logged and does not stop the queue", async () => {
  const broken = createNotifier({
    loadConfig: async () => {
      throw new Error("config.json is broken");
    },
    pendingNotifications: () => [job({ started: 1 })],
    markNotified: async () => {}
  });
  await broken.tick();

  const logs = [];
  const failing = createNotifier({
    loadConfig: async () => ({ notify: NOTIFY }),
    pendingNotifications: () => [job({ jobId: id(1), started: 1 })],
    markNotified: async () => {},
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
    log: line => logs.push(line)
  });
  await failing.tick();
  assert.match(logs[0], /Could not send a notification: ECONNREFUSED/);
});
