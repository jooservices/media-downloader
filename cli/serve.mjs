// `serve`: keeps the bridge open and works through the queue until stopped.
// `add`: puts profile URLs in that queue. Both share the job files, so adding works whether or not
// `serve` is running at that moment.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  APP_DIR,
  DAEMON_FILE,
  EDGE_PROFILE_FILE,
  LOGS_DIR,
  TERMINAL_STATES,
  listJobs,
  normalizeProfileUrl,
  readJson,
  sleep,
  updateJob,
  writeJsonAtomic
} from "./store.mjs";
import { ensureConfigFile, loadConfig } from "./config.mjs";
import { createJob, openJobInEdge } from "./jobs.mjs";
import { startBridgeServer } from "./bridge-server.mjs";
import { edgeDownloadsDir, moveFinishedFiles } from "./mover.mjs";
import { createSupervisor, recoverInterrupted } from "./supervisor.mjs";

const TICK_MS = 2000;
const MAX_CONSECUTIVE_FAILURES = 20;
export const DEFAULT_INBOX = path.join(APP_DIR, "inbox.txt");

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export async function runningServer() {
  const info = await readJson(DAEMON_FILE).catch(() => null);
  return info?.pid && info.pid !== process.pid && isProcessAlive(info.pid) ? info : null;
}

async function createLogger() {
  await mkdir(LOGS_DIR, { recursive: true });
  return message => {
    const stamp = new Date().toISOString();
    const line = `[${stamp}] ${message}`;
    process.stdout.write(`${line}\n`);
    // One file per day, chosen when the line is written, so a long run rolls over at midnight.
    appendFile(path.join(LOGS_DIR, `serve-${stamp.slice(0, 10)}.log`), `${line}\n`).catch(() => {});
  };
}

// Same profile URL, however it was typed: no query string, one trailing slash, any letter case.
const sameUrl = (a, b) => a.toLowerCase() === b.toLowerCase();

// Creates a job for each URL that has none yet. A URL that already ran (even if it failed) is left
// alone, so the inbox file can keep growing without anything being downloaded twice.
export async function addUrls(urls, { limit = null, force = false } = {}) {
  const known = (await listJobs()).map(job => job.url);
  const created = [];
  const skipped = [];
  for (const raw of urls) {
    let url;
    try {
      ({ url } = normalizeProfileUrl(raw));
    } catch (error) {
      skipped.push({ raw, reason: error?.message || String(error) });
      continue;
    }
    if (!force && known.some(existing => sameUrl(existing, url))) {
      skipped.push({ raw, reason: "already queued or done" });
      continue;
    }
    created.push(await createJob(url, limit));
    known.push(url);
  }
  return { created, skipped };
}

export async function readUrlFile(file) {
  const text = await readFile(file, "utf8").catch(() => "");
  return text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line.startsWith("https://"));
}

async function buildDeps(log) {
  const profile = await readJson(EDGE_PROFILE_FILE);
  const userData = path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data");
  return {
    now: Date.now,
    random: Math.random,
    log,
    loadConfig,
    listJobs,
    updateJob,
    openJob: openJobInEdge,
    moveFiles: async destRoot =>
      moveFinishedFiles({
        sourceRoot: await edgeDownloadsDir(userData, profile?.profileDirectory || "Default"),
        destRoot
      })
  };
}

const hasWork = jobs => jobs.some(job => !TERMINAL_STATES.has(job.status));

export async function serve({ inbox = DEFAULT_INBOX, once = false, limit = null } = {}) {
  const other = await runningServer();
  if (other) {
    throw new Error(`Another “serve” is already running (process ${other.pid}).`);
  }
  await ensureConfigFile();
  await loadConfig();
  const log = await createLogger();
  let server = null;
  let stopping = false;
  const stop = () => {
    stopping = true;
  };
  // Everything after the bridge starts is inside the try, so a failed setup step still closes the bridge.
  try {
    server = await startBridgeServer();
    await writeJsonAtomic(DAEMON_FILE, { pid: process.pid, startedAt: new Date().toISOString(), inbox });
    const deps = await buildDeps(log);
    const recovered = await recoverInterrupted(deps);
    if (recovered) {
      log(`Recovered ${recovered} job(s) left by a previous run.`);
    }
    const supervisor = createSupervisor(deps);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    log(`Serving. Add URLs to ${inbox} or run “add <url>”; stop with Ctrl+C.`);

    const pass = async () => {
      const { created } = await addUrls(await readUrlFile(inbox), { limit });
      if (created.length) {
        log(`Queued ${created.length} new URL(s) from the inbox.`);
      }
      await supervisor.tick();
    };

    // One bad pass (a file briefly locked, a disk hiccup) must not end an unattended run;
    // many in a row means something is really wrong, so stop and say so.
    let failures = 0;
    while (!stopping) {
      try {
        await pass();
        failures = 0;
      } catch (error) {
        failures++;
        log(`Pass failed (${failures}/${MAX_CONSECUTIVE_FAILURES}): ${error?.message || error}`);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          throw error;
        }
      }
      if (once && !failures && !hasWork(await listJobs())) {
        break;
      }
      await sleep(TICK_MS);
    }
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (server) {
      await new Promise(resolve => server.close(() => resolve()));
      await writeJsonAtomic(DAEMON_FILE, { pid: null, stoppedAt: new Date().toISOString() });
    }
    log("Stopped.");
  }
}

// `move`: one pass of what `serve` does in the background, for people who run single downloads.
export async function moveCommand() {
  const config = await loadConfig();
  if (!config.downloadDir) {
    throw new Error('Set downloadDir in config.json first, for example { "downloadDir": "D:\\\\Media" }.');
  }
  const deps = await buildDeps(() => {});
  const result = await deps.moveFiles(config.downloadDir);
  process.stdout.write(
    `Moved ${result.moved} file(s) to ${config.downloadDir}; ${result.duplicates} duplicate(s) dropped, ${result.skipped} still being written, ${result.failed} failed.\n`
  );
  for (const error of result.errors) {
    process.stdout.write(`  ${error}\n`);
  }
}

export async function addCommand(args) {
  const urls = args.filter(arg => !arg.startsWith("--"));
  if (!urls.length) {
    throw new Error("Give at least one profile URL: node cli/mediasaver.mjs add <url> [<url>...] [--again]");
  }
  const force = args.includes("--again");
  const { created, skipped } = await addUrls(urls, { force, limit: null });
  for (const job of created) {
    process.stdout.write(`Queued ${job.platform}/${job.account} (job ${job.jobId}).\n`);
  }
  for (const item of skipped) {
    process.stdout.write(`Skipped ${item.raw}: ${item.reason}\n`);
  }
  if (!(await runningServer())) {
    process.stdout.write("Nothing is processing the queue yet. Start it with: node cli/mediasaver.mjs serve\n");
  }
}
