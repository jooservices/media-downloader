import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { parseConfig } from "../../cli/config.mjs";

const require = createRequire(import.meta.url);
const model = require("../../src/options/options-model.js");
const { STRINGS, pick, translator } = require("../../src/options/options-strings.js");

const html = fs.readFileSync(new URL("../../src/options/options.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("../../src/options/options.js", import.meta.url), "utf8");

test("pasted text yields each http(s) link once, in order, ignoring everything else", () => {
  const text =
    "  https://x.com/a\n\nhttps://www.instagram.com/b/, note\nhttps://x.com/A ; ftp://nope\r\nhttp://x.com/c";
  assert.deepEqual(model.parseLinks(text), ["https://x.com/a", "https://www.instagram.com/b/", "http://x.com/c"]);
  assert.deepEqual(model.parseLinks(""), []);
  assert.deepEqual(model.parseLinks(null), []);
});

test("each job state gets the right tone and only the buttons that make sense", () => {
  const actions = status => model.describeJob({ status }).actions;
  assert.deepEqual(actions("running"), ["stop"]);
  assert.deepEqual(actions("queued"), ["remove"]);
  assert.deepEqual(actions("complete"), ["remove"]);
  assert.deepEqual(actions("error"), ["retry", "remove"]);
  assert.deepEqual(actions("incomplete"), ["retry", "remove"]);
  assert.deepEqual(actions("paused"), ["retry", "remove"]);
  assert.equal(model.describeJob({ status: "complete" }).tone, "ok");
  assert.equal(model.describeJob({ status: "error" }).tone, "bad");
  assert.equal(model.describeJob({ status: "running" }).tone, "busy");
  assert.equal(model.describeJob({ status: "mystery" }).state, "queued", "an unknown state reads as waiting");
});

test("a job row names the account and site, counts saved files and flags a sign-in problem", () => {
  const row = model.describeJob(
    {
      jobId: "j",
      platform: "Twitter",
      account: "nasa",
      status: "queued",
      started: 3,
      videoStarted: 4,
      message: "Waiting for you to sign in to X."
    },
    { Twitter: "X" }
  );
  assert.deepEqual([row.id, row.site, row.account, row.files, row.needsSignIn], ["j", "X", "nasa", 7, true]);
  assert.equal(model.describeJob({ status: "queued", needsLogin: true }).needsSignIn, true);
  assert.equal(model.describeJob({ status: "running", message: "Scanning." }).needsSignIn, false);
});

test("the headline counts every state and the files saved", () => {
  const jobs = [
    { status: "running", started: 5 },
    { status: "queued" },
    { status: "queued" },
    { status: "complete", started: 10, videoStarted: 2 },
    { status: "error" },
    { status: "incomplete" }
  ];
  assert.deepEqual(model.summarize(jobs), { total: 6, running: 1, waiting: 2, done: 1, problems: 2, files: 17 });
  assert.deepEqual(model.summarize([]), { total: 0, running: 0, waiting: 0, done: 0, problems: 0, files: 0 });
});

test("a site needs a sign-in prompt only when the user is signed out and has unfinished work there", () => {
  const login = {
    Twitter: { label: "X", signedIn: true, signInUrl: "u1" },
    Instagram: { label: "Instagram", signedIn: false, signInUrl: "u2" },
    Facebook: { label: "Facebook", signedIn: false, signInUrl: "u3" }
  };
  const jobs = [
    { platform: "Instagram", status: "queued" },
    { platform: "Facebook", status: "complete" },
    { platform: "Twitter", status: "queued" }
  ];
  assert.deepEqual(model.signInNeeded(login, jobs), [{ site: "Instagram", label: "Instagram", url: "u2" }]);
  assert.deepEqual(model.signInNeeded(login, []), []);
  assert.deepEqual(model.signInNeeded(null, jobs), []);
});

test("the settings form round-trips through the extension's own validator", () => {
  const settings = parseConfig({
    workers: { x: 2, instagram: 3 },
    delaySeconds: { min: 5, max: 9 },
    maxAttempts: 4,
    limit: 50
  });
  const form = model.settingsToForm(settings);
  assert.deepEqual(form.workers, { x: "2", instagram: "3", facebook: "1" });
  assert.deepEqual(
    [form.delayMin, form.delayMax, form.maxAttempts, form.limit, form.unlimited],
    ["5", "9", "4", "50", false]
  );
  assert.deepEqual(parseConfig(model.formToSettings(form)), settings);
});

test("an unlimited profile limit round-trips as no limit, and a blank field is not silently zero", () => {
  const form = model.settingsToForm(parseConfig({}));
  assert.equal(form.unlimited, true);
  assert.equal(parseConfig(model.formToSettings(form)).limit, null);
  assert.throws(() => parseConfig(model.formToSettings({ ...form, delayMin: "" })), /delaySeconds/);
  assert.throws(() => parseConfig(model.formToSettings({ ...form, unlimited: false, limit: "" })), /limit/);
});

test("every language has exactly the same texts, and the placeholders match", () => {
  const english = Object.keys(STRINGS.en).sort();
  for (const [language, table] of Object.entries(STRINGS)) {
    assert.deepEqual(Object.keys(table).sort(), english, language);
    for (const key of english) {
      const names = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
      assert.deepEqual(names(table[key]), names(STRINGS.en[key]), `${language}.${key}`);
    }
  }
});

test("a language is picked from the browser's, falling back to English", () => {
  assert.equal(pick("vi"), "vi");
  assert.equal(pick("vi-VN"), "vi");
  assert.equal(pick("EN-us"), "en");
  assert.equal(pick("fr"), "en");
  assert.equal(pick(undefined), "en");
});

test("the translator fills placeholders and shows a missing text as its key", () => {
  const t = translator("vi");
  assert.equal(t("added", { count: 3 }), "Đã thêm 3.");
  assert.equal(translator("en")("added", { count: 3 }), "Added 3.");
  assert.equal(t("nope"), "nope");
  assert.equal(translator("en")("added"), "Added {count}.");
});

test("every text the page asks for exists in every language", () => {
  const keys = [...html.matchAll(/data-i18n(?:-placeholder)?="(\w+)"/g)].map(match => match[1]);
  const dynamic = [...script.matchAll(/\bt\("(\w+)"/g)].map(match => match[1]);
  const states = ["running", "queued", "complete", "error", "incomplete", "paused"].map(state => `state_${state}`);
  const actions = ["stop", "retry", "remove"].map(action => `action_${action}`);
  for (const key of new Set([...keys, ...dynamic, ...states, ...actions])) {
    for (const [language, table] of Object.entries(STRINGS)) {
      assert.ok(Object.hasOwn(table, key), `${language} is missing ${key}`);
    }
  }
});

test("every element the page script looks up exists in the page", () => {
  const ids = new Set([...html.matchAll(/\sid="([\w-]+)"/g)].map(match => match[1]));
  for (const match of script.matchAll(/\bel\("([\w-]+)"\)/g)) {
    assert.ok(ids.has(match[1]), `options.html has no #${match[1]}`);
  }
});

test("the page loads its scripts in dependency order and nothing from the network", () => {
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(scripts, ["options-strings.js", "options-model.js", "options.js"]);
  assert.doesNotMatch(html, /https?:\/\//);
});
