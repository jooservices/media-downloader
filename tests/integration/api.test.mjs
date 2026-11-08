import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startApiServer } from "../../cli/api.mjs";
import { installService, launchdPlist, systemdUnit, windowsStartupScript } from "../../cli/service.mjs";

function call(port, { method, path: pathname, host, body }) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path: pathname,
        headers: { host: host || `127.0.0.1:${port}`, "content-type": "application/json" }
      },
      response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString() || "null") });
        });
      }
    );
    req.on("error", reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

test("POST /downloads queues the link and the reply has no extra job fields", async () => {
  const seen = [];
  const server = await startApiServer({
    port: 0,
    addUrls: async urls => {
      seen.push(urls[0]);
      return {
        created: [
          {
            jobId: "11111111-1111-1111-1111-111111111111",
            status: "queued",
            platform: "instagram",
            account: "name",
            url: "https://www.instagram.com/name/",
            cookie: "must-not-leak"
          }
        ],
        skipped: []
      };
    },
    listJobs: async () => []
  });
  const port = server.address().port;
  try {
    const queued = await call(port, {
      method: "POST",
      path: "/downloads",
      body: JSON.stringify({ url: "https://www.instagram.com/name/?e=1" })
    });
    assert.equal(queued.status, 202);
    assert.equal(seen[0], "https://www.instagram.com/name/?e=1");
    assert.equal(queued.body.created[0].account, "name");
    assert.equal(queued.body.created[0].cookie, undefined);

    const jobs = await call(port, { method: "GET", path: "/jobs" });
    assert.equal(jobs.status, 200);
    const rejected = await call(port, { method: "GET", path: "/health", host: "evil.example" });
    assert.equal(rejected.status, 403);
    const missing = await call(port, { method: "POST", path: "/downloads", body: "{}" });
    assert.equal(missing.status, 400);
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
  }
});

test("a link the queue refuses is a 400, and one already saved is still accepted", async () => {
  const server = await startApiServer({
    port: 0,
    addUrls: async () => ({ created: [], skipped: [{ raw: "https://nope", reason: "not a profile" }] }),
    listJobs: async () => []
  });
  try {
    const bad = await call(server.address().port, {
      method: "POST",
      path: "/downloads",
      body: JSON.stringify({ url: "https://nope" })
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error, "not a profile");
  } finally {
    await new Promise(resolve => server.close(() => resolve()));
  }

  const again = await startApiServer({
    port: 0,
    addUrls: async () => ({
      created: [],
      skipped: [{ raw: "https://www.instagram.com/name/", reason: "already queued or done" }]
    }),
    listJobs: async () => []
  });
  try {
    const same = await call(again.address().port, {
      method: "POST",
      path: "/downloads",
      body: JSON.stringify({ url: "https://www.instagram.com/name/" })
    });
    assert.equal(same.status, 202);
    assert.equal(same.body.created.length, 0);
  } finally {
    await new Promise(resolve => again.close(() => resolve()));
  }
});

test("sign-in startup is a logon task on Windows and a user service on Linux and macOS", async () => {
  const launch = {
    executable: "C:\\Program Files\\nodejs\\node.exe",
    script: "C:\\Claude\\media-downloader\\cli\\mediasaver.mjs"
  };
  assert.match(windowsStartupScript(launch), /Wscript\.Shell/);
  assert.match(windowsStartupScript(launch), /mediasaver\.mjs"" serve/);
  const home = await mkdtemp(path.join(os.homedir(), ".pms-service-test-"));
  const calls = [];
  try {
    await installService({
      platform: "linux",
      home,
      launch: { executable: "/usr/bin/node", script: "/opt/media-downloader/cli/mediasaver.mjs" },
      run: async (command, args) => {
        calls.push([command, args]);
      }
    });
    const unit = await readFile(path.join(home, ".config", "systemd", "user", "page-media-saver.service"), "utf8");
    assert.match(unit, /ExecStart="\/usr\/bin\/node"/);
    assert.deepEqual(calls[1], ["systemctl", ["--user", "enable", "--now", "page-media-saver.service"]]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
  assert.match(systemdUnit(launch), /ExecStart=/);
  assert.match(launchdPlist({ executable: "/usr/bin/node", script: "/opt/a&b.mjs" }), /a&amp;b\.mjs/);
});
