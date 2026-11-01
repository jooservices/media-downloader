// Printing a job and listing saved jobs.
import { readdir } from "node:fs/promises";
import path from "node:path";
import { JOBS_DIR, readJson, getActiveJob, jobFile } from "./store.mjs";

export function printJob(job) {
  process.stdout.write(`Job: ${job.jobId}\n`);
  process.stdout.write(`Status: ${job.status}\n`);
  if (job.platform || job.account) process.stdout.write(`Account: ${job.platform || ""}/${job.account || ""}\n`);
  process.stdout.write(`Started requests: ${Number(job.started || 0)} · pending: ${Number(job.pending || 0)} · failed: ${Number(job.failed || 0)} · skipped: ${Number(job.skipped || 0)}\n`);
  if (job.videoStarted || job.videoSkipped) process.stdout.write(`Files from page data or menus started: ${Number(job.videoStarted || 0)} · unavailable or already saved: ${Number(job.videoSkipped || 0)}\n`);
  if (job.message) process.stdout.write(`${job.message}\n`);
}

export async function showStatus(jobId) {
  if (jobId) {
    const job = await readJson(jobFile(jobId));
    if (!job) throw new Error(`No job was found with id ${jobId}.`);
    printJob(job);
    return;
  }
  const active = await getActiveJob();
  if (active) {
    printJob(active);
    return;
  }
  const entries = await readdir(JOBS_DIR, { withFileTypes: true }).catch(() => []);
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith(".json"));
  const jobs = [];
  for (const entry of files) {
    const job = await readJson(path.join(JOBS_DIR, entry.name));
    if (job) jobs.push(job);
  }
  jobs.sort((a, b) => String(b.updatedAt || b.createdAt).localeCompare(String(a.updatedAt || a.createdAt)));
  if (!jobs.length) {
    process.stdout.write("No Page Media Saver jobs yet.\n");
    return;
  }
  for (const job of jobs.slice(0, 10)) {
    process.stdout.write(`${job.jobId}  ${job.status.padEnd(10)}  ${job.platform || ""}/${job.account || ""}  ${job.message || ""}\n`);
  }
}
