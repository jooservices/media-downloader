import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("browser stop closes the managed browser and waits until its debugging port releases the profile", async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "pms-browser-stop-"));
  process.env.PMS_DATA_DIR = dataDir;
  try {
    const { EDGE_PROFILE_FILE } = await import("../../cli/store.mjs");
    const { stopManagedBrowser } = await import("../../cli/browser.mjs");
    await mkdir(path.dirname(EDGE_PROFILE_FILE), { recursive: true });
    await writeFile(EDGE_PROFILE_FILE, JSON.stringify({ debugPort: 38543 }));

    let running = true;
    const sent = [];
    const fetchImpl = async () => {
      if (!running) {
        throw new Error("ECONNREFUSED");
      }
      return { ok: true, json: async () => ({ webSocketDebuggerUrl: "ws://127.0.0.1:38543/devtools/browser/test" }) };
    };
    const webSocketFactory = () => {
      const socket = Object.assign(new EventTarget(), {
        send(message) {
          sent.push(JSON.parse(message));
          running = false;
          socket.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify({ id: 1, result: {} }) }));
        },
        close() {}
      });
      setImmediate(() => socket.dispatchEvent(new Event("open")));
      return socket;
    };

    assert.equal(await stopManagedBrowser({ fetchImpl, webSocketFactory }), true);
    assert.deepEqual(sent, [{ id: 1, method: "Browser.close" }]);
    assert.equal(running, false);
  } finally {
    delete process.env.PMS_DATA_DIR;
    await rm(dataDir, { recursive: true, force: true });
  }
});
