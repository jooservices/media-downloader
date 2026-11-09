// Re-downloading images left in the Downloads root and verifying them.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { stat, unlink } from "node:fs/promises";
import path from "node:path";
import {
  QUEUE_FILE,
  EDGE_PROFILE_FILE,
  BRIDGE_CONFIG_FILE,
  REPAIR_MANIFEST_FILE,
  TERMINAL_STATES,
  normalizeProfileUrl,
  cleanPathPart,
  writeJsonAtomic,
  readJson,
  getActiveJob,
  readJob,
  writeJob
} from "./store.mjs";
import { printJob } from "./status.mjs";

const IMAGE_FILE = /\.(jpe?g|png|webp|gif|avif)$/i;

const downloadRoot = () => path.resolve(process.env.USERPROFILE || process.env.HOME, "Downloads");

const sameText = (a, b) => a.toLowerCase() === b.toLowerCase();

async function saveJob(job, changes) {
  Object.assign(job, changes, { updatedAt: new Date().toISOString() });
  await writeJob(job);
  return job;
}

// A repair source must sit directly in the Downloads root and carry its own name.
function resolveSource(target, root) {
  const basename = path.basename(String(target.basename || ""));
  const sourcePath = path.resolve(String(target.rootPath || ""));
  const valid = basename && sameText(path.basename(sourcePath), basename) && sameText(path.dirname(sourcePath), root);
  return valid ? { basename, sourcePath } : null;
}

// The re-downloaded copy, when it exists in the account folder, is non-empty and is newer than the job.
async function verifiedOutputPath(job, output, root, createdAt) {
  const filename = path.basename(String(output?.filename || ""));
  const accountDirectory = path.resolve(root, job.platform, cleanPathPart(job.account));
  const outputPath = path.resolve(accountDirectory, filename);
  if (!output || !filename || !sameText(outputPath, path.join(accountDirectory, filename))) {
    return null;
  }
  try {
    const info = await stat(outputPath);
    return info.isFile() && info.size > 0 && info.mtimeMs >= createdAt ? outputPath : null;
  } catch {
    return null; // an absent or incomplete destination keeps its original
  }
}

async function deleteSources(verified) {
  let deleted = 0;
  for (const file of verified) {
    try {
      await unlink(file.sourcePath);
      deleted++;
    } catch {
      /* keep any source that could not be removed */
    }
  }
  return deleted;
}

export async function finalizeRepairJob(job) {
  const root = downloadRoot();
  const targets = job.repairTargets || [];
  const outputs = new Map((job.repairFiles || []).map(file => [String(file.basename || "").toLowerCase(), file]));
  const createdAt = Date.parse(job.createdAt) || 0;
  const verified = [];

  for (const target of targets) {
    const source = resolveSource(target, root);
    if (!source) {
      return saveJob(job, {
        status: "incomplete",
        message: "Repair source validation failed; all original files were retained."
      });
    }
    const outputPath = await verifiedOutputPath(job, outputs.get(source.basename.toLowerCase()), root, createdAt);
    if (outputPath) {
      verified.push({ sourcePath: source.sourcePath, outputPath });
    }
  }

  if (verified.length !== targets.length) {
    return saveJob(job, {
      status: "incomplete",
      repairVerified: verified.length,
      repairDeleted: 0,
      message: `Repair incomplete: verified ${verified.length} of ${targets.length} new destination files. All original files were retained.`
    });
  }
  const deleted = await deleteSources(verified);
  return saveJob(job, {
    repairVerified: verified.length,
    repairDeleted: deleted,
    repairFinalized: true,
    message: `Redownloaded and verified ${verified.length} files in Downloads/${job.platform}/${cleanPathPart(job.account)}; removed ${deleted} old root copies after verification.`
  });
}

async function assertRepairReady() {
  if (process.platform !== "win32") {
    throw new Error("Root download repair is currently supported on Windows only.");
  }
  if (
    !(await readJson(EDGE_PROFILE_FILE))?.profileDirectory ||
    !(await readJson(BRIDGE_CONFIG_FILE))?.extensionOrigin
  ) {
    throw new Error("Run the CLI install command after loading the extension in Edge.");
  }
  const active = await getActiveJob();
  if (active && !TERMINAL_STATES.has(active.status)) {
    throw new Error(`Job ${active.jobId} is still ${active.status}. Finish or resume it before starting a repair.`);
  }
}

// Every listed file must be a picture in the Downloads root; anything else aborts the repair.
function toRepairTargets(group, root) {
  return group.files
    .map(file => {
      const source = resolveSource(file, root);
      if (!source || !IMAGE_FILE.test(source.basename)) {
        throw new Error(`Rejected unsafe repair source path: ${file.rootPath || "(empty)"}`);
      }
      return { basename: source.basename, rootPath: path.resolve(String(file.rootPath)) };
    })
    .filter(target => existsSync(target.rootPath));
}

function newRepairJob(profile, targets) {
  const now = new Date().toISOString();
  return {
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
}

// Runs one account's repair; returns true when it did not fully succeed.
async function repairGroup(group, root, launchAndMonitor) {
  const profile = normalizeProfileUrl(group.url);
  if (profile.platform !== group.platform || !sameText(profile.account, String(group.account || ""))) {
    throw new Error(`Repair manifest account does not match ${group.url}.`);
  }
  if (!Array.isArray(group.files) || group.files.length === 0) {
    return false;
  }
  const targets = toRepairTargets(group, root);
  if (targets.length === 0) {
    return false;
  }
  const job = newRepairJob(profile, targets);
  await writeJob(job);
  await writeJsonAtomic(QUEUE_FILE, { jobId: job.jobId, updatedAt: job.createdAt });
  await launchAndMonitor(job);
  const completed = await readJob(job.jobId);
  return completed?.status !== "complete" || completed?.repairDeleted !== targets.length;
}

export async function repairRootDownloads(launchAndMonitor) {
  if (process.platform !== "win32") {
    throw new Error("Root download repair is currently supported on Windows only.");
  }
  await assertRepairReady();
  const manifest = await readJson(REPAIR_MANIFEST_FILE);
  if (!Array.isArray(manifest?.jobs) || manifest.jobs.length === 0) {
    throw new Error(`No repair jobs were found in ${REPAIR_MANIFEST_FILE}.`);
  }
  const root = downloadRoot();
  let hadFailure = false;
  for (const group of manifest.jobs) {
    if (await repairGroup(group, root, launchAndMonitor)) {
      hadFailure = true;
    }
  }
  if (hadFailure) {
    process.exitCode = 1;
  }
}

export async function finalizeRepairById(jobId) {
  if (!jobId) {
    throw new Error("Provide the repair job ID to verify.");
  }
  const job = await readJob(jobId);
  if (!job?.repairTargets?.length) {
    throw new Error(`No repair job was found with id ${jobId}.`);
  }
  if (job.status !== "complete") {
    throw new Error(`Repair job ${jobId} is ${job.status}; originals stay in Downloads until the job completes.`);
  }
  const result = await finalizeRepairJob(job);
  printJob(result);
  if (result.status !== "complete" || result.repairDeleted !== result.repairTargets.length) {
    process.exitCode = 1;
  }
}
