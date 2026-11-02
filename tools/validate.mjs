// Checks the extension's manifest against the files on disk and against package.json.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Every file the manifest points at: scripts, the worker, the popup, icons. */
export function manifestFiles(manifest) {
  const files = new Set();
  for (const entry of manifest.content_scripts ?? []) {
    for (const file of [...(entry.js ?? []), ...(entry.css ?? [])]) {
      files.add(file);
    }
  }
  if (manifest.background?.service_worker) {
    files.add(manifest.background.service_worker);
  }
  if (manifest.action?.default_popup) {
    files.add(manifest.action.default_popup);
  }
  if (manifest.options_ui?.page) {
    files.add(manifest.options_ui.page);
  }
  for (const icon of Object.values({ ...manifest.icons, ...manifest.action?.default_icon })) {
    files.add(icon);
  }
  return [...files];
}

/** The problems found in a manifest, as readable lines (an empty list means it is valid). */
export function validateManifest(manifest, packageJson, fileExists) {
  const problems = [];
  if (manifest.manifest_version !== 3) {
    problems.push("manifest_version must be 3");
  }
  if (manifest.version !== packageJson.version) {
    problems.push(`manifest version ${manifest.version} differs from package.json ${packageJson.version}`);
  }
  for (const key of ["name", "description", "version"]) {
    if (!manifest[key]) {
      problems.push(`manifest is missing "${key}"`);
    }
  }
  for (const file of manifestFiles(manifest)) {
    if (!fileExists(file)) {
      problems.push(`manifest references a missing file: ${file}`);
    }
  }
  for (const pattern of manifest.host_permissions ?? []) {
    if (pattern === "<all_urls>" || pattern === "*://*/*") {
      problems.push(`host permission is too broad: ${pattern}`);
    }
  }
  return problems;
}

function main() {
  const manifest = JSON.parse(readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8"));
  const problems = validateManifest(manifest, packageJson, file => existsSync(path.join(ROOT, file)));
  if (problems.length) {
    console.error(problems.map(problem => `✖ ${problem}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  console.log(`✔ manifest ${manifest.version} is valid (${manifestFiles(manifest).length} files checked)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
