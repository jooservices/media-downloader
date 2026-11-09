import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Never the live queue's folder or port: a temp folder and a free port, set before the CLI is imported.
const home = await mkdtemp(path.join(os.tmpdir(), "pms-reload-"));
const PORT = await freePort();
process.env.LOCALAPPDATA = home;
process.env.PMS_BRIDGE_PORT = String(PORT);
const store = await import("../../cli/store.mjs");
const { startBridgeServer } = await import("../../cli/bridge-server.mjs");
const { syncEdge } = await import("../../tools/sync-edge.mjs");

const ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

after(() => rm(home, { recursive: true, force: true }));

async function post(message) {
  const response = await fetch(`http://127.0.0.1:${PORT}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: ORIGIN },
    body: JSON.stringify(message)
  });
  return response.json();
}

test("an extension that is not the version on disk is told to reload until it reports the new version", async () => {
  await store.writeJsonAtomic(store.BRIDGE_CONFIG_FILE, { extensionOrigin: ORIGIN, port: PORT });
  const server = await startBridgeServer();
  try {
    const quiet = await post({ type: "JOB_PROGRESS", jobId: "bad id", version: "1.0.0" });
    assert.equal(quiet.reload, undefined, "no version file, no reload");

    await writeFile(store.EXPECTED_VERSION_FILE, "1.0.1\n");
    assert.equal((await post({ type: "JOB_PROGRESS", jobId: "bad id", version: "1.0.0" })).reload, true);
    assert.equal(
      (await post({ type: "JOB_PROGRESS", jobId: "bad id" })).reload,
      true,
      "an extension that reports nothing is old"
    );
    assert.equal((await post({ type: "JOB_PROGRESS", jobId: "bad id", version: "1.0.0" })).reload, true, "still asked");

    assert.equal((await post({ type: "JOB_PROGRESS", jobId: "bad id", version: "1.0.1" })).reload, undefined);
    await assert.rejects(readFile(store.EXPECTED_VERSION_FILE), "the file goes once the new version reports in");
    assert.equal((await post({ type: "JOB_PROGRESS", jobId: "bad id", version: "1.0.0" })).reload, undefined);

    await writeFile(store.EXPECTED_VERSION_FILE, "\n");
    assert.equal(
      (await post({ type: "JOB_PROGRESS", jobId: "bad id" })).reload,
      undefined,
      "an empty file means nothing"
    );
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test("sync-edge copies the extension, bumps the copy's version and records it for the queue", async () => {
  const destination = path.join(home, "edge-copy");
  const flag = path.join(home, "flags", "expected-extension-version");
  const first = await syncEdge(destination, ROOT, flag);
  assert.match(first.version, /^\d+\.\d+\.\d+$/);
  assert.ok(first.count > 20);
  assert.equal((await readFile(flag, "utf8")).trim(), first.version);
  assert.equal(JSON.parse(await readFile(path.join(destination, "manifest.json"), "utf8")).version, first.version);
  const second = await syncEdge(destination, ROOT, flag);
  assert.notEqual(second.version, first.version);
  assert.equal((await readFile(flag, "utf8")).trim(), second.version);
  await assert.rejects(syncEdge(ROOT, ROOT, flag), /onto itself/);
});
