import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENTRY = path.join(ROOT, "cli", "mediasaver.mjs");

function edgeUserData(home) {
  if (process.platform === "win32") {
    return path.join(home, "Microsoft", "Edge", "User Data");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Microsoft Edge");
  }
  return path.join(home, ".config", "microsoft-edge");
}

// A home folder with a browser profile that has this checkout loaded as an unpacked extension.
async function fakeHome({ browser = "edge", loaded = true } = {}) {
  const home = await mkdtemp(path.join(os.tmpdir(), "pms-edge-"));
  const env = { ...process.env, LOCALAPPDATA: home, USERPROFILE: home, HOME: home, APPDATA: home };
  const userData = edgeUserData(home);
  if (loaded && browser === "edge") {
    await mkdir(path.join(userData, "Default"), { recursive: true });
    const settings = { abcdefabcdefabcdefabcdefabcdefab: { path: ROOT } };
    await writeFile(path.join(userData, "Default", "Preferences"), JSON.stringify({ extensions: { settings } }));
  }
  return { home, env, userData };
}

function run(env, ...args) {
  return spawnSync(process.execPath, [ENTRY, ...args], { env, encoding: "utf8", timeout: 20000 });
}

test("help and no arguments print the usage", () => {
  const { env } = { env: { ...process.env, LOCALAPPDATA: os.tmpdir() } };
  assert.match(run(env, "help").stdout, /Page Media Saver/);
  assert.match(run(env).stdout, /install \[edge\|chrome\|firefox\]/);
});

test("an unknown command fails with the usage", () => {
  const result = run({ ...process.env, LOCALAPPDATA: os.tmpdir() }, "frobnicate");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unknown command: frobnicate/);
});

test("install records the browser profile and the extension origin; uninstall forgets the profile", async () => {
  const { home, env } = await fakeHome();
  try {
    const installed = run(env, "install", "edge");
    assert.equal(installed.status, 0, installed.stderr);
    assert.match(installed.stdout, /Using Edge, profile Default/);
    const app = path.join(home, "PageMediaSaver");
    const bridge = JSON.parse(await readFile(path.join(app, "bridge-config.json"), "utf8"));
    assert.equal(bridge.extensionOrigin, "chrome-extension://abcdefabcdefabcdefabcdefabcdefab");
    const profile = JSON.parse(await readFile(path.join(app, "edge-profile.json"), "utf8"));
    assert.equal(profile.browser, "edge");
    assert.equal(profile.profileDirectory, "Default");
    const removed = run(env, "uninstall");
    assert.equal(removed.status, 0);
    await assert.rejects(readFile(path.join(app, "edge-profile.json")));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("install explains what to do when the extension is not loaded, and rejects an unknown browser", async () => {
  const { home, env } = await fakeHome({ loaded: false });
  try {
    const missing = run(env, "install", "edge");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /is not loaded from this folder/);
    const unknown = run(env, "install", "netscape");
    assert.equal(unknown.status, 1);
    assert.match(unknown.stderr, /Choose a browser/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("download without a link, and a bare https link, both reach the download command", async () => {
  const { home, env } = await fakeHome({ loaded: false });
  try {
    const none = run(env, "download");
    assert.equal(none.status, 1);
    assert.match(none.stderr, /Add a profile link/);
    const bare = run(env, "https://www.instagram.com/someone/");
    assert.equal(bare.status, 1);
    assert.match(bare.stderr, /install/i);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("add queues a link without a running queue and says how to start it; service rejects odd arguments", async () => {
  const { home, env } = await fakeHome({ loaded: false });
  try {
    const added = run(env, "add", "https://www.instagram.com/someone/");
    assert.equal(added.status, 0, added.stderr);
    assert.match(added.stdout, /Queued Instagram\/someone/);
    assert.match(added.stdout, /Nothing is processing the queue yet/);
    const odd = run(env, "service", "explode");
    assert.equal(odd.status, 1);
    assert.match(odd.stderr, /service install/);
    const watchAdd = run(env, "watch", "add");
    assert.equal(watchAdd.status, 1);
    assert.match(watchAdd.stderr, /at least one profile URL/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
