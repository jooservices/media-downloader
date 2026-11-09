// Starting, monitoring and resuming a download job.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
  QUEUE_FILE,
  EDGE_PROFILE_FILE,
  BRIDGE_CONFIG_FILE,
  TERMINAL_STATES,
  sleep,
  normalizeProfileUrl,
  accountPages,
  cliTabMarker,
  writeJsonAtomic,
  readJson,
  getActiveJob,
  jobFile
} from "./store.mjs";
import { DEFAULT_LIMIT } from "./args.mjs";
import { browserLayout, launchArgs, resolvedProfile } from "./browsers.mjs";
import { startBridgeServer } from "./bridge-server.mjs";
import { printJob } from "./status.mjs";
import { loadConfig } from "./config.mjs";
import { finalizeRepairJob } from "./repair.mjs";

const QUEUE_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 2000;
const INSTALL_HINT = "Load the extension, then run install (or install chrome / install firefox / install edge).";

function describeLimit(limit) {
  if (limit === null) {
    return " (no limit)";
  }
  return limit ? ` (limit ${limit} files)` : "";
}

// Extra command-line switches kept with the saved browser profile (for example a private profile folder for tests).
function extraBrowserArgs(saved) {
  return Array.isArray(saved?.extraArgs) ? saved.extraArgs.filter(arg => typeof arg === "string") : [];
}

export async function openJobInEdge(job, spawnProcess = spawn) {
  const saved = await readJson(EDGE_PROFILE_FILE);
  if (!saved?.profileDirectory && !saved?.profilePath) {
    throw new Error(INSTALL_HINT);
  }
  const profile = resolvedProfile(saved, process.platform, process.env);
  const executable =
    (profile.executable && existsSync(profile.executable) && profile.executable) ||
    browserLayout(process.platform, process.env)[profile.browser].executables.find(candidate => existsSync(candidate));
  if (!executable) {
    throw new Error(
      `${profile.label} is not installed. Install it, load the extension, then run install ${profile.browser}.`
    );
  }
  // The marker lets the extension recognise this tab as the CLI's and close it when it is done with it.
  const pageUrl = `${job.url}${cliTabMarker(job.jobId)}`;
  const browserProcess = spawnProcess(
    executable,
    [...extraBrowserArgs(saved), ...launchArgs(profile.browser, profile, pageUrl)],
    {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    }
  );
  browserProcess.once("error", async error => {
    const failedJob = {
      ...job,
      status: "error",
      message: `Could not open ${profile.label}: ${error.message}`,
      updatedAt: new Date().toISOString()
    };
    await writeJsonAtomic(jobFile(job.jobId), failedJob).catch(() => {});
    process.stderr.write(`${failedJob.message}\n`);
  });
  browserProcess.unref();
}

const progressLine = job =>
  `${job.status} · ${Number(job.started || 0)} requests started · ${Number(job.pending || 0)} pending · ${Number(job.failed || 0)} failed`;

async function failUnacknowledgedJob(current) {
  const failedJob = {
    ...current,
    status: "error",
    message:
      "The browser did not acknowledge the job within 90 seconds. Reload Page Media Saver on its extensions page, then resume this job.",
    updatedAt: new Date().toISOString()
  };
  await writeJsonAtomic(jobFile(current.jobId), failedJob);
  printJob(failedJob);
  process.exitCode = 1;
}

async function finishJob(current) {
  const needsRepairCheck = current.status === "complete" && current.repairTargets?.length && !current.repairFinalized;
  const finalJob = needsRepairCheck ? await finalizeRepairJob(current) : current;
  printJob(finalJob, (await loadConfig().catch(() => null))?.downloadDir);
  if (finalJob.status !== "complete") {
    process.exitCode = finalJob.status === "paused" ? 2 : 1;
  }
}

// Polls the job file until the job ends. Returns false when the user stopped watching first.
async function watchJob(job, queuedAt, isInterrupted) {
  let lastLine = "";
  while (!isInterrupted()) {
    const current = await readJson(jobFile(job.jobId));
    if (current?.status === "queued" && Date.now() - queuedAt >= QUEUE_TIMEOUT_MS) {
      await failUnacknowledgedJob(current);
      return true;
    }
    if (current) {
      const line = progressLine(current);
      if (line !== lastLine) {
        process.stdout.write(`${line}\n`);
        lastLine = line;
      }
      if (TERMINAL_STATES.has(current.status)) {
        await finishJob(current);
        return true;
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  return false;
}

export async function launchAndMonitor(job, { openPage = true } = {}) {
  const queuedAt = Date.now();
  const bridgeServer = await startBridgeServer();
  let interrupted = false;
  const stopMonitoring = () => {
    interrupted = true;
  };
  try {
    if (openPage) {
      await openJobInEdge(job);
    }
    process.stdout.write(
      `${openPage ? "Opening" : "Watching"} ${job.platform}/${job.account}${describeLimit(job.limit)}. Job ${job.jobId}.\n`
    );
    process.stdout.write("You can use other tabs. Leave this window open until the job finishes.\n");
    process.once("SIGINT", stopMonitoring);
    const finished = await watchJob(job, queuedAt, () => interrupted);
    if (!finished) {
      process.stdout.write(
        `Stopped monitoring and closed the local bridge. Resume the job to reconnect: node cli/mediasaver.mjs resume ${job.jobId}\n`
      );
    }
  } finally {
    process.removeListener("SIGINT", stopMonitoring);
    await new Promise(resolve => bridgeServer.close(() => resolve()));
  }
}

async function requireInstalled() {
  const saved = await readJson(EDGE_PROFILE_FILE);
  if (!saved?.profileDirectory && !saved?.profilePath) {
    throw new Error(INSTALL_HINT);
  }
  if (!(await readJson(BRIDGE_CONFIG_FILE))?.extensionOrigin) {
    throw new Error(INSTALL_HINT);
  }
}

// Writes a waiting job file for a profile or post URL. Nothing is opened yet.
export async function createJob(rawUrl, limit = DEFAULT_LIMIT) {
  const { url, platform, account, mediaPage } = normalizeProfileUrl(rawUrl);
  const jobId = randomUUID();
  const now = new Date().toISOString();
  const job = {
    jobId,
    url,
    platform,
    account,
    mediaPage,
    limit,
    status: "queued",
    message: "Waiting for the Page Media Saver extension.",
    createdAt: now,
    updatedAt: now,
    started: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
    videoStarted: 0,
    videoSkipped: 0,
    rounds: 0,
    attempts: 0,
    openedAt: null
  };
  await writeJsonAtomic(jobFile(jobId), job);
  return job;
}

export async function startDownload(rawUrl, limit = DEFAULT_LIMIT) {
  await requireInstalled();
  const active = await getActiveJob();
  if (active && !TERMINAL_STATES.has(active.status)) {
    throw new Error(
      `Job ${active.jobId} is still ${active.status}. Use “status” to check it before starting another URL.`
    );
  }
  const pages = accountPages(rawUrl);
  let last;
  for (const url of pages) {
    const job = await createJob(url, limit);
    await writeJsonAtomic(QUEUE_FILE, { jobId: job.jobId, updatedAt: job.createdAt });
    last = await launchAndMonitor(job);
  }
  return last;
}

export async function resumeJob(jobId) {
  const active = await getActiveJob();
  const job = jobId ? await readJson(jobFile(jobId)) : active;
  if (!job) {
    throw new Error("No job was found to resume. Run “status” to list saved jobs.");
  }
  if (active && active.jobId !== job.jobId && !TERMINAL_STATES.has(active.status)) {
    throw new Error(`Job ${active.jobId} is still ${active.status}; finish or pause it before resuming another job.`);
  }
  if (job.status === "complete") {
    throw new Error("This job is already complete. Use “download <URL>” to start another scan.");
  }
  if (active?.jobId === job.jobId && job.status === "running") {
    return launchAndMonitor(job, { openPage: false });
  }
  job.status = "queued";
  job.updatedAt = new Date().toISOString();
  job.message = "Resuming the saved profile scan.";
  await writeJsonAtomic(jobFile(job.jobId), job);
  await writeJsonAtomic(QUEUE_FILE, { jobId: job.jobId, updatedAt: job.updatedAt });
  return launchAndMonitor(job);
}
