// Finds Edge, and records which Edge profile has the extension loaded.
import { existsSync } from "node:fs";
import { mkdir, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import { EXTENSION_ROOT, APP_DIR, EDGE_PROFILE_FILE, BRIDGE_CONFIG_FILE, BRIDGE_PORT, writeJsonAtomic, readJson } from "./store.mjs";

export function edgeExecutable() {
  const candidates = [
    path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.ProgramFiles || "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe")
  ];
  return candidates.find(candidate => candidate && existsSync(candidate));
}

export async function installBridge() {
  if (process.platform !== "win32") throw new Error("Edge profile setup is currently supported on Windows only.");
  const edgeUserData = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data");
  const profiles = await readdir(edgeUserData, { withFileTypes: true }).catch(() => []);
  const expectedPath = path.resolve(EXTENSION_ROOT).replace(/[\\/]+$/, "").toLowerCase();
  const extensionManifest = await readJson(path.join(EXTENSION_ROOT, "manifest.json"));
  if (extensionManifest?.name !== "Page Media Saver") {
    throw new Error(`Expected the Page Media Saver manifest in ${EXTENSION_ROOT}.`);
  }
  let extensionId = null;
  let extensionProfile = null;
  for (const profile of profiles) {
    if (!profile.isDirectory() || !(profile.name === "Default" || profile.name.startsWith("Profile "))) continue;
    for (const preferencesFile of ["Secure Preferences", "Preferences"]) {
      let preferences;
      try {
        preferences = await readJson(path.join(edgeUserData, profile.name, preferencesFile));
      } catch {
        continue;
      }
      const settings = preferences?.extensions?.settings || {};
      for (const [id, entry] of Object.entries(settings)) {
        const loadedPath = typeof entry?.path === "string"
          ? path.resolve(entry.path).replace(/[\\/]+$/, "").toLowerCase()
          : "";
        if (loadedPath === expectedPath) {
          extensionId = id;
          extensionProfile = profile.name;
          break;
        }
      }
      if (extensionId) break;
    }
    if (extensionId) break;
  }
  if (!extensionId) {
    throw new Error("Page Media Saver is not loaded in an Edge profile from this folder. In edge://extensions choose Load unpacked for this folder, then run install again.");
  }

  await mkdir(APP_DIR, { recursive: true });
  await writeJsonAtomic(BRIDGE_CONFIG_FILE, {
    extensionOrigin: `chrome-extension://${extensionId}`,
    port: BRIDGE_PORT
  });
  await writeJsonAtomic(EDGE_PROFILE_FILE, { profileDirectory: extensionProfile });
  process.stdout.write(`Installed the local CLI bridge for extension ${extensionId}.\n`);
  process.stdout.write(`Bridge endpoint: http://127.0.0.1:${BRIDGE_PORT}/message\n`);
  process.stdout.write("Reload Page Media Saver in edge://extensions before using the CLI.\n");
}

export async function uninstallBridge() {
  await Promise.all([
    unlink(EDGE_PROFILE_FILE).catch(() => {}),
    unlink(BRIDGE_CONFIG_FILE).catch(() => {})
  ]);
  process.stdout.write("Removed the Page Media Saver CLI bridge configuration from Edge.\n");
}
