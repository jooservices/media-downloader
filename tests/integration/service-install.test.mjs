import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { installService, launchdPlist, systemdUnit, windowsStartupScript } from "../../cli/service.mjs";

test("sign-in startup is a logon task on Windows and a user service on Linux and macOS", async () => {
  const launch = {
    executable: "C:\\Program Files\\nodejs\\node.exe",
    script: "C:\\Claude\\media-downloader\\cli\\mediasaver.mjs"
  };
  assert.match(windowsStartupScript(launch), /Wscript\.Shell/);
  assert.match(windowsStartupScript(launch), /mediasaver\.mjs"" serve/);
  const home = await mkdtemp(path.join(os.homedir(), ".pms-service-test-"));
  const calls = [];
  try {
    await installService({
      platform: "linux",
      home,
      launch: { executable: "/usr/bin/node", script: "/opt/media-downloader/cli/mediasaver.mjs" },
      run: async (command, args) => {
        calls.push([command, args]);
      }
    });
    const unit = await readFile(path.join(home, ".config", "systemd", "user", "page-media-saver.service"), "utf8");
    assert.match(unit, /ExecStart="\/usr\/bin\/node"/);
    assert.deepEqual(calls[1], ["systemctl", ["--user", "enable", "--now", "page-media-saver.service"]]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  assert.match(systemdUnit(launch), /ExecStart=/);
  assert.match(launchdPlist({ executable: "/usr/bin/node", script: "/opt/a&b.mjs" }), /a&amp;b\.mjs/);
});
