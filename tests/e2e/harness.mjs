// Everything an end-to-end test needs: a fake X site over HTTPS, a private Chromium profile with the
// real extension loaded, and the real `serve` process. Nothing here touches the user's own browser,
// folders or ports.
import { spawn, spawnSync } from "node:child_process";
import { prepareManagedExtension } from "../../cli/browser.mjs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const FIXTURES = path.join(ROOT, "tests", "e2e", "fixtures");
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

export async function waitFor(check, { timeoutMs = 60_000, everyMs = 500, what = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) {
      return value;
    }
    await sleep(everyMs);
  }
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}.`);
}

// Chromium-based browsers that can run the extension headless in a private profile, best first.
function browserCandidates() {
  const env = process.env;
  const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean);
  return [
    env.PMS_E2E_CHROMIUM,
    ...roots.flatMap(root => [
      path.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(root, "Google", "Chrome", "Application", "chrome.exe")
    ]),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/usr/bin/microsoft-edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  ].filter(Boolean);
}

function runs(executable) {
  if (!existsSync(executable)) {
    return false;
  }
  const result = spawnSync(executable, ["--version"], { encoding: "utf8", timeout: 20_000 });
  // Chrome-style browsers print nothing for --version on Windows; a broken install cannot even be started.
  return !result.error && result.status === 0;
}

// The browser the end-to-end tests drive: PMS_E2E_CHROMIUM, the Chromium that Playwright installed if it
// starts, or a Chromium-based browser already on this machine. Null when none works.
export async function chromiumPath() {
  const candidates = browserCandidates();
  try {
    const { chromium } = await import("playwright");
    candidates.splice(process.env.PMS_E2E_CHROMIUM ? 1 : 0, 0, chromium.executablePath());
  } catch {
    // Playwright is optional: any installed browser will do.
  }
  return candidates.find(runs) ?? null;
}

function crc32(buffer) {
  let value = ~0;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
  }
  return ~value >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  body.copy(out, 4);
  out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
}

// A real PNG of the given size; `label` makes every picture differ so duplicates are detectable.
export function makePng(width, height, label) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8-bit
  header[9] = 0; // grey
  const rows = Buffer.alloc((width + 1) * height);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("tEXt", Buffer.from(`label\0${label}`)),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

function profilePage(state) {
  const articles = state.posts
    .map(
      post =>
        `<article><a href="/${state.account}/status/${post.id}">post</a>` +
        `<img src="https://pbs.twimg.com/media/${post.media}?format=png&amp;name=small" width="600" height="600"></article>`
    )
    .join("\n");
  return `<!doctype html><title>${state.account}</title><body style="height:3000px">${articles}</body>`;
}

// An X profile page with one article per post, and the picture host. `state.posts` may change between runs.
export async function startFakeSites(state) {
  const server = createHttpsServer(
    {
      key: await readFile(path.join(FIXTURES, "test-key.pem")),
      cert: await readFile(path.join(FIXTURES, "test-cert.pem"))
    },
    async (request, response) => {
      const host = String(request.headers.host || "").split(":")[0];
      const url = new URL(request.url, `https://${host}`);
      state.requests.push(`${host}${url.pathname}`);
      for (const route of state.routes ?? []) {
        if (await route({ host, url, request, response })) {
          return;
        }
      }
      if (host === "pbs.twimg.com" && url.pathname.startsWith("/media/")) {
        response.writeHead(200, { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" });
        response.end(makePng(640, 480, url.pathname.slice("/media/".length)));
      } else if (url.pathname.toLowerCase().startsWith(`/${state.account.toLowerCase()}`)) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(profilePage(state));
      } else {
        response.writeHead(404);
        response.end();
      }
    }
  );
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { port: server.address().port, close: () => new Promise(resolve => server.close(resolve)) };
}

const DEFAULT_HOSTS = ["x.com", "www.x.com", "pbs.twimg.com"];

function browserArgs({ userData, extension, sitesPort, siteHosts = DEFAULT_HOSTS }) {
  const hosts = siteHosts.map(host => `MAP ${host} 127.0.0.1:${sitesPort}`).join(", ");
  return [
    `--user-data-dir=${userData}`,
    `--load-extension=${extension}`,
    `--disable-extensions-except=${extension}`,
    "--headless=new",
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    "--no-first-run",
    "--no-default-browser-check",
    "--ignore-certificate-errors",
    ...(process.env.CI ? ["--no-sandbox", "--disable-gpu"] : []),
    `--host-resolver-rules=${hosts}`
  ];
}

export async function createSandbox({ bridgePort, apiPort, sitesPort, executable, config = {}, siteHosts }) {
  const debugPort = await freePort();
  const root = await mkdtemp(path.join(os.tmpdir(), "pms-e2e-"));
  const localAppData = path.join(root, "localappdata");
  const appDir = path.join(localAppData, "PageMediaSaver");
  const userData = path.join(root, "profile");
  const downloads = path.join(root, "browser-downloads");
  const media = path.join(root, "media");
  const extension = path.join(root, "extension");
  for (const dir of [downloads, media, appDir, path.join(userData, "Default")]) {
    await mkdir(dir, { recursive: true });
  }
  // The browser saves into this folder (Chromium ignores environment variables for its Downloads folder).
  await writeFile(
    path.join(userData, "Default", "Preferences"),
    JSON.stringify({ download: { default_directory: downloads, prompt_for_download: false } })
  );
  const { id } = await prepareManagedExtension({ target: extension, bridgePort, keyDir: root });
  await writeFile(
    path.join(appDir, "bridge-config.json"),
    JSON.stringify({ extensionOrigin: `chrome-extension://${id}`, port: bridgePort })
  );
  await writeFile(
    path.join(appDir, "config.json"),
    JSON.stringify({ delaySeconds: { min: 0, max: 0 }, maxAttempts: 3, downloadDir: media, ...config })
  );
  await writeFile(
    path.join(appDir, "edge-profile.json"),
    JSON.stringify({
      browser: "chrome",
      profileDirectory: "Default",
      userData,
      executable,
      debugPort,
      extraArgs: browserArgs({ userData, extension, sitesPort, siteHosts })
    })
  );
  const env = {
    ...process.env,
    LOCALAPPDATA: localAppData,
    USERPROFILE: root,
    HOME: root,
    APPDATA: root,
    PMS_BRIDGE_PORT: String(bridgePort),
    PMS_API_PORT: String(apiPort)
  };
  return { root, env, appDir, userData, downloads, media, extension, debugPort };
}

export function startServe(sandbox) {
  const child = spawn(process.execPath, [path.join(ROOT, "cli", "mediasaver.mjs"), "serve"], {
    env: sandbox.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  const output = [];
  child.stdout.on("data", chunk => output.push(String(chunk)));
  child.stderr.on("data", chunk => output.push(String(chunk)));
  return { child, output };
}

const POWERSHELL = path.join(
  process.env.SystemRoot || "C:/Windows",
  "System32",
  "WindowsPowerShell",
  "v1.0",
  "powershell.exe"
);

// Ends only the browsers that use this sandbox's profile folder.
export function stopBrowsers(userData) {
  if (process.platform === "win32") {
    const needle = userData.replaceAll("'", "''");
    const script =
      `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' } | ` +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    spawnSync(POWERSHELL, ["-NoProfile", "-Command", script], { stdio: "ignore" });
  } else {
    spawnSync("/usr/bin/pkill", ["-f", userData], { stdio: "ignore" });
  }
}

export async function destroySandbox(sandbox, serve) {
  if (serve?.child && serve.child.exitCode === null) {
    serve.child.kill();
    await sleep(500);
  }
  stopBrowsers(sandbox.userData);
  await sleep(500);
  await rm(sandbox.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
}

export function apiClient(apiPort, token) {
  const base = `http://127.0.0.1:${apiPort}`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    health: () => fetch(`${base}/v1/health`).then(response => response.json()),
    jobs: () => fetch(`${base}/v1/jobs`, { headers }).then(response => response.json()),
    queue: async (url, again = false) => {
      const response = await fetch(`${base}/v1/jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ url, again })
      });
      return { status: response.status, body: await response.json() };
    },
    raw: (pathname, init) => fetch(`${base}${pathname}`, init)
  };
}

// A small MP4-looking file that differs per label (the browser only saves it; nothing plays it).
export function makeMp4(label) {
  const brand = Buffer.from("ftypisom");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(8 + 8 + 4 + String(label).length, 0);
  return Buffer.concat([header, brand, Buffer.alloc(4), Buffer.from(`mdat-${label}`)]);
}

export function sendJson(response, body) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

export function sendHtml(response, html) {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

// Serves a picture or a video for any path on a media host: the label is the path, so every file differs.
export function serveMedia(host, hostsSet) {
  return ({ host: requested, url, response }) => {
    if (!hostsSet.has(requested) || requested !== host) {
      return false;
    }
    const label = url.pathname;
    if (/[.]mp4$/.test(label)) {
      response.writeHead(200, { "Content-Type": "video/mp4", "Access-Control-Allow-Origin": "*" });
      response.end(makeMp4(label));
    } else {
      response.writeHead(200, { "Content-Type": "image/png", "Access-Control-Allow-Origin": "*" });
      response.end(makePng(640, 480, label));
    }
    return true;
  };
}

const FINISHED_STATES = new Set(["complete", "incomplete", "error", "paused"]);

export async function listFiles(directory) {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(directory, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries
    .filter(entry => entry.isFile())
    .map(entry => path.join(entry.parentPath ?? entry.path, entry.name))
    .sort();
}

// Everything one end-to-end file needs: fake sites, a private browser profile, the real queue and its API.
export async function startEnvironment(t, { routes, siteHosts, config } = {}) {
  const executable = await chromiumPath();
  const state = { account: "unused", posts: [], requests: [], routes };
  const sites = await startFakeSites(state);
  const [bridgePort, apiPort] = [await freePort(), await freePort()];
  const sandbox = await createSandbox({ bridgePort, apiPort, sitesPort: sites.port, executable, siteHosts, config });
  const serve = startServe(sandbox);
  t.after(async () => {
    await destroySandbox(sandbox, serve);
    await sites.close();
  });
  const token = await waitFor(
    async () => (await readFile(path.join(sandbox.appDir, "api-token"), "utf8").catch(() => "")).trim(),
    { what: "the API token", timeoutMs: 30_000 }
  );
  const api = apiClient(apiPort, token);
  await waitFor(() => api.health().catch(() => null), { what: "the API", timeoutMs: 30_000 });
  const diagnostics = () =>
    ["serve output:", serve.output.join(""), "site requests:", ...state.requests].join(String.fromCharCode(10));
  async function runJob(url, again = false, timeoutMs = 600_000) {
    const queued = await api.queue(url, again);
    if (queued.status !== 201) {
      throw new Error(`${url} was not queued: ${JSON.stringify(queued.body)}`);
    }
    const ids = queued.body.items.map(item => item.id);
    const finished = await waitFor(
      async () => {
        const jobs = (await api.jobs()).items.filter(item => ids.includes(item.id));
        return jobs.length === ids.length && jobs.every(job => FINISHED_STATES.has(job.status)) ? jobs : null;
      },
      { what: `${url} to finish`, timeoutMs, everyMs: 1000 }
    ).catch(error => {
      throw new Error([error.message, diagnostics()].join(String.fromCharCode(10)), { cause: error });
    });
    return finished;
  }
  return { api, sandbox, state, runJob, diagnostics, executable };
}
