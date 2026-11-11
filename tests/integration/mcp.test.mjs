import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { startApiServer } from "../../cli/api.mjs";
import { SUPPORTED_VERSIONS, TOOLS, createMcpServer, localApi, runMcp } from "../../cli/mcp.mjs";

const JOB_ID = "11111111-1111-4111-8111-111111111111";

// A queue that answers with whatever the test sets; it records what the server asked for.
function fakeQueue(reply) {
  const calls = [];
  return {
    calls,
    fetchApi: async (method, requestPath, body) => {
      calls.push([method, requestPath, body]);
      return typeof reply === "function" ? reply(method, requestPath, body) : reply;
    }
  };
}

const json = (status, body) => new Response(JSON.stringify(body), { status });
const rpc = (method, params, id = 1) => ({ jsonrpc: "2.0", id, method, params });
const call = (server, name, args) => server.handle(rpc("tools/call", { name, arguments: args }));

test("initialize agrees on a protocol version and announces tools only", async () => {
  const server = createMcpServer({ fetchApi: fakeQueue(json(200, {})).fetchApi });
  const agreed = await server.handle(rpc("initialize", { protocolVersion: "2025-03-26" }));
  assert.equal(agreed.result.protocolVersion, "2025-03-26");
  assert.deepEqual(Object.keys(agreed.result.capabilities), ["tools"]);
  assert.equal(agreed.result.serverInfo.name, "media-downloader");
  const unknown = await server.handle(rpc("initialize", { protocolVersion: "1999-01-01" }));
  assert.equal(unknown.result.protocolVersion, SUPPORTED_VERSIONS[0]);
  const none = await server.handle(rpc("initialize"));
  assert.equal(none.result.protocolVersion, SUPPORTED_VERSIONS[0]);
});

test("the local MCP client follows an IPv6 API bind", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pms-mcp-ipv6-"));
  const tokenFile = path.join(home, "api-token");
  await writeFile(tokenFile, "tok-123\n");
  const previousBind = process.env.PMS_API_HOST;
  const previousAllowedHosts = process.env.PMS_API_ALLOWED_HOSTS;
  const calls = [];
  process.env.PMS_API_HOST = "::1";
  try {
    const fetchApi = localApi({
      port: 1234,
      tokenFile,
      fetchImpl: async (...args) => {
        calls.push(args);
        return new Response(null);
      }
    });
    await fetchApi("GET", "/v1/health");
    assert.equal(calls[0][0], "http://[::1]:1234/v1/health");
    assert.equal(calls[0][1].headers.Host, undefined);
  } finally {
    if (previousBind === undefined) {
      delete process.env.PMS_API_HOST;
    } else {
      process.env.PMS_API_HOST = previousBind;
    }
    if (previousAllowedHosts === undefined) {
      delete process.env.PMS_API_ALLOWED_HOSTS;
    } else {
      process.env.PMS_API_ALLOWED_HOSTS = previousAllowedHosts;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("the local MCP client uses a configured Host for a wildcard API bind", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pms-mcp-allowed-host-"));
  const tokenFile = path.join(home, "api-token");
  await writeFile(tokenFile, "tok-123\n");
  const previousBind = process.env.PMS_API_HOST;
  const previousAllowedHosts = process.env.PMS_API_ALLOWED_HOSTS;
  const calls = [];
  process.env.PMS_API_HOST = "0.0.0.0";
  process.env.PMS_API_ALLOWED_HOSTS = "api.local.test:1234";
  try {
    const fetchApi = localApi({
      port: 1234,
      tokenFile,
      fetchImpl: async (...args) => {
        calls.push(args);
        return new Response(null);
      }
    });
    await fetchApi("GET", "/v1/health");
    assert.equal(calls[0][0], "http://127.0.0.1:1234/v1/health");
    assert.equal(calls[0][1].headers.Host, "api.local.test:1234");
  } finally {
    if (previousBind === undefined) {
      delete process.env.PMS_API_HOST;
    } else {
      process.env.PMS_API_HOST = previousBind;
    }
    if (previousAllowedHosts === undefined) {
      delete process.env.PMS_API_ALLOWED_HOSTS;
    } else {
      process.env.PMS_API_ALLOWED_HOSTS = previousAllowedHosts;
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("notifications get no reply, ping is answered, bad messages are errors", async () => {
  const server = createMcpServer({ fetchApi: fakeQueue(json(200, {})).fetchApi });
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  assert.deepEqual((await server.handle(rpc("ping"))).result, {});
  assert.equal((await server.handle(rpc("nope"))).error.code, -32601);
  assert.equal((await server.handle({ id: 5 })).error.code, -32600);
  assert.equal((await server.handle(null)).error.code, -32600);
  assert.equal((await server.handle({ jsonrpc: "2.0", id: 2, method: 7 })).error.code, -32600);
});

test("tools/list describes every tool with a JSON schema and keeps internals out", async () => {
  const server = createMcpServer({ fetchApi: fakeQueue(json(200, {})).fetchApi });
  const { tools } = (await server.handle(rpc("tools/list"))).result;
  assert.deepEqual(
    tools.map(tool => tool.name),
    TOOLS.map(tool => tool.name)
  );
  assert.deepEqual(tools.map(tool => tool.name).sort(), [
    "cancel_job",
    "download_account",
    "get_config",
    "get_job",
    "get_metrics",
    "get_status",
    "get_watched",
    "list_jobs",
    "list_watched",
    "platform_health",
    "queue_health",
    "queue_status",
    "unwatch_account",
    "watch_account"
  ]);
  for (const tool of tools) {
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.ok(tool.description.length > 20, tool.name);
    assert.equal(tool.request, undefined, "the request builder is not part of the protocol");
    assert.equal(typeof tool.annotations.readOnlyHint, "boolean", tool.name);
  }
});

test("each tool turns its arguments into the right REST request", async () => {
  const queue = fakeQueue(json(200, { ok: true }));
  const server = createMcpServer({ fetchApi: queue.fetchApi });
  await call(server, "download_account", { url: "https://www.instagram.com/a/" });
  await call(server, "download_account", { url: "https://www.instagram.com/a/", again: true });
  await call(server, "get_config", {});
  await call(server, "get_status", {});
  await call(server, "get_metrics", {});
  await call(server, "list_jobs", {});
  await call(server, "list_jobs", { status: "running", limit: 5, offset: 10 });
  await call(server, "get_job", { id: JOB_ID });
  await call(server, "cancel_job", { id: JOB_ID });
  await call(server, "watch_account", { url: "https://x.com/a/" });
  await call(server, "list_watched", {});
  await call(server, "get_watched", { platform: "instagram", account: "a" });
  await call(server, "unwatch_account", { platform: "twitter", account: "a b" });
  await call(server, "queue_health");
  await call(server, "platform_health", {});
  await call(server, "queue_status");
  assert.deepEqual(queue.calls, [
    ["POST", "/v1/jobs", { url: "https://www.instagram.com/a/", again: false }],
    ["POST", "/v1/jobs", { url: "https://www.instagram.com/a/", again: true }],
    ["GET", "/v1/config", undefined],
    ["GET", "/v1/status", undefined],
    ["GET", "/v1/metrics", undefined],
    ["GET", "/v1/jobs", undefined],
    ["GET", "/v1/jobs?status=running&limit=5&offset=10", undefined],
    ["GET", `/v1/jobs/${JOB_ID}`, undefined],
    ["DELETE", `/v1/jobs/${JOB_ID}`, undefined],
    ["POST", "/v1/watches", { url: "https://x.com/a/" }],
    ["GET", "/v1/watches", undefined],
    ["GET", "/v1/watches/instagram/a", undefined],
    ["DELETE", "/v1/watches/twitter/a%20b", undefined],
    ["GET", "/v1/health", undefined],
    ["GET", "/v1/health/platforms", undefined],
    ["GET", "/v1/status", undefined]
  ]);
});

test("a good reply is the JSON text; 204 is Done; a problem reply is an error the model can read", async () => {
  const ok = await call(
    createMcpServer({ fetchApi: fakeQueue(json(201, { items: [{ id: JOB_ID }] })).fetchApi }),
    "get_job",
    {
      id: JOB_ID
    }
  );
  assert.equal(ok.result.isError, false);
  assert.deepEqual(JSON.parse(ok.result.content[0].text), { items: [{ id: JOB_ID }] });

  const gone = await call(
    createMcpServer({ fetchApi: fakeQueue(new Response(null, { status: 204 })).fetchApi }),
    "cancel_job",
    {
      id: JOB_ID
    }
  );
  assert.equal(gone.result.content[0].text, "Done.");

  const empty = await call(
    createMcpServer({ fetchApi: fakeQueue(new Response("", { status: 200 })).fetchApi }),
    "queue_health"
  );
  assert.equal(empty.result.content[0].text, "Done.");

  const conflict = await call(
    createMcpServer({ fetchApi: fakeQueue(json(409, { title: "Conflict", detail: "Already queued." })).fetchApi }),
    "download_account",
    { url: "https://www.instagram.com/a/" }
  );
  assert.equal(conflict.result.isError, true);
  assert.equal(conflict.result.content[0].text, "409 Conflict: Already queued.");

  const plain = await call(
    createMcpServer({ fetchApi: fakeQueue(new Response("<html>", { status: 502 })).fetchApi }),
    "queue_health"
  );
  assert.equal(plain.result.content[0].text, "502 Error: The request failed.");
});

test("tool arguments are validated against each published schema before making a request", async () => {
  const queue = fakeQueue(json(200, {}));
  const server = createMcpServer({ fetchApi: queue.fetchApi });
  const invalidCalls = [
    ["download_account", { url: "https://www.instagram.com/a/", again: "true" }],
    ["download_account", { url: "https://www.instagram.com/a/", unexpected: 1 }],
    ["list_jobs", { limit: "5" }],
    ["list_jobs", { limit: 0 }],
    ["list_jobs", { status: "invalid" }],
    ["get_job", { id: JOB_ID, extra: false }],
    ["list_watched", { page: 1 }],
    ["unwatch_account", { platform: "twitter", account: "a", extra: true }],
    ["watch_account", { url: 4 }],
    ["queue_health", ["unexpected"]]
  ];
  for (const [name, args] of invalidCalls) {
    const result = await call(server, name, args);
    assert.equal(result.result.isError, true, name);
    assert.match(
      result.result.content[0].text,
      name === "list_jobs" ? /^400 Bad Request:/ : /^422 Unprocessable Content:/
    );
  }
  assert.equal(queue.calls.length, 0, "invalid inputs never reach the REST API");
  const valid = await call(server, "list_jobs", { status: "running", limit: 5, offset: 0 });
  assert.equal(valid.result.isError, false);
  assert.equal(queue.calls.length, 1);
});

test("missing arguments, unknown tools and an unreachable queue are reported, not thrown", async () => {
  const queue = fakeQueue(json(200, {}));
  const server = createMcpServer({ fetchApi: queue.fetchApi });
  const missing = await call(server, "get_job", {});
  assert.equal(missing.result.isError, true);
  assert.match(missing.result.content[0].text, /^422 Unprocessable Content: Missing required argument: id\./);
  const blank = await call(server, "unwatch_account", { platform: "twitter" });
  assert.match(blank.result.content[0].text, /^422 Unprocessable Content: Missing required argument: account\./);
  assert.equal(queue.calls.length, 0, "nothing is sent for an incomplete call");
  for (const [name, args] of [
    ["list_jobs", { limit: "5" }],
    ["list_jobs", { limit: 101 }],
    ["list_jobs", { status: "mystery" }],
    ["download_account", { url: "http://instagram.com/a/" }],
    ["download_account", { url: "https://instagram.com/a/", ignored: true }],
    ["get_config", { ignored: true }],
    ["unwatch_account", { platform: "myspace", account: "a" }]
  ]) {
    const invalid = await call(server, name, args);
    assert.equal(invalid.result.isError, true, `${name} ${JSON.stringify(args)}`);
  }
  assert.equal(queue.calls.length, 0, "invalid schemas are rejected before REST");
  const unknown = await call(server, "format_disk", {});
  assert.equal(unknown.error.code, -32602);
  const noParams = await server.handle(rpc("tools/call"));
  assert.equal(noParams.error.code, -32602);

  const down = createMcpServer({
    fetchApi: async () => {
      throw new Error("connect ECONNREFUSED");
    }
  });
  const offline = await call(down, "queue_health");
  assert.equal(offline.result.isError, true);
  assert.match(offline.result.content[0].text, /not reachable.*serve/);
  assert.doesNotMatch(offline.result.content[0].text, /ECONNREFUSED/);
  const silent = createMcpServer({
    fetchApi: async () => {
      throw new Error("");
    }
  });
  assert.match((await call(silent, "queue_health")).result.content[0].text, /not reachable/);
  const secretFailure = createMcpServer({
    fetchApi: async () => {
      throw new Error("/private/api-token SECRET");
    }
  });
  const hidden = await call(secretFailure, "queue_health");
  assert.doesNotMatch(hidden.result.content[0].text, /private|api-token|SECRET/);
  assert.match(hidden.result.content[0].text, /Check that its local API token is available/);
});

async function converse(fetchApi, lines) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks = [];
  output.on("data", chunk => chunks.push(chunk));
  const finished = runMcp({ input, output, fetchApi });
  for (const line of lines) {
    input.write(typeof line === "string" ? `${line}\n` : `${JSON.stringify(line)}\n`);
  }
  input.end();
  await finished;
  return Buffer.concat(chunks)
    .toString()
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test("over stdio: one JSON message per line in, one reply per request out; garbage is a parse error", async () => {
  const replies = await converse(fakeQueue(json(200, { status: "ok" })).fetchApi, [
    rpc("initialize", { protocolVersion: "2025-06-18" }, 1),
    { jsonrpc: "2.0", method: "notifications/initialized" },
    "",
    "this is not json",
    rpc("tools/call", { name: "queue_health", arguments: {} }, 2)
  ]);
  assert.equal(replies.length, 3);
  assert.equal(replies.find(reply => reply.id === 1).result.protocolVersion, "2025-06-18");
  assert.equal(replies.find(reply => reply.id === 2).result.isError, false);
  assert.equal(replies.find(reply => reply.id === null).error.code, -32700);
});

test("an unexpected failure while handling a line is an internal error reply", async () => {
  const replies = await converse(fakeQueue(json(200, {})).fetchApi, [
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "get_job", arguments: { id: JOB_ID } }, trap: 1 }
  ]);
  assert.equal(replies[0].id, 9);
  const original = Object.getOwnPropertyDescriptor(JSON, "parse");
  JSON.parse = () => {
    JSON.parse = original.value;
    throw new TypeError("boom");
  };
  try {
    const failed = await converse(fakeQueue(json(200, {})).fetchApi, [rpc("ping")]);
    assert.equal(failed[0].error.code, -32603);
  } finally {
    Object.defineProperty(JSON, "parse", original);
  }
});

test("end to end through the real REST API: ask for a download, read it back, watch, cancel", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pms-mcp-"));
  const tokenFile = path.join(home, "api-token");
  await writeFile(tokenFile, "tok-123\n");
  const jobs = [];
  const watched = [];
  const server = await startApiServer({
    port: 0,
    token: "tok-123",
    listJobs: async () => jobs,
    addUrls: async urls => {
      const created = { jobId: JOB_ID, status: "queued", platform: "Instagram", account: "a", url: urls[0] };
      jobs.push(created);
      return { created: [created], skipped: [] };
    },
    removeJob: async id => jobs.some(job => job.jobId === id),
    status: async () => ({ platforms: { instagram: { configuredWorkers: 1 } } }),
    watch: {
      list: async () => watched,
      add: async url => {
        watched.push(url);
        return { added: [url], existing: [] };
      },
      remove: async url => {
        watched.splice(watched.indexOf(url), 1);
      }
    }
  });
  try {
    const fetchApi = localApi({ port: server.address().port, tokenFile });
    const text = reply => JSON.parse(reply.result.content[0].text);
    const mcp = createMcpServer({ fetchApi });
    const made = await call(mcp, "download_account", { url: "https://www.instagram.com/a/" });
    assert.equal(made.result.isError, false);
    assert.equal(text(made).items[0].id, JOB_ID);
    assert.equal(text(await call(mcp, "get_job", { id: JOB_ID })).status, "queued");
    assert.equal(text(await call(mcp, "list_jobs", { status: "queued" })).page.total, 1);
    const watching = await call(mcp, "watch_account", { url: "https://www.instagram.com/a/" });
    assert.equal(text(watching).id, "instagram/a");
    assert.equal(text(await call(mcp, "list_watched")).items.length, 1);
    assert.equal(
      (await call(mcp, "unwatch_account", { platform: "instagram", account: "a" })).result.content[0].text,
      "Done."
    );
    assert.equal((await call(mcp, "cancel_job", { id: JOB_ID })).result.content[0].text, "Done.");
    const absent = await call(mcp, "get_job", { id: "55555555-5555-4555-8555-555555555555" });
    assert.match(absent.result.content[0].text, /^404 Not Found/);
    assert.equal(text(await call(mcp, "queue_health")).status, "ok");
    assert.equal(text(await call(mcp, "platform_health")).items.length, 4);
    assert.equal(text(await call(mcp, "queue_status")).platforms.instagram.configuredWorkers, 1);

    const wrong = createMcpServer({
      fetchApi: localApi({ port: server.address().port, tokenFile: tokenFile + ".missing" })
    });
    assert.match((await call(wrong, "queue_health")).result.content[0].text, /not reachable/);
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
