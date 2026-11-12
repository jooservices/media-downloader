import assert from "node:assert/strict";
import test from "node:test";
import { closeBrowserGracefully, createBrowserWatchdog } from "../../cli/browser-watchdog.mjs";

function setup({ waiting = true, lastSeen = null } = {}) {
  let clock = Date.parse("2026-01-01T00:00:00Z");
  const state = { waiting, lastSeen, closed: 0, logs: [], closeError: null };
  const watchdog = createBrowserWatchdog({
    waitingForBrowser: () => state.waiting,
    lastSeenAt: () => state.lastSeen,
    closeBrowser: async () => {
      state.closed++;
      if (state.closeError) {
        throw state.closeError;
      }
    },
    log: line => state.logs.push(line),
    now: () => clock
  });
  return { state, watchdog, advance: ms => (clock += ms) };
}

test("does nothing while the extension keeps answering", async () => {
  const { state, watchdog, advance } = setup();
  advance(4 * 60_000);
  state.lastSeen = new Date(Date.parse("2026-01-01T00:00:00Z") + 4 * 60_000).toISOString();
  advance(4 * 60_000);
  assert.equal(await watchdog.tick(), false);
  assert.equal(state.closed, 0);
});

test("does nothing when no job waits for the browser, however long it was quiet", async () => {
  const { state, watchdog, advance } = setup({ waiting: false });
  advance(60 * 60_000);
  assert.equal(await watchdog.tick(), false);
  assert.equal(state.closed, 0);
});

test("closes the browser once it has been silent too long, then waits out the cool-down", async () => {
  const { state, watchdog, advance } = setup();
  advance(5 * 60_000);
  assert.equal(await watchdog.tick(), true);
  assert.equal(state.closed, 1);
  assert.match(state.logs[0], /silent for 5 minutes/);
  advance(9 * 60_000);
  assert.equal(await watchdog.tick(), false);
  advance(2 * 60_000);
  assert.equal(await watchdog.tick(), true);
  assert.equal(state.closed, 2);
});

test("counts silence from the last message, not from when serve started", async () => {
  const { state, watchdog, advance } = setup();
  advance(60 * 60_000);
  state.lastSeen = new Date(Date.parse("2026-01-01T00:00:00Z") + 59 * 60_000).toISOString();
  assert.equal(await watchdog.tick(), false);
});

test("reports a browser that will not close and tries again after the cool-down", async () => {
  const { state, watchdog, advance } = setup();
  state.closeError = new Error("denied");
  advance(6 * 60_000);
  assert.equal(await watchdog.tick(), false);
  assert.match(state.logs.at(-1), /Could not close the browser: denied/);
});

test("closes the right browser politely on each platform and never kills", async () => {
  const calls = [];
  const exec = async (file, args) => calls.push([file, ...args]);
  assert.equal(await closeBrowserGracefully("edge", "win32", exec), "CloseMainWindow");
  assert.match(calls[0].at(-1), /Get-Process msedge .*CloseMainWindow/);
  assert.equal(await closeBrowserGracefully("chrome", "win32", exec), "CloseMainWindow");
  assert.match(calls[1].at(-1), /Get-Process chrome /);
  assert.equal(await closeBrowserGracefully("unknown", "win32", exec), "CloseMainWindow");
  assert.match(calls[2].at(-1), /Get-Process msedge /);
  assert.equal(await closeBrowserGracefully("edge", "darwin", exec), "osascript quit");
  assert.deepEqual(calls[3], ["osascript", "-e", 'tell application "Microsoft Edge" to quit']);
  assert.equal(await closeBrowserGracefully("firefox", "linux", exec), "SIGTERM");
  assert.deepEqual(calls[4], ["pkill", "-TERM", "-x", "firefox"]);
  assert.ok(
    !calls.some(call => call.includes("-9") || call.includes("-KILL") || call.join(" ").includes("Stop-Process"))
  );
});

test("pkill finding nothing is fine; any other failure is raised", async () => {
  await closeBrowserGracefully("edge", "linux", async () => {
    throw Object.assign(new Error("none"), { code: 1 });
  });
  await assert.rejects(
    closeBrowserGracefully("edge", "linux", async () => {
      throw Object.assign(new Error("boom"), { code: 2 });
    }),
    /boom/
  );
});
