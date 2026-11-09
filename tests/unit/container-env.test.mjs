import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// The settings are read when a module loads, so each case runs in a fresh process.
function inFreshProcess(code, env) {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("PMS_DATA_DIR decides where the queue keeps everything", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "pms-data-"));
  try {
    const printed = inFreshProcess(
      'import { APP_DIR, JOBS_DB_FILE } from "./cli/store.mjs"; console.log(JSON.stringify([APP_DIR, JOBS_DB_FILE]));',
      { PMS_DATA_DIR: data, LOCALAPPDATA: path.join(data, "ignored") }
    );
    assert.deepEqual(JSON.parse(printed), [data, path.join(data, "queue.db")]);
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});

test("PMS_DOWNLOAD_DIR is the download folder unless config.json names one", async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), "pms-dl-"));
  const code =
    'import { loadConfig } from "./cli/config.mjs"; console.log(JSON.stringify((await loadConfig()).downloadDir));';
  try {
    const env = { PMS_DATA_DIR: data, PMS_DOWNLOAD_DIR: "/media" };
    assert.equal(JSON.parse(inFreshProcess(code, env)), "/media", "no config file at all");
    await writeFile(path.join(data, "config.json"), JSON.stringify({ maxAttempts: 4 }));
    assert.equal(JSON.parse(inFreshProcess(code, env)), "/media", "a config without a folder");
    await writeFile(path.join(data, "config.json"), JSON.stringify({ downloadDir: "/chosen" }));
    assert.equal(JSON.parse(inFreshProcess(code, env)), "/chosen", "the file wins");
    assert.equal(JSON.parse(inFreshProcess(code, { ...env, PMS_DOWNLOAD_DIR: "" })), "/chosen");
  } finally {
    await rm(data, { recursive: true, force: true });
  }
});
