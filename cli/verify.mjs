// Compares files on disk with the completed media totals recorded for one account.
import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { cleanPathPart, listJobs, normalizeProfileUrl, writeJob } from "./store.mjs";

const PARTIAL = /(?:\.crdownload|\.part|\.pms-partial|\.tmp)$/i;
const MEDIA = /\.(?:jpe?g|png|webp|gif|avif|mp4|mov|m4v|webm|mkv|avi|3gp)$/i;

async function hasMediaHeader(file, extension) {
  const handle = await open(file, "r");
  try {
    const header = Buffer.alloc(16);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const bytes = header.subarray(0, bytesRead);
    const ext = extension.toLowerCase();
    if (["jpg", "jpeg"].includes(ext)) {
      return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    }
    if (ext === "png") {
      return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    if (ext === "gif") {
      return bytes.subarray(0, 6).toString("ascii").startsWith("GIF8");
    }
    if (ext === "webp") {
      return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
    }
    if (ext === "avif") {
      return bytes.subarray(4, 12).toString("ascii").includes("ftypavif");
    }
    if (["mp4", "mov", "m4v", "3gp"].includes(ext)) {
      return bytes.subarray(4, 8).toString("ascii") === "ftyp";
    }
    if (["webm", "mkv"].includes(ext)) {
      return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
    }
    if (ext === "avi") {
      return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "AVI ";
    }
    return bytes.length > 0;
  } finally {
    await handle.close();
  }
}

async function inspectDirectory(directory) {
  const result = { files: [], corrupt: [], partial: [], missing: 0 };
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      result.missing = 1;
      return result;
    }
    throw error;
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const nested = await inspectDirectory(file);
      result.files.push(...nested.files);
      result.corrupt.push(...nested.corrupt);
      result.partial.push(...nested.partial);
    } else if (entry.isFile() && PARTIAL.test(entry.name)) {
      result.partial.push(file);
    } else if (entry.isFile() && MEDIA.test(entry.name)) {
      const info = await stat(file);
      if (info.size > 0 && (await hasMediaHeader(file, path.extname(entry.name).slice(1)))) {
        result.files.push(file);
      } else {
        result.corrupt.push(file);
      }
    }
  }
  return result;
}

const expectedCount = job => Number(job.started || 0) + Number(job.videoStarted || 0);

export async function verifyAccount(rawAccount, { repair = false, config = null, jobs = null, write = writeJob } = {}) {
  const parsed = normalizeProfileUrl(rawAccount);
  const settings = config || (await loadConfig());
  const root = settings.downloadDir || path.join(process.env.USERPROFILE || process.env.HOME, "Downloads");
  const directory = path.join(root, parsed.platform, cleanPathPart(parsed.account));
  const accountJobs = (jobs || (await listJobs())).filter(
    job => job.platform === parsed.platform && job.account?.toLowerCase() === parsed.account.toLowerCase()
  );
  const completed = accountJobs.filter(job => job.status === "complete");
  const expected = completed.reduce((count, job) => count + expectedCount(job), 0);
  const found = await inspectDirectory(directory);
  found.missing = Math.max(0, expected - found.files.length);
  const affected = found.missing + found.corrupt.length + found.partial.length > 0;
  let requeued = 0;
  if (repair && affected) {
    for (const job of completed) {
      await write({
        ...job,
        status: "queued",
        attempts: 0,
        openedAt: null,
        message: "Requeued by verify --repair because account files are missing, corrupt or partial."
      });
      requeued++;
    }
  }
  return { platform: parsed.platform, account: parsed.account, directory, expected, ...found, requeued };
}

export async function verifyCommand(args) {
  const repair = args.includes("--repair");
  const accountArgs = args.filter(argument => argument !== "--repair");
  const rawAccount = accountArgs[0];
  if (!rawAccount || accountArgs.length !== 1 || args.filter(argument => argument === "--repair").length > 1) {
    throw new Error("Use: verify <profile-url> [--repair]");
  }
  const result = await verifyAccount(rawAccount, { repair });
  process.stdout.write(
    `${result.platform}/${result.account}: ${result.files.length}/${result.expected} files present, ${result.missing} missing, ${result.corrupt.length} corrupt, ${result.partial.length} partial.\n`
  );
  for (const file of [...result.corrupt, ...result.partial]) {
    process.stdout.write(`  ${file}\n`);
  }
  if (result.requeued) {
    process.stdout.write(`Requeued ${result.requeued} completed account job(s).\n`);
  }
  return result;
}
