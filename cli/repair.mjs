// Re-downloading images left in the Downloads root and verifying them.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import { QUEUE_FILE, EDGE_PROFILE_FILE, BRIDGE_CONFIG_FILE, REPAIR_MANIFEST_FILE, TERMINAL_STATES, normalizeProfileUrl, cleanPathPart, writeJsonAtomic, readJson, getActiveJob, jobFile } from "./store.mjs";
import { printJob } from "./status.mjs";
import { launchAndMonitor } from "./jobs.mjs";

export async function finalizeRepairJob(job) {
  const downloadRoot = path.resolve(process.env.USERPROFILE || process.env.HOME, "Downloads");
  const expectedTargets = job.repairTargets || [];
  const outputByBasename = new Map((job.repairFiles || []).map(file => [String(file.basename || "").toLowerCase(), file]));
  const verified = [];
  const createdAt = Date.parse(job.createdAt) || 0;

  for (const target of expectedTargets) {
    const basename = path.basename(String(target.basename || ""));
    const sourcePath = path.resolve(String(target.rootPath || ""));
    if (!basename || path.basename(sourcePath).toLowerCase() !== basename.toLowerCase()
      || path.dirname(sourcePath).toLowerCase() !== downloadRoot.toLowerCase()) {
      job.status = "incomplete";
      job.message = "Repair source validation failed; all original files were retained.";
      job.updatedAt = new Date().toISOString();
      await writeJsonAtomic(jobFile(job.jobId), job);
      return job;
    }

    const output = outputByBasename.get(basename.toLowerCase());
    const filename = path.basename(String(output?.filename || ""));
    const accountDirectory = path.resolve(downloadRoot, job.platform, cleanPathPart(job.account));
    const outputPath = path.resolve(accountDirectory, filename);
    if (!output || !filename || outputPath.toLowerCase() !== path.join(accountDirectory, filename).toLowerCase()) continue;
    try {
      const info = await stat(outputPath);
      if (info.isFile() && info.size > 0 && info.mtimeMs >= createdAt) {
        verified.push({ sourcePath, outputPath });
      }
    } catch { /* an absent or incomplete destination keeps its original */ }
  }

  if (verified.length !== expectedTargets.length) {
    job.status = "incomplete";
    job.repairVerified = verified.length;
    job.repairDeleted = 0;
    job.message = `Repair incomplete: verified ${verified.length} of ${expectedTargets.length} new destination files. All original files were retained.`;
    job.updatedAt = new Date().toISOString();
    await writeJsonAtomic(jobFile(job.jobId), job);
    return job;
  }

  let deleted = 0;
  for (const file of verified) {
    try {
      await unlink(file.sourcePath);
      deleted++;
    } catch { /* keep any source that could not be removed */ }
  }
  job.repairVerified = verified.length;
  job.repairDeleted = deleted;
  job.repairFinalized = true;
  job.message = `Redownloaded and verified ${verified.length} files in Downloads/${job.platform}/${cleanPathPart(job.account)}; removed ${deleted} old root copies after verification.`;
  job.updatedAt = new Date().toISOString();
  await writeJsonAtomic(jobFile(job.jobId), job);
  return job;
}

export async function repairRootDownloads(launchAndMonitor) {
  if (process.platform !== "win32") throw new Error("Root download repair is currently supported on Windows only.");
  if (!(await readJson(EDGE_PROFILE_FILE))?.profileDirectory || !(await readJson(BRIDGE_CONFIG_FILE))?.extensionOrigin) {
    throw new Error("Run the CLI install command after loading the extension in Edge.");
  }
  const manifest = await readJson(REPAIR_MANIFEST_FILE);
  if (!Array.isArray(manifest?.jobs) || !manifest.jobs.length) {
    throw new Error(`No repair jobs were found in ${REPAIR_MANIFEST_FILE}.`);
  }
  const downloadRoot = path.resolve(process.env.USERPROFILE || process.env.HOME, "Downloads");
  const active = await getActiveJob();
  if (active && !TERMINAL_STATES.has(active.status)) {
    throw new Error(`Job ${active.jobId} is still ${active.status}. Finish or resume it before starting a repair.`);
  }

  let hadFailure = false;
  for (const group of manifest.jobs) {
    const profile = normalizeProfileUrl(group.url);
    if (profile.platform !== group.platform || profile.account.toLowerCase() !== String(group.account || "").toLowerCase()) {
      throw new Error(`Repair manifest account does not match ${group.url}.`);
    }
    if (!Array.isArray(group.files) || !group.files.length) continue;
    const targets = group.files.map(file => {
      const basename = path.basename(String(file.basename || ""));
      const rootPath = path.resolve(String(file.rootPath || ""));
      if (!basename || path.basename(rootPath).toLowerCase() !== basename.toLowerCase()
        || path.dirname(rootPath).toLowerCase() !== downloadRoot.toLowerCase()
        || !/\.(jpe?g|png|webp|gif|avif)$/i.test(basename)) {
        throw new Error(`Rejected unsafe repair source path: ${file.rootPath || "(empty)"}`);
      }
      return { basename, rootPath };
    }).filter(target => existsSync(target.rootPath));
    if (!targets.length) continue;

    const now = new Date().toISOString();
    const job = {
      jobId: randomUUID(),
      url: profile.url,
      platform: profile.platform,
      account: profile.account,
      status: "queued",
      mode: "repair-root",
      message: "Waiting for Edge to find the selected source images and redownload the largest exposed versions.",
      createdAt: now,
      updatedAt: now,
      started: 0,
      skipped: 0,
      failed: 0,
      pending: 0,
      rounds: 0,
      repairTargets: targets,
      repairBasenames: targets.map(target => target.basename),
      repairFound: [],
      repairFiles: []
    };
    await writeJsonAtomic(jobFile(job.jobId), job);
    await writeJsonAtomic(QUEUE_FILE, { jobId: job.jobId, updatedAt: now });
    await launchAndMonitor(job);
    const completed = await readJson(jobFile(job.jobId));
    if (completed?.status !== "complete" || completed?.repairDeleted !== targets.length) hadFailure = true;
  }
  if (hadFailure) process.exitCode = 1;
}

export async function finalizeRepairById(jobId) {
  if (!jobId) throw new Error("Provide the repair job ID to verify.");
  const job = await readJson(jobFile(jobId));
  if (!job?.repairTargets?.length) throw new Error(`No repair job was found with id ${jobId}.`);
  if (job.status !== "complete") throw new Error(`Repair job ${jobId} is ${job.status}; originals stay in Downloads until the job completes.`);
  const result = await finalizeRepairJob(job);
  printJob(result);
  if (result.status !== "complete" || result.repairDeleted !== result.repairTargets.length) process.exitCode = 1;
}
