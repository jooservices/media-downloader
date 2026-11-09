import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { openInManagedBrowser, startManagedBrowser } from "../../cli/managed.mjs";

const SOCKET = "ws://127.0.0.1:9333/devtools/browser/abc";
const PAGE = "https://x.com/a/#pms=11111111-1111-4111-8111-111111111111";

// A browser that is up (or comes up after `bootAfter` checks) and answers /json/version.
function fakeBrowser({ bootAfter = 0, version = { webSocketDebuggerUrl: SOCKET } } = {}) {
  let checks = 0;
  return {
    fetchImpl: async url => {
      assert.match(url, /^http:\/\/127\.0\.0\.1:9333\/json\/version$/);
      checks++;
      if (checks <= bootAfter) {
        throw new Error("ECONNREFUSED");
      }
      return { ok: true, json: async () => version };
    },
    checks: () => checks
  };
}

function fakeSpawn() {
  const launched = [];
  const spawnProcess = (executable, args, options) => {
    const child = Object.assign(new EventEmitter(), { unref() {} });
    launched.push({ executable, args, options, child });
    return child;
  };
  return { spawnProcess, launched };
}

// A DevTools socket that records what it is sent and answers like the browser does.
function fakeSocketFactory(answer) {
  const sockets = [];
  const factory = address => {
    const socket = Object.assign(new EventTarget(), {
      address,
      sent: [],
      closed: false,
      send(text) {
        socket.sent.push(JSON.parse(text));
        answer(socket);
      },
      close() {
        socket.closed = true;
      }
    });
    sockets.push(socket);
    setImmediate(() => socket.dispatchEvent(new Event("open")));
    return socket;
  };
  return { factory, sockets };
}

const reply = (socket, payload) =>
  socket.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(payload) }));

test("a running browser is asked for a new window and nothing is started", async () => {
  const browser = fakeBrowser();
  const { spawnProcess, launched } = fakeSpawn();
  const { factory, sockets } = fakeSocketFactory(socket => {
    reply(socket, { id: 99, result: {} }); // another message is ignored
    reply(socket, { id: 1, result: { targetId: "T1" } });
  });
  await openInManagedBrowser(
    { executable: "/bin/browser", args: ["--x"], port: 9333, url: PAGE },
    { spawnProcess, fetchImpl: browser.fetchImpl, webSocketFactory: factory }
  );
  assert.equal(launched.length, 0);
  assert.equal(sockets[0].address, SOCKET);
  assert.deepEqual(sockets[0].sent, [{ id: 1, method: "Target.createTarget", params: { url: PAGE, newWindow: true } }]);
  assert.equal(sockets[0].closed, true);
});

test("a browser that is not running is started with its debugging port and about:blank, then used", async () => {
  const browser = fakeBrowser({ bootAfter: 2 });
  const { spawnProcess, launched } = fakeSpawn();
  const { factory } = fakeSocketFactory(socket => reply(socket, { id: 1, result: {} }));
  await openInManagedBrowser(
    { executable: "/bin/browser", args: ["--user-data-dir=/p"], port: 9333, url: PAGE },
    { spawnProcess, fetchImpl: browser.fetchImpl, webSocketFactory: factory, timeoutMs: 5000 }
  );
  assert.equal(launched.length, 1);
  assert.deepEqual(launched[0].args, ["--user-data-dir=/p", "--remote-debugging-port=9333", "about:blank"]);
  assert.equal(launched[0].options.detached, true);
  assert.equal(launched[0].options.windowsHide, true);
});

test("a browser that cannot be started is reported with the reason", async () => {
  const { spawnProcess, launched } = fakeSpawn();
  const pending = startManagedBrowser(
    { executable: "/missing", port: 9333 },
    {
      spawnProcess,
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED");
      },
      timeoutMs: 5000
    }
  );
  launched[0].child.emit("error", new Error("spawn ENOENT"));
  await assert.rejects(pending, /Could not start the browser: spawn ENOENT/);
});

test("a browser that never opens its port ends in a timeout error", async () => {
  const { spawnProcess } = fakeSpawn();
  await assert.rejects(
    startManagedBrowser(
      { executable: "/slow", port: 9333 },
      {
        spawnProcess,
        fetchImpl: async () => ({ ok: false }),
        timeoutMs: 300
      }
    ),
    /did not open its debugging port 9333 within 0\.3 seconds/
  );
});

test("a refusal from the browser is an error with its message", async () => {
  const { factory } = fakeSocketFactory(socket => reply(socket, { id: 1, error: { message: "No such target" } }));
  await assert.rejects(
    openInManagedBrowser(
      { executable: "/b", port: 9333, url: PAGE },
      { fetchImpl: fakeBrowser().fetchImpl, webSocketFactory: factory }
    ),
    /refused to open the page: No such target/
  );
});

test("a socket that fails to connect is reported and closed", async () => {
  const factory = () => {
    const socket = Object.assign(new EventTarget(), { closed: false, close: () => (socket.closed = true) });
    setImmediate(() => socket.dispatchEvent(new Event("error")));
    return socket;
  };
  await assert.rejects(
    openInManagedBrowser(
      { executable: "/b", port: 9333, url: PAGE },
      { fetchImpl: fakeBrowser().fetchImpl, webSocketFactory: factory }
    ),
    /Could not talk to the browser's debugging port/
  );
});
