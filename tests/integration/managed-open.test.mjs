import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const home = await mkdtemp(path.join(os.tmpdir(), "pms-managed-"));
process.env.LOCALAPPDATA = home;
const store = await import("../../cli/store.mjs");
const { openJobInEdge } = await import("../../cli/jobs.mjs");

after(() => rm(home, { recursive: true, force: true }));

const JOB = {
  jobId: "11111111-1111-4111-8111-111111111111",
  url: "https://x.com/a/"
};

test("a profile with a debugging port opens the job through the managed browser instead of a new launch", async () => {
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(request.url);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1:1/devtools/browser/x" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await store.writeJsonAtomic(store.EDGE_PROFILE_FILE, {
    browser: "chrome",
    profileDirectory: "Default",
    executable: process.execPath,
    debugPort: port,
    extraArgs: ["--user-data-dir=/private"]
  });
  const sent = [];
  const launched = [];
  try {
    await openJobInEdge(JOB, (...args) => launched.push(args), {
      webSocketFactory: () => {
        const socket = Object.assign(new EventTarget(), {
          send: text => {
            sent.push(JSON.parse(text));
            socket.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ id: 1, result: {} }) }));
          },
          close() {}
        });
        setImmediate(() => socket.dispatchEvent(new Event("open")));
        return socket;
      }
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
  assert.deepEqual(launched, [], "no new browser process is started");
  assert.deepEqual(seen, ["/json/version", "/json/version"]);
  assert.equal(sent[0].params.url, `${JOB.url}#pms=${JOB.jobId}`);
  assert.equal(sent[0].params.newWindow, true);
});
