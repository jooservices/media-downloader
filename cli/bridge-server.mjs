// The loopback server the extension talks to while a job runs.
import { createServer } from "node:http";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { QUEUE_FILE, BRIDGE_CONFIG_FILE, BRIDGE_PORT, TERMINAL_STATES, normalizeProfileUrl, writeJsonAtomic, readJson, jobFile, isJobId } from "./store.mjs";

export function startBridgeServer() {
  return readJson(BRIDGE_CONFIG_FILE).then(config => {
    if (!config?.extensionOrigin || config.port !== BRIDGE_PORT) {
      throw new Error("The local CLI bridge is not configured. Run `node cli/mediasaver.mjs install` first.");
    }
    const claimedJobs = new Set();
    let bridgeMessageQueue = Promise.resolve();
    const server = createServer(async (request, response) => {
      const origin = request.headers.origin;
      const host = request.headers.host;
      const expectedOrigin = config.extensionOrigin;
      const expectedHost = `127.0.0.1:${BRIDGE_PORT}`;
      if (host !== expectedHost || origin !== expectedOrigin) {
        response.writeHead(403, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "Origin or host rejected." }));
        return;
      }
      response.setHeader("Access-Control-Allow-Origin", expectedOrigin);
      response.setHeader("Vary", "Origin");
      response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type");
      response.setHeader("Access-Control-Allow-Private-Network", "true");
      if (request.method === "OPTIONS") {
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method !== "POST" || request.url !== "/message") {
        response.writeHead(404, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "Not found." }));
        return;
      }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => {
        body += chunk;
        if (body.length > 1_000_000) request.destroy(new Error("Request too large."));
      });
      request.on("error", () => {
        if (!response.headersSent) response.writeHead(413);
        response.end();
      });
      request.on("end", async () => {
        let message;
        try { message = JSON.parse(body); } catch {
          response.writeHead(400, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: "Invalid JSON." }));
          return;
        }
        try {
          const operation = bridgeMessageQueue.then(() => handleBridgeMessage(message, claimedJobs));
          bridgeMessageQueue = operation.then(() => undefined, () => undefined);
          const result = await operation;
          response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
          response.end(JSON.stringify(result));
        } catch (error) {
          response.writeHead(500, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
        }
      });
    });
    return new Promise((resolve, reject) => {
      server.once("error", error => {
        if (error?.code === "EADDRINUSE") {
          reject(new Error(`CLI bridge port ${BRIDGE_PORT} is already in use. Close the other Page Media Saver CLI process, then resume the job.`));
        } else reject(error);
      });
      server.listen(BRIDGE_PORT, "127.0.0.1", () => {
        resolve(server);
      });
    });
  });
}

export async function handleBridgeMessage(message, claimedJobs) {
  if (message?.type === "PAGE_READY") {
    if (!Number.isInteger(message.tabId)) return { ok: false, error: "The Edge tab could not be identified." };
    const queue = await readJson(QUEUE_FILE);
    const job = queue?.jobId ? await readJson(jobFile(queue.jobId)) : null;
    if (!job || TERMINAL_STATES.has(job.status)) return { ok: true, type: "NO_JOB" };
    const currentUrl = normalizeProfileUrl(message.pageUrl || "").url;
    const expectedUrl = normalizeProfileUrl(job.url).url;
    if (currentUrl !== expectedUrl || message.platform !== job.platform
      || (!job.mediaPage && message.account?.toLowerCase() !== job.account.toLowerCase())) {
      return { ok: true, type: "NO_JOB" };
    }
    if (claimedJobs.has(job.jobId)) return { ok: true, type: "JOB_CONNECTED" };
    claimedJobs.add(job.jobId);
    if (job.mediaPage) job.account = String(message.account || job.account);
    job.status = "running";
    job.message = job.mediaPage
      ? "Edge acknowledged the media post; checking its platform download control."
      : "Edge acknowledged the profile page; scanning and downloading.";
    job.updatedAt = new Date().toISOString();
    await writeJsonAtomic(jobFile(job.jobId), job);
    return { ok: true, type: "START_JOB", tabId: message.tabId, job };
  }

  const jobId = message?.jobId || message?.state?.jobId;
  if (!jobId || !["JOB_PROGRESS", "JOB_DONE", "JOB_ERROR"].includes(message?.type)) {
    return { ok: false, error: "Unsupported bridge message." };
  }
  if (!isJobId(jobId)) return { ok: false, error: "Invalid job id." };
  const filePath = jobFile(jobId);
  const job = await readJson(filePath);
  if (!job) return { ok: false, error: "The CLI job no longer exists." };
  const state = message.state || {};
  if (message.type === "JOB_ERROR") {
    job.status = "error";
    job.message = String(message.error || "The page scan could not start.").slice(0, 500);
  } else {
    job.started = Number(state.started || 0);
    job.skipped = Number(state.skipped || 0);
    job.videoStarted = Number(state.videoStarted || 0);
    job.videoSkipped = Number(state.videoSkipped || 0);
    job.failed = Number(state.failed || 0);
    job.pending = Number(state.pending || 0);
    job.rounds = Number(state.rounds || 0);
    job.message = String(state.message || "Scanning profile grid.").slice(0, 500);
    if (job.mediaPage && state.account) job.account = String(state.account);
    if (Array.isArray(state.repairFound)) job.repairFound = state.repairFound;
    if (Array.isArray(state.repairFiles)) job.repairFiles = state.repairFiles;
    if (message.type === "JOB_DONE") {
      job.status = ["complete", "incomplete", "paused", "error"].includes(state.status) ? state.status : "incomplete";
    } else {
      job.status = "running";
    }
  }
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(filePath, job);
  if (TERMINAL_STATES.has(job.status)) {
    const queue = await readJson(QUEUE_FILE);
    if (queue?.jobId === jobId) await unlink(QUEUE_FILE).catch(() => {});
  }
  return { ok: true, type: "ACK" };
}
