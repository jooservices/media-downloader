import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Runs one of the extension's classic scripts (a path relative to the repository root) in a
// fake page. The file name is the real path so coverage is attributed to the source file.
export function runScript(relativePath, context) {
  const full = path.join(ROOT, relativePath);
  const script = new vm.Script(fs.readFileSync(full, "utf8"), { filename: full });
  return vm.isContext(context) ? script.runInContext(context) : script.runInNewContext(context);
}
