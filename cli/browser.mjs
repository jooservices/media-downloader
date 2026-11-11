// `browser setup | login | status`: a browser profile that belongs to the queue, so it can run 24/7 on a
// machine without anyone's desktop session. The profile gets its own copy of the extension (with a fixed key,
// so the extension id and the bridge origin never change) and one sign-in per site, done once with `browser login`.
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { browserLayout } from "./browsers.mjs";
import {
  APP_DIR,
  BRIDGE_CONFIG_FILE,
  BRIDGE_PORT,
  EDGE_PROFILE_FILE,
  EXTENSION_ROOT,
  readJson,
  writeJsonAtomic
} from "./store.mjs";

const require = createRequire(import.meta.url);
const sites = require("../lib/sites.js");

export const MANAGED_DIR = path.join(APP_DIR, "managed");
export const MANAGED_DEBUG_PORT = 38543;
const DEFAULT_BRIDGE_ADDRESS = "127.0.0.1:38541";
const KEY_FILE = "extension-key.json";

async function copyTree(from, to) {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    await (entry.isDirectory() ? copyTree(source, target) : copyFile(source, target));
  }
}

// Chromium derives an unpacked extension's id from its public key: sha256, first 16 bytes, as letters a to p.
export function extensionIdForKey(publicKeyDer) {
  const hash = createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 32);
  return [...hash].map(char => String.fromCodePoint(97 + Number.parseInt(char, 16))).join("");
}

// The key is made once and kept, so reinstalling the copy never changes the extension id.
async function stableKey(directory) {
  const file = path.join(directory, KEY_FILE);
  const saved = await readJson(file);
  if (saved?.publicKey) {
    return Buffer.from(saved.publicKey, "base64");
  }
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const der = publicKey.export({ type: "spki", format: "der" });
  await mkdir(directory, { recursive: true });
  await writeFile(file, JSON.stringify({ publicKey: der.toString("base64") }));
  return der;
}

// Copies the extension to `target`, adds the fixed key, and points its bridge at `bridgePort`.
export async function prepareManagedExtension({ target, bridgePort = BRIDGE_PORT, source = EXTENSION_ROOT, keyDir }) {
  for (const item of ["lib", "src"]) {
    await copyTree(path.join(source, item), path.join(target, item));
  }
  const clientFile = path.join(target, "src", "background", "bridge-client.js");
  const client = await readFile(clientFile, "utf8");
  if (!client.includes(DEFAULT_BRIDGE_ADDRESS)) {
    throw new Error("The bridge address in the extension changed; update cli/browser.mjs.");
  }
  await writeFile(clientFile, client.replace(DEFAULT_BRIDGE_ADDRESS, `127.0.0.1:${bridgePort}`));
  const der = await stableKey(keyDir ?? path.dirname(target));
  const manifest = JSON.parse(await readFile(path.join(source, "manifest.json"), "utf8"));
  manifest.key = der.toString("base64");
  await writeFile(path.join(target, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { id: extensionIdForKey(der) };
}

// The first browser on this machine that can run an unpacked extension in a private profile.
export function findBrowser(platform = process.platform, env = process.env, exists = existsSync) {
  // PMS_BROWSER names the executable outright (a Chromium installed by a container image, for example).
  if (env.PMS_BROWSER && exists(env.PMS_BROWSER)) {
    return { id: "chrome", label: "Chromium", executable: env.PMS_BROWSER };
  }
  const layout = browserLayout(platform, env);
  for (const id of ["chrome", "edge"]) {
    const found = layout[id].executables.find(candidate => exists(candidate));
    if (found) {
      return { id, label: layout[id].label, executable: found };
    }
  }
  return null;
}

// PMS_BROWSER_ARGS adds switches the machine needs, such as --no-sandbox inside a container.
export function managedArgs({ userData, extension, headless, env = process.env }) {
  return [
    `--user-data-dir=${userData}`,
    `--load-extension=${extension}`,
    `--disable-extensions-except=${extension}`,
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
    ...(headless ? ["--headless=new"] : []),
    ...String(env.PMS_BROWSER_ARGS || "")
      .split(/ +/)
      .filter(Boolean)
  ];
}

// Writes the profile, the extension copy and the bridge/profile settings the queue reads.
export async function setupManagedBrowser({ browser = findBrowser(), dir = MANAGED_DIR, headless = true } = {}) {
  if (!browser) {
    throw new Error("No Chrome or Edge was found. Install one of them, then run `browser setup` again.");
  }
  const userData = path.join(dir, "profile");
  const extension = path.join(dir, "extension");
  await mkdir(userData, { recursive: true });
  // Where the browser saves files before the queue moves them to the download folder.
  const downloads = path.join(dir, "downloads");
  await mkdir(path.join(userData, "Default"), { recursive: true });
  await writeFile(
    path.join(userData, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } })
  );
  const { id } = await prepareManagedExtension({ target: extension, keyDir: dir });
  await writeJsonAtomic(BRIDGE_CONFIG_FILE, { extensionOrigin: `chrome-extension://${id}`, port: BRIDGE_PORT });
  await writeJsonAtomic(EDGE_PROFILE_FILE, {
    browser: browser.id,
    profileDirectory: "Default",
    userData,
    executable: browser.executable,
    debugPort: MANAGED_DEBUG_PORT,
    extraArgs: managedArgs({ userData, extension, headless })
  });
  return { id, userData, extension, browser };
}

// Opens the managed profile with a window, on each site's sign-in page, so the user can sign in once.
export async function loginManagedBrowser({ spawnProcess = spawn } = {}) {
  const saved = await readJson(EDGE_PROFILE_FILE);
  if (!saved?.debugPort || !Array.isArray(saved.extraArgs)) {
    throw new Error("Run `browser setup` first.");
  }
  const args = saved.extraArgs.filter(arg => arg !== "--headless=new");
  const pages = sites.list().map(site => site.signInUrl);
  const child = spawnProcess(saved.executable, [...args, ...pages], { detached: true, stdio: "ignore" });
  child.unref();
  return { pages };
}

export async function stopManagedBrowser({
  fetchImpl = fetch,
  webSocketFactory = address => new WebSocket(address)
} = {}) {
  const saved = await readJson(EDGE_PROFILE_FILE);
  if (!saved?.debugPort) {
    throw new Error("Run `browser setup` first.");
  }
  const endpoint = `http://127.0.0.1:${saved.debugPort}/json/version`;
  let version;
  try {
    const response = await fetchImpl(endpoint);
    if (!response.ok) {
      return false;
    }
    version = await response.json();
  } catch {
    return false;
  }

  await new Promise((resolve, reject) => {
    const socket = webSocketFactory(version.webSocketDebuggerUrl);
    let settled = false;
    const timer = setTimeout(() => finish(new Error("The managed browser did not close.")), 10_000);
    const finish = error => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.close();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    socket.addEventListener("error", () => finish(new Error("Could not talk to the managed browser.")));
    socket.addEventListener("close", () => finish());
    socket.addEventListener("message", event => {
      const reply = JSON.parse(String(event.data));
      if (reply.id === 1) {
        finish(reply.error ? new Error(`The managed browser refused to close: ${reply.error.message}`) : null);
      }
    });
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Browser.close" }));
    });
  });

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if (!(await fetchImpl(endpoint)).ok) {
        return true;
      }
    } catch {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error("The managed browser did not release its profile.");
}

export async function managedStatus({ fetchImpl = fetch } = {}) {
  const saved = await readJson(EDGE_PROFILE_FILE);
  if (!saved?.debugPort) {
    return { managed: false };
  }
  const running = await fetchImpl(`http://127.0.0.1:${saved.debugPort}/json/version`).then(
    response => response.ok,
    () => false
  );
  return { managed: true, running, executable: saved.executable, userData: saved.userData, debugPort: saved.debugPort };
}

export async function browserCommand(args) {
  const [action, ...rest] = args;
  if (action === "setup") {
    const result = await setupManagedBrowser({ headless: !rest.includes("--headed") });
    process.stdout.write(
      `Managed browser ready (${result.browser.label}).\nProfile: ${result.userData}\nNext: node cli/mediasaver.mjs browser login   (sign in to each site once)\n`
    );
  } else if (action === "login") {
    const { pages } = await loginManagedBrowser();
    process.stdout.write(`Opened the managed browser. Sign in to the sites, then close it:\n  ${pages.join("\n  ")}\n`);
  } else if (action === "status") {
    process.stdout.write(`${JSON.stringify(await managedStatus(), null, 2)}\n`);
  } else if (action === "stop") {
    const stopped = await stopManagedBrowser();
    process.stdout.write(
      stopped ? "Managed browser stopped; profile released.\n" : "Managed browser is not running.\n"
    );
  } else {
    throw new Error("Use: browser setup [--headed]   |   browser login   |   browser status   |   browser stop");
  }
}
