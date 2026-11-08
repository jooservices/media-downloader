// Loopback API for the running queue. A page on the internet cannot call it: the server
// listens on 127.0.0.1 only and rejects any other Host header, and it sends no CORS headers.
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

export const API_PORT = 38542;
const MAX_BODY_BYTES = 8192;
const JSON_TYPE = /^application\/json\b/i;
const ALREADY_QUEUED = "already queued or done";

export function jobView(job) {
  return {
    jobId: job.jobId,
    status: job.status,
    platform: job.platform || "",
    account: job.account || "",
    url: job.url,
    message: job.message || "",
    started: Number(job.started || 0),
    pending: Number(job.pending || 0),
    failed: Number(job.failed || 0),
    skipped: Number(job.skipped || 0)
  };
}

function respond(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(Object.assign(new Error("Request too large."), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on("error", reject);
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function queueDownload(request, response, addUrls) {
  let payload;
  try {
    payload = JSON.parse((await readBody(request)) || "");
  } catch (error) {
    const status = error?.status || 400;
    respond(response, status, {
      ok: false,
      error: status === 413 ? "Request too large." : 'Send JSON: {"url":"https://..."}.'
    });
    return;
  }
  if (typeof payload?.url !== "string" || !payload.url.startsWith("https://")) {
    respond(response, 400, { ok: false, error: "url must be an https link." });
    return;
  }
  const { created, skipped } = await addUrls([payload.url], { force: payload.again === true });
  const rejected = skipped.filter(item => item.reason !== ALREADY_QUEUED);
  if (!created.length && rejected.length) {
    respond(response, 400, { ok: false, error: rejected[0].reason });
    return;
  }
  respond(response, 202, { ok: true, created: created.map(jobView), skipped });
}

function createApiServer(deps) {
  return createServer((request, response) => {
    route(request, response, deps).catch(() => {
      if (!response.headersSent) {
        respond(response, 500, { ok: false, error: "The request failed." });
      }
    });
  });
}

function hasValidToken(request, token) {
  const given = Buffer.from(String(request.headers.authorization || ""));
  const wanted = Buffer.from(`Bearer ${token}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

async function route(request, response, { addUrls, listJobs, expectedHost, token }) {
  if (request.headers.host !== expectedHost()) {
    respond(response, 403, { ok: false, error: "Only 127.0.0.1 is accepted." });
    return;
  }
  const pathname = (request.url || "/").split("?")[0];
  if (token && pathname !== "/health" && !hasValidToken(request, token)) {
    respond(response, 401, { ok: false, error: "Send the API token as: Authorization: Bearer <token>." });
    return;
  }
  // JSON only: a web page cannot send this type to another origin without a CORS preflight, which is never answered.
  if (request.method === "POST" && !JSON_TYPE.test(request.headers["content-type"] || "")) {
    respond(response, 415, { ok: false, error: "Content-Type must be application/json." });
    return;
  }
  if (request.method === "GET" && pathname === "/health") {
    respond(response, 200, { ok: true });
    return;
  }
  if (request.method === "GET" && pathname === "/jobs") {
    respond(response, 200, { ok: true, jobs: (await listJobs()).slice(0, 50).map(jobView) });
    return;
  }
  if (request.method === "POST" && pathname === "/downloads") {
    await queueDownload(request, response, addUrls);
    return;
  }
  respond(response, 404, { ok: false, error: "Not found." });
}

export function startApiServer({ addUrls, listJobs, port = API_PORT, token = null }) {
  let host = `127.0.0.1:${port}`;
  const server = createApiServer({ addUrls, listJobs, token, expectedHost: () => host });
  return new Promise((resolve, reject) => {
    server.once("error", error => {
      reject(error?.code === "EADDRINUSE" ? new Error(`Download API port ${port} is already in use.`) : error);
    });
    server.listen(port, "127.0.0.1", () => {
      host = `127.0.0.1:${server.address().port}`;
      resolve(server);
    });
  });
}
