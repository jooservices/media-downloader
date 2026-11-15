import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { BASE_DELAY_MS, MAX_DELAY_MS, MIN_HEALTHY_MS, keepAlive } from "../../cli/keep-alive.mjs";

// A fake child process that ends the way the test scripts: each step is { code, after, error, signal, hold }.
function setup(steps, { holdTimers = false } = {}) {
  let clock = 0;
  const spawned = [];
  const sleeps = [];
  const cleared = [];
  const logs = [];
  const handlers = new Map();
  const spawnChild = (command, args, options) => {
    const step = steps[spawned.length] ?? { code: 0, after: 1 };
    const child = new EventEmitter();
    child.kill = signal => {
      child.killedWith = signal;
      child.emit("exit", null, signal);
    };
    spawned.push({ command, args, options, child });
    queueMicrotask(() => {
      clock += step.after ?? 1;
      if (step.error) {
        child.emit("error", new Error(step.error));
      } else if (!step.hold) {
        child.emit("exit", "code" in step ? step.code : 0, step.signal ?? null);
      }
    });
    return child;
  };
  const setTimer = (callback, ms) => {
    sleeps.push(ms);
    clock += ms;
    if (!holdTimers) {
      queueMicrotask(callback);
    }
    return sleeps.length;
  };
  const clearTimer = id => cleared.push(id);
  const run = (extra = {}) =>
    keepAlive({
      command: "node",
      args: ["cli.mjs", "serve"],
      env: { A: "1" },
      log: line => logs.push(line),
      spawnChild,
      setTimer,
      clearTimer,
      now: () => clock,
      onSignal: (signal, handler) => handlers.set(signal, handler),
      ...extra
    });
  return { run, spawned, sleeps, cleared, logs, handlers };
}

test("a crash starts serve again after 5 s, then a growing pause, and a clean exit ends the loop", async () => {
  const env = setup([{ code: 1 }, { code: 1 }, { code: 3 }, { code: 0 }]);
  const code = await env.run();
  assert.equal(code, 0);
  assert.equal(env.spawned.length, 4);
  assert.deepEqual(env.sleeps, [BASE_DELAY_MS, BASE_DELAY_MS * 2, BASE_DELAY_MS * 4]);
  assert.deepEqual(env.spawned[0].args, ["cli.mjs", "serve"]);
  assert.deepEqual(env.spawned[0].options, { stdio: "inherit", env: { A: "1" } });
  assert.match(env.logs[0], /serve stopped with code 1; starting it again in 5 s/);
});

test("the pause is capped, and a run that stayed up resets it", async () => {
  const crashes = Array.from({ length: 8 }, () => ({ code: 1 }));
  const capped = setup([...crashes, { code: 0 }]);
  await capped.run();
  assert.equal(Math.max(...capped.sleeps), MAX_DELAY_MS);

  const healthy = setup([{ code: 1 }, { code: 1 }, { code: 1, after: MIN_HEALTHY_MS }, { code: 1 }, { code: 0 }]);
  await healthy.run();
  assert.deepEqual(healthy.sleeps, [BASE_DELAY_MS, BASE_DELAY_MS * 2, BASE_DELAY_MS, BASE_DELAY_MS * 2]);
});

test("a child that cannot start, or dies from a signal, counts as a crash", async () => {
  const env = setup([{ error: "spawn ENOENT" }, { code: null, signal: "SIGKILL" }, { code: 0 }]);
  assert.equal(await env.run(), 0);
  assert.equal(env.spawned.length, 3);
  assert.match(env.logs[0], /Could not start serve: spawn ENOENT/);
  assert.equal(env.sleeps.length, 2);
});

test("a stop request is passed to the child and ends the loop without a restart", async () => {
  const env = setup([{ hold: true }]);
  const done = env.run();
  await new Promise(resolve => setImmediate(resolve));
  env.handlers.get("SIGTERM")();
  const code = await done;
  assert.equal(env.spawned.length, 1);
  assert.equal(env.spawned[0].child.killedWith, "SIGTERM");
  assert.equal(env.sleeps.length, 0);
  assert.equal(code, 1, "a child stopped by a signal reports a non-zero code but is not started again");
});

test("a stop request during the pause before a restart cancels the wait at once", async () => {
  const env = setup([{ code: 1 }], { holdTimers: true });
  const done = env.run();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.sleeps.length, 1, "it is waiting to restart");
  env.handlers.get("SIGINT")();
  assert.equal(await done, 0);
  assert.deepEqual(env.cleared, [1], "the timer was cancelled, so nothing keeps the process alive");
  assert.equal(env.spawned.length, 1);
});

test("it uses the console log by default", async () => {
  const written = [];
  const original = process.stderr.write;
  process.stderr.write = chunk => (written.push(String(chunk)), true);
  try {
    const env = setup([{ code: 1 }, { code: 0 }]);
    await env.run({ log: undefined });
  } finally {
    process.stderr.write = original;
  }
  assert.match(written.join(""), /serve stopped with code 1/);
});
