// Loopback REST API for the running queue (version 1). Resources are nouns in the plural:
//   /v1/health                       the service is up (no token)
//   /v1/jobs                         GET list (filter, page) · POST create (201 + Location)
//   /v1/jobs/{id}                    GET one · DELETE cancel an active job or remove a finished one (204)
//   /v1/watches                      GET list · POST start watching an account (201 + Location)
//   /v1/watches/{platform}/{account} GET one · DELETE stop watching (204)
// Errors are RFC 9457 problem documents. A page on the internet cannot call the server: it listens on
// 127.0.0.1 only, rejects any other Host header, needs a bearer token, and sends no CORS headers.
import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { normalizeProfileUrl } from "./store.mjs";

export const API_PORT = Number(process.env.PMS_API_PORT) || 38542;
export const API_BASE = "/v1";
const MAX_BODY_BYTES = 8192;
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
function isJsonContentType(value) {
  const [mediaType, ...parameters] = value.split(";");
  return (
    mediaType.trim().toLowerCase() === "application/json" &&
    parameters.every(parameter => /^\s*[\w-]+\s*=\s*(?:[\w.-]+|"[^"]*")\s*$/.test(parameter))
  );
}
const JOB_STATUSES = new Set(["queued", "running", "complete", "incomplete", "paused", "error"]);
const ALREADY_QUEUED = "already queued or done";
const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 120;
const PLATFORMS = new Set(["instagram", "facebook", "twitter", "tiktok"]);

export function jobView(job) {
  return {
    id: job.jobId,
    status: job.status,
    platform: job.platform || "",
    account: job.account || "",
    url: job.url,
    message: job.message || "",
    counts: {
      started: Number(job.started || 0),
      pending: Number(job.pending || 0),
      failed: Number(job.failed || 0),
      skipped: Number(job.skipped || 0)
    },
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null,
    links: { self: `${API_BASE}/jobs/${job.jobId}` }
  };
}

// Groups the watched pages (an account can have several) into one resource per account.
export function watchViews(pages) {
  const accounts = new Map();
  for (const page of pages) {
    let found;
    try {
      found = normalizeProfileUrl(page);
    } catch {
      continue;
    }
    const platform = found.platform.toLowerCase();
    const account = found.account.toLowerCase();
    const key = `${platform}/${account}`;
    const entry = accounts.get(key) ?? {
      id: key,
      platform,
      account,
      url: page,
      pages: [],
      links: { self: `${API_BASE}/watches/${encodeURIComponent(platform)}/${encodeURIComponent(account)}` }
    };
    entry.pages.push(page);
    accounts.set(key, entry);
  }
  return [...accounts.values()];
}

function send(response, status, body, headers = {}) {
  const payload = body === undefined ? "" : JSON.stringify(body);
  response.writeHead(status, {
    ...(body === undefined ? {} : { "Content-Type": "application/json; charset=utf-8" }),
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload),
    ...headers
  });
  response.end(payload);
}

const TITLES = {
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error"
};

function problem(response, status, detail, headers = {}) {
  const body = { type: "about:blank", title: TITLES[status] || "Error", status, detail };
  send(response, status, body, { "Content-Type": "application/problem+json; charset=utf-8", ...headers });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    request.on("error", reject);
    if (Number(request.headers["content-length"]) > MAX_BODY_BYTES) {
      request.resume();
      reject(Object.assign(new Error("The request body is too large."), { status: 413 }));
      return;
    }
    request.on("data", chunk => {
      if (tooLarge) {
        return;
      }
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        request.resume();
        reject(Object.assign(new Error("The request body is too large."), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

// The JSON object in the body, or null after answering 400/413/422.
async function readJsonObject(request, response) {
  let text;
  try {
    text = await readBody(request);
  } catch (error) {
    const status = error?.status || 400;
    problem(
      response,
      status,
      status === 413 ? "The request body is too large." : "The request body could not be read."
    );
    return null;
  }
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    problem(response, 400, "The request body is not valid JSON.");
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    problem(response, 422, "The request body must be a JSON object.");
    return null;
  }
  return payload;
}

function readHttpsUrl(payload, response) {
  if (typeof payload.url !== "string" || payload.url.length > 2048) {
    problem(response, 422, "url must be a supported profile or post link.");
    return null;
  }
  try {
    const parsed = new URL(payload.url);
    if (parsed.username || parsed.password || parsed.port) {
      throw new Error("URL authority is not allowed.");
    }
    normalizeProfileUrl(payload.url);
  } catch {
    problem(response, 422, "Use a supported Instagram, Facebook, X, or TikTok profile or post URL.");
    return null;
  }
  return payload.url;
}

function hasOnlyKeys(payload, allowed, response) {
  const unknown = Object.keys(payload).find(key => !allowed.includes(key));
  if (unknown) {
    problem(response, 422, "The request contains an unsupported field.");
    return false;
  }
  return true;
}

// ---- jobs -------------------------------------------------------------------------------------------------

function pageOf(url) {
  const limit = url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : DEFAULT_PAGE;
  const offset = url.searchParams.has("offset") ? Number(url.searchParams.get("offset")) : 0;
  const status = url.searchParams.get("status");
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE) {
    return { error: `limit must be a whole number from 1 to ${MAX_PAGE}.` };
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return { error: "offset must be a whole number of 0 or more." };
  }
  if (status !== null && !JOB_STATUSES.has(status)) {
    return { error: `status must be one of: ${[...JOB_STATUSES].join(", ")}.` };
  }
  return { limit, offset, status };
}

async function listJobsRoute({ response, url, deps }) {
  const page = pageOf(url);
  if (page.error) {
    problem(response, 400, page.error);
    return;
  }
  const all = (await deps.listJobs()).filter(job => !page.status || job.status === page.status);
  const items = all.slice(page.offset, page.offset + page.limit).map(jobView);
  const next = page.offset + page.limit < all.length;
  const query = new URLSearchParams({ limit: String(page.limit), offset: String(page.offset + page.limit) });
  if (page.status) {
    query.set("status", page.status);
  }
  send(
    response,
    200,
    { items, page: { limit: page.limit, offset: page.offset, total: all.length } },
    next ? { Link: `<${API_BASE}/jobs?${query}>; rel="next"` } : {}
  );
}

async function createJobRoute({ request, response, deps }) {
  const payload = await readJsonObject(request, response);
  if (payload && !hasOnlyKeys(payload, ["url", "again"], response)) {
    return;
  }
  if (payload && payload.again !== undefined && typeof payload.again !== "boolean") {
    problem(response, 422, "again must be a boolean.");
    return;
  }
  const url = payload && readHttpsUrl(payload, response);
  if (!url) {
    return;
  }
  const { created, skipped } = await deps.addUrls([url], { force: payload.again === true });
  if (!created.length) {
    const rejected = skipped.find(item => item.reason !== ALREADY_QUEUED);
    if (rejected) {
      problem(response, 422, rejected.reason);
    } else {
      problem(response, 409, 'This account is already queued or done. Send {"again": true} to run it anew.');
    }
    return;
  }
  const items = created.map(jobView);
  send(response, 201, { items }, { Location: items[0].links.self });
}

async function jobRoute({ response, params, deps }) {
  const job = (await deps.listJobs()).find(item => item.jobId === params[0].toLowerCase());
  if (job) {
    send(response, 200, jobView(job));
  } else {
    problem(response, 404, "There is no job with this id.");
  }
}

async function deleteJobRoute({ response, params, deps }) {
  if (await deps.removeJob(params[0].toLowerCase())) {
    send(response, 204);
  } else {
    problem(response, 404, "There is no job with this id.");
  }
}

// ---- watches ----------------------------------------------------------------------------------------------

async function listWatchesRoute({ response, deps }) {
  const items = watchViews(await deps.watch.list());
  send(response, 200, { items, page: { limit: items.length, offset: 0, total: items.length } });
}

async function createWatchRoute({ request, response, deps }) {
  const payload = await readJsonObject(request, response);
  if (payload && !hasOnlyKeys(payload, ["url"], response)) {
    return;
  }
  const url = payload && readHttpsUrl(payload, response);
  if (!url) {
    return;
  }
  let outcome;
  try {
    outcome = await deps.watch.add(url);
  } catch {
    problem(response, 500, "The request failed.");
    return;
  }
  if (!outcome.added.length) {
    problem(response, 409, "This account is already being watched.");
    return;
  }
  const first = watchViews(outcome.added)[0];
  const full = watchViews(await deps.watch.list()).find(item => item.id === first.id);
  send(response, 201, full ?? first, { Location: first.links.self });
}

async function findWatch(deps, params) {
  let platform;
  let account;
  try {
    platform = decodeURIComponent(params[0]).toLowerCase();
    account = decodeURIComponent(params[1]).toLowerCase();
  } catch {
    return null;
  }
  if (!PLATFORMS.has(platform)) {
    return null;
  }
  const id = `${platform}/${account}`;
  return watchViews(await deps.watch.list()).find(item => item.id === id) ?? null;
}

async function watchRoute({ response, params, deps }) {
  const watch = await findWatch(deps, params);
  if (watch) {
    send(response, 200, watch);
  } else {
    problem(response, 404, "This account is not being watched.");
  }
}

async function deleteWatchRoute({ response, params, deps }) {
  const watch = await findWatch(deps, params);
  if (!watch) {
    problem(response, 404, "This account is not being watched.");
    return;
  }
  for (const page of watch.pages) {
    await deps.watch.remove(page);
  }
  send(response, 204);
}

// ---- routing ----------------------------------------------------------------------------------------------

const ID = "([0-9a-f-]{36})";
const SEGMENT = "([^/]+)";
const startedAt = Date.now();

async function statusRoute({ response, deps }) {
  const state = deps.status ? await deps.status() : {};
  send(response, 200, { uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), ...state });
}

// Prometheus text format: one gauge per job state, whether an extension has reported in, and uptime.
async function metricsRoute({ response, deps }) {
  const state = deps.status ? await deps.status() : {};
  const lines = ["# HELP pms_jobs Jobs in the queue by status.", "# TYPE pms_jobs gauge"];
  for (const [status, count] of Object.entries(state.jobs ?? {})) {
    lines.push(`pms_jobs{status="${status}"} ${count}`);
  }
  lines.push(
    "# HELP pms_extension_seen_timestamp_seconds When the browser extension last reported in.",
    "# TYPE pms_extension_seen_timestamp_seconds gauge",
    `pms_extension_seen_timestamp_seconds ${state.extension?.at ? Math.round(Date.parse(state.extension.at) / 1000) : 0}`,
    "# HELP pms_uptime_seconds Seconds since the API started.",
    "# TYPE pms_uptime_seconds gauge",
    `pms_uptime_seconds ${Math.round((Date.now() - startedAt) / 1000)}`
  );
  const payload = lines.join(String.fromCharCode(10)) + String.fromCharCode(10);
  response.writeHead(200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(payload)
  });
  response.end(payload);
}

const ROUTES = [
  { pattern: new RegExp(`^${API_BASE}/status$`), GET: statusRoute },
  { pattern: new RegExp(`^${API_BASE}/metrics$`), GET: metricsRoute },
  {
    pattern: new RegExp(`^${API_BASE}/health$`),
    open: true,
    GET: ({ response }) => send(response, 200, { status: "ok" })
  },
  { pattern: new RegExp(`^${API_BASE}/jobs$`), GET: listJobsRoute, POST: createJobRoute },
  { pattern: new RegExp(`^${API_BASE}/jobs/${ID}$`, "i"), GET: jobRoute, DELETE: deleteJobRoute },
  { pattern: new RegExp(`^${API_BASE}/watches$`), GET: listWatchesRoute, POST: createWatchRoute, needs: "watch" },
  {
    pattern: new RegExp(`^${API_BASE}/watches/${SEGMENT}/${SEGMENT}$`),
    GET: watchRoute,
    DELETE: deleteWatchRoute,
    needs: "watch"
  }
];
const METHODS = ["GET", "POST", "DELETE"];

function hasValidToken(request, token) {
  const given = Buffer.from(String(request.headers.authorization || ""));
  const wanted = Buffer.from(`Bearer ${token}`);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function createLimiter() {
  const windows = new Map();
  return (request, now, limit, category, consume = true) => {
    const key = `${request.socket.remoteAddress || "unknown"}:${category}`;
    let entry = windows.get(key);
    if (!consume && (!entry || now - entry.started >= RATE_WINDOW_MS)) {
      return false;
    }
    if (!entry || now - entry.started >= RATE_WINDOW_MS) {
      entry = { started: now, count: 0 };
      windows.set(key, entry);
    }
    if (consume) {
      entry.count++;
    }
    if (windows.size > 2048) {
      for (const [address, window] of windows) {
        if (now - window.started >= RATE_WINDOW_MS) {
          windows.delete(address);
        }
      }
    }
    return entry.count > limit;
  };
}

// Host, token and body type are checked before any route runs. Returns false after it has answered.
function rateLimited(request, response, deps, category) {
  if (!deps.limiter(request, Date.now(), deps.rateLimit, category)) {
    return false;
  }
  problem(response, 429, "Too many requests. Try again later.", { "Retry-After": "60" });
  return true;
}

function failedAuthLimited(request, response, deps) {
  if (!deps.limiter(request, Date.now(), deps.rateLimit, "unauthenticated", false)) {
    return false;
  }
  problem(response, 429, "Too many failed authentication attempts. Try again later.", { "Retry-After": "60" });
  return true;
}

function rejectRequest({ request, response, deps, category, status, detail, headers = {} }) {
  if (!rateLimited(request, response, deps, category)) {
    problem(response, status, detail, headers);
  }
}

function admit(request, response, open, deps) {
  const { allowedHosts, token } = deps;
  if (!allowedHosts().includes(request.headers.host)) {
    rejectRequest({
      request,
      response,
      deps,
      category: "rejected",
      status: 403,
      detail: "The Host header is not allowed."
    });
    return false;
  }
  if (request.headers.origin) {
    rejectRequest({
      request,
      response,
      deps,
      category: "rejected",
      status: 403,
      detail: "Cross-origin requests are not allowed."
    });
    return false;
  }
  if (token && !open) {
    if (failedAuthLimited(request, response, deps)) {
      return false;
    }
    if (!hasValidToken(request, token)) {
      rejectRequest({
        request,
        response,
        deps,
        category: "unauthenticated",
        status: 401,
        detail: "Send the API token as: Authorization: Bearer <token>.",
        headers: { "WWW-Authenticate": 'Bearer realm="media-downloader"' }
      });
      return false;
    }
  }
  return !rateLimited(request, response, deps, token && !open ? "authenticated" : "accepted");
}

function validateQuery(request, response, url) {
  const queryKeys = [...url.searchParams.keys()];
  if (new Set(queryKeys).size !== queryKeys.length) {
    problem(response, 400, "Each query parameter may be supplied only once.");
    return false;
  }
  const supportedQuery =
    ["GET", "HEAD"].includes(request.method) && url.pathname === `${API_BASE}/jobs`
      ? ["limit", "offset", "status"]
      : [];
  if ([...url.searchParams.keys()].some(key => !supportedQuery.includes(key))) {
    problem(response, 400, "The request contains an unsupported query parameter.");
    return false;
  }
  return true;
}

async function dispatchRoute(request, response, deps, url, candidate, match) {
  if (!admit(request, response, candidate.open, deps)) {
    return;
  }
  const allowed = METHODS.filter(method => candidate[method]);
  const allow = ["OPTIONS", ...(candidate.GET ? ["HEAD"] : []), ...allowed].join(", ");
  if (request.method === "OPTIONS") {
    send(response, 204, undefined, { Allow: allow });
    return;
  }
  const handler = candidate[request.method === "HEAD" ? "GET" : request.method];
  if (!handler || !(METHODS.includes(request.method) || request.method === "HEAD")) {
    problem(response, 405, `Use one of: ${allow}.`, { Allow: allow });
    return;
  }
  if (!validateQuery(request, response, url)) {
    return;
  }
  if (request.method === "POST" && !isJsonContentType(request.headers["content-type"] || "")) {
    // JSON only: a web page cannot send this type to another origin without a CORS preflight, which is never answered.
    problem(response, 415, "Content-Type must be application/json.");
    return;
  }
  const hasBody = Number(request.headers["content-length"]) > 0 || Boolean(request.headers["transfer-encoding"]);
  if (hasBody && request.method !== "POST") {
    request.resume();
    problem(response, 400, "This method does not accept a request body.");
    return;
  }
  await handler({ request, response, url, params: match.slice(1), deps });
}

async function route(request, response, deps) {
  let url;
  try {
    url = new URL(request.url || "/", "http://127.0.0.1");
  } catch {
    problem(response, 400, "The request target is invalid.");
    return;
  }
  const found = ROUTES.map(candidate => ({ candidate, match: candidate.pattern.exec(url.pathname) })).find(
    item => item.match && (!item.candidate.needs || deps[item.candidate.needs])
  );
  if (!found) {
    if (!admit(request, response, false, deps)) {
      return;
    }
    problem(response, 404, "There is no such resource.");
    return;
  }
  await dispatchRoute(request, response, deps, url, found.candidate, found.match);
}

function createApiServer(deps) {
  return createServer((request, response) => {
    route(request, response, deps).catch(() => {
      if (!response.headersSent) {
        problem(response, 500, "The request failed.");
      }
    });
  });
}

export function startApiServer({
  addUrls,
  listJobs,
  removeJob = () => Promise.resolve(false),
  status = null,
  port = API_PORT,
  token = null,
  watch = null,
  bind = process.env.PMS_API_HOST || "127.0.0.1",
  extraHosts = (process.env.PMS_API_ALLOWED_HOSTS || "")
    .split(",")
    .map(item => item.trim())
    .filter(Boolean),
  rateLimit = RATE_LIMIT
}) {
  if (!LOOPBACK.has(bind) && !token) {
    return Promise.reject(new Error("The API can listen beyond this computer only with an API token."));
  }
  let loopbackHosts = [];
  const allowedHosts = () => [...loopbackHosts, ...extraHosts];
  const limiter = createLimiter();
  const server = createApiServer({
    addUrls,
    listJobs,
    removeJob,
    token,
    watch,
    status,
    allowedHosts,
    rateLimit,
    limiter
  });
  return new Promise((resolve, reject) => {
    server.once("error", error => {
      reject(error?.code === "EADDRINUSE" ? new Error(`Download API port ${port} is already in use.`) : error);
    });
    server.listen(port, bind, () => {
      const address = server.address();
      if (LOOPBACK.has(bind) && address && typeof address === "object") {
        const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
        loopbackHosts = [`${host}:${address.port}`];
        if (bind === "localhost") {
          loopbackHosts.push(`localhost:${address.port}`);
        }
      }
      resolve(server);
    });
  });
}
