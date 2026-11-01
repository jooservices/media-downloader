// The loopback server the extension talks to while a job runs.
import { createServer } from "node:http";
import { unlink } from "node:fs/promises";
import {
  QUEUE_FILE,
  BRIDGE_CONFIG_FILE,
  BRIDGE_PORT,
  TERMINAL_STATES,
  normalizeProfileUrl,
  writeJsonAtomic,
  readJson,
  jobFile,
  isJobId
} from "./store.mjs";

const MAX_BODY_BYTES = 1_000_000;
const JOB_UPDATES = new Set(["JOB_PROGRESS", "JOB_DONE", "JOB_ERROR"]);
const PROGRESS_COUNTERS = ["started", "skipped", "videoStarted", "videoSkipped", "failed", "pending", "rounds"];

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
      respondJson(response, 200, await operation, { "Cache-Control": "no-store" });
    } catch (error) {
      respondJson(response, 500, { ok: false, error: error?.message || String(error) });
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

// Does the page that announced itself belong to this job?
function pageMatchesJob(message, job) {
  const sameUrl = normalizeProfileUrl(message.pageUrl || "").url === normalizeProfileUrl(job.url).url;
  const sameAccount = job.mediaPage || message.account?.toLowerCase() === job.account.toLowerCase();
  return sameUrl && message.platform === job.platform && sameAccount;
}

async function handlePageReady(message, claimedJobs) {
  if (!Number.isInteger(message.tabId)) {
    return { ok: false, error: "The Edge tab could not be identified." };
  }
  const queue = await readJson(QUEUE_FILE);
  const job = queue?.jobId ? await readJson(jobFile(queue.jobId)) : null;
  if (!job || TERMINAL_STATES.has(job.status) || !pageMatchesJob(message, job)) {
    return { ok: true, type: "NO_JOB" };
  }
  if (claimedJobs.has(job.jobId)) {
    return { ok: true, type: "JOB_CONNECTED" };
  }
  claimedJobs.add(job.jobId);
  if (job.mediaPage) {
    job.account = String(message.account || job.account);
  }
  job.status = "running";
  job.message = job.mediaPage
    ? "Edge acknowledged the media post; checking its platform download control."
    : "Edge acknowledged the profile page; scanning and downloading.";
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(jobFile(job.jobId), job);
  return { ok: true, type: "START_JOB", tabId: message.tabId, job };
}

function applyProgress(job, message) {
  const state = message.state || {};
  for (const key of PROGRESS_COUNTERS) {
    job[key] = Number(state[key] || 0);
  }
  job.message = String(state.message || "Scanning profile grid.").slice(0, 500);
  if (job.mediaPage && state.account) {
    job.account = String(state.account);
  }
  if (Array.isArray(state.repairFound)) {
    job.repairFound = state.repairFound;
  }
  if (Array.isArray(state.repairFiles)) {
    job.repairFiles = state.repairFiles;
  }
  if (message.type === "JOB_DONE") {
    job.status = TERMINAL_STATES.has(state.status) ? state.status : "incomplete";
  } else {
    job.status = "running";
  }
}

async function handleJobUpdate(message) {
  const jobId = message?.jobId || message?.state?.jobId;
  if (!jobId || !JOB_UPDATES.has(message?.type)) {
    return { ok: false, error: "Unsupported bridge message." };
  }
  if (!isJobId(jobId)) {
    return { ok: false, error: "Invalid job id." };
  }
  const filePath = jobFile(jobId);
  const job = await readJson(filePath);
  if (!job) {
    return { ok: false, error: "The CLI job no longer exists." };
  }
  if (message.type === "JOB_ERROR") {
    job.status = "error";
    job.message = String(message.error || "The page scan could not start.").slice(0, 500);
  } else {
    applyProgress(job, message);
  }
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(filePath, job);
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
