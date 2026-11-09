// A browser the queue owns. Instead of starting a new browser process for every job (which only works when a
// window is already open on someone's desktop), the queue keeps one long-lived browser with a private profile
// and opens each job as a new tab through the browser's own debugging port. If the browser is not running,
// it is started first. The port listens on 127.0.0.1 only.
import { spawn } from "node:child_process";
import { sleep } from "./store.mjs";

const START_TIMEOUT_MS = 30_000;
const POLL_MS = 250;

const endpoint = (port, route) => `http://127.0.0.1:${port}${route}`;

async function isUp(port, fetchImpl) {
  try {
    return (await fetchImpl(endpoint(port, "/json/version"))).ok;
  } catch {
    return false;
  }
}

// Starts the browser with the debugging port open and waits until it answers.
export async function startManagedBrowser(
  { executable, args = [], port },
  { spawnProcess = spawn, fetchImpl = fetch, timeoutMs = START_TIMEOUT_MS } = {}
) {
  const child = spawnProcess(executable, [...args, `--remote-debugging-port=${port}`, "about:blank"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  let failure = null;
  child.once("error", error => {
    failure = error;
  });
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (failure) {
      throw new Error(`Could not start the browser: ${failure.message}`);
    }
    if (await isUp(port, fetchImpl)) {
      return;
    }
    await sleep(POLL_MS);
  }
  throw new Error(`The browser did not open its debugging port ${port} within ${timeoutMs / 1000} seconds.`);
}

// Asks the browser, over its debugging socket, for a new window showing `url`. A window of its own matters: a
// tab behind another one is treated as hidden and slowed down, which starves the scan running in it.
function createWindow(socketUrl, url, webSocketFactory) {
  return new Promise((resolve, reject) => {
    const socket = webSocketFactory(socketUrl);
    const fail = error => {
      socket.close();
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("The browser did not answer the request to open a window.")), 10_000);
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      fail(new Error("Could not talk to the browser's debugging port."));
    });
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url, newWindow: true } }));
    });
    socket.addEventListener("message", event => {
      const reply = JSON.parse(String(event.data));
      if (reply.id !== 1) {
        return;
      }
      clearTimeout(timer);
      socket.close();
      if (reply.error) {
        reject(new Error(`The browser refused to open the page: ${reply.error.message}`));
      } else {
        resolve(reply.result);
      }
    });
  });
}

// Opens `url` in a new window of the managed browser, starting the browser if it is not running.
export async function openInManagedBrowser(
  { executable, args, port, url },
  {
    spawnProcess = spawn,
    fetchImpl = fetch,
    timeoutMs = START_TIMEOUT_MS,
    webSocketFactory = address => new WebSocket(address)
  } = {}
) {
  if (!(await isUp(port, fetchImpl))) {
    await startManagedBrowser({ executable, args, port }, { spawnProcess, fetchImpl, timeoutMs });
  }
  const version = await (await fetchImpl(endpoint(port, "/json/version"))).json();
  await createWindow(version.webSocketDebuggerUrl, url, webSocketFactory);
}
