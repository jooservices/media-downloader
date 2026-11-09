import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { API_OPERATIONS, startApiServer } from "../../cli/api.mjs";
import { createMcpServer, localApi, TOOLS } from "../../cli/mcp.mjs";

const TOKEN = "contract-test-token";
const ID = "11111111-1111-4111-8111-111111111111";
const PROFILE_URL = "https://www.instagram.com/alice/";
const inputJob = { jobId: ID, status: "queued", platform: "Instagram", account: "alice", url: PROFILE_URL };

function dependencies() {
  const jobs = [inputJob];
  const watched = [];
  return {
    jobs,
    watched,
    addUrls: async urls => {
      const made = { ...inputJob, url: urls[0] };
      jobs.unshift(made);
      return { created: [made], skipped: [] };
    },
    listJobs: async () => jobs,
    removeJob: async id => jobs.some(job => job.jobId === id),
    watch: {
      list: async () => watched,
      add: async url => {
        if (watched.includes(url)) {
          return { added: [], existing: [url] };
        }
        watched.push(url);
        return { added: [url], existing: [] };
      },
      remove: async url => {
        const at = watched.indexOf(url);
        if (at >= 0) {
          watched.splice(at, 1);
        }
      }
    },
    status: async () => ({ jobs: { queued: jobs.length }, extension: { version: "test", at: null }, pid: 42 }),
    config: async () => ({ workers: { instagram: 1 }, delaySeconds: { min: 15, max: 60 }, maxAttempts: 3 })
  };
}

async function withAdapters(run) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pms-contract-"));
  const tokenFile = path.join(temp, "api-token");
  await writeFile(tokenFile, `${TOKEN}\n`);
  const deps = dependencies();
  const server = await startApiServer({ ...deps, port: 0, token: TOKEN });
  const base = `http://127.0.0.1:${server.address().port}`;
  const direct = async (method, endpoint, body) => {
    const response = await fetch(`${base}${endpoint}`, {
      method,
      headers: { Authorization: `Bearer ${TOKEN}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    const contentType = response.headers.get("content-type") || "";
    return {
      status: response.status,
      body: /json/i.test(contentType) ? await response.json() : await response.text(),
      contentType
    };
  };
  const mcp = createMcpServer({ fetchApi: localApi({ port: server.address().port, tokenFile }) });
  const tool = async (name, args = {}) => {
    const reply = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const result = reply.result;
    if (result.isError) {
      const match = /^(\d+) ([^:]+): (.*)$/.exec(result.content[0].text);
      return { status: Number(match?.[1] || 0), body: { title: match?.[2], detail: match?.[3] } };
    }
    if (result.content[0].text === "Done.") {
      const status = name === "cancel_job" || name === "unwatch_account" ? 204 : 0;
      return { status, body: null };
    }
    const text = result.content[0].text;
    try {
      return { status: name === "download_account" || name === "watch_account" ? 201 : 200, body: JSON.parse(text) };
    } catch {
      return { status: 200, body: text };
    }
  };
  try {
    await run({ direct, tool, watched: deps.watched });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
}

function assertSuccessContract(contract, operation) {
  const definition = contract.paths[operation.path][operation.method.toLowerCase()];
  let success = "200";
  if (operation.method === "POST") {
    success = "201";
  } else if (operation.method === "DELETE") {
    success = "204";
  }
  assert.ok(definition.operationId, `${operation.method} ${operation.path} operationId`);
  assert.ok(definition.responses[success], `${operation.method} ${operation.path} success response`);
  if (success === "204") {
    assert.equal(
      definition.responses[success].content,
      undefined,
      `${operation.method} ${operation.path} has no response body`
    );
    return;
  }
  const media = definition.responses[success].content;
  assert.ok(media && Object.keys(media).length, `${operation.method} ${operation.path} response media`);
  for (const { schema } of Object.values(media)) {
    assert.ok(schema?.$ref || schema?.type, `${operation.method} ${operation.path} response schema`);
    if (schema?.$ref) {
      const name = schema.$ref.split("/").at(-1);
      assert.ok(contract.components.schemas[name], `schema reference ${schema.$ref}`);
    }
  }
}

function expectedResponses(operation) {
  const statuses = new Set(["403", "405", "500"]);
  if (operation.method === "GET") {
    statuses.add("200");
  }
  if (operation.path !== "/v1/health") {
    statuses.add("401");
  }
  if (operation.method === "POST") {
    for (const code of ["201", "400", "409", "413", "415", "422"]) {
      statuses.add(code);
    }
  }
  if (operation.method === "GET" && operation.path === "/v1/jobs") {
    statuses.add("400");
  }
  if (operation.path === "/v1/watches") {
    statuses.add("404");
  }
  if (operation.path.includes("{id}") || operation.path.includes("{account}")) {
    statuses.add("404");
  }
  if (operation.method === "DELETE") {
    statuses.add("204");
  } else if (operation.method === "POST") {
    statuses.add("201");
  }
  return [...statuses].sort();
}

test("the OpenAPI document and REST route registry have exact operation parity", async () => {
  const contract = JSON.parse(await readFile(new URL("../../openapi.json", import.meta.url), "utf8"));
  const documented = Object.entries(contract.paths).flatMap(([route, pathItem]) =>
    Object.keys(pathItem)
      .filter(method => ["get", "post", "delete"].includes(method))
      .map(method => ({ method: method.toUpperCase(), path: route }))
  );
  assert.deepEqual(
    documented.sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`)),
    [...API_OPERATIONS].sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`))
  );
  for (const [route, pathItem] of Object.entries(contract.paths)) {
    assert.ok(pathItem.options?.responses["204"], `${route} documents HTTP OPTIONS`);
    if (pathItem.get) {
      assert.ok(pathItem.head?.responses["200"], `${route} documents HTTP HEAD`);
    }
  }
  for (const operation of API_OPERATIONS) {
    const definition = contract.paths[operation.path][operation.method.toLowerCase()];
    assert.deepEqual(
      Object.keys(definition.responses).sort(),
      expectedResponses(operation),
      `${operation.method} ${operation.path} response statuses`
    );
  }
  API_OPERATIONS.forEach(operation => assertSuccessContract(contract, operation));
  assert.equal(
    contract.paths["/v1/jobs"].post.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/CreateJob"
  );
  assert.equal(
    contract.paths["/v1/watches"].post.requestBody.content["application/json"].schema.$ref,
    "#/components/schemas/CreateWatch"
  );
  assert.equal(
    contract.paths["/v1/metrics"].get.responses["200"].content["text/plain; version=0.0.4"].schema.type,
    "string"
  );
  assert.deepEqual(contract.security, [{ bearerAuth: [] }]);
  assert.deepEqual(contract.paths["/v1/health"].get.security, []);
});

test("every REST operation is reachable through an MCP tool", () => {
  const args = {
    download_account: { url: PROFILE_URL },
    get_config: {},
    get_status: {},
    get_metrics: {},
    list_jobs: {},
    get_job: { id: ID },
    cancel_job: { id: ID },
    watch_account: { url: PROFILE_URL },
    list_watched: {},
    get_watched: { platform: "instagram", account: "alice" },
    unwatch_account: { platform: "instagram", account: "alice" },
    queue_health: {}
  };
  const mapped = TOOLS.map(tool => {
    const [method, requestPath] = tool.request(args[tool.name]);
    const route = requestPath
      .split("?")[0]
      .replace(new RegExp(ID, "g"), "{id}")
      .replace("/watches/instagram/alice", "/watches/{platform}/{account}");
    return { method, path: route };
  });
  assert.deepEqual(
    mapped.sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`)),
    [...API_OPERATIONS].sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`))
  );
});

test("the same REST and MCP scenarios produce equal data and mapped errors", () =>
  withAdapters(async ({ direct, tool, watched }) => {
    const cases = [
      [["GET", "/v1/config"], ["get_config"]],
      [["GET", "/v1/status"], ["get_status"]],
      [["GET", "/v1/health"], ["queue_health"]],
      [["GET", "/v1/jobs"], ["list_jobs"]],
      [
        ["GET", `/v1/jobs/${ID}`],
        ["get_job", { id: ID }]
      ],
      [
        ["POST", "/v1/jobs", { url: PROFILE_URL }],
        ["download_account", { url: PROFILE_URL }]
      ],
      [
        ["POST", "/v1/watches", { url: PROFILE_URL }],
        ["watch_account", { url: PROFILE_URL }]
      ],
      [["GET", "/v1/watches"], ["list_watched"]],
      [
        ["GET", "/v1/watches/instagram/alice"],
        ["get_watched", { platform: "instagram", account: "alice" }]
      ],
      [
        ["DELETE", `/v1/jobs/${ID}`],
        ["cancel_job", { id: ID }]
      ],
      [
        ["DELETE", "/v1/watches/instagram/alice"],
        ["unwatch_account", { platform: "instagram", account: "alice" }]
      ]
    ];
    for (const [[method, endpoint, body], [name, args]] of cases) {
      const rest = await direct(method, endpoint, body);
      if (name === "watch_account") {
        watched.splice(0);
      }
      if (name === "unwatch_account") {
        watched.push(PROFILE_URL);
      }
      const agent = await tool(name, args);
      assert.equal(agent.status, rest.status, `${name} status`);
      if (rest.status === 204) {
        continue;
      }
      assert.deepEqual(agent.body, rest.body, `${name} response body`);
    }
    const restError = await direct("GET", "/v1/jobs/55555555-5555-4555-8555-555555555555");
    const mcpError = await tool("get_job", { id: "55555555-5555-4555-8555-555555555555" });
    assert.equal(mcpError.status, restError.status);
    assert.equal(mcpError.body.title, restError.body.title);
    assert.equal(mcpError.body.detail, restError.body.detail);
  }));
