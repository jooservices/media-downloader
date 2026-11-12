import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { apiClient } from "../e2e/harness.mjs";

async function withApi(handler, run) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("the E2E client waits out a 429 and then returns the job list instead of a problem document", async () => {
  let calls = 0;
  await withApi(
    (request, response) => {
      calls++;
      if (calls === 1) {
        response.writeHead(429, { "Content-Type": "application/problem+json", "Retry-After": "0" });
        response.end(JSON.stringify({ status: 429, title: "Too Many Requests" }));
        return;
      }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ items: [{ id: "a", status: "complete" }] }));
    },
    async port => {
      const body = await apiClient(port, "token").jobs();
      assert.deepEqual(
        body.items.map(item => item.id),
        ["a"]
      );
      assert.equal(calls, 2);
    }
  );
});

test("the E2E client names an API error instead of letting it be read as a job list", async () => {
  await withApi(
    (request, response) => {
      response.writeHead(500, { "Content-Type": "application/problem+json" });
      response.end(JSON.stringify({ status: 500, title: "Internal Server Error" }));
    },
    async port => {
      await assert.rejects(apiClient(port, "token").jobs(), /GET \/v1\/jobs answered 500/);
    }
  );
});
