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
  const config = parseConfig({ delaySeconds: { min: 0, max: 0 }, ...configInput });
  const supervisor = createSupervisor({
    now: () => clock,
    random: () => 0,
    log: message => logs.push(message),
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
    store,
    opened,
    moves,
    logs,
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
  assert.match(env.job("1").message, /Could not open Edge: Edge missing/);
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
  assert.ok(logs.some(line => /config\.json is invalid/.test(line)));

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
