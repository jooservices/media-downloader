import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

// Nothing here installs or starts a real service: every file lands in a temp folder and every command is a fake.
const home = await mkdtemp(path.join(os.tmpdir(), "pms-service-"));
process.env.LOCALAPPDATA = home;
const service = await import("../../cli/service.mjs");

after(() => rm(home, { recursive: true, force: true }));

const LAUNCH = { executable: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\tools\\mediasaver.mjs" };
const exists = file =>
  access(file).then(
    () => true,
    () => false
  );

function capture(t) {
  const lines = [];
  const original = process.stdout.write;
  t.mock.method(process.stdout, "write", function (chunk, ...rest) {
    if (typeof chunk !== "string") {
      return original.call(this, chunk, ...rest);
    }
    lines.push(chunk);
    return true;
  });
  return lines;
}

function recorder({ failOn = [] } = {}) {
  const calls = [];
  const run = async (command, args) => {
    calls.push([command, ...args]);
    if (failOn.includes(command + " " + args[1])) {
      throw new Error(`${command} failed`);
    }
  };
  return { calls, run };
}

test("the launch points at this Node and the CLI entry script", () => {
  const launch = service.serviceLaunch();
  assert.equal(launch.executable, process.execPath);
  assert.equal(path.basename(launch.script), "mediasaver.mjs");
  assert.equal(path.basename(path.dirname(launch.script)), "cli");
});

test("the Windows startup file is a per-user Startup entry", () => {
  const file = service.windowsStartupFile({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" });
  assert.equal(
    file,
    path.join(
      "C:\\Users\\me\\AppData\\Roaming",
      "Microsoft",
      "Windows",
      "Start Menu",
      "Programs",
      "Startup",
      "PageMediaSaver.vbs"
    )
  );
  assert.ok(service.windowsStartupFile({}).endsWith("PageMediaSaver.vbs"), "falls back to the home folder");
});

test("the Windows startup script runs the queue hidden, with paths quoted for VBScript", () => {
  assert.equal(
    service.windowsStartupScript(LAUNCH),
    'Set shell = CreateObject("Wscript.Shell")\nSet env = shell.Environment("Process")\nshell.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\tools\\mediasaver.mjs"" serve", 0, False\n'
  );
  const quoted = service.windowsStartupScript({ executable: 'C:\\a"b\\node.exe', script: "s.mjs" });
  assert.doesNotMatch(quoted, /a"b/, "a quote in a path cannot break out of the command");
  assert.match(service.windowsStartupScript(), /serve", 0, False\n$/, "defaults to the real launch");
});

test("the systemd unit restarts the queue on failure and escapes its paths", () => {
  const unit = service.systemdUnit({ executable: "/opt/my node/node", script: '/home/me/"x"\\y.mjs' });
  assert.match(unit, /^\[Unit\]\nDescription=Page Media Saver\n/);
  assert.match(unit, /ExecStart="\/opt\/my node\/node" "\/home\/me\/\\"x\\"\\\\y\.mjs" serve\n/);
  assert.match(unit, /Restart=on-failure\nRestartSec=10\n/);
  assert.match(unit, /WantedBy=default\.target\n$/);
  assert.match(service.systemdUnit(), /ExecStart=/);
});

test("service launchers persist configured data and download directories", () => {
  const env = { PMS_DATA_DIR: "C:\\queue data %", PMS_DOWNLOAD_DIR: "D:\\media & files" };
  const windows = service.windowsStartupScript(LAUNCH, env);
  assert.ok(windows.includes('env("PMS_DATA_DIR") = "C:\\queue data %"'));
  assert.ok(windows.includes('env("PMS_DOWNLOAD_DIR") = "D:\\media & files"'));

  const unit = service.systemdUnit(LAUNCH, { PMS_DATA_DIR: "/srv/queue%data", PMS_DOWNLOAD_DIR: "/mnt/media" });
  assert.match(unit, /Environment="PMS_DATA_DIR=\/srv\/queue%%data"/);
  assert.match(unit, /Environment="PMS_DOWNLOAD_DIR=\/mnt\/media"/);

  const plist = service.launchdPlist(LAUNCH, { PMS_DATA_DIR: "/srv/queue&data", PMS_DOWNLOAD_DIR: "/mnt/media" });
  assert.match(
    plist,
    /<key>EnvironmentVariables<\/key><dict><key>PMS_DATA_DIR<\/key><string>\/srv\/queue&amp;data<\/string>/
  );
  assert.match(plist, /<key>PMS_DOWNLOAD_DIR<\/key><string>\/mnt\/media<\/string><\/dict>/);
  assert.match(plist, /<key>WorkingDirectory<\/key><string>C:\\tools<\/string>/);
});

test("the launchd plist keeps the queue alive and escapes XML in paths", () => {
  const plist = service.launchdPlist({ executable: "/opt/a&b/node", script: "/x/<y>.mjs" });
  assert.match(plist, /<key>Label<\/key><string>dev\.jooservices\.page-media-saver<\/string>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(
    plist,
    /<string>\/opt\/a&amp;b\/node<\/string>\s*<string>\/x\/&lt;y&gt;\.mjs<\/string>\s*<string>serve<\/string>/
  );
  assert.match(service.launchdPlist(), /<plist version="1\.0">/);
});

test("installing on Windows writes the Startup entry, starts the queue now and says how to request downloads", async t => {
  const lines = capture(t);
  const started = [];
  const env = { APPDATA: path.join(home, "win-roaming") };
  env.PMS_DATA_DIR = path.join(home, "queue-data");
  env.PMS_DOWNLOAD_DIR = path.join(home, "downloads");
  await service.installService({
    platform: "win32",
    env,
    launch: LAUNCH,
    start: (launch, childEnv) => started.push([launch, childEnv])
  });
  const file = service.windowsStartupFile(env);
  const script = await readFile(file, "utf8");
  assert.equal(script, service.windowsStartupScript(LAUNCH, env));
  assert.ok(script.includes(`env("PMS_DATA_DIR") = "${env.PMS_DATA_DIR}"`));
  assert.deepEqual(started, [[LAUNCH, env]]);
  assert.match(
    lines.join(""),
    /The queue starts when you sign in\.\nRequest a download with: POST http:\/\/127\.0\.0\.1:\d+\/downloads/
  );
});

test("installing on Linux writes a user unit, then reloads and enables it", async t => {
  capture(t);
  const { calls, run } = recorder();
  const userHome = path.join(home, "linux");
  const env = { PMS_DATA_DIR: path.join(home, "persistent-data"), PMS_DOWNLOAD_DIR: path.join(home, "downloads") };
  await service.installService({ platform: "linux", home: userHome, env, launch: LAUNCH, run });
  const unit = path.join(userHome, ".config", "systemd", "user", "page-media-saver.service");
  const unitText = await readFile(unit, "utf8");
  assert.equal(unitText, service.systemdUnit(LAUNCH, env));
  const escapeSystemdValue = value => value.replaceAll("\\", "\\\\");
  assert.ok(unitText.includes(`Environment="PMS_DATA_DIR=${escapeSystemdValue(env.PMS_DATA_DIR)}"`));
  assert.ok(unitText.includes(`Environment="PMS_DOWNLOAD_DIR=${escapeSystemdValue(env.PMS_DOWNLOAD_DIR)}"`));
  assert.deepEqual(calls, [
    ["systemctl", "--user", "daemon-reload"],
    ["systemctl", "--user", "enable", "--now", "page-media-saver.service"]
  ]);
});

test("installing on Linux reports a systemctl failure", async t => {
  capture(t);
  const { run } = recorder({ failOn: ["systemctl enable"] });
  await assert.rejects(
    service.installService({ platform: "linux", home: path.join(home, "linux2"), launch: LAUNCH, run }),
    /systemctl failed/
  );
});

test("installing on macOS writes a LaunchAgent and bootstraps it after clearing an old one", async t => {
  capture(t);
  const { calls, run } = recorder();
  const userHome = path.join(home, "mac");
  const failingBootout = async (command, args) => {
    await run(command, args);
    if (args[0] === "bootout") {
      throw new Error("not loaded"); // no earlier agent: that is fine
    }
  };
  const env = { PMS_DATA_DIR: path.join(home, "mac-data"), PMS_DOWNLOAD_DIR: path.join(home, "mac-media") };
  await service.installService({ platform: "darwin", home: userHome, env, launch: LAUNCH, run: failingBootout });
  const plist = path.join(userHome, "Library", "LaunchAgents", "dev.jooservices.page-media-saver.plist");
  const plistText = await readFile(plist, "utf8");
  assert.equal(plistText, service.launchdPlist(LAUNCH, env));
  assert.ok(plistText.includes(`<key>PMS_DATA_DIR</key><string>${env.PMS_DATA_DIR}</string>`));
  assert.ok(plistText.includes(`<key>PMS_DOWNLOAD_DIR</key><string>${env.PMS_DOWNLOAD_DIR}</string>`));
  assert.deepEqual(
    calls.map(call => call.slice(0, 2)),
    [
      ["launchctl", "bootout"],
      ["launchctl", "bootstrap"]
    ]
  );
  assert.match(calls[1][2], /^gui\/\d+$/);
  assert.equal(calls[1][3], plist);
});

test("installing on a platform without a sign-in service says to run serve by hand", async () => {
  await assert.rejects(
    service.installService({ platform: "freebsd", home, launch: LAUNCH }),
    /No sign-in service is defined for freebsd\. Run: node cli\/mediasaver\.mjs serve/
  );
});

test("removing on Windows deletes the Startup entry, and is fine when it is already gone", async t => {
  const lines = capture(t);
  const env = { APPDATA: path.join(home, "win-roaming2") };
  const file = service.windowsStartupFile(env);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "x");
  await service.removeService({ platform: "win32", env });
  assert.equal(await exists(file), false);
  await service.removeService({ platform: "win32", env });
  assert.deepEqual(lines, ["The sign-in queue was removed.\n", "The sign-in queue was removed.\n"]);
});

test("removing on Linux disables the unit, deletes it and reloads, even when systemctl fails", async t => {
  capture(t);
  const userHome = path.join(home, "linux3");
  const unit = path.join(userHome, ".config", "systemd", "user", "page-media-saver.service");
  await mkdir(path.dirname(unit), { recursive: true });
  await writeFile(unit, "x");
  const calls = [];
  await service.removeService({
    platform: "linux",
    home: userHome,
    run: async (command, args) => {
      calls.push([command, ...args]);
      throw new Error("no systemd here");
    }
  });
  assert.equal(await exists(unit), false);
  assert.deepEqual(calls, [
    ["systemctl", "--user", "disable", "--now", "page-media-saver.service"],
    ["systemctl", "--user", "daemon-reload"]
  ]);
});

test("removing on macOS boots the agent out and deletes its plist", async t => {
  capture(t);
  const userHome = path.join(home, "mac2");
  const plist = path.join(userHome, "Library", "LaunchAgents", "dev.jooservices.page-media-saver.plist");
  await mkdir(path.dirname(plist), { recursive: true });
  await writeFile(plist, "x");
  const calls = [];
  await service.removeService({
    platform: "darwin",
    home: userHome,
    run: async (command, args) => {
      calls.push([command, ...args]);
    }
  });
  assert.equal(await exists(plist), false);
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0][0], calls[0][1]], ["launchctl", "bootout"]);
  assert.equal(calls[0][3], plist);
});

test("removing on an unknown platform is an error", async () => {
  await assert.rejects(service.removeService({ platform: "plan9" }), /No sign-in service is defined for plan9/);
});

test("defaultRun resolves on exit code 0 and rejects with stderr, an exit code or a launch error", async () => {
  await service.defaultRun(process.execPath, ["-e", ""]);
  await assert.rejects(
    service.defaultRun(process.execPath, ["-e", "console.error('bad things'); process.exit(3)"]),
    /bad things/
  );
  await assert.rejects(service.defaultRun(process.execPath, ["-e", "process.exit(4)"]), /exited with code 4/);
  await assert.rejects(service.defaultRun(path.join(home, "no-such-program"), []), error => error.code === "ENOENT");
});

test("startQueue launches the script with `serve`, detached", async () => {
  // A stand-in script that records its arguments, so the real CLI is never started.
  const script = path.join(home, "record-args.mjs");
  const out = path.join(home, "args.json");
  await writeFile(
    script,
    `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`
  );
  service.startQueue({ executable: process.execPath, script });
  for (let i = 0; i < 100 && !(await exists(out)); i++) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.deepEqual(JSON.parse(await readFile(out, "utf8")), ["serve"]);
});
