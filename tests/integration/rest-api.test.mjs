import assert from "node:assert/strict";
import { request } from "node:http";
import test from "node:test";
import { startApiServer, watchViews } from "../../cli/api.mjs";

const TOKEN = "s3cret";
const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";
const ID_C = "33333333-3333-4333-8333-333333333333";
const ALICE = "https://www.instagram.com/alice/";
const BOB_FB = "https://www.facebook.com/bob/";

const job = (jobId, status, extra = {}) => ({
  jobId,
  status,
  platform: "Instagram",
  account: "alice",
  url: ALICE,
  message: "",
  started: 2,
  pending: 1,
  failed: 0,
  skipped: 3,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:01:00.000Z",
  cookie: "must-not-leak",
  ...extra
});

// A fake queue behind the API: everything the server needs, kept in memory.
function backend() {
  const state = {
    jobs: [job(ID_A, "complete"), job(ID_B, "running"), job(ID_C, "error")],
    watched: [],
    removed: [],
    asked: []
  };
  const reads = [];
  return {
    state,
    reads,
    deps: {
      listJobs: async options => {
        reads.push(options);
        const selected = state.jobs.filter(item => !options?.status || item.status === options.status);
        return options?.limit ? selected.slice(options.offset || 0, (options.offset || 0) + options.limit) : selected;
      },
      countJobs: async status => state.jobs.filter(item => !status || item.status === status).length,
      getJob: async id => state.jobs.find(item => item.jobId === id) || null,
      addUrls: async (urls, options) => {
        state.asked.push([urls[0], options]);
        if (urls[0].includes("known") && !options.force) {
          return { created: [], skipped: [{ raw: urls[0], reason: "already queued or done" }] };
        }
        if (urls[0].includes("nope")) {
          return { created: [], skipped: [{ raw: urls[0], reason: "Use an Instagram/Facebook/X profile URL." }] };
        }
        return { created: [job(ID_A, "queued", { jobId: "44444444-4444-4444-8444-444444444444" })], skipped: [] };
      },
      removeJob: async id => {
        state.removed.push(id);
        return state.jobs.some(item => item.jobId === id);
      },
      watch: {
        list: async () => state.watched,
        add: async url => {
          if (url.includes("bad")) {
            throw new Error("Use an Instagram/Facebook/X profile URL.");
          }
          const known = state.watched.includes(url);
          if (!known) {
            state.watched.push(url);
          }
          return { added: known ? [] : [url], existing: known ? [url] : [] };
        },
        remove: async url => {
          state.watched = state.watched.filter(item => item !== url);
        }
      }
    }
  };
}

function encodeBody(body) {
  if (body === undefined) {
    return undefined;
  }
  return typeof body === "string" ? body : JSON.stringify(body);
}

async function withServer(options, run) {
  const { state, deps, reads } = backend();
  const server = await startApiServer({ port: 0, token: TOKEN, ...deps, ...options });
  const port = server.address().port;
  const call = (method, path, { body, headers = {}, host, auth = true, json = true } = {}) =>
    new Promise((resolve, reject) => {
      const sent = {
        host: host || `127.0.0.1:${port}`,
        ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
        ...(body !== undefined && json ? { "content-type": "application/json" } : {}),
        ...headers
      };
      const req = request({ hostname: "127.0.0.1", port, method, path, headers: sent }, response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString();
          resolve({
            status: response.statusCode,
            headers: response.headers,
            text,
            body: /json/.test(response.headers["content-type"] || "") && text ? JSON.parse(text) : null
          });
        });
      });
      req.on("error", reject);
      req.end(encodeBody(body));
    });
  try {
    await run({ call, state, reads, port });
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
  }
}

test("health needs no token; everything else answers 401 with WWW-Authenticate", () =>
  withServer({}, async ({ call }) => {
    const health = await call("GET", "/v1/health", { auth: false });
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { status: "ok" });
    const denied = await call("GET", "/v1/jobs", { auth: false });
    assert.equal(denied.status, 401);
    assert.match(denied.headers["www-authenticate"], /^Bearer/);
    assert.match(denied.headers["content-type"], /^application\/problem\+json/);
    assert.equal(denied.body.status, 401);
    const wrong = await call("GET", "/v1/jobs", { headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
    const short = await call("GET", "/v1/jobs", { headers: { authorization: "x" } });
    assert.equal(short.status, 401);
  }));

test("a request for another host or Origin is refused, and unknown resources are 404 problems", () =>
  withServer({}, async ({ call }) => {
    assert.equal((await call("GET", "/v1/health", { host: "evil.example" })).status, 403);
    const origin = await call("GET", "/v1/health", { headers: { origin: "https://attacker.example" } });
    assert.equal(origin.status, 403);
    assert.equal(origin.headers["access-control-allow-origin"], undefined);
    const missing = await call("GET", "/v1/nothing");
    assert.equal(missing.status, 404);
    assert.equal(missing.body.title, "Not Found");
    assert.equal((await call("GET", "/health")).status, 404, "the old unversioned path is gone");
  }));

test("GET /v1/jobs lists bounded pages, filters by status and links the next page", () =>
  withServer({}, async ({ call, reads }) => {
    const all = await call("GET", "/v1/jobs");
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.page, { limit: 50, offset: 0, total: 3 });
    assert.equal(all.body.items[0].id, ID_A);
    assert.equal(all.body.items[0].counts.skipped, 3);
    assert.equal(all.body.items[0].links.self, `/v1/jobs/${ID_A}`);
    assert.equal(all.body.items[0].cookie, undefined, "no internal field leaks");
    assert.equal(all.headers.link, undefined);
    assert.deepEqual(
      reads[0],
      { status: null, limit: 50, offset: 0 },
      "the backing read is capped at the requested page"
    );
    const running = await call("GET", "/v1/jobs?status=running");
    assert.deepEqual(
      running.body.items.map(item => item.id),
      [ID_B]
    );
    const paged = await call("GET", "/v1/jobs?limit=2&offset=0");
    assert.equal(paged.body.items.length, 2);
    assert.equal(paged.headers.link, '</v1/jobs?limit=2&offset=2>; rel="next"');
    const filtered = await call("GET", "/v1/jobs?limit=1&status=complete");
    assert.equal(filtered.headers.link, undefined);
    for (const query of ["limit=0", "limit=101", "limit=x", "offset=-1", "status=bogus"]) {
      const bad = await call("GET", `/v1/jobs?${query}`);
      assert.equal(bad.status, 400, query);
      assert.match(bad.headers["content-type"], /problem\+json/);
    }
    assert.equal((await call("GET", "/v1/jobs?limit=1&limit=2")).status, 400);
    assert.equal((await call("GET", "/v1/jobs?unknown=yes")).status, 400);
  }));

test("HEAD /v1/jobs accepts the same filtered and paginated queries as GET", () =>
  withServer({}, async ({ call }) => {
    const get = await call("GET", "/v1/jobs?status=complete&limit=1&offset=0");
    const head = await call("HEAD", "/v1/jobs?status=complete&limit=1&offset=0");
    assert.equal(get.status, 200);
    assert.equal(head.status, get.status);
    assert.equal(head.text, "");
    assert.equal(head.headers.link, get.headers.link);
  }));

test("GET /v1/jobs/{id} returns one job or a 404; HEAD has no body", () =>
  withServer({}, async ({ call, state }) => {
    state.jobs.find(item => item.jobId === ID_B).message = "Download finished. 3 from the grid, 2 opened.";
    const one = await call("GET", `/v1/jobs/${ID_B}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.status, "running");
    assert.match(one.body.message, /3 from the grid, 2 opened/);
    assert.equal((await call("GET", "/v1/jobs/55555555-5555-4555-8555-555555555555")).status, 404);
    const head = await call("HEAD", `/v1/jobs/${ID_B}`);
    assert.equal(head.status, 200);
    assert.equal(head.text, "");
    assert.equal((await call("GET", "/v1/jobs/not-an-id")).status, 404);
  }));

test("POST /v1/jobs creates a job: 201 with Location; a known account is a 409 unless asked again", () =>
  withServer({}, async ({ call, state }) => {
    const created = await call("POST", "/v1/jobs", { body: { url: "https://www.instagram.com/name/?e=1" } });
    assert.equal(created.status, 201);
    assert.equal(created.headers.location, "/v1/jobs/44444444-4444-4444-8444-444444444444");
    assert.equal(created.body.items[0].status, "queued");
    assert.deepEqual(state.asked[0], ["https://www.instagram.com/name/?e=1", { force: false }]);
    const again = await call("POST", "/v1/jobs", { body: { url: "https://www.instagram.com/known/", again: true } });
    assert.equal(again.status, 201);
    assert.deepEqual(state.asked[1][1], { force: true });
    const known = await call("POST", "/v1/jobs", { body: { url: "https://www.instagram.com/known/" } });
    assert.equal(known.status, 409);
    assert.match(known.body.detail, /again/);
    const refused = await call("POST", "/v1/jobs", { body: { url: "https://x.com/nope" } });
    assert.equal(refused.status, 422);
    assert.equal(refused.body.detail, "Use an Instagram/Facebook/X profile URL.");
    for (const url of [
      "https://attacker.example/name",
      "https://127.0.0.1/private",
      "http://x.com/name",
      "https://x.com/",
      "https://user:pass@x.com/name",
      "https://x.com:8443/name"
    ]) {
      assert.equal((await call("POST", "/v1/jobs", { body: { url } })).status, 422, url);
    }
    assert.equal((await call("POST", "/v1/jobs", { body: { url: ALICE, extra: true } })).status, 422);
    assert.equal((await call("POST", "/v1/jobs", { body: { url: ALICE, again: "yes" } })).status, 422);
  }));

test("POST validates the body: 400 for bad JSON, 413 for a huge one, 415 for another type, 422 for wrong values", () =>
  withServer({}, async ({ call }) => {
    assert.equal((await call("POST", "/v1/jobs", { body: "{not json" })).status, 400);
    assert.equal((await call("POST", "/v1/jobs", { body: "" })).status, 400);
    assert.equal((await call("POST", "/v1/jobs", { body: "[1]" })).status, 422);
    assert.equal((await call("POST", "/v1/jobs", { body: "null" })).status, 422);
    assert.equal((await call("POST", "/v1/jobs", { body: {} })).status, 422);
    assert.equal((await call("POST", "/v1/jobs", { body: { url: "http://x.com/a" } })).status, 422);
    assert.equal((await call("POST", "/v1/jobs", { body: { url: 5 } })).status, 422);
    const huge = await call("POST", "/v1/jobs", {
      body: JSON.stringify({ url: `https://x.com/${"a".repeat(9000)}` })
    }).catch(error => ({ status: error.code }));
    assert.equal(huge.status, 413);
    const text = await call("POST", "/v1/jobs", {
      body: '{"url":"https://x.com/a"}',
      headers: { "content-type": "text/plain" }
    });
    assert.equal(text.status, 415);
    const none = await call("POST", "/v1/jobs", { body: '{"url":"https://x.com/a"}', json: false });
    assert.equal(none.status, 415);
    const suffix = await call("POST", "/v1/jobs", {
      body: { url: ALICE },
      headers: { "content-type": "application/json-malicious" }
    });
    assert.equal(suffix.status, 415);
    const structuredSuffix = await call("POST", "/v1/jobs", {
      body: { url: ALICE },
      headers: { "content-type": "application/json+foo" }
    });
    assert.equal(structuredSuffix.status, 415);
    const charset = await call("POST", "/v1/jobs", {
      body: { url: ALICE },
      headers: { "content-type": "application/json; charset=utf-8" }
    });
    assert.equal(charset.status, 201);
  }));

test("DELETE /v1/jobs/{id} answers 204 for a known job and 404 for an unknown one", () =>
  withServer({}, async ({ call, state }) => {
    const gone = await call("DELETE", `/v1/jobs/${ID_B}`);
    assert.equal(gone.status, 204);
    assert.equal(gone.text, "");
    assert.deepEqual(state.removed, [ID_B]);
    assert.equal((await call("DELETE", "/v1/jobs/55555555-5555-4555-8555-555555555555")).status, 404);
  }));

test("a method the resource does not offer is 405 with Allow; OPTIONS lists the methods", () =>
  withServer({}, async ({ call }) => {
    const put = await call("PUT", "/v1/jobs", { body: {} });
    assert.equal(put.status, 405);
    assert.equal(put.headers.allow, "OPTIONS, HEAD, GET, POST");
    const post = await call("POST", `/v1/jobs/${ID_A}`, { body: {} });
    assert.equal(post.status, 405);
    assert.equal(post.headers.allow, "OPTIONS, HEAD, GET, DELETE");
    assert.equal((await call("DELETE", "/v1/jobs")).status, 405);
    const health = await call("POST", "/v1/health", { body: {} });
    assert.equal(health.status, 405);
    assert.equal(health.headers.allow, "OPTIONS, HEAD, GET");
    const healthWithoutType = await call("POST", "/v1/health");
    assert.equal(healthWithoutType.status, 405);
    assert.equal(healthWithoutType.headers.allow, "OPTIONS, HEAD, GET");
    const putWithQuery = await call("PUT", "/v1/jobs?limit=1");
    assert.equal(putWithQuery.status, 405);
    assert.equal(putWithQuery.headers.allow, "OPTIONS, HEAD, GET, POST");
    const options = await call("OPTIONS", "/v1/jobs");
    assert.equal(options.status, 204);
    assert.equal(options.headers.allow, "OPTIONS, HEAD, GET, POST");
    assert.equal(options.headers["access-control-allow-origin"], undefined, "no CORS");
  }));

test("an IPv6 loopback bind accepts its bracketed Host header", async () => {
  const { deps } = backend();
  const server = await startApiServer({ port: 0, bind: "::1", token: TOKEN, ...deps });
  const { port } = server.address();
  try {
    const result = await new Promise((resolve, reject) => {
      const req = request(
        { hostname: "::1", port, path: "/v1/health", headers: { host: `[::1]:${port}` } },
        response => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(result, 200);
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
  }
});

test("watches: create (201 + Location), conflict, list, get, delete", () =>
  withServer({}, async ({ call, state }) => {
    const created = await call("POST", "/v1/watches", { body: { url: ALICE } });
    assert.equal(created.status, 201);
    assert.equal(created.headers.location, "/v1/watches/instagram/alice");
    assert.deepEqual(created.body.pages, [ALICE]);
    assert.equal((await call("POST", "/v1/watches", { body: { url: ALICE } })).status, 409);
    const rejected = await call("POST", "/v1/watches", { body: { url: "https://x.com/bad" } });
    assert.equal(rejected.status, 500);
    assert.equal(rejected.body.detail, "The request failed.", "backend error details stay private");
    assert.equal((await call("POST", "/v1/watches", { body: "nope" })).status, 400);
    assert.equal((await call("POST", "/v1/watches", { body: {} })).status, 422);

    const list = await call("GET", "/v1/watches");
    assert.equal(list.status, 200);
    assert.equal(list.body.page.total, 1);
    assert.equal(list.body.items[0].id, "instagram/alice");

    const one = await call("GET", "/v1/watches/instagram/alice");
    assert.equal(one.status, 200);
    assert.equal(one.body.account, "alice");
    assert.equal((await call("GET", "/v1/watches/instagram/ALICE")).status, 200, "accounts are case-insensitive");
    assert.equal((await call("GET", "/v1/watches/instagram/zed")).status, 404);

    assert.equal((await call("DELETE", "/v1/watches/instagram/alice")).status, 204);
    assert.deepEqual(state.watched, []);
    assert.equal((await call("DELETE", "/v1/watches/instagram/alice")).status, 404);
    assert.equal((await call("PUT", "/v1/watches/instagram/alice", { body: {} })).status, 405);
  }));

test("encoded watch account identifiers round-trip through their self links", () =>
  withServer({}, async ({ call }) => {
    const created = await call("POST", "/v1/watches", {
      body: { url: "https://www.facebook.com/%E4%BD%A0%E5%A5%BD/" }
    });
    assert.equal(created.status, 201);
    const self = created.body.links.self;
    assert.equal(created.headers.location, self);
    assert.equal((await call("GET", self)).status, 200);
    const list = await call("GET", "/v1/watches");
    assert.equal(list.body.items[0].links.self, self);
    assert.equal((await call("DELETE", self)).status, 204);
  }));

test("punctuated watch identifiers round-trip through their self links", () =>
  withServer({}, async ({ call }) => {
    const created = await call("POST", "/v1/watches", {
      body: { url: "https://www.facebook.com/a!b/" }
    });
    assert.equal(created.status, 201);
    const self = created.body.links.self;
    assert.equal(created.headers.location, self);
    const list = await call("GET", "/v1/watches");
    assert.equal(list.body.items[0].links.self, self);
    assert.equal((await call("GET", self)).status, 200);
    assert.equal((await call("DELETE", self)).status, 204);
  }));

test("an account with several pages is one watch, removed in one call", () =>
  withServer({}, async ({ call, state }) => {
    state.watched.push(BOB_FB, `${BOB_FB}photos/`, `${BOB_FB}reels/`);
    const one = await call("GET", "/v1/watches/facebook/bob");
    assert.equal(one.body.pages.length, 3);
    assert.equal((await call("DELETE", "/v1/watches/facebook/bob")).status, 204);
    assert.deepEqual(state.watched, []);
  }));

test("without a watch list the watch resources do not exist", () =>
  withServer({ watch: null }, async ({ call }) => {
    assert.equal((await call("GET", "/v1/watches")).status, 404);
  }));

test("watchViews skips links that are not profile pages", () => {
  assert.deepEqual(watchViews(["https://example.com/x", "not a url"]), []);
});

test("a server error is a 500 problem and the token is optional when none is set", async () => {
  const server = await startApiServer({
    port: 0,
    addUrls: async () => ({ created: [], skipped: [] }),
    listJobs: async () => {
      throw new Error("disk gone");
    }
  });
  const port = server.address().port;
  try {
    const result = await new Promise((resolve, reject) => {
      const req = request(
        { hostname: "127.0.0.1", port, path: "/v1/jobs", headers: { host: `127.0.0.1:${port}` } },
        response => {
          const chunks = [];
          response.on("data", chunk => chunks.push(chunk));
          response.on("end", () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
        }
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(result.status, 500);
    assert.equal(result.body.detail, "The request failed.", "the cause stays in the process");
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
  }
});

test("a port already in use is reported clearly", async () => {
  const first = await startApiServer({ port: 0, addUrls: async () => ({}), listJobs: async () => [] });
  try {
    await assert.rejects(
      startApiServer({ port: first.address().port, addUrls: async () => ({}), listJobs: async () => [] }),
      /already in use/
    );
  } finally {
    await new Promise(resolve => first.close(() => resolve()));
  }
});

test("GET /v1/status reports uptime and what the queue tells it; /v1/metrics speaks Prometheus", () =>
  withServer(
    {
      status: async () => ({
        jobs: { queued: 2, complete: 5 },
        extension: { version: "0.5.9", at: "2026-01-01T00:00:00.000Z" },
        platforms: {
          instagram: {
            configuredWorkers: 4,
            effectiveWorkers: 1,
            backoffUntil: "2026-01-01T00:15:00.000Z",
            backoffLevel: 1
          }
        },
        pid: 42
      })
    },
    async ({ call }) => {
      const status = await call("GET", "/v1/status");
      assert.equal(status.status, 200);
      assert.equal(status.body.jobs.complete, 5);
      assert.equal(status.body.extension.version, "0.5.9");
      assert.deepEqual(status.body.platforms.instagram, {
        configuredWorkers: 4,
        effectiveWorkers: 1,
        backoffUntil: "2026-01-01T00:15:00.000Z",
        backoffLevel: 1
      });
      assert.equal(typeof status.body.uptimeSeconds, "number");
      assert.equal((await call("GET", "/v1/status", { auth: false })).status, 401, "status needs the token");

      const metrics = await call("GET", "/v1/metrics", { json: false });
      assert.equal(metrics.status, 200);
      assert.match(metrics.headers["content-type"], /^text\/plain; version=0\.0\.4/);
      assert.match(metrics.text, /^pms_jobs\{status="queued"\} 2$/m);
      assert.match(metrics.text, /^pms_jobs\{status="complete"\} 5$/m);
      assert.match(metrics.text, /^pms_platform_configured_workers\{platform="instagram"\} 4$/m);
      assert.match(metrics.text, /^pms_platform_effective_workers\{platform="instagram"\} 1$/m);
      assert.match(metrics.text, /^pms_platform_backoff_until_timestamp_seconds\{platform="instagram"\} 1767226500$/m);
      assert.match(metrics.text, /^pms_platform_backoff_level\{platform="instagram"\} 1$/m);
      assert.match(metrics.text, /^pms_extension_seen_timestamp_seconds 1767225600$/m);
      assert.match(metrics.text, /^pms_uptime_seconds \d+$/m);
      assert.equal((await call("POST", "/v1/metrics", { body: {} })).status, 405);
    }
  ));

test("status and metrics still answer when the queue offers no details", () =>
  withServer({ status: null }, async ({ call }) => {
    assert.equal((await call("GET", "/v1/status")).status, 200);
    const metrics = await call("GET", "/v1/metrics", { json: false });
    assert.match(metrics.text, /pms_extension_seen_timestamp_seconds 0/);
    assert.doesNotMatch(metrics.text, /pms_jobs\{/);
  }));

test("GET /v1/health/platforms reports per-platform canary state and metrics export gauges", () =>
  withServer({}, async ({ call }) => {
    const health = await call("GET", "/v1/health/platforms");
    assert.equal(health.status, 200);
    assert.equal(health.body.items.length, 4);
    assert.equal(health.body.items.find(item => item.platform === "Instagram").state, "ok");
    assert.equal(health.body.summary.total, 4);
    assert.equal((await call("GET", "/v1/health/platforms", { auth: false })).status, 401);
    assert.equal((await call("POST", "/v1/health/platforms", { body: {} })).status, 405);
    const metrics = await call("GET", "/v1/metrics", { json: false });
    assert.match(metrics.text, /^pms_platform_health\{platform="instagram"\} 0$/m);
  }));

test("the API limits request bursts with a problem response", () =>
  withServer({ rateLimit: 2 }, async ({ call }) => {
    assert.equal((await call("GET", "/v1/health", { auth: false })).status, 200);
    assert.equal((await call("GET", "/v1/health", { auth: false })).status, 200);
    const limited = await call("GET", "/v1/health", { auth: false });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers["retry-after"], "60");
    assert.match(limited.headers["content-type"], /problem\+json/);
    assert.equal(limited.body.title, "Too Many Requests");
    assert.equal(limited.body.status, 429);
  }));

test("rejected and unauthenticated bursts cannot exhaust the authenticated request quota", () =>
  withServer({ rateLimit: 2 }, async ({ call }) => {
    for (let index = 0; index < 3; index++) {
      const rejected = await call("GET", "/v1/jobs?unsupported=1", {
        headers: { origin: "https://attacker.example" }
      });
      assert.equal(rejected.status, index < 2 ? 403 : 429);
    }
    for (let index = 0; index < 2; index++) {
      const rejected = await call("GET", "/v1/jobs", { auth: false });
      assert.equal(rejected.status, 401);
    }
    assert.equal((await call("GET", "/v1/jobs")).status, 200);
    assert.equal((await call("GET", "/v1/jobs")).status, 200);
    const limited = await call("GET", "/v1/jobs");
    assert.equal(limited.status, 429);
    assert.equal(limited.body.title, "Too Many Requests");
  }));

test("failed authentication limits also block a valid token after the failure threshold", () =>
  withServer({ rateLimit: 2 }, async ({ call }) => {
    for (let index = 0; index < 3; index++) {
      const invalid = await call("GET", "/v1/jobs", { headers: { authorization: `Bearer wrong-${index}` } });
      assert.equal(invalid.status, index < 2 ? 401 : 429);
    }

    const valid = await call("GET", "/v1/jobs");
    assert.equal(valid.status, 429);
    assert.equal(valid.body.title, "Too Many Requests");
    assert.equal(valid.body.detail, "Too many failed authentication attempts. Try again later.");
    assert.equal(valid.headers["retry-after"], "60");
  }));

test("unknown routes still enforce Host, Origin, authentication, and rate limits", () =>
  withServer({ rateLimit: 1 }, async ({ call }) => {
    const hostile = await call("GET", "/v1/unknown", {
      headers: { origin: "https://attacker.example" }
    });
    assert.equal(hostile.status, 403);
    const hostileLimited = await call("GET", "/v1/another-unknown", {
      headers: { origin: "https://attacker.example" }
    });
    assert.equal(hostileLimited.status, 429);

    const unknown = await call("GET", "/v1/unknown");
    assert.equal(unknown.status, 404);
    const unknownLimited = await call("GET", "/v1/another-unknown");
    assert.equal(unknownLimited.status, 429);
  }));

test("beyond this computer the API needs a token, and only the hosts it was told about", async () => {
  const deps = { addUrls: async () => ({}), listJobs: async () => [] };
  await assert.rejects(startApiServer({ port: 0, bind: "0.0.0.0", ...deps }), /only with an API token/);
  const server = await startApiServer({
    port: 0,
    bind: "0.0.0.0",
    token: TOKEN,
    extraHosts: ["api.internal:41742"],
    ...deps
  });
  const { port } = server.address();
  try {
    const ask = host =>
      new Promise((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port, path: "/v1/health", headers: { host } }, response => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        });
        req.on("error", reject);
        req.end();
      });
    assert.equal(await ask(`127.0.0.1:${port}`), 403, "a remote bind does not implicitly trust loopback Host values");
    assert.equal(await ask("api.internal:41742"), 200);
    assert.equal(await ask("evil.example"), 403);
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
  }
});
