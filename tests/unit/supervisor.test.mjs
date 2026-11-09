import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../../cli/config.mjs";
import {
  ACK_TIMEOUT_MS,
  STALE_RUNNING_MS,
  createSupervisor,
  recoverInterrupted,
  shouldRetry
} from "../../cli/supervisor.mjs";

// A tiny in-memory stand-in for the job files, the clock and Edge.
function setup(configInput = {}, jobs = []) {
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const store = new Map(jobs.map(job => [job.jobId, structuredClone(job)]));
  const opened = [];
  const moves = [];
  const logs = [];
  const backoffs = [];
  const config = parseConfig({ delaySeconds: { min: 0, max: 0 }, ...configInput });
  const supervisor = createSupervisor({
    now: () => clock,
    random: () => 0,
    log: message => logs.push(message),
    onBackoff: async event => backoffs.push(event),
    loadConfig: async () => config,
    listJobs: async () => [...store.values()].map(job => structuredClone(job)),
    updateJob: async (jobId, mutate) => {
      const job = store.get(jobId);
      await mutate(job);
      job.updatedAt = new Date(clock).toISOString();
      return job;
    },
    openJob: async job => {
      opened.push(`${job.platform}/${job.account}`);
    },
    moveFiles: async destRoot => {
      moves.push(destRoot);
      return { moved: 2, failed: 0 };
    }
  });
  return {
    supervisor,
    store,
    opened,
    moves,
    logs,
    backoffs,
    tick: () => supervisor.tick(),
    advance: ms => {
      clock += ms;
    },
    job: id => store.get(id)
  };
}

const queued = (id, platform, account, extra = {}) => ({
  jobId: id,
  platform,
  account,
  url: `https://example.test/${account}`,
  status: "queued",
  createdAt: `2026-01-01T00:00:0${id}Z`,
  attempts: 0,
  openedAt: null,
  ...extra
});

test("opens one job per site at a time and the others when a worker frees up", async () => {
  const env = setup({}, [queued("1", "Instagram", "a"), queued("2", "Instagram", "b"), queued("3", "Twitter", "c")]);
  assert.equal((await env.tick()).opened, 2);
  assert.deepEqual(env.opened.sort(), ["Instagram/a", "Twitter/c"]);

  env.job("1").status = "complete";
  assert.equal((await env.tick()).opened, 1);
  assert.deepEqual(env.opened.sort(), ["Instagram/a", "Instagram/b", "Twitter/c"]);
});

test("two workers on one site open two jobs", async () => {
  const env = setup({ workers: { instagram: 2 } }, [
    queued("1", "Instagram", "a"),
    queued("2", "Instagram", "b"),
    queued("3", "Instagram", "c")
  ]);
  await env.tick();
  assert.deepEqual(env.opened, ["Instagram/a", "Instagram/b"]);
  await env.tick();
  assert.equal(env.opened.length, 2, "a third waits for a free worker");
});

test("rate-limit outcomes pause only that platform, apply exponential back-off, and restore configured workers", async () => {
  const env = setup({ workers: { instagram: 3, facebook: 2 } }, [
    queued("1", "Instagram", "failed", { status: "error", attempts: 1, message: "HTTP 429 Too Many Requests" }),
    queued("2", "Instagram", "waiting"),
    queued("3", "Facebook", "other")
  ]);
  const first = await env.tick();
  assert.deepEqual(env.opened, ["Facebook/other"]);
  assert.equal(first.requeued, 1);
  assert.equal(env.job("1").status, "queued");
  assert.deepEqual(env.supervisor.platformStatus().instagram, {
    configuredWorkers: 3,
    effectiveWorkers: 1,
    backoffUntil: "2026-01-01T00:15:00.000Z",
    backoffLevel: 1
  });
  assert.equal(env.supervisor.platformStatus().facebook.effectiveWorkers, 2);
  assert.equal(env.backoffs[0].kind, "backoff-start");
  assert.equal(env.backoffs[0].level, 1);

  env.advance(15 * 60_000);
  await env.tick();
  assert.equal(env.supervisor.platformStatus().instagram.effectiveWorkers, 3);
  assert.equal(env.supervisor.platformStatus().instagram.backoffUntil, null);
  assert.equal(env.backoffs.at(-1).kind, "backoff-end");

  Object.assign(env.job("1"), { status: "error", attempts: 2, message: "Please try again later" });
  await env.tick();
  assert.equal(env.supervisor.platformStatus().instagram.backoffLevel, 2);
  assert.equal(env.supervisor.platformStatus().instagram.backoffUntil, "2026-01-01T00:45:00.000Z");
  assert.equal(env.supervisor.platformStatus().instagram.configuredWorkers, 3);
});

test("a repeated challenge on the same job gets a new back-off after cooldown and sign-in", async () => {
  const env = setup({ workers: { instagram: 2 } }, [
    queued("1", "Instagram", "challenged", {
      status: "error",
      attempts: 1,
      openSequence: 1,
      openingId: "first-opening",
      needsLogin: true,
      message: "Instagram asked to sign in."
    })
  ]);
  await env.tick();
  assert.equal(env.supervisor.platformStatus().instagram.backoffLevel, 1);
  env.advance(15 * 60_000);
  env.supervisor.clearSignIn("Instagram");
  await env.tick();
  assert.equal(env.job("1").status, "queued");
  await env.tick();
  env.job("1").status = "running";
  assert.equal(env.job("1").openingId, "1767226500000-2");

  Object.assign(env.job("1"), {
    status: "error",
    needsLogin: true,
    message: "Instagram asked to sign in again."
  });
  await env.tick();
  assert.equal(env.supervisor.platformStatus().instagram.backoffLevel, 2);
  assert.equal(env.backoffs.filter(event => event.kind === "backoff-start").length, 2);
});

test("a repeated challenge has a distinct opening identity after supervisor recreation", async () => {
  let clock = Date.parse("2026-01-01T00:00:00Z");
  let saved = null;
  const job = queued("1", "Instagram", "challenged", {
    status: "error",
    attempts: 1,
    openSequence: 1,
    openingId: "first-opening",
    needsLogin: true,
    message: "Instagram asked to sign in."
  });
  const create = () =>
    createSupervisor({
      now: () => clock,
      random: () => 0,
      log: () => {},
      loadConfig: async () => parseConfig({ workers: { instagram: 2 }, delaySeconds: { min: 0, max: 0 } }),
      listJobs: async () => [job],
      updateJob: async (_id, mutate) => {
        await mutate(job);
        job.updatedAt = new Date(clock).toISOString();
      },
      loadBackoffState: async () => saved,
      saveBackoffState: async state => {
        saved = structuredClone(state);
      },
      openJob: async () => {}
    });

  await create().tick();
  assert.equal(saved.platforms.Instagram.level, 1);
  clock += 15 * 60_000;
  await create().tick();
  assert.equal(job.openingId, "1767226500000-2");
  job.status = "running";
  Object.assign(job, { status: "error", needsLogin: true, message: "Instagram asked to sign in again." });

  await create().tick();
  assert.equal(saved.platforms.Instagram.level, 2);
  assert.equal(saved.platforms.Instagram.until, clock + 30 * 60_000);
});

test("a clean completed run resets the back-off level", async () => {
  const env = setup({}, [queued("1", "TikTok", "failed", { status: "error", message: "checkpoint" })]);
  await env.tick();
  assert.equal(env.supervisor.platformStatus().tiktok.backoffLevel, 1);
  env.advance(15 * 60_000);
  env.job("1").status = "complete";
  env.job("1").message = "";
  env.job("1").updatedAt = "2026-01-01T00:15:00.001Z";
  env.job("1").outcomeAt = "2026-01-01T00:15:00.001Z";
  await env.tick();
  assert.equal(env.supervisor.platformStatus().tiktok.backoffLevel, 0);
});

test("older completed jobs do not reset escalation and cooldown state survives supervisor recreation", async () => {
  let saved = null;
  const baseJobs = [
    queued("1", "Instagram", "old", {
      status: "complete",
      updatedAt: "2025-12-31T23:00:00.000Z"
    }),
    queued("2", "Instagram", "failed", {
      status: "error",
      attempts: 1,
      updatedAt: "2026-01-01T00:00:00.000Z",
      message: "HTTP 429"
    }),
    queued("3", "Instagram", "waiting")
  ];
  const env = setup({ workers: { instagram: 3 } }, baseJobs);
  const makeSupervisor = () =>
    createSupervisor({
      now: () => Date.parse("2026-01-01T00:00:00Z"),
      random: () => 0,
      log: () => {},
      loadConfig: async () => parseConfig({ workers: { instagram: 3 }, delaySeconds: { min: 0, max: 0 } }),
      listJobs: async () => [...env.store.values()],
      updateJob: async (id, mutate) => mutate(env.store.get(id)),
      loadBackoffState: async () => saved,
      saveBackoffState: async state => {
        saved = structuredClone(state);
      },
      openJob: async () => {},
      moveFiles: async () => ({ moved: 0, failed: 0 })
    });
  const first = makeSupervisor();
  await first.tick();
  assert.equal(first.platformStatus().instagram.backoffLevel, 1);
  assert.equal(saved.platforms.Instagram.level, 1);

  Object.assign(env.job("2"), { tabId: null, notifiedAt: "2026-01-01T00:00:01.000Z" });
  const afterUnrelatedUpdate = makeSupervisor();
  await afterUnrelatedUpdate.tick();
  assert.equal(afterUnrelatedUpdate.platformStatus().instagram.backoffLevel, 1);

  const restarted = makeSupervisor();
  await restarted.tick();
  assert.equal(restarted.platformStatus().instagram.backoffLevel, 1);
  assert.equal(restarted.platformStatus().instagram.backoffUntil, "2026-01-01T00:15:00.000Z");

  Object.assign(env.job("2"), {
    status: "error",
    attempts: 2,
    updatedAt: "2026-01-01T00:01:00.000Z",
    message: "Please try again later"
  });
  const escalated = makeSupervisor();
  await escalated.tick();
  assert.equal(escalated.platformStatus().instagram.backoffLevel, 2);
  assert.equal(escalated.platformStatus().instagram.backoffUntil, "2026-01-01T00:30:00.000Z");
});

test("upgrade ignores an old throttling outcome when a newer clean outcome exists", async () => {
  const env = setup({}, [
    queued("1", "Instagram", "old-failure", {
      status: "error",
      attempts: 2,
      message: "HTTP 429",
      updatedAt: "2025-12-31T20:00:00.000Z"
    }),
    queued("2", "Instagram", "healthy", {
      status: "complete",
      outcomeAt: "2025-12-31T23:59:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z"
    })
  ]);
  await env.tick();
  assert.equal(env.supervisor.platformStatus().instagram.backoffLevel, 0);
  assert.equal(env.supervisor.platformStatus().instagram.backoffUntil, null);
});

test("counts the attempt and marks the job as opened", async () => {
  const env = setup({}, [queued("1", "Twitter", "a")]);
  await env.tick();
  assert.equal(env.job("1").attempts, 1);
  assert.ok(env.job("1").openedAt);
});

test("a page that never answers fails after 90 s, then the job is retried after a pause", async () => {
  const env = setup({}, [queued("1", "Twitter", "a")]);
  await env.tick();
  env.advance(ACK_TIMEOUT_MS + 1000);
  const second = await env.tick();
  assert.equal(second.expired, 1);
  assert.equal(second.requeued, 1);
  assert.equal(env.job("1").status, "queued");
  assert.equal(env.job("1").openedAt, null);
  assert.match(env.job("1").lastProblem, /did not acknowledge/);
  assert.equal((await env.tick()).opened, 0, "it waits out the retry delay");

  env.advance(60_000 + 1000);
  assert.equal((await env.tick()).opened, 1);
  assert.equal(env.job("1").attempts, 2);
});

test("stops retrying after maxAttempts", async () => {
  const env = setup({ maxAttempts: 2 }, [queued("1", "Twitter", "a")]);
  for (let round = 0; round < 2; round++) {
    await env.tick();
    env.advance(ACK_TIMEOUT_MS + 1000);
    await env.tick();
    await env.tick();
    env.advance(3 * 60_000);
  }
  await env.tick();
  assert.equal(env.job("1").status, "error", "the second failure is final");
  assert.equal(env.job("1").attempts, 2);
  assert.equal(env.opened.length, 2);
});

test("a running job that stops reporting is ended as incomplete", async () => {
  const env = setup({}, [queued("1", "Twitter", "a", { status: "running", openedAt: "2026-01-01T00:00:00Z" })]);
  env.job("1").updatedAt = "2026-01-01T00:00:00Z";
  env.advance(STALE_RUNNING_MS + 1000);
  assert.equal((await env.tick()).expired, 1);
  assert.equal(env.job("1").status, "incomplete");
});

test("shouldRetry: errors yes, incomplete only if something was saved, complete and paused never", () => {
  assert.equal(shouldRetry({ status: "error", attempts: 1 }, 3), true);
  assert.equal(shouldRetry({ status: "error", attempts: 3 }, 3), false);
  assert.equal(shouldRetry({ status: "incomplete", attempts: 1, started: 4 }, 3), true);
  assert.equal(shouldRetry({ status: "incomplete", attempts: 1, videoStarted: 1 }, 3), true);
  assert.equal(shouldRetry({ status: "incomplete", attempts: 1, started: 0, videoStarted: 0 }, 3), false);
  assert.equal(shouldRetry({ status: "complete", attempts: 1 }, 3), false);
  assert.equal(shouldRetry({ status: "paused", attempts: 1 }, 3), false);
});

test("a job that could not be opened is failed with the reason", async () => {
  const env = setup({}, [queued("1", "Twitter", "a")]);
  const failing = createSupervisor({
    now: () => Date.parse("2026-01-01T00:00:00Z"),
    random: () => 0,
    log: () => {},
    loadConfig: async () => parseConfig({ delaySeconds: { min: 0, max: 0 } }),
    listJobs: async () => [...env.store.values()],
    updateJob: async (id, mutate) => mutate(env.store.get(id)),
    openJob: async () => {
      throw new Error("Edge missing");
    },
    moveFiles: async () => ({ moved: 0, failed: 0 })
  });
  await failing.tick();
  assert.equal(env.job("1").status, "error");
  assert.match(env.job("1").message, /Could not open the page: Edge missing/);
});

test("files are moved only when a download folder is configured, at most every 20 s", async () => {
  const off = setup({}, []);
  await off.tick();
  assert.deepEqual(off.moves, []);

  const on = setup({ downloadDir: "D:\\Media" }, []);
  await on.tick();
  await on.tick();
  assert.deepEqual(on.moves, ["D:\\Media"], "the second pass is too soon");
  on.advance(21_000);
  await on.tick();
  assert.equal(on.moves.length, 2);
  assert.ok(on.logs.some(line => /Moved 2 file/.test(line)));
});

test("a sign-in wall puts the job back to waiting and holds the whole site, while other sites carry on", async () => {
  const env = setup({}, [queued("1", "Instagram", "a"), queued("2", "Instagram", "b"), queued("3", "Twitter", "c")]);
  await env.tick();
  assert.deepEqual(env.opened.sort(), ["Instagram/a", "Twitter/c"]);

  // The page reported a sign-in wall for the Instagram job.
  Object.assign(env.job("1"), { status: "error", needsLogin: true });
  env.job("3").status = "complete";
  const second = await env.tick();
  assert.equal(second.heldForSignIn, 1);
  assert.equal(env.job("1").status, "queued", "the URL is kept, not lost");
  assert.equal(env.job("1").attempts, 0, "the sign-in wall does not use up an attempt");
  assert.match(env.job("1").message, /sign in to Instagram/);
  assert.equal(second.opened, 0, "nothing else starts on Instagram");
  assert.ok(env.logs.some(line => /Instagram: sign-in needed/.test(line)));
});

test("the held site starts again once the user says they signed in, or after the recheck time", async () => {
  const env = setup({}, [queued("1", "Instagram", "a")]);
  await env.tick();
  Object.assign(env.job("1"), { status: "error", needsLogin: true });
  await env.tick();
  assert.equal(env.opened.length, 1);

  env.advance(5 * 60_000);
  await env.tick();
  assert.equal(env.opened.length, 1, "still held after 5 minutes");

  env.advance(6 * 60_000);
  await env.tick();
  assert.equal(env.opened.length, 2, "one job probes again after 10 minutes");
});

test("clearSignIn lets the site start immediately", async () => {
  const env = setup({}, [queued("1", "Instagram", "a")]);
  await env.tick();
  Object.assign(env.job("1"), { status: "error", needsLogin: true });
  await env.tick();
  assert.deepEqual(env.supervisor.signInNeeded(), ["Instagram"]);
  env.supervisor.clearSignIn("Instagram");
  assert.deepEqual(env.supervisor.signInNeeded(), []);
  await env.tick();
  assert.equal(env.opened.length, 2);
});

test("on start, jobs left running by a dead process are ended and unanswered ones are reopened", async () => {
  const env = setup({}, [
    queued("1", "Twitter", "a", { status: "running", started: 5 }),
    queued("2", "Twitter", "b", { openedAt: "2026-01-01T00:00:00Z", attempts: 1 }),
    queued("3", "Twitter", "c"),
    queued("4", "Twitter", "d", { status: "complete" })
  ]);
  const deps = {
    listJobs: async () => [...env.store.values()],
    updateJob: async (id, mutate) => mutate(env.store.get(id))
  };
  assert.equal(await recoverInterrupted(deps), 2);
  assert.equal(env.job("1").status, "incomplete");
  assert.match(env.job("1").message, /interrupted/);
  assert.equal(env.job("2").openedAt, null);
  assert.equal(env.job("3").status, "queued");
  assert.equal(env.job("4").status, "complete");
});

test("an invalid config is rejected at start but the previous one is kept while running", async () => {
  let current = { delaySeconds: { min: 0, max: 0 } };
  const logs = [];
  const supervisor = createSupervisor({
    now: () => 0,
    random: () => 0,
    log: message => logs.push(message),
    loadConfig: async () => parseConfig(current),
    listJobs: async () => [],
    updateJob: async () => null,
    openJob: async () => {},
    moveFiles: async () => ({ moved: 0, failed: 0 })
  });
  await supervisor.tick();
  current = { workers: { x: 99 } };
  await supervisor.tick();
  assert.ok(logs.some(line => /settings are invalid/.test(line)));

  const fresh = createSupervisor({
    now: () => 0,
    random: () => 0,
    log: () => {},
    loadConfig: async () => parseConfig(current),
    listJobs: async () => [],
    updateJob: async () => null,
    openJob: async () => {},
    moveFiles: async () => ({})
  });
  await assert.rejects(() => fresh.tick(), /workers\.x/);
});
