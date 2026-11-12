// Notices that the browser stopped answering while jobs wait for it, and closes it politely so the
// queue reopens it with a fresh extension. It never kills a process: a window that will not close is
// reported and left alone.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export const SILENT_MS = 5 * 60_000;
export const RECOVERY_COOLDOWN_MS = 10 * 60_000;

const PROCESS_NAME = { edge: "msedge", chrome: "chrome", firefox: "firefox" };
const APP_NAME = { edge: "Microsoft Edge", chrome: "Google Chrome", firefox: "Firefox" };
const WINDOWS_CLOSE = name =>
  `Get-Process ${name} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }`;

// Asks the browser to close its windows the way a user would. Returns the command that was used.
export async function closeBrowserGracefully(browser = "edge", platform = process.platform, exec = run) {
  const id = Object.hasOwn(PROCESS_NAME, browser) ? browser : "edge";
  if (platform === "win32") {
    await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_CLOSE(PROCESS_NAME[id])]);
    return "CloseMainWindow";
  }
  if (platform === "darwin") {
    await exec("osascript", ["-e", `tell application "${APP_NAME[id]}" to quit`]);
    return "osascript quit";
  }
  await exec("pkill", ["-TERM", "-x", PROCESS_NAME[id]]).catch(error => {
    if (error?.code !== 1) {
      throw error; // pkill exits 1 when nothing matched, which is fine.
    }
  });
  return "SIGTERM";
}

// `waitingForBrowser()` says whether any job has been handed to the browser and is still expected to
// answer; `lastSeenAt()` is when the extension last spoke to the bridge.
export function createBrowserWatchdog({
  waitingForBrowser,
  lastSeenAt,
  closeBrowser,
  log,
  now = Date.now,
  silentMs = SILENT_MS,
  cooldownMs = RECOVERY_COOLDOWN_MS
}) {
  const startedAt = now();
  let lastRecoveryAt = Number.NEGATIVE_INFINITY;
  return {
    async tick() {
      if (!(await waitingForBrowser())) {
        return false;
      }
      const heard = Date.parse(lastSeenAt() || "");
      const quietSince = Number.isFinite(heard) ? Math.max(heard, startedAt) : startedAt;
      const quietFor = now() - quietSince;
      if (quietFor < silentMs || now() - lastRecoveryAt < cooldownMs) {
        return false;
      }
      lastRecoveryAt = now();
      log(
        `The browser extension has been silent for ${Math.floor(quietFor / 60_000)} minutes; closing the browser so it restarts.`
      );
      try {
        await closeBrowser();
      } catch (error) {
        log(`Could not close the browser: ${error?.message || error}`);
        return false;
      }
      return true;
    }
  };
}
