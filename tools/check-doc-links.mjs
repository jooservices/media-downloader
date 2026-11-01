// Checks that every relative link in the repository's Markdown files points at a file that exists.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKIPPED_DIRECTORIES = new Set(["node_modules", "build", "coverage", ".git"]);
const LINK = /\]\(([^)\s]+)\)/g;

export function markdownFiles(directory) {
  const found = [];
  for (const name of readdirSync(directory)) {
    const full = path.join(directory, name);
    if (SKIPPED_DIRECTORIES.has(name)) {
      continue;
    }
    if (statSync(full).isDirectory()) {
      found.push(...markdownFiles(full));
    } else if (name.endsWith(".md")) {
      found.push(full);
    }
  }
  return found;
}

const isExternal = target => /^(?:[a-z][a-z0-9+.-]*:|#)/i.test(target);

/** Relative links in `text` (found in `file`) whose target does not exist. */
export function brokenLinks(text, file, fileExists = existsSync) {
  const broken = [];
  for (const match of text.matchAll(LINK)) {
    const target = match[1];
    if (isExternal(target)) {
      continue;
    }
    const withoutAnchor = decodeURIComponent(target.split("#")[0]);
    if (withoutAnchor && !fileExists(path.resolve(path.dirname(file), withoutAnchor))) {
      broken.push(target);
    }
  }
  return broken;
}

function main() {
  let failed = 0;
  for (const file of markdownFiles(ROOT)) {
    for (const target of brokenLinks(readFileSync(file, "utf8"), file)) {
      console.error(`✖ ${path.relative(ROOT, file)}: broken link ${target}`);
      failed++;
    }
  }
  if (failed) {
    process.exitCode = 1;
    return;
  }
  console.log("✔ all relative Markdown links resolve");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
