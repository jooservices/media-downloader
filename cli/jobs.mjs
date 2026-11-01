// Starting, monitoring and resuming a download job.
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { QUEUE_FILE, EDGE_PROFILE_FILE, BRIDGE_CONFIG_FILE, TERMINAL_STATES, sleep, normalizeProfileUrl, writeJsonAtomic, readJson, getActiveJob, jobFile } from "./store.mjs";
import { DEFAULT_LIMIT } from "./args.mjs";
import { edgeExecutable } from "./edge.mjs";
import { startBridgeServer } from "./bridge-server.mjs";
import { printJob } from "./status.mjs";
import { finalizeRepairJob } from "./repair.mjs";

export async function launchAndMonitor(job, { openPage = true } = {}) {
  const queuedAt = Date.now();
  const queueTimeoutMs = 90_000;
  const bridgeServer = await startBridgeServer();
  try {
    if (openPage) {
      const edge = edgeExecutable();
      if (!edge) throw new Error("Microsoft Edge was not found in its standard Windows installation folders.");
      const edgeProfile = await readJson(EDGE_PROFILE_FILE);
      if (!edgeProfile?.profileDirectory) throw new Error("Run the CLI install command after loading the extension in Edge.");
      const edgeProcess = spawn(edge, [`--profile-directory=${edgeProfile.profileDirectory}`, job.url], { detached: true, stdio: "ignore", windowsHide: true });
      edgeProcess.once("error", async error => {
        const failedJob = { ...job, status: "error", message: `Could not open Edge: ${error.message}`, updatedAt: new Date().toISOString() };
        await writeJsonAtomic(jobFile(job.jobId), failedJob).catch(() => {});
        process.stderr.write(`${failedJob.message}\n`);
      });
      edgeProcess.unref();
    }

    const limitText = job.limit ? ` (limit ${job.limit} files)` : job.limit === null ? " (no limit)" : "";
    process.stdout.write(`${openPage ? "Queued" : "Monitoring"} ${job.platform}/${job.account} in Edge${limitText}. Job ${job.jobId}.\n`);
    process.stdout.write("The profile tab can run in the background while you use other tabs. Keep this CLI process open until the job completes.\n");
    let lastLine = "";
    let interrupted = false;
    const stopMonitoring = () => { interrupted = true; };
    process.once("SIGINT", stopMonitoring);
    try {
    while (!interrupted) {
      const current = await readJson(jobFile(job.jobId));
      if (current) {
        if (current.status === "queued" && Date.now() - queuedAt >= queueTimeoutMs) {
          const failedJob = {
            ...current,
            status: "error",
            message: "Edge did not acknowledge the job within 90 seconds. Reload Page Media Saver in edge://extensions, then resume this job.",
            updatedAt: new Date().toISOString()
          };
          await writeJsonAtomic(jobFile(job.jobId), failedJob);
          printJob(failedJob);
          process.exitCode = 1;
          return;
        }
        const line = `${current.status} · ${Number(current.started || 0)} requests started · ${Number(current.pending || 0)} pending · ${Number(current.failed || 0)} failed`;
        if (line !== lastLine) {
          process.stdout.write(`${line}\n`);
          lastLine = line;
        }
        if (TERMINAL_STATES.has(current.status)) {
          const finalJob = current.status === "complete" && current.repairTargets?.length && !current.repairFinalized
            ? await finalizeRepairJob(current)
            : current;
          printJob(finalJob);
          if (finalJob.status === "complete") return;
          process.exitCode = finalJob.status === "paused" ? 2 : 1;
          return;
        }
      }
      await sleep(2000);
    }
    process.stdout.write(`Stopped monitoring and closed the local bridge. Resume the job to reconnect: node cli/mediasaver.mjs resume ${job.jobId}\n`);
    } finally {
      process.removeListener("SIGINT", stopMonitoring);
    }
  } finally {
    await new Promise(resolve => bridgeServer.close(() => resolve()));
  }
}

export async function startDownload(rawUrl, limit = DEFAULT_LIMIT) {
  if (process.platform !== "win32") throw new Error("The Edge CLI bridge currently runs on Windows only.");
  if (!(await readJson(EDGE_PROFILE_FILE))?.profileDirectory) throw new Error("Run the CLI install command after loading the extension in Edge.");
  if (!(await readJson(BRIDGE_CONFIG_FILE))?.extensionOrigin) throw new Error("Run the CLI install command after loading the extension in Edge.");
  const { url, platform, account, mediaPage } = normalizeProfileUrl(rawUrl);
  const active = await getActiveJob();
  if (active && !TERMINAL_STATES.has(active.status)) {
    throw new Error(`Job ${active.jobId} is still ${active.status}. Use “status” to check it before starting another URL.`);
  }

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
    message: "Waiting for the Page Media Saver extension in Edge.",
    createdAt: now,
    updatedAt: now,
    started: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
    videoStarted: 0,
    videoSkipped: 0,
    rounds: 0
  };
  await writeJsonAtomic(jobFile(jobId), job);
  await writeJsonAtomic(QUEUE_FILE, { jobId, updatedAt: now });
  return launchAndMonitor(job);
}

export async function resumeJob(jobId) {
  const active = await getActiveJob();
  const job = jobId
    ? await readJson(jobFile(jobId))
    : active;
  if (!job) throw new Error("No job was found to resume. Run “status” to list saved jobs.");
  if (active && active.jobId !== job.jobId && !TERMINAL_STATES.has(active.status)) {
    throw new Error(`Job ${active.jobId} is still ${active.status}; finish or pause it before resuming another job.`);
  }
  if (TERMINAL_STATES.has(job.status) && job.status === "complete") {
    throw new Error("This job is already complete. Use “download <URL>” to start another scan.");
  }
  if (active?.jobId === job.jobId && job.status === "running") {
    return launchAndMonitor(job, { openPage: false });
  }
  job.status = "queued";
  job.updatedAt = new Date().toISOString();
  job.message = "Resuming the saved profile scan in Edge.";
  await writeJsonAtomic(jobFile(job.jobId), job);
  await writeJsonAtomic(QUEUE_FILE, { jobId: job.jobId, updatedAt: job.updatedAt });
  return launchAndMonitor(job);
}
