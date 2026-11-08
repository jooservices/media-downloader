// Printing a job and listing saved jobs.
import { createRequire } from "node:module";
import { readJson, getActiveJob, jobFile, listJobs } from "./store.mjs";
import { loadConfig } from "./config.mjs";

const require = createRequire(import.meta.url);
const { saveSummary } = require("../lib/job-progress.js");

export function printJob(job, downloadDir = null) {
  process.stdout.write(`Job: ${job.jobId}\n`);
  process.stdout.write(`Status: ${job.status}\n`);
  if (job.platform || job.account) {
    process.stdout.write(`Account: ${job.platform || ""}/${job.account || ""}\n`);
  }
  process.stdout.write(
    `Started requests: ${Number(job.started || 0)} · pending: ${Number(job.pending || 0)} · failed: ${Number(job.failed || 0)} · skipped: ${Number(job.skipped || 0)}\n`
  );
  if (job.videoStarted || job.videoSkipped) {
    process.stdout.write(
      `Files from page data or menus started: ${Number(job.videoStarted || 0)} · unavailable or already saved: ${Number(job.videoSkipped || 0)}\n`
    );
  }
  if (job.message) {
    process.stdout.write(`${job.message}\n`);
  }
  process.stdout.write(`${saveSummary(job, downloadDir)}\n`);
}

export async function showStatus(jobId) {
  if (jobId) {
    const job = await readJson(jobFile(jobId));
    if (!job) {
      throw new Error(`No job was found with id ${jobId}.`);
    }
    printJob(job, (await loadConfig().catch(() => null))?.downloadDir);
    return;
  }
  const active = await getActiveJob();
  if (active) {
    printJob(active, (await loadConfig().catch(() => null))?.downloadDir);
    return;
  }
  const jobs = (await listJobs()).sort((a, b) =>
    String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt))
  );
  if (!jobs.length) {
    process.stdout.write("No Page Media Saver jobs yet.\n");
    return;
  }
  const counts = {};
  for (const job of jobs) {
    counts[job.status] = (counts[job.status] || 0) + 1;
  }
  process.stdout.write(
    `Jobs: ${Object.entries(counts)
      .map(([status, n]) => `${n} ${status}`)
      .join(", ")}\n`
  );
  for (const job of jobs.slice(0, 10)) {
    process.stdout.write(
      `${job.jobId}  ${job.status.padEnd(10)}  ${job.platform || ""}/${job.account || ""}  ${job.message || ""}\n`
    );
  }
}
