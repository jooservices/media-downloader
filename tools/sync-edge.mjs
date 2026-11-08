// Copies the extension and the CLI into the folder Edge has loaded unpacked, and bumps that
// copy's manifest version so Edge notices the new files. The git tree's own version is not changed.
// Logs, queues and URL lists already in the destination are left where they are.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extensionFiles } from "./build.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function nextEdgeVersion(current) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(current || "").trim());
  if (!match) {
    return "0.5.1";
  }
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`;
}

const REQUIRED_LIB = /require\(["'](\.\.\/lib\/[^"']+)["']\)/g;

// The CLI folder plus the shared lib files it loads. Extension packaging does not see a lib
// file that only the CLI requires, and the Edge copy then fails at startup.
export function cliBundle(root) {
  const files = [];
  const walk = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".mjs")) {
        files.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  };
  walk(path.join(root, "cli"));
  const libs = [];
  for (const file of files) {
    for (const match of readFileSync(path.join(root, file), "utf8").matchAll(REQUIRED_LIB)) {
      libs.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])));
    }
  }
  return [...files, ...libs];
}

async function destinationVersion(destination, fallback) {
  try {
    return JSON.parse(await readFile(path.join(destination, "manifest.json"), "utf8")).version || fallback;
  } catch {
    return fallback;
  }
}

export async function syncEdge(destination, root = ROOT) {
  if (path.resolve(destination) === path.resolve(root)) {
    throw new Error("Refusing to sync a folder onto itself.");
  }
  const readText = file => readFileSync(path.join(root, file), "utf8");
  const manifest = JSON.parse(readText("manifest.json"));
  const files = [...new Set([...extensionFiles(manifest, readText), ...cliBundle(root)])];
  const version = nextEdgeVersion(await destinationVersion(destination, manifest.version));
  for (const file of files) {
    const target = path.join(destination, file);
    await mkdir(path.dirname(target), { recursive: true });
    if (file === "manifest.json") {
      await writeFile(target, `${JSON.stringify({ ...manifest, version }, null, 2)}\n`);
    } else {
      await copyFile(path.join(root, file), target);
    }
  }
  return { version, count: files.length };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const destination = process.argv[2] || "C:\\Claude\\PageMediaSaver";
  const result = await syncEdge(destination);
  process.stdout.write(`Synced ${result.count} files to ${destination} as version ${result.version}.\n`);
  process.stdout.write("Reload Page Media Saver in edge://extensions before the new code runs.\n");
}
