import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { DEFAULT_CONFIG, MAX_WORKERS, parseConfig } from "../../cli/config.mjs";
import { plain } from "../helpers/background.mjs";

test("a config.json that cannot be parsed is left alone: the error surfaces and the file is not replaced", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pms-config-"));
  const script = `
    import { ensureConfigFile } from ${JSON.stringify(pathToFileURL(path.resolve("cli/config.mjs")).href)};
    try { await ensureConfigFile(); console.log("no error"); } catch (error) { console.log("error:" + error.name); }
  `;
  const run = () =>
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, LOCALAPPDATA: root, XDG_DATA_HOME: root, HOME: root },
      encoding: "utf8"
    }).trim();
  const file = path.join(root, "PageMediaSaver", "config.json");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, '{ "downloadDir": "D:\\\\Media", }');

  assert.equal(run(), "error:SyntaxError");
  assert.match(await readFile(file, "utf8"), /downloadDir/, "the user's file is untouched");

  await rm(file);
  assert.equal(run(), "no error");
  assert.match(await readFile(file, "utf8"), /workers/, "a missing file gets the defaults");
});

test("an empty or missing config gives the safe defaults: one worker per site", () => {
  for (const raw of [null, undefined, {}]) {
    assert.deepEqual(plain(parseConfig(raw)), plain(DEFAULT_CONFIG));
  }
  assert.deepEqual(plain(DEFAULT_CONFIG.workers), { Twitter: 1, Instagram: 1, Facebook: 1, TikTok: 1 });
});

test("workers are set per site, and x is another name for Twitter", () => {
  const config = parseConfig({ workers: { x: 3, Instagram: 2 } });
  assert.deepEqual(plain(config.workers), { Twitter: 3, Instagram: 2, Facebook: 1, TikTok: 1 });
  assert.equal(parseConfig({ workers: { TWITTER: 2 } }).workers.Twitter, 2);
});

test("rejects a worker count that is not a whole number from 1 to the maximum", () => {
  for (const value of [0, -1, 1.5, "2", null, MAX_WORKERS + 1]) {
    assert.throws(() => parseConfig({ workers: { x: value } }), /workers\.x must be a whole number/, String(value));
  }
  assert.doesNotThrow(() => parseConfig({ workers: { x: MAX_WORKERS } }));
  assert.throws(() => parseConfig({ workers: { tumblr: 1 } }), /unknown site/);
});

test("limit is a whole number of at least 1, or null for no limit", () => {
  assert.equal(parseConfig({}).limit, null);
  assert.equal(parseConfig({ limit: 50 }).limit, 50);
  assert.equal(parseConfig({ limit: null }).limit, null);
  for (const value of [0, -3, 1.5, "10"]) {
    assert.throws(() => parseConfig({ limit: value }), /limit must be/, String(value));
  }
});

test("the pause between accounts needs min <= max within an hour", () => {
  assert.deepEqual(plain(parseConfig({ delaySeconds: { min: 5 } }).delaySeconds), { min: 5, max: 60 });
  assert.deepEqual(plain(parseConfig({ delaySeconds: { min: 0, max: 0 } }).delaySeconds), { min: 0, max: 0 });
  for (const delay of [{ min: 90, max: 10 }, { min: -1 }, { max: 3601 }, { min: "a" }]) {
    assert.throws(() => parseConfig({ delaySeconds: delay }), /delaySeconds/, JSON.stringify(delay));
  }
});

test("maxAttempts is a whole number from 1 to 20", () => {
  assert.equal(parseConfig({ maxAttempts: 5 }).maxAttempts, 5);
  for (const value of [0, 21, 2.5, "3"]) {
    assert.throws(() => parseConfig({ maxAttempts: value }), /maxAttempts/, String(value));
  }
});

test("canary accounts are normalized supported profiles with a bounded probe interval", () => {
  assert.deepEqual(parseConfig({ canary: { accounts: ["https://x.com/Name"], intervalMinutes: 60 } }).canary, {
    accounts: ["https://x.com/Name/"],
    intervalMinutes: 60
  });
  assert.equal(parseConfig({}).canary, null);
  for (const canary of [
    "x",
    [],
    {},
    { accounts: [] },
    { accounts: ["https://example.com/a"] },
    { accounts: ["https://www.instagram.com/p/ABC123/"] },
    { accounts: ["https://instagram.com/a"], intervalMinutes: 14 },
    { accounts: ["https://instagram.com/a"], intervalMinutes: 1.5 }
  ]) {
    assert.throws(() => parseConfig({ canary }), /canary/);
  }
});

test("downloadDir accepts a drive folder or a network share and normalises it", () => {
  assert.equal(parseConfig({ downloadDir: "D:\\Media\\" }).downloadDir, "D:\\Media");
  assert.equal(parseConfig({ downloadDir: "D:/Media/Social" }).downloadDir, "D:\\Media\\Social");
  assert.equal(parseConfig({ downloadDir: "\\\\nas\\share\\Media" }).downloadDir, "\\\\nas\\share\\Media");
  assert.equal(parseConfig({ downloadDir: "/home/me/Media/" }).downloadDir, "/home/me/Media");
  assert.equal(parseConfig({ downloadDir: "" }).downloadDir, null);
  assert.equal(parseConfig({}).downloadDir, null);
});

test("downloadDir refuses a relative path, a drive root and system folders", () => {
  for (const dir of [
    "Media",
    ".\\Media",
    "..\\x",
    "D:",
    "D:\\",
    "C:\\Windows",
    "C:\\Windows\\System32",
    "C:\\Program Files\\x",
    42,
    "D:\\a\0b"
  ]) {
    assert.throws(() => parseConfig({ downloadDir: dir }), /downloadDir/, String(dir));
  }
});

test("the config must be a JSON object", () => {
  for (const raw of ["text", 5, [], true]) {
    assert.throws(() => parseConfig(raw), /JSON object/, JSON.stringify(raw));
  }
});
