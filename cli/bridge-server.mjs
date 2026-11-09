// The loopback server the extension talks to while a job runs.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { readFile, unlink } from "node:fs/promises";
import {
  EXPECTED_VERSION_FILE,
  QUEUE_FILE,
  BRIDGE_CONFIG_FILE,
  BRIDGE_PORT,
  TERMINAL_STATES,
  normalizeProfileUrl,
  readJson,
  matchingJobs,
  updateJob,
  isJobId,
  isSignInPage,
  readJob
} from "./store.mjs";

const MAX_BODY_BYTES = 1_000_000;
const MAX_CLAIMED_JOBS = 500;
const JOB_UPDATES = new Set(["JOB_PROGRESS", "JOB_DONE", "JOB_ERROR"]);
const require = createRequire(import.meta.url);
const { applyProgress, applyError } = require("../lib/job-progress.js");

function respondJson(response, status, body, extraHeaders = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...extraHeaders });
  response.end(JSON.stringify(body));
}

// Only the installed extension, talking to exactly this loopback address, is let in.
function isTrustedRequest(request, config) {
  return request.headers.host === `127.0.0.1:${BRIDGE_PORT}` && request.headers.origin === config.extensionOrigin;
}

function setCorsHeaders(response, origin) {
  response.setHeader("Access-Control-Allow-Origin", origin);
  response.setHeader("Vary", "Origin");
  response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Private-Network", "true");
}

function readBody(request, response) {
  return new Promise(resolve => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        request.destroy(new Error("Request too large."));
      }
    });
    request.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(413);
      }
      response.end();
      resolve(null);
    });
    request.on("end", () => resolve(body));
  });
}

// `sync-edge` leaves the version it just copied in a file. An extension that reports another version (or none)
// is told to reload; the file goes away as soon as an extension reports the expected version.
// The newest extension version that reported in, so `/v1/status` can say what the browser is really running.
let lastExtension = null;
export const extensionSeen = () => lastExtension;
export function resetExtensionSeen() {
  lastExtension = null;
}

async function outdatedExtension(message) {
  let expected;
  try {
    expected = (await readFile(EXPECTED_VERSION_FILE, "utf8")).trim();
  } catch {
    return false;
  }
  if (!expected) {
    return false;
  }
  if (message?.version === expected) {
    await unlink(EXPECTED_VERSION_FILE).catch(() => {});
    return false;
  }
  return true;
}

function createBridgeServer(config) {
  const claimedJobs = new Set();
  let bridgeMessageQueue = Promise.resolve();

  async function handleMessageRequest(request, response) {
    const body = await readBody(request, response);
    if (body === null) {
      return;
    }
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      respondJson(response, 400, { ok: false, error: "Invalid JSON." });
      return;
    }
    try {
      const operation = bridgeMessageQueue.then(() => handleBridgeMessage(message, claimedJobs));
      bridgeMessageQueue = operation.then(
        () => undefined,
        () => undefined
      );
      lastExtension = {
        version: message?.version ? String(message.version).slice(0, 32) : null,
        at: new Date().toISOString()
      };
      const result = await operation;
      respondJson(response, 200, (await outdatedExtension(message)) ? { ...result, reload: true } : result, {
        "Cache-Control": "no-store"
      });
    } catch (error) {
      // The detail stays in this process's log; the caller only learns that the message failed.
      console.error(`Bridge message failed: ${error?.message || String(error)}`);
      respondJson(response, 500, { ok: false, error: "The CLI could not handle this message." });
    }
  }

  return createServer((request, response) => {
    if (!isTrustedRequest(request, config)) {
      respondJson(response, 403, { ok: false, error: "Origin or host rejected." });
      return;
    }
    setCorsHeaders(response, config.extensionOrigin);
    if (request.method === "OPTIONS") {
      response.writeHead(204);
      response.end();
    } else if (request.method === "POST" && request.url === "/message") {
      handleMessageRequest(request, response);
    } else {
      respondJson(response, 404, { ok: false, error: "Not found." });
    }
  });
}

export async function startBridgeServer() {
  const config = await readJson(BRIDGE_CONFIG_FILE);
  if (!config?.extensionOrigin || config.port !== BRIDGE_PORT) {
    throw new Error("The local CLI bridge is not configured. Run `node cli/mediasaver.mjs install` first.");
  }
  const server = createBridgeServer(config);
  return new Promise((resolve, reject) => {
    server.once("error", error => {
      if (error?.code === "EADDRINUSE") {
        reject(
          new Error(
            `CLI bridge port ${BRIDGE_PORT} is already in use. Close the other Page Media Saver CLI process, then resume the job.`
          )
        );
      } else {
        reject(error);
      }
    });
    server.listen(BRIDGE_PORT, "127.0.0.1", () => resolve(server));
  });
}

// A claim lasts for one opening of the job. When the queue retries a job it opens it again with a new
// `openedAt`, so the new attempt can be claimed; a second tab for the same opening still cannot.
const claimKey = job => `${job.jobId}|${job.openedAt || ""}`;

// Does the page that announced itself belong to this job?
function pageMatchesJob(message, job) {
  let sameUrl;
  try {
    sameUrl = normalizeProfileUrl(message.pageUrl || "").url === normalizeProfileUrl(job.url).url;
  } catch {
    return false; // a page the CLI does not scan (an opened post, a sign-in page) matches no job
  }
  const sameAccount = job.mediaPage || message.account?.toLowerCase() === job.account.toLowerCase();
  return sameUrl && message.platform === job.platform && sameAccount;
}

const CLOSE_TAB = { ok: true, type: "NO_JOB", close: true };

// A tab the CLI opened names its job in the URL. Say whether that tab is still useful; when it is
// not (its job is gone or finished, the site wants a sign-in, it landed on the wrong page, or another
// tab already runs the job) the extension closes it so tabs never pile up.
async function judgeTaggedTab(message) {
  const tagged = isJobId(message.cliJobId) ? await readJob(message.cliJobId) : null;
  if (!tagged || TERMINAL_STATES.has(tagged.status)) {
    return CLOSE_TAB;
  }
  if (isSignInPage(message.pageUrl)) {
    await updateJob(tagged.jobId, job => {
      job.status = "error";
      job.needsLogin = true;
      job.message = `${job.platform} asked to sign in. Sign in with Edge's profile; the queue continues by itself.`;
    });
    return CLOSE_TAB;
  }
  // The tab that runs the job moves between pages while it scans (Instagram opens each post), so
  // only a tab that has not started the job is judged by the page it shows.
  if (tagged.status === "running" && tagged.tabId === message.tabId) {
    return null;
  }
  const duplicate = tagged.status === "running" && tagged.tabId && tagged.tabId !== message.tabId;
  return duplicate || !pageMatchesJob(message, tagged) ? CLOSE_TAB : null;
}

// Several jobs can be waiting at once (one per worker), so the page is matched against all of them.
// The oldest waiting job for this page starts; a page that reloads while its job runs just reconnects.
async function handlePageReady(message, claimedJobs) {
  if (!Number.isInteger(message.tabId)) {
    return { ok: false, error: "The Edge tab could not be identified." };
  }
  if (message.cliJobId) {
    const verdict = await judgeTaggedTab(message);
    if (verdict) {
      return verdict;
    }
  }
  let pageUrl = message.pageUrl || "";
  try {
    pageUrl = normalizeProfileUrl(pageUrl).url;
  } catch {
    // The store's exact-URL candidate for a media post is only an accelerator; pageMatchesJob rejects bad URLs.
  }
  const matching = (await matchingJobs(message.platform, message.account || "", pageUrl))
    .filter(job => !TERMINAL_STATES.has(job.status) && pageMatchesJob(message, job))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const waiting = matching.find(job => job.status === "queued" && !claimedJobs.has(claimKey(job)));
  if (!waiting) {
    return { ok: true, type: matching.length ? "JOB_CONNECTED" : "NO_JOB" };
  }
  claimedJobs.add(claimKey(waiting));
  while (claimedJobs.size > MAX_CLAIMED_JOBS) {
    claimedJobs.delete(claimedJobs.values().next().value);
  }
  const started = await updateJob(waiting.jobId, job => {
    if (job.mediaPage) {
      job.account = String(message.account || job.account);
    }
    job.status = "running";
    job.tabId = message.tabId;
    job.message = job.mediaPage
      ? "Edge acknowledged the media post; checking its platform download control."
      : "Edge acknowledged the profile page; scanning and downloading.";
  });
  return { ok: true, type: "START_JOB", tabId: message.tabId, job: started };
}

async function handleJobUpdate(message) {
  const jobId = message?.jobId || message?.state?.jobId;
  if (!jobId || !JOB_UPDATES.has(message?.type)) {
    return { ok: false, error: "Unsupported bridge message." };
  }
  if (!isJobId(jobId)) {
    return { ok: false, error: "Invalid job id." };
  }
  // A job that was cancelled, finished or removed must not keep a scan running in its tab: tell the page to stop.
  if (message.type === "JOB_PROGRESS") {
    const known = await readJob(jobId);
    if (!known || TERMINAL_STATES.has(known.status)) {
      return { ok: true, type: "STOP_JOB", close: true };
    }
  }
  const job = await updateJob(jobId, current => {
    if (message.type === "JOB_ERROR") {
      applyError(current, message.error);
    } else {
      applyProgress(current, message);
      if (message.type === "JOB_PROGRESS") {
        current.lastProgressAt = new Date().toISOString();
      }
    }
  });
  if (!job) {
    return { ok: false, error: "The CLI job no longer exists." };
  }
  if (TERMINAL_STATES.has(job.status)) {
    const queue = await readJson(QUEUE_FILE);
    if (queue?.jobId === jobId) {
      await unlink(QUEUE_FILE).catch(() => {});
    }
  }
  return { ok: true, type: "ACK" };
}

export function handleBridgeMessage(message, claimedJobs) {
  return message?.type === "PAGE_READY" ? handlePageReady(message, claimedJobs) : handleJobUpdate(message);
}
