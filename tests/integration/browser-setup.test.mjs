import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";

// Never the live queue's folder: a temp folder, set before the CLI is imported.
const home = await mkdtemp(path.join(os.tmpdir(), "pms-browser-"));
process.env.LOCALAPPDATA = home;
const store = await import("../../cli/store.mjs");
const browser = await import("../../cli/browser.mjs");

const FAKE = { id: "chrome", label: "Chrome", executable: path.join(home, "chrome-fake") };

after(() => rm(home, { recursive: true, force: true }));
beforeEach(() => store.removeAppData());

function capture(t) {
  const lines = [];
  const original = process.stdout.write;
  process.stdout.write = chunk => {
    lines.push(String(chunk));
    return true;
  };
  t.after(() => {
    process.stdout.write = original;
  });
  return lines;
}

test("extensionIdForKey makes a 32 letter id from a to p, the same for the same key", () => {
  const id = browser.extensionIdForKey(Buffer.from("some public key"));
  assert.match(id, /^[a-p]{32}$/);
  assert.equal(browser.extensionIdForKey(Buffer.from("some public key")), id);
  assert.notEqual(browser.extensionIdForKey(Buffer.from("another key")), id);
});

test("findBrowser prefers Chrome, then Edge, and says nothing when neither exists", () => {
  const env = { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" };
  assert.equal(browser.findBrowser("win32", env, file => /chrome\.exe$/.test(file)).id, "chrome");
  assert.equal(browser.findBrowser("win32", env, file => /msedge\.exe$/.test(file)).id, "edge");
  assert.equal(
    browser.findBrowser("win32", env, () => false),
    null
  );
  assert.equal(
    browser.findBrowser("linux", { HOME: "/home/u" }, file => file === "/usr/bin/google-chrome").id,
    "chrome"
  );
});

test("managedArgs loads only the managed extension and adds headless on request", () => {
  const args = browser.managedArgs({ userData: "/p", extension: "/e", headless: true });
  assert.ok(args.includes("--user-data-dir=/p"));
  assert.ok(args.includes("--load-extension=/e"));
  assert.ok(args.includes("--disable-extensions-except=/e"));
  assert.ok(args.includes("--headless=new"));
  assert.ok(!browser.managedArgs({ userData: "/p", extension: "/e", headless: false }).includes("--headless=new"));
});

test("setup copies the extension with a fixed key, records the profile and the bridge origin, and keeps the id on a second run", async () => {
  const dir = path.join(home, "managed-a");
  const first = await browser.setupManagedBrowser({ browser: FAKE, dir });
  assert.match(first.id, /^[a-p]{32}$/);
  const manifest = JSON.parse(await readFile(path.join(dir, "extension", "manifest.json"), "utf8"));
  assert.ok(manifest.key.length > 100);
  assert.equal(manifest.name, "Page Media Saver");
  assert.match(
    await readFile(path.join(dir, "extension", "src", "background", "bridge-client.js"), "utf8"),
    /127\.0\.0\.1:38541/
  );

  assert.deepEqual(await store.readJson(store.BRIDGE_CONFIG_FILE), {
    extensionOrigin: `chrome-extension://${first.id}`,
    port: store.BRIDGE_PORT
  });
  const profile = await store.readJson(store.EDGE_PROFILE_FILE);
  assert.equal(profile.browser, "chrome");
  assert.equal(profile.debugPort, browser.MANAGED_DEBUG_PORT);
  assert.equal(profile.executable, FAKE.executable);
  assert.ok(profile.extraArgs.includes("--headless=new"));

  const second = await browser.setupManagedBrowser({ browser: FAKE, dir, headless: false });
  assert.equal(second.id, first.id, "the id survives a second setup");
  assert.ok(!(await store.readJson(store.EDGE_PROFILE_FILE)).extraArgs.includes("--headless=new"));
});

test("prepareManagedExtension points the bridge at another port and refuses a changed bridge address", async () => {
  const target = path.join(home, "managed-b", "extension");
  await browser.prepareManagedExtension({ target, bridgePort: 40123, keyDir: path.join(home, "managed-b") });
  const client = await readFile(path.join(target, "src", "background", "bridge-client.js"), "utf8");
  assert.match(client, /127\.0\.0\.1:40123/);
  assert.doesNotMatch(client, /127\.0\.0\.1:38541/);

  const fakeSource = path.join(home, "fake-source");
  await mkdir(path.join(fakeSource, "lib"), { recursive: true });
  await mkdir(path.join(fakeSource, "src", "background"), { recursive: true });
  await writeFile(path.join(fakeSource, "src", "background", "bridge-client.js"), "const url = 'http://elsewhere';");
  await writeFile(path.join(fakeSource, "manifest.json"), "{}");
  await assert.rejects(
    browser.prepareManagedExtension({ target: path.join(home, "managed-c", "extension"), source: fakeSource }),
    /bridge address in the extension changed/
  );
});

test("setup without any browser says what to do", async () => {
  await assert.rejects(browser.setupManagedBrowser({ browser: null }), /No Chrome or Edge was found/);
});

test("login opens the managed profile with a window on every sign-in page; it needs setup first", async () => {
  await assert.rejects(browser.loginManagedBrowser(), /Run `browser setup` first/);
  await browser.setupManagedBrowser({ browser: FAKE, dir: path.join(home, "managed-d") });
  const launched = [];
  const spawnProcess = (executable, args, options) => {
    launched.push({ executable, args, options });
    return Object.assign(new EventEmitter(), { unref() {} });
  };
  const { pages } = await browser.loginManagedBrowser({ spawnProcess });
  assert.equal(launched[0].executable, FAKE.executable);
  assert.ok(!launched[0].args.includes("--headless=new"), "a window is needed to sign in");
  assert.ok(launched[0].args.includes("--load-extension=" + path.join(home, "managed-d", "extension")));
  assert.deepEqual(launched[0].args.slice(-pages.length), pages);
  assert.ok(pages.includes("https://www.instagram.com/accounts/login/"));
  assert.ok(pages.every(page => page.startsWith("https://")));
});

test("status says whether a managed browser is configured and whether it answers", async () => {
  assert.deepEqual(await browser.managedStatus(), { managed: false });
  await browser.setupManagedBrowser({ browser: FAKE, dir: path.join(home, "managed-e") });
  const up = await browser.managedStatus({ fetchImpl: async () => ({ ok: true }) });
  assert.equal(up.managed, true);
  assert.equal(up.running, true);
  assert.equal(up.debugPort, browser.MANAGED_DEBUG_PORT);
  const down = await browser.managedStatus({
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    }
  });
  assert.equal(down.running, false);
});

test("the browser command dispatches setup, login and status and rejects anything else", async t => {
  const lines = capture(t);
  await assert.rejects(browser.browserCommand([]), /Use: browser setup/);
  await assert.rejects(browser.browserCommand(["explode"]), /Use: browser setup/);
  await assert.rejects(browser.browserCommand(["login"]), /Run `browser setup` first/);
  await browser.browserCommand(["status"]);
  assert.match(lines.join(""), /"managed": false/);
});

test("PMS_BROWSER names the browser outright, and PMS_BROWSER_ARGS adds switches such as --no-sandbox", () => {
  const exists = file => file === "/usr/bin/chromium";
  const found = browser.findBrowser("linux", { HOME: "/home/u", PMS_BROWSER: "/usr/bin/chromium" }, exists);
  assert.deepEqual(found, { id: "chrome", label: "Chromium", executable: "/usr/bin/chromium" });
  assert.equal(
    browser.findBrowser("linux", { HOME: "/home/u", PMS_BROWSER: "/nope" }, exists),
    null,
    "a missing file is not used"
  );

  const args = browser.managedArgs({
    userData: "/p",
    extension: "/e",
    headless: true,
    env: { PMS_BROWSER_ARGS: "--no-sandbox   --disable-gpu" }
  });
  assert.deepEqual(args.slice(-2), ["--no-sandbox", "--disable-gpu"]);
  assert.ok(
    !browser.managedArgs({ userData: "/p", extension: "/e", headless: false, env: {} }).includes("--no-sandbox")
  );
});

test("setup tells the browser where to save, so the queue knows where to look", async () => {
  const dir = path.join(home, "managed-f");
  await browser.setupManagedBrowser({ browser: FAKE, dir });
  const preferences = JSON.parse(await readFile(path.join(dir, "profile", "Default", "Preferences"), "utf8"));
  assert.equal(preferences.download.default_directory, path.join(dir, "downloads"));
  assert.equal(preferences.download.prompt_for_download, false);
});
