// Soak test: the real `serve --keep-alive`, a private Chromium with the real extension and a fake X site, fed
// batch after batch of new accounts for a long time. It records memory and queue health on every cycle and
// kills the serve child now and then, then reports whether anything leaked, got stuck or failed to come back.
// Nothing here touches the user's own browser, queue, folders or ports.
//   node tools/soak.mjs [minutes=30] [accountsPerBatch=6] [crashEveryMinutes=8]
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  apiClient,
  chromiumPath,
  createSandbox,
  destroySandbox,
  freePort,
  ROOT,
  sleep,
  startFakeSites,
  waitFor
} from "../tests/e2e/harness.mjs";

const minutes = Number(process.argv[2]) || 30;
const perBatch = Number(process.argv[3]) || 6;
const crashEvery = (Number(process.argv[4]) || 8) * 60_000;
const POSTS = 4;
const FINISHED = new Set(["complete", "incomplete", "error", "paused"]);
const LOG = path.join(ROOT, "soak-report.jsonl");
writeFileSync(LOG, "");
const record = entry => {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
  appendFileSync(LOG, `${line}\n`);
  console.log(line);
};

const executable = await chromiumPath();
if (!executable) {
  throw new Error("No Chromium found; set PMS_E2E_CHROMIUM.");
}

// Any /<account>/ page on x.com is a profile with POSTS photos; the default handler serves the pictures.
const profile = account => {
  const posts = Array.from({ length: POSTS }, (_, i) => ({
    id: `1900${account.replace(/\D/g, "")}${i}`,
    media: `${account}p${i}`
  }));
  const articles = posts
    .map(
      post =>
        `<article><a href="/${account}/status/${post.id}">post</a>` +
        `<img src="https://pbs.twimg.com/media/${post.media}?format=png&amp;name=small" width="600" height="600"></article>`
    )
    .join("\n");
  return `<!doctype html><title>${account}</title><body style="height:3000px">${articles}</body>`;
};
const state = {
  account: "unused",
  posts: [],
  requests: [],
  routes: [
    ({ host, url, response }) => {
      const match = /^\/(soak\d+)\/?$/i.exec(url.pathname);
      if (!/^(www\.)?x\.com$/.test(host) || !match) {
        return false;
      }
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(profile(match[1]));
      return true;
    }
  ]
};
state.requests = { push() {} }; // thousands of requests would only grow memory in this harness

const sites = await startFakeSites(state);
const [bridgePort, apiPort] = [await freePort(), await freePort()];
const sandbox = await createSandbox({ bridgePort, apiPort, sitesPort: sites.port, executable });
const output = [];
const supervisor = spawn(process.execPath, [path.join(ROOT, "cli", "mediasaver.mjs"), "serve", "--keep-alive"], {
  env: sandbox.env,
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true
});
for (const stream of [supervisor.stdout, supervisor.stderr]) {
  stream.on("data", chunk => {
    output.push(String(chunk));
    if (output.length > 400) {
      output.shift();
    }
  });
}

const SYSTEM32 = path.join(process.env.SystemRoot || "C:/Windows", "System32");
const rssMb = pid => {
  if (process.platform === "win32") {
    const result = spawnSync(path.join(SYSTEM32, "tasklist.exe"), ["/FI", `PID eq ${pid}`, "/NH", "/FO", "CSV"], {
      encoding: "utf8"
    });
    const cell = result.stdout.split('","')[4];
    return cell ? Math.round(Number(cell.replace(/[^\d]/g, "")) / 1024) : null;
  }
  const result = spawnSync("/bin/ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" });
  return Number(result.stdout.trim()) / 1024 || null;
};
const killHard = pid =>
  process.platform === "win32"
    ? spawnSync(path.join(SYSTEM32, "taskkill.exe"), ["/F", "/PID", String(pid)])
    : process.kill(pid, "SIGKILL");

let exitCode;
let lastServePid = null;
try {
  const token = await waitFor(
    async () => (await readFile(path.join(sandbox.appDir, "api-token"), "utf8").catch(() => "")).trim(),
    { what: "the API token", timeoutMs: 60_000 }
  );
  const api = apiClient(apiPort, token);
  await waitFor(() => api.health().catch(() => null), { what: "the API", timeoutMs: 60_000 });
  const status = () => api.raw("/v1/status", { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json());

  const started = Date.now();
  const deadline = started + minutes * 60_000;
  let nextCrash = started + crashEvery;
  let counter = 0;
  const samples = [];
  const problems = [];
  let restarts = 0;

  while (Date.now() < deadline) {
    const names = Array.from({ length: perBatch }, () => `soak${++counter}`);
    const ids = [];
    const queuedAt = Date.now();
    for (const name of names) {
      const queued = await api.queue(`https://x.com/${name}/`);
      if (queued.status !== 201) {
        problems.push(`queue ${name}: ${queued.status} ${JSON.stringify(queued.body)}`);
        continue;
      }
      ids.push(...queued.body.items.map(item => item.id));
    }
    let crashed = false;
    const finished = await waitFor(
      async () => {
        if (!crashed && Date.now() >= nextCrash) {
          crashed = true;
          nextCrash = Date.now() + crashEvery;
          const before = (await status()).pid;
          killHard(before);
          const after = await waitFor(
            async () => {
              const s = await status().catch(() => null);
              return s?.pid && s.pid !== before ? s.pid : null;
            },
            { what: "serve to come back", timeoutMs: 120_000, everyMs: 1000 }
          ).catch(() => null);
          restarts += after ? 1 : 0;
          record({ event: "crash", killed: before, cameBack: after });
          if (!after) {
            problems.push("serve did not come back after being killed");
          }
        }
        const jobs = (await api.jobs()).items.filter(job => ids.includes(job.id));
        return jobs.length === ids.length && jobs.every(job => FINISHED.has(job.status)) ? jobs : null;
      },
      { what: "batch to finish", timeoutMs: 15 * 60_000, everyMs: 3000 }
    ).catch(() => null);

    const s = await status().catch(() => ({}));
    // A job that ends in error or incomplete is a problem, except when this cycle killed serve (the kill cuts jobs short).
    for (const job of finished ?? []) {
      if (!crashed && ["error", "incomplete"].includes(job.status)) {
        problems.push(`${job.account} ended ${job.status}: ${job.message}`);
      }
    }
    const counts = {};
    for (const job of finished ?? []) {
      counts[job.status] = (counts[job.status] || 0) + 1;
    }
    const dbBytes = await stat(path.join(sandbox.appDir, "queue.db"))
      .then(f => f.size)
      .catch(() => null);
    const sample = {
      event: "cycle",
      minute: Math.round((Date.now() - started) / 600) / 100,
      batchSeconds: Math.round((Date.now() - queuedAt) / 1000),
      finished: Boolean(finished),
      counts,
      saved: (finished ?? []).reduce((sum, job) => sum + (job.counts?.saved ?? 0), 0),
      servePid: s.pid,
      serveRssMb: s.pid ? rssMb(s.pid) : null,
      dbBytes,
      failuresByReason: s.failuresByReason
    };
    samples.push(sample);
    lastServePid = s.pid ?? lastServePid;
    record(sample);
    if (!finished) {
      problems.push(`batch ${counter} did not finish in 15 minutes (queue stuck)`);
      break;
    }
    await sleep(2000);
  }

  const rss = samples.map(s => s.serveRssMb).filter(Boolean);
  const half = Math.floor(rss.length / 2);
  const avg = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
  const summary = {
    event: "summary",
    minutes,
    cycles: samples.length,
    accounts: counter,
    restarts,
    rssFirstThirdAvg: Math.round(avg(rss.slice(0, Math.max(1, Math.floor(rss.length / 3))))),
    rssLastThirdAvg: Math.round(avg(rss.slice(-Math.max(1, Math.floor(rss.length / 3))))),
    rssMax: Math.max(0, ...rss),
    stuckOrFailed: problems,
    errorJobs: samples.reduce((sum, s) => sum + (s.counts.error || 0) + (s.counts.incomplete || 0), 0),
    half
  };
  record(summary);
  exitCode = problems.length ? 1 : 0;
} catch (error) {
  record({ event: "fatal", message: error.message, serveOutput: output.slice(-30).join("") });
  exitCode = 2;
} finally {
  // Each step runs even when an earlier one throws (the serve process may already be gone).
  const attempt = async step => {
    try {
      await step();
    } catch {
      // Already stopped.
    }
  };
  if (lastServePid) {
    await attempt(() => killHard(lastServePid));
  }
  await attempt(() => supervisor.kill());
  await sleep(1000);
  await attempt(() => destroySandbox(sandbox, { child: supervisor }));
  await attempt(() => sites.close());
}
process.exitCode = exitCode;
