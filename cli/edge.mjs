// Finds Edge, and records which Edge profile has the extension loaded.
import { existsSync } from "node:fs";
import { mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
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

export function edgeExecutable() {
  const candidates = [
    path.join(
      process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)",
      "Microsoft",
      "Edge",
      "Application",
      "msedge.exe"
    ),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe")
  ];
  return candidates.find(candidate => candidate && existsSync(candidate));
}

function trimTrailingSeparators(value) {
  let end = value.length;
  while (end > 0 && (value[end - 1] === "/" || value[end - 1] === "\\")) {
    end--;
  }
  return value.slice(0, end);
}

const comparablePath = value => trimTrailingSeparators(path.resolve(value)).toLowerCase();

const isEdgeProfile = entry => entry.isDirectory() && (entry.name === "Default" || entry.name.startsWith("Profile "));

// The id Edge gave the extension when it was loaded unpacked from `expectedPath`, if this profile has it.
async function findExtensionInProfile(profileDirectory, expectedPath) {
  for (const file of PREFERENCE_FILES) {
    let preferences;
    try {
      preferences = await readJson(path.join(profileDirectory, file));
    } catch {
      continue;
    }
    const settings = Object.entries(preferences?.extensions?.settings || {});
    const match = settings.find(
      ([, entry]) => typeof entry?.path === "string" && comparablePath(entry.path) === expectedPath
    );
    if (match) {
      return match[0];
    }
  }
  return null;
}

async function findLoadedExtension() {
  const edgeUserData = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data");
  const entries = await readdir(edgeUserData, { withFileTypes: true }).catch(() => []);
  const expectedPath = comparablePath(EXTENSION_ROOT);
  for (const entry of entries.filter(isEdgeProfile)) {
    const extensionId = await findExtensionInProfile(path.join(edgeUserData, entry.name), expectedPath);
    if (extensionId) {
      return { extensionId, profile: entry.name };
    }
  }
  return null;
}

export async function installBridge() {
  if (process.platform !== "win32") {
    throw new Error("Edge profile setup is currently supported on Windows only.");
  }
  const extensionManifest = await readJson(path.join(EXTENSION_ROOT, "manifest.json"));
  if (extensionManifest?.name !== EXTENSION_NAME) {
    throw new Error(`Expected the ${EXTENSION_NAME} manifest in ${EXTENSION_ROOT}.`);
  }
  const loaded = await findLoadedExtension();
  if (!loaded) {
    throw new Error(
      `${EXTENSION_NAME} is not loaded in an Edge profile from this folder. In edge://extensions choose Load unpacked for this folder, then run install again.`
    );
  }

  await mkdir(APP_DIR, { recursive: true });
  await writeJsonAtomic(BRIDGE_CONFIG_FILE, {
    extensionOrigin: `chrome-extension://${loaded.extensionId}`,
    port: BRIDGE_PORT
  });
  await writeJsonAtomic(EDGE_PROFILE_FILE, { profileDirectory: loaded.profile });
  process.stdout.write(`Installed the local CLI bridge for extension ${loaded.extensionId}.\n`);
  process.stdout.write(`Bridge endpoint: http://127.0.0.1:${BRIDGE_PORT}/message\n`);
  process.stdout.write(`Reload ${EXTENSION_NAME} in edge://extensions before using the CLI.\n`);
}

export async function uninstallBridge() {
  await Promise.all([unlink(EDGE_PROFILE_FILE).catch(() => {}), unlink(BRIDGE_CONFIG_FILE).catch(() => {})]);
  process.stdout.write("Removed the Page Media Saver CLI bridge configuration from Edge.\n");
}
