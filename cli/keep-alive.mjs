// Runs `serve` as a child and starts it again when it dies, so a crash does not end a 24/7 queue.
// systemd and launchd already do this on Linux and macOS; the Windows Startup folder does not.
import { spawn } from "node:child_process";

export const MIN_HEALTHY_MS = 60_000;
export const BASE_DELAY_MS = 5_000;
export const MAX_DELAY_MS = 5 * 60_000;

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// Returns the exit code to end with. A clean exit (0) or a stop request ends the loop; anything else is a crash.
export async function keepAlive({
  command,
  args,
  env = process.env,
  log = line => process.stderr.write(`${line}\n`),
  spawnChild = spawn,
  sleep = wait,
  now = Date.now,
  onSignal = (signal, handler) => process.on(signal, handler)
}) {
  let stopping = false;
  let child = null;
  const stop = signal => () => {
    stopping = true;
    child?.kill(signal);
  };
  const signals = process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM"];
  for (const signal of signals) {
    onSignal(signal, stop(signal));
  }

  let delay = BASE_DELAY_MS;
  while (!stopping) {
    const startedAt = now();
    const code = await new Promise(resolve => {
      child = spawnChild(command, args, { stdio: "inherit", env });
      child.once("error", error => {
        log(`Could not start serve: ${error.message}`);
        resolve(1);
      });
      child.once("exit", (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
    });
    child = null;
    if (stopping || code === 0) {
      return code;
    }
    // A run that lasted a while was healthy, so the next crash starts the delay over.
    delay = now() - startedAt >= MIN_HEALTHY_MS ? BASE_DELAY_MS : Math.min(delay * 2, MAX_DELAY_MS);
    log(`serve stopped with code ${code}; starting it again in ${Math.round(delay / 1000)} s.`);
    await sleep(delay);
  }
  return 0;
}
