import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { API_OPERATIONS, startApiServer } from "../../cli/api.mjs";
import { createMcpServer, localApi, TOOLS } from "../../cli/mcp.mjs";

const TOKEN = "contract-test-token";
const ID = "abcdefab-cdef-4abc-8def-abcdefabcdef";
const PROFILE_URL = "https://www.instagram.com/alice/";
const inputJob = { jobId: ID, status: "queued", platform: "Instagram", account: "alice", url: PROFILE_URL };

function dependencies() {
  const jobs = [inputJob];
  const watched = [];
  return {
    jobs,
    watched,
    addUrls: async (urls, options) => {
      if (urls[0].includes("known") && !options.force) {
        return { created: [], skipped: [{ raw: urls[0], reason: "already queued or done" }] };
      }
      if (urls[0].includes("nope")) {
        return { created: [], skipped: [{ raw: urls[0], reason: "Use an Instagram/Facebook/X profile URL." }] };
      }
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
    config: async () => ({
      workers: { instagram: 1 },
      delaySeconds: { min: 15, max: 60 },
      maxAttempts: 3,
      limit: null,
      downloadDir: null,
      notify: null
    })
  };
}

async function withAdapters(run) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "pms-contract-"));
  const tokenFile = path.join(temp, "api-token");
  await writeFile(tokenFile, `${TOKEN}\n`);
  const deps = dependencies();
  const server = await startApiServer({ ...deps, port: 0, token: TOKEN });
  const base = `http://127.0.0.1:${server.address().port}`;
  const direct = async (method, endpoint, body, options = {}) => {
    let requestBody;
    if (body !== undefined) {
      requestBody = typeof body === "string" ? body : JSON.stringify(body);
    }
    const response = await fetch(`${base}${endpoint}`, {
      method,
      headers: {
        ...(options.auth === false ? {} : { Authorization: `Bearer ${TOKEN}` }),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      },
      body: requestBody
    });
    const contentType = response.headers.get("content-type") || "";
    let responseBody = null;
    if (response.status !== 204 && method !== "HEAD") {
      responseBody = /json/i.test(contentType) ? await response.json() : await response.text();
    }
    return {
      status: response.status,
      body: responseBody,
      contentType,
      headers: response.headers
    };
  };
  let observed;
  const actualFetch = localApi({ port: server.address().port, tokenFile });
  const mcp = createMcpServer({
    fetchApi: async (...args) => {
      const response = await actualFetch(...args);
      observed = {
        status: response.status,
        headers: response.headers,
        body: await response
          .clone()
          .json()
          .catch(() => response.clone().text())
      };
      return response;
    }
  });
  const tool = async (name, args = {}) => {
    const reply = await mcp.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    const result = reply.result;
    if (result.isError) {
      const match = /^(\d+) ([^:]+): (.*)$/.exec(result.content[0].text);
      return {
        status: match ? Number(match[1]) : null,
        body: match ? { title: match[2], detail: match[3] } : { detail: result.content[0].text }
      };
    }
    if (result.content[0].text === "Done.") {
      return { status: observed.status, body: null };
    }
    const text = result.content[0].text;
    try {
      return { status: observed.status, body: JSON.parse(text) };
    } catch {
      return { status: observed.status, body: text };
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

function matchesType(type, value) {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return Boolean(value) && typeof value === "object" && !Array.isArray(value);
    case "integer":
      return Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    default:
      return typeof value === type;
  }
}

function validateStringSchema(schema, value, label) {
  if (schema.minLength !== undefined) {
    assert.ok(value.length >= schema.minLength, `${label} minLength`);
  }
  if (schema.maxLength !== undefined) {
    assert.ok(value.length <= schema.maxLength, `${label} maxLength`);
  }
  if (schema.pattern) {
    assert.match(value, new RegExp(schema.pattern), `${label} pattern`);
  }
  if (schema.format === "uri") {
    assert.doesNotThrow(() => new URL(value), `${label} uri`);
  }
  if (schema.format === "uuid") {
    assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, `${label} uuid`);
  }
  if (schema.format === "date-time") {
    assert.ok(Number.isFinite(Date.parse(value)), `${label} date-time`);
  }
}

function validateObjectSchema(contract, schema, value, label) {
  for (const key of schema.required || []) {
    assert.ok(Object.hasOwn(value, key), `${label}.${key} required`);
  }
  for (const [key, child] of Object.entries(value)) {
    let childSchema = schema.properties?.[key];
    if (!childSchema && schema.additionalProperties && typeof schema.additionalProperties === "object") {
      childSchema = schema.additionalProperties;
    }
    if (childSchema) {
      validateSchema(contract, childSchema, child, `${label}.${key}`);
    } else if (schema.additionalProperties === false) {
      assert.fail(`${label}.${key} is not allowed`);
    }
  }
}

function validateNumberSchema(schema, value, label) {
  if (schema.minimum !== undefined) {
    assert.ok(value >= schema.minimum, `${label} minimum`);
  }
  if (schema.maximum !== undefined) {
    assert.ok(value <= schema.maximum, `${label} maximum`);
  }
}

function validateArraySchema(contract, schema, value, label) {
  if (schema.minItems !== undefined) {
    assert.ok(value.length >= schema.minItems, `${label} minItems`);
  }
  if (schema.maxItems !== undefined) {
    assert.ok(value.length <= schema.maxItems, `${label} maxItems`);
  }
  if (schema.uniqueItems) {
    assert.equal(new Set(value.map(item => JSON.stringify(item))).size, value.length, `${label} uniqueItems`);
  }
  if (schema.items) {
    value.forEach((item, index) => validateSchema(contract, schema.items, item, `${label}[${index}]`));
  }
}

function validateCompositions(contract, schema, value, label) {
  if (schema.allOf) {
    schema.allOf.forEach(item => validateSchema(contract, item, value, label));
  }
  for (const keyword of ["anyOf", "oneOf"]) {
    if (schema[keyword]) {
      const matches = schema[keyword].filter(item => {
        try {
          validateSchema(contract, item, value, label);
          return true;
        } catch {
          return false;
        }
      }).length;
      assert.equal(matches > 0, true, `${label} ${keyword}`);
      if (keyword === "oneOf") {
        assert.equal(matches, 1, `${label} oneOf`);
      }
    }
  }
}

function validateSchema(contract, schema, value, label) {
  if (schema.$ref) {
    const name = schema.$ref.split("/").at(-1);
    validateSchema(contract, contract.components.schemas[name], value, label);
    return;
  }
  validateCompositions(contract, schema, value, label);
  if (schema.not) {
    assert.throws(() => validateSchema(contract, schema.not, value, label), `${label} not`);
  }
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert.ok(
      types.some(type => matchesType(type, value)),
      `${label} expected ${types.join(" or ")}, received ${JSON.stringify(value)}`
    );
  }
  if (schema.const !== undefined) {
    assert.equal(value, schema.const, `${label} const`);
  }
  if (schema.enum) {
    assert.ok(schema.enum.includes(value), `${label} enum`);
  }
  if (typeof value === "string") {
    validateStringSchema(schema, value, label);
  }
  if (typeof value === "number") {
    validateNumberSchema(schema, value, label);
  }
  if (Array.isArray(value)) {
    validateArraySchema(contract, schema, value, label);
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    validateObjectSchema(contract, schema, value, label);
  }
}

function routePath(route, id = ID) {
  return route.replace("{id}", id).replace("{platform}", "instagram").replace("{account}", "alice");
}

async function assertDocumentedResponse(contract, response, method, route) {
  const pathItem = contract.paths[route];
  const operation = pathItem[method.toLowerCase()];
  assert.ok(operation, `${method} ${route} is documented`);
  let definition = operation.responses[String(response.status)];
  assert.ok(definition, `${method} ${route} status ${response.status} is documented`);
  if (definition.$ref) {
    definition = contract.components.responses[definition.$ref.split("/").at(-1)];
  }
  for (const [name, headerDefinition] of Object.entries(definition.headers || {})) {
    const actual = response.headers.get(name.toLowerCase());
    assert.notEqual(actual, null, `${method} ${route} ${name} header`);
    if (headerDefinition.schema) {
      validateSchema(contract, headerDefinition.schema, actual, `${method} ${route} ${name} header`);
    }
  }
  if (method === "OPTIONS") {
    assert.equal(response.status, 204);
    assert.ok(response.headers.get("allow"), `${route} Allow header`);
    assert.equal(response.body, null);
    return;
  }
  if (method === "HEAD" || response.status === 204) {
    assert.equal(response.body, null, `${method} ${route} has no body`);
    return;
  }
  const media = definition.content;
  assert.ok(media, `${method} ${route} response content is documented`);
  assert.ok(
    Object.hasOwn(media, response.contentType.split(";")[0]) ||
      Object.keys(media).includes(response.contentType.split("; charset")[0]),
    `${method} ${route} content type ${response.contentType}`
  );
  const mediaDefinition = Object.entries(media).find(([type]) => response.contentType.startsWith(type));
  assert.ok(mediaDefinition, `${method} ${route} content type matches OpenAPI`);
  validateSchema(contract, mediaDefinition[1].schema, response.body, `${method} ${route} response`);
  if (mediaDefinition[0] === "application/problem+json") {
    assert.equal(response.body.status, response.status, `${method} ${route} problem status matches HTTP status`);
  }
}

test("live REST responses match OpenAPI statuses, headers, media types, and schemas", async () => {
  const contract = JSON.parse(await readFile(new URL("../../openapi.json", import.meta.url), "utf8"));
  await withAdapters(async ({ direct }) => {
    const requests = [
      ["GET", "/v1/config"],
      ["GET", "/v1/status"],
      ["GET", "/v1/metrics"],
      ["GET", "/v1/health"],
      ["GET", "/v1/jobs"],
      ["POST", "/v1/jobs", { url: PROFILE_URL }],
      ["GET", `/v1/jobs/${ID}`],
      ["DELETE", `/v1/jobs/${ID}`],
      ["GET", "/v1/watches"],
      ["POST", "/v1/watches", { url: PROFILE_URL }],
      ["GET", "/v1/watches/instagram/alice"],
      ["DELETE", "/v1/watches/instagram/alice"]
    ];
    for (const [method, endpoint, body] of requests) {
      const route = endpoint.replace(ID, "{id}").replace("instagram/alice", "{platform}/{account}");
      if (body !== undefined) {
        const operation = contract.paths[route][method.toLowerCase()];
        const requestSchema = operation.requestBody.content["application/json"].schema;
        validateSchema(contract, requestSchema, body, `${method} ${route} request`);
      }
      const response = await direct(method, endpoint, body);
      await assertDocumentedResponse(contract, response, method, route);
      if (response.status === 201) {
        assert.ok(response.headers.get("location"), `${method} ${route} Location header`);
      }
      if (method === "GET" && route === "/v1/metrics") {
        assert.match(response.contentType, /^text\/plain; version=0\.0\.4/);
      }
    }
    for (const [route, pathItem] of Object.entries(contract.paths)) {
      const options = await direct("OPTIONS", routePath(route));
      await assertDocumentedResponse(contract, options, "OPTIONS", route);
      if (pathItem.get) {
        const head = await direct("HEAD", routePath(route));
        await assertDocumentedResponse(contract, head, "HEAD", route);
        assert.ok(head.contentType, `${route} HEAD content type`);
        assert.deepEqual(Object.keys(pathItem.head.responses).sort(), Object.keys(pathItem.get.responses).sort());
      }
    }
    const invalidRequests = [
      ["/v1/jobs", { again: true }, 422],
      ["/v1/jobs", { url: "http://www.instagram.com/alice/" }, 422],
      ["/v1/jobs", { url: PROFILE_URL, extra: true }, 422],
      ["/v1/jobs", { url: PROFILE_URL, again: "yes" }, 422],
      ["/v1/watches", { url: PROFILE_URL, extra: true }, 422]
    ];
    for (const [endpoint, body, expectedStatus] of invalidRequests) {
      const operation = contract.paths[endpoint].post;
      const requestSchema = operation.requestBody.content["application/json"].schema;
      assert.throws(() => validateSchema(contract, requestSchema, body, `${endpoint} invalid request`));
      const response = await direct("POST", endpoint, body);
      assert.equal(response.status, expectedStatus, `${endpoint} ${JSON.stringify(body)}`);
      await assertDocumentedResponse(contract, response, "POST", endpoint);
    }
    const headFailure = await direct("HEAD", "/v1/jobs?limit=0");
    assert.equal(headFailure.status, 400);
    await assertDocumentedResponse(contract, headFailure, "HEAD", "/v1/jobs");
    const failures = [
      ["GET", "/v1/jobs?limit=0", undefined, 400],
      ["GET", "/v1/jobs/55555555-5555-4555-8555-555555555555", undefined, 404],
      ["POST", "/v1/jobs", { url: "https://www.instagram.com/known/" }, 409],
      ["POST", "/v1/jobs", { url: "https://x.com/nope" }, 422],
      ["POST", "/v1/jobs", `{"url":"https://x.com/${"a".repeat(9000)}"}`, 413]
    ];
    for (const [method, endpoint, body, expectedStatus] of failures) {
      const response = await direct(method, endpoint, body);
      assert.equal(response.status, expectedStatus, `${method} ${endpoint}`);
      const route = endpoint.split("?")[0].replace(/\/v1\/jobs\/[0-9a-f-]{36}$/i, "/v1/jobs/{id}");
      await assertDocumentedResponse(contract, response, method, route);
    }
    const unauthorized = await direct("GET", "/v1/jobs", undefined, { auth: false });
    assert.equal(unauthorized.status, 401);
    await assertDocumentedResponse(contract, unauthorized, "GET", "/v1/jobs");
  });
});

test("the OpenAPI document and REST route registry have exact operation parity", async () => {
  const contract = JSON.parse(await readFile(new URL("../../openapi.json", import.meta.url), "utf8"));
  const documented = Object.entries(contract.paths).flatMap(([route, pathItem]) =>
    Object.keys(pathItem)
      .filter(method =>
        ["get", "post", "delete", "put", "patch", "options", "head", "trace", "connect"].includes(method)
      )
      .map(method => ({ method: method.toUpperCase(), path: route }))
  );
  const expectedDocumented = [
    ...API_OPERATIONS,
    ...Object.entries(contract.paths).flatMap(([route, pathItem]) => [
      { method: "OPTIONS", path: route },
      ...(pathItem.get ? [{ method: "HEAD", path: route }] : [])
    ])
  ];
  assert.deepEqual(
    documented.sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`)),
    expectedDocumented.sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`))
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
  for (const pathItem of Object.values(contract.paths)) {
    if (pathItem.head && pathItem.get) {
      assert.deepEqual(Object.keys(pathItem.head.responses).sort(), Object.keys(pathItem.get.responses).sort());
    }
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
  const idSchema = TOOLS.find(tool => tool.name === "get_job").inputSchema.properties.id;
  assert.match(ID.toUpperCase(), new RegExp(idSchema.pattern));
});

test("the same REST and MCP scenarios produce equal data and mapped errors", () =>
  withAdapters(async ({ direct, tool, watched }) => {
    const cases = [
      [["GET", "/v1/config"], ["get_config"]],
      [["GET", "/v1/status"], ["get_status"]],
      [["GET", "/v1/metrics"], ["get_metrics"]],
      [["GET", "/v1/health"], ["queue_health"]],
      [["GET", "/v1/jobs"], ["list_jobs"]],
      [
        ["GET", `/v1/jobs/${ID.toUpperCase()}`],
        ["get_job", { id: ID.toUpperCase() }]
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
        ["DELETE", `/v1/jobs/${ID.toUpperCase()}`],
        ["cancel_job", { id: ID.toUpperCase() }]
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

    for (const url of ["https://www.instagram.com/known/", "https://x.com/nope"]) {
      const rest = await direct("POST", "/v1/jobs", { url });
      const agent = await tool("download_account", { url });
      assert.equal(agent.status, rest.status, `${url} status`);
      assert.equal(agent.body.title, rest.body.title, `${url} title`);
      assert.equal(agent.body.detail, rest.body.detail, `${url} detail`);
    }
    const invalidInputs = [
      [{}, {}],
      [[], []],
      [{ url: 23 }, { url: 23 }],
      [{ url: "http://www.instagram.com/alice/" }, { url: "http://www.instagram.com/alice/" }],
      [
        { url: PROFILE_URL, extra: true },
        { url: PROFILE_URL, extra: true }
      ],
      [
        { url: PROFILE_URL, again: "yes" },
        { url: PROFILE_URL, again: "yes" }
      ]
    ];
    for (const [body, args] of invalidInputs) {
      const rest = await direct("POST", "/v1/jobs", body);
      const agent = await tool("download_account", args);
      assert.equal(agent.status, rest.status, `invalid MCP arguments ${JSON.stringify(args)}`);
      assert.equal(agent.body.title, rest.body.title, `invalid MCP arguments ${JSON.stringify(args)} title`);
      assert.match(agent.body.detail, /.+/, `invalid MCP arguments ${JSON.stringify(args)} detail`);
    }
    const hugeUrl = `https://x.com/${"a".repeat(9000)}`;
    const oversizedRest = await direct("POST", "/v1/jobs", { url: hugeUrl });
    const oversizedMcp = await tool("download_account", { url: hugeUrl });
    assert.equal(oversizedRest.status, 413);
    assert.equal(oversizedMcp.status, oversizedRest.status);
    assert.equal(oversizedMcp.body.title, oversizedRest.body.title);
    assert.equal(oversizedMcp.body.detail, oversizedRest.body.detail);
  }));
