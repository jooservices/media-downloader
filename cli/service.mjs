// Starts the queue when the user signs in. This is a logon task, not a Windows service
// in session 0: the download opens the signed-in browser, which only exists on the desktop.
import { spawn } from "node:child_process";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { API_PORT } from "./api.mjs";

const SCRIPT = fileURLToPath(new URL("./mediasaver.mjs", import.meta.url));
const UNIT_NAME = "page-media-saver.service";
const LAUNCHD_LABEL = "dev.jooservices.page-media-saver";

function quoteWindows(value) {
  return `"${String(value).replaceAll('"', "")}"`;
}

function quoteSystemd(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function escapeXml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function serviceLaunch() {
  return { executable: process.execPath, script: SCRIPT };
}

export function windowsStartupFile(env = process.env) {
  const root = env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(root, "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "PageMediaSaver.vbs");
}

// A logon task via schtasks needs an administrator. The per-user Startup folder does not.
export function windowsStartupScript(launch = serviceLaunch()) {
  const command = `${quoteWindows(launch.executable)} ${quoteWindows(launch.script)} serve`;
  const vbs = `"${command.replaceAll('"', '""')}"`;
  return `CreateObject("Wscript.Shell").Run ${vbs}, 0, False\n`;
}

export function startQueue(launch) {
  const child = spawn(launch.executable, [launch.script, "serve"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

export function systemdUnit(launch = serviceLaunch()) {
  return `[Unit]
Description=Page Media Saver

[Service]
ExecStart=${quoteSystemd(launch.executable)} ${quoteSystemd(launch.script)} serve
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

export function launchdPlist(launch = serviceLaunch()) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(launch.executable)}</string>
    <string>${escapeXml(launch.script)}</string>
    <string>serve</string>
  </array>
</dict></plist>
`;
}

export function defaultRun(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let errorText = "";
    child.stderr.on("data", chunk => {
      errorText += chunk;
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(errorText.trim() || `${command} exited with code ${code}`));
      }
    });
  });
}

function sayInstalled() {
  process.stdout.write(
    `The queue starts when you sign in.\nRequest a download with: POST http://127.0.0.1:${API_PORT}/downloads {"url":"https://..."}\n`
  );
}

export async function installService({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  launch = serviceLaunch(),
  run = defaultRun,
  start = startQueue
} = {}) {
  if (platform === "win32") {
    const file = windowsStartupFile(env);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, windowsStartupScript(launch), "utf8");
    start(launch);
    sayInstalled();
    return;
  }
  if (platform === "linux") {
    const unit = path.join(home, ".config", "systemd", "user", UNIT_NAME);
    await mkdir(path.dirname(unit), { recursive: true });
    await writeFile(unit, systemdUnit(launch), "utf8");
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "enable", "--now", UNIT_NAME]);
    sayInstalled();
    return;
  }
  if (platform === "darwin") {
    const plist = path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    await mkdir(path.dirname(plist), { recursive: true });
    await writeFile(plist, launchdPlist(launch), "utf8");
    const domain = `gui/${process.getuid?.() ?? 0}`;
    await run("launchctl", ["bootout", domain, plist]).catch(() => {});
    await run("launchctl", ["bootstrap", domain, plist]);
    sayInstalled();
    return;
  }
  throw new Error(`No sign-in service is defined for ${platform}. Run: node cli/mediasaver.mjs serve`);
}

export async function removeService({
  platform = process.platform,
  home = os.homedir(),
  env = process.env,
  run = defaultRun
} = {}) {
  if (platform === "win32") {
    await unlink(windowsStartupFile(env)).catch(() => {});
  } else if (platform === "linux") {
    await run("systemctl", ["--user", "disable", "--now", UNIT_NAME]).catch(() => {});
    await unlink(path.join(home, ".config", "systemd", "user", UNIT_NAME)).catch(() => {});
    await run("systemctl", ["--user", "daemon-reload"]).catch(() => {});
  } else if (platform === "darwin") {
    const plist = path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
    await run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}`, plist]).catch(() => {});
    await unlink(plist).catch(() => {});
  } else {
    throw new Error(`No sign-in service is defined for ${platform}.`);
  }
  process.stdout.write("The sign-in queue was removed.\n");
}
