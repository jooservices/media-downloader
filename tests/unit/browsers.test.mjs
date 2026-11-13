import assert from "node:assert/strict";
import test from "node:test";
import {
  browserLayout,
  chromiumExtensionId,
  firefoxAddonPath,
  firefoxExtensionId,
  CHROMIUM_FULL_SPEED_ARGS,
  launchArgs,
  resolvedProfile
} from "../../cli/browsers.mjs";

const winEnv = {
  LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
  APPDATA: "C:\\Users\\me\\AppData\\Roaming",
  ProgramFiles: "C:\\Program Files",
  "PROGRAMFILES(X86)": "C:\\Program Files (x86)"
};

test("Windows, macOS and Linux each get a real executable path for Edge, Chrome and Firefox", () => {
  const windows = browserLayout("win32", winEnv);
  assert.equal(windows.edge.executables[0], "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
  assert.equal(windows.chrome.userData, "C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\User Data");
  assert.match(windows.firefox.executables[0], /firefox\.exe$/);

  const mac = browserLayout("darwin", { HOME: "/Users/me" });
  assert.equal(mac.chrome.executables[0], "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  assert.equal(mac.chrome.userData, "/Users/me/Library/Application Support/Google/Chrome");
  assert.equal(mac.firefox.userData, "/Users/me/Library/Application Support/Firefox/Profiles");

  const linux = browserLayout("linux", { HOME: "/home/me" });
  assert.equal(linux.edge.executables[0], "/usr/bin/microsoft-edge");
  assert.equal(linux.chrome.userData, "/home/me/.config/google-chrome");
  assert.equal(linux.firefox.userData, "/home/me/.mozilla/firefox");
});

test("Chrome and Edge open a named profile; Firefox opens a profile folder", () => {
  assert.deepEqual(launchArgs("chrome", { profileDirectory: "Default" }, "https://www.instagram.com/a/"), [
    ...CHROMIUM_FULL_SPEED_ARGS,
    "--profile-directory=Default",
    "https://www.instagram.com/a/"
  ]);
  assert.ok(CHROMIUM_FULL_SPEED_ARGS.includes("--disable-background-timer-throttling"));
  assert.ok(!launchArgs("firefox", { profilePath: "/p" }, "https://x.com/").some(arg => arg.startsWith("--disable")));
  assert.deepEqual(launchArgs("firefox", { profilePath: "/home/me/.mozilla/firefox/abc" }, "https://x.com/a/"), [
    "-profile",
    "/home/me/.mozilla/firefox/abc",
    "-new-tab",
    "https://x.com/a/"
  ]);
});

test("the loaded extension is recognised in Chromium preferences and in a Firefox add-on list", () => {
  const same = (left, right) => left.toLowerCase() === right.toLowerCase();
  const folder = "C:\\Claude\\PageMediaSaver";
  assert.equal(chromiumExtensionId({ extensions: { settings: { abc: { path: folder } } } }, folder, same), "abc");
  assert.equal(firefoxExtensionId({ addons: [{ id: "page@media", path: folder }] }, folder, same), "page@media");
  assert.equal(firefoxAddonPath({ rootURI: "file:///C:/Claude/PageMediaSaver/" }), "C:/Claude/PageMediaSaver/");
});

test("an old Edge-only profile file still opens Edge", () => {
  const profile = resolvedProfile({ profileDirectory: "Default" }, "win32", winEnv);
  assert.equal(profile.browser, "edge");
  assert.equal(profile.label, "Edge");
  assert.equal(profile.userData, "C:\\Users\\me\\AppData\\Local\\Microsoft\\Edge\\User Data");
  assert.equal(profile.extensionsPage, "edge://extensions");
});
