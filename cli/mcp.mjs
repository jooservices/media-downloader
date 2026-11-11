// MCP server (stdio) so an AI assistant can ask the running queue for downloads. It is a thin adapter over
// the loopback REST API: it holds no state of its own, so the queue stays the one source of truth.
// Start it from an MCP client with: node cli/mediasaver.mjs mcp
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import readline from "node:readline";
import { API_BASE, API_PORT } from "./api.mjs";
import { API_TOKEN_FILE } from "./store.mjs";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json");

export const SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const URL_SCHEMA = {
  type: "string",
  format: "uri",
  pattern: "^[hH][tT][tT][pP][sS]://[^\\s]+$",
  description: "An https profile link from Instagram, Facebook, X, or TikTok."
};

const JOB_ID_SCHEMA = {
  type: "string",
  format: "uuid",
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
  description: "The UUID id of a job, as returned by download_account or list_jobs."
};

export const TOOLS = [
  {
    name: "get_config",
    title: "Read queue configuration",
    description: "Read the queue's active settings, including worker counts, delays, retry limit, and download folder.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    request: () => ["GET", `${API_BASE}/config`]
  },
  {
    name: "get_status",
    title: "Read queue status",
    description: "Read current job counts, extension check-in details, process id, and queue uptime.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    request: () => ["GET", `${API_BASE}/status`]
  },
  {
    name: "queue_status",
    title: "Get queue status",
    description: "Show queue activity and configured/effective workers with any platform back-off state.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    request: () => ["GET", `${API_BASE}/status`]
  },
  {
    name: "get_metrics",
    title: "Read queue metrics",
    description: "Read Prometheus text metrics for job states, extension check-in time, and uptime.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    request: () => ["GET", `${API_BASE}/metrics`]
  },
  {
    name: "download_account",
    title: "Download an account",
    description:
      "Queue a download of everything new on a profile. Files already saved are skipped. Returns the job(s) created; poll get_job for progress.",
    inputSchema: {
      type: "object",
      properties: {
        url: URL_SCHEMA,
        again: { type: "boolean", description: "Run the account again even if it already ran." }
      },
      required: ["url"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    request: ({ url, again }) => ["POST", `${API_BASE}/jobs`, { url, again: again === true }]
  },
  {
    name: "list_jobs",
    title: "List jobs",
    description: "List download jobs, newest first, optionally only those with one status.",
    inputSchema: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["queued", "running", "complete", "incomplete", "paused", "error"],
          description: "Filter to this job state."
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum jobs to return (1–100; default 50)."
        },
        offset: { type: "integer", minimum: 0, description: "Number of matching jobs to skip (default 0)." }
      },
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    request: ({ status, limit, offset }) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries({ status, limit, offset })) {
        if (value !== undefined) {
          query.set(key, String(value));
        }
      }
      const suffix = query.size ? `?${query}` : "";
      return ["GET", `${API_BASE}/jobs${suffix}`];
    }
  },
  {
    name: "get_job",
    title: "Get a job",
    description: "Show the state of one job: status, message and how many files were started, skipped or failed.",
    inputSchema: {
      type: "object",
      properties: { id: JOB_ID_SCHEMA },
      required: ["id"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    request: ({ id }) => ["GET", `${API_BASE}/jobs/${encodeURIComponent(id)}`]
  },
  {
    name: "cancel_job",
    title: "Cancel or remove a job",
    description: "Cancel a job that is still queued or running, or remove the record of a finished one.",
    inputSchema: {
      type: "object",
      properties: { id: JOB_ID_SCHEMA },
      required: ["id"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    request: ({ id }) => ["DELETE", `${API_BASE}/jobs/${encodeURIComponent(id)}`]
  },
  {
    name: "watch_account",
    title: "Watch an account",
    description:
      "Start watching an account: the queue scans it again every few hours and downloads whatever is new. Returns the watch resource.",
    inputSchema: {
      type: "object",
      properties: { url: URL_SCHEMA },
      required: ["url"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    request: ({ url }) => ["POST", `${API_BASE}/watches`, { url }]
  },
  {
    name: "list_watched",
    title: "List watched accounts",
    description: "List the accounts that are scanned again automatically.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    request: () => ["GET", `${API_BASE}/watches`]
  },
  {
    name: "get_watched",
    title: "Get a watched account",
    description:
      "Read the watched pages associated with one platform account. Use the platform and account from list_watched.",
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          pattern:
            "^[iI][nN][sS][tT][aA][gG][rR][aA][mM]$|^[fF][aA][cC][eE][bB][oO][oO][kK]$|^[tT][wW][iI][tT][tT][eE][rR]$|^[tT][iI][kK][tT][oO][kK]$",
          description: "Platform id shown by list_watched."
        },
        account: { type: "string", minLength: 1, description: "Account name shown by list_watched." }
      },
      required: ["platform", "account"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    request: ({ platform, account }) => [
      "GET",
      `${API_BASE}/watches/${encodeURIComponent(platform)}/${encodeURIComponent(account)}`
    ]
  },
  {
    name: "unwatch_account",
    title: "Stop watching an account",
    description: "Stop scanning an account automatically. Files already saved are kept.",
    inputSchema: {
      type: "object",
      properties: {
        platform: {
          type: "string",
          pattern:
            "^[iI][nN][sS][tT][aA][gG][rR][aA][mM]$|^[fF][aA][cC][eE][bB][oO][oO][kK]$|^[tT][wW][iI][tT][tT][eE][rR]$|^[tT][iI][kK][tT][oO][kK]$",
          description: "Platform id shown by list_watched."
        },
        account: { type: "string", minLength: 1, description: "Account name as shown by list_watched." }
      },
      required: ["platform", "account"],
      additionalProperties: false
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    request: ({ platform, account }) => [
      "DELETE",
      `${API_BASE}/watches/${encodeURIComponent(platform)}/${encodeURIComponent(account)}`
    ]
  },
  {
    name: "queue_health",
    title: "Check the queue",
    description: "Say whether the download queue is running.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    request: () => ["GET", `${API_BASE}/health`]
  },
  {
    name: "platform_health",
    title: "Check platform health",
    description: "Show canary health from finished jobs for Instagram, Facebook, X and TikTok.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    request: () => ["GET", `${API_BASE}/health/platforms`]
  }
];

const BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));
const publicTool = ({ name, title, description, inputSchema, annotations }) => ({
  name,
  title,
  description,
  inputSchema,
  annotations
});

const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const textResult = (value, isError = false) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
  isError
});

function validateObject(value, schema, name) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return `422 Unprocessable Content: ${name} must be an object.`;
  }
  if (schema.additionalProperties === false) {
    const extra = Object.keys(value).find(key => !Object.hasOwn(schema.properties || {}, key));
    if (extra) {
      return `422 Unprocessable Content: ${name}.${extra} is not allowed.`;
    }
  }
  for (const key of schema.required || []) {
    if (!Object.hasOwn(value, key)) {
      return `422 Unprocessable Content: Missing required argument: ${key}.`;
    }
  }
  for (const [key, item] of Object.entries(value)) {
    const issue = validateValue(item, schema.properties?.[key], `${name}.${key}`);
    if (issue) {
      return issue;
    }
  }
  return null;
}

function validateScalar(value, schema, name) {
  const typeIssue = validateType(value, schema, name);
  if (typeIssue) {
    return `422 Unprocessable Content: ${typeIssue}`;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return `422 Unprocessable Content: ${name} must be one of: ${schema.enum.join(", ")}.`;
  }
  return validateScalarConstraints(value, schema, name);
}

function validateType(value, schema, name) {
  const validType = schema.type === "integer" ? Number.isInteger(value) : typeof value === schema.type;
  if (validType) {
    return null;
  }
  const expected = schema.type === "integer" ? "an integer" : `a ${schema.type}`;
  return `${name} must be ${expected}.`;
}

function validateScalarConstraints(value, schema, name) {
  if (schema.minimum !== undefined && value < schema.minimum) {
    return `422 Unprocessable Content: ${name} must be at least ${schema.minimum}.`;
  }
  if (schema.maximum !== undefined && value > schema.maximum) {
    return `422 Unprocessable Content: ${name} must be at most ${schema.maximum}.`;
  }
  if (schema.minLength !== undefined && value.length < schema.minLength) {
    return `422 Unprocessable Content: ${name} must not be empty.`;
  }
  if (schema.format === "uri") {
    try {
      new URL(value);
    } catch {
      return `422 Unprocessable Content: ${name} must be a valid URL.`;
    }
  }
  if (schema.pattern && !new RegExp(schema.pattern, schema.format === "uuid" ? "i" : "").test(value)) {
    return schema.format === "uuid"
      ? `400 Bad Request: ${name} must be a UUID.`
      : `422 Unprocessable Content: url must be an https link.`;
  }
  return null;
}

function validateValue(value, schema, name) {
  if (!schema) {
    return `422 Unprocessable Content: ${name} is not allowed.`;
  }
  return schema.type === "object" ? validateObject(value, schema, name) : validateScalar(value, schema, name);
}

// Turns a REST reply into the text a model should read. Problem documents keep their detail.
async function describeReply(response) {
  if (response.status === 204) {
    return textResult("Done.");
  }
  const contentType = response.headers.get("content-type") || "";
  let body;
  if (/json/i.test(contentType)) {
    body = await response.json().catch(() => null);
  } else {
    const text = await response.text().catch(() => "");
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (response.ok) {
    return textResult(body || "Done.");
  }
  return textResult(`${response.status} ${body?.title || "Error"}: ${body?.detail || "The request failed."}`, true);
}

export function createMcpServer({ fetchApi }) {
  async function callTool(params) {
    const tool = BY_NAME.get(params?.name);
    if (!tool) {
      return { error: rpcError(null, -32602, `Unknown tool: ${params?.name}`).error };
    }
    const args = params.arguments ?? {};
    const validation = validateValue(args, tool.inputSchema, "arguments");
    if (validation) {
      const mapped = tool.name === "list_jobs" ? validation.replace(/^\d+ [^:]+:/, "400 Bad Request:") : validation;
      return { result: textResult(mapped, true) };
    }
    try {
      const [method, path, body] = tool.request(args);
      return { result: await describeReply(await fetchApi(method, path, body)) };
    } catch (error) {
      const message =
        error instanceof Error ? "The download queue is not reachable." : "The download queue could not be contacted.";
      return {
        result: textResult(
          `${message} Check that its local API token is available, then start it with: node cli/mediasaver.mjs serve`,
          true
        )
      };
    }
  }

  // One JSON-RPC message in, one reply out (or null for a notification).
  async function handle(message) {
    if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      return rpcError(message?.id, -32600, "Invalid request.");
    }
    const { id, method, params } = message;
    if (id === undefined) {
      return null; // notifications such as notifications/initialized need no answer
    }
    switch (method) {
      case "initialize": {
        const asked = params?.protocolVersion;
        return rpcResult(id, {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "media-downloader", title: "Media Downloader", version: VERSION }
        });
      }
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS.map(publicTool) });
      case "tools/call": {
        const outcome = await callTool(params);
        return outcome.error ? { jsonrpc: "2.0", id, error: outcome.error } : rpcResult(id, outcome.result);
      }
      default:
        return rpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  return { handle };
}

// Calls the running queue's REST API on this machine with the token the queue keeps for this user.
export function localApi({ port = API_PORT, tokenFile = API_TOKEN_FILE, fetchImpl = fetch } = {}) {
  return async (method, path, body) => {
    const token = (await readFile(tokenFile, "utf8")).trim();
    const configuredBind = process.env.PMS_API_HOST || "127.0.0.1";
    let host = "127.0.0.1";
    if (configuredBind === "::1" || configuredBind === "::") {
      host = "[::1]";
    } else if (configuredBind === "localhost") {
      host = "localhost";
    } else if (configuredBind !== "0.0.0.0") {
      host = configuredBind.includes(":") ? `[${configuredBind}]` : configuredBind;
    }
    const headers = { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) };
    if (!new Set(["127.0.0.1", "::1", "localhost"]).has(configuredBind)) {
      const allowedHosts = (process.env.PMS_API_ALLOWED_HOSTS || "")
        .split(",")
        .map(item => item.trim())
        .filter(item => item.endsWith(`:${port}`));
      if (!allowedHosts.length) {
        throw new Error(
          `PMS_API_ALLOWED_HOSTS must include a local MCP Host value ending in :${port} when PMS_API_HOST is non-loopback.`
        );
      }
      headers.Host = allowedHosts[0];
    }
    return fetchImpl(`http://${host}:${port}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined
    });
  };
}

// Newline-delimited JSON-RPC on stdin/stdout. Logs go to stderr: stdout carries only protocol messages.
export async function runMcp({ input = process.stdin, output = process.stdout, fetchApi = localApi() } = {}) {
  const server = createMcpServer({ fetchApi });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  const pending = new Set();
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    const work = (async () => {
      let reply;
      try {
        reply = await server.handle(JSON.parse(line));
      } catch (error) {
        reply =
          error instanceof SyntaxError
            ? rpcError(null, -32700, "Parse error.")
            : rpcError(null, -32603, "Internal error.");
      }
      if (reply) {
        output.write(`${JSON.stringify(reply)}\n`);
      }
    })();
    pending.add(work);
    work.finally(() => pending.delete(work));
  }
  await Promise.all(pending);
}
