// Records which browser profile has the extension loaded, so later commands open that profile.
import { existsSync } from "node:fs";
import { mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { browserLayout, BROWSER_IDS, chromiumExtensionId, firefoxExtensionId } from "./browsers.mjs";
import {
  EXTENSION_ROOT,
  APP_DIR,
  EDGE_PROFILE_FILE,
  BRIDGE_CONFIG_FILE,
  BRIDGE_PORT,
  writeJsonAtomic,
  readJson
} from "./store.mjs";

const EXTENSION_NAME = "Page Media Saver";
const PREFERENCE_FILES = ["Secure Preferences", "Preferences"];

function trimTrailingSeparators(value) {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "/" || value[end - 1] === "\\")) {
    end--;
  }
  return value.slice(0, end);
}

const comparablePath = value => trimTrailingSeparators(path.resolve(value)).toLowerCase();
const samePath = (left, right) => comparablePath(left) === comparablePath(right);
const isProfileDir = entry => entry.isDirectory() && (entry.name === "Default" || entry.name.startsWith("Profile "));

async function chromiumHit(layout, expectedPath) {
  const entries = await readdir(layout.userData, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter(isProfileDir)) {
    for (const file of PREFERENCE_FILES) {
      const preferences = await readJson(path.join(layout.userData, entry.name, file)).catch(() => null);
      const extensionId = chromiumExtensionId(preferences, expectedPath, samePath);
      if (extensionId) {
        return { extensionId, profileDirectory: entry.name, userData: layout.userData };
      }
    }
  }
  return null;
}

async function firefoxHit(layout, expectedPath) {
  const entries = await readdir(layout.userData, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.filter(item => item.isDirectory())) {
    const profilePath = path.join(layout.userData, entry.name);
    const extensions = await readJson(path.join(profilePath, "extensions.json")).catch(() => null);
    const extensionId = firefoxExtensionId(extensions, expectedPath, samePath);
    if (extensionId) {
      return { extensionId, profileDirectory: entry.name, profilePath, userData: layout.userData };
    }
  }
  return null;
}

export function browserChoice(name) {
  if (!name) {
    return BROWSER_IDS;
  }
  const id = String(name).toLowerCase();
  if (!BROWSER_IDS.includes(id)) {
    throw new Error("Choose a browser with: install, install edge, install chrome, or install firefox.");
  }
  return [id];
}

export async function installBridge(requested) {
  const extensionManifest = await readJson(path.join(EXTENSION_ROOT, "manifest.json"));
  if (extensionManifest?.name !== EXTENSION_NAME) {
    throw new Error(`Expected the ${EXTENSION_NAME} manifest in ${EXTENSION_ROOT}.`);
  }
  const layout = browserLayout(process.platform, process.env);
  const expectedPath = EXTENSION_ROOT;
  const wanted = browserChoice(requested);
  let loaded = null;
  for (const id of wanted) {
    const browser = layout[id];
    const hit = id === "firefox" ? await firefoxHit(browser, expectedPath) : await chromiumHit(browser, expectedPath);
    if (hit) {
      const executable = browser.executables.find(candidate => existsSync(candidate)) || null;
      loaded = { ...hit, browser: id, label: browser.label, executable, extensionsPage: browser.extensionsPage };
      break;
    }
  }
  if (!loaded) {
    const pages = wanted.map(id => layout[id].extensionsPage).join(", ");
    throw new Error(
      `${EXTENSION_NAME} is not loaded from this folder. Turn on developer mode, choose Load unpacked (or Load Temporary Add-on in Firefox) for this folder at ${pages}, then run install again.`
    );
  }

  await mkdir(APP_DIR, { recursive: true });
  const origin =
    loaded.browser === "firefox" ? `moz-extension://${loaded.extensionId}` : `chrome-extension://${loaded.extensionId}`;
  await writeJsonAtomic(BRIDGE_CONFIG_FILE, { extensionOrigin: origin, port: BRIDGE_PORT });
  await writeJsonAtomic(EDGE_PROFILE_FILE, {
    browser: loaded.browser,
    profileDirectory: loaded.profileDirectory,
    profilePath: loaded.profilePath || path.join(loaded.userData, loaded.profileDirectory),
    userData: loaded.userData,
    executable: loaded.executable
  });
  process.stdout.write(`Using ${loaded.label}, profile ${loaded.profileDirectory}.\n`);
  process.stdout.write(`Bridge: http://127.0.0.1:${BRIDGE_PORT}/message\n`);
  process.stdout.write(`If a download does not start, reload ${EXTENSION_NAME} at ${loaded.extensionsPage}.\n`);
}

export async function uninstallBridge() {
  await Promise.all([unlink(EDGE_PROFILE_FILE).catch(() => {}), unlink(BRIDGE_CONFIG_FILE).catch(() => {})]);
  process.stdout.write("Forgot which browser profile the CLI was using. Run install again before the next download.\n");
}
