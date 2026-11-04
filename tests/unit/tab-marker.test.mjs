import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { shouldRetry } from "../../cli/supervisor.mjs";
import { loadBackground } from "../helpers/background.mjs";
import { loadContent } from "../helpers/content.mjs";

const require = createRequire(import.meta.url);
const { cliTabMarker, cliJobIdFromHash, isSignInPage, samePage } = require("../../lib/urls.js");

test("a job id survives the round trip through the URL fragment, in either letter case", () => {
  const id = randomUUID();
  assert.equal(cliJobIdFromHash(cliTabMarker(id)), id);
  assert.equal(cliJobIdFromHash(cliTabMarker(id.toUpperCase())), id);
});

test("only a well-formed marker counts as one", () => {
  for (const hash of [
    "",
    "#",
    "#pms=",
    "#pms=abc",
    "#other=1",
    "#pms=../../x",
    `#pms=${randomUUID()}x`,
    null,
    undefined
  ]) {
    assert.equal(cliJobIdFromHash(hash), null, String(hash));
  }
});

test("the marker does not change which page a URL points at", () => {
  const id = randomUUID();
  assert.equal(samePage(`https://x.com/NASA/${cliTabMarker(id)}`, "https://x.com/nasa/"), true);
  assert.equal(samePage(`https://www.instagram.com/a/${cliTabMarker(id)}`, "https://www.instagram.com/b/"), false);
});

test("sign-in and security-check pages are recognised on every site", () => {
  for (const url of [
    "https://www.instagram.com/accounts/login/?next=%2Fa%2F",
    "https://x.com/i/flow/login",
    "https://x.com/login",
    "https://www.facebook.com/login.php?next=x",
    "https://www.facebook.com/login/",
    "https://www.facebook.com/checkpoint/1234/",
    "https://www.instagram.com/challenge/"
  ]) {
    assert.equal(isSignInPage(url), true, url);
  }
  for (const url of [
    "https://www.instagram.com/loginfan/",
    "https://x.com/login_help_desk",
    "https://x.com/NASA/",
    "https://www.facebook.com/checkpoints.fans",
    "not a url",
    ""
  ]) {
    assert.equal(isSignInPage(url), false, url);
  }
});

test("a job that was told not to retry is never retried", () => {
  assert.equal(shouldRetry({ status: "error", attempts: 1, noRetry: true }, 3), false);
  assert.equal(shouldRetry({ status: "error", attempts: 1 }, 3), true);
});

test("a tab the CLI opened announces itself even on a page that is not a profile", () => {
  const id = randomUUID();
  const { sent } = loadContent({ url: `https://www.instagram.com/accounts/login/#pms=${id}` });
  const ready = sent.find(message => message.type === "CLI_PAGE_READY");
  assert.equal(ready.cliJobId, id);
});

test("a tab the user opened on a non-profile page stays silent, and a profile tab has no job id", () => {
  assert.equal(loadContent({ url: "https://www.instagram.com/accounts/login/" }).sent.length, 0);
  const ready = loadContent({ url: "https://x.com/NASA/" }).sent.find(message => message.type === "CLI_PAGE_READY");
  assert.equal(ready.cliJobId, null);
});

test("the extension forwards the job id and closes the tab when the bridge says it is not needed", async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ ok: true, type: "NO_JOB", close: true }) };
  };
  const env = loadBackground({ fetchImpl });
  const id = randomUUID();
  await env.send(
    { type: "CLI_PAGE_READY", pageUrl: "https://x.com/a/", platform: "Twitter", account: "a", cliJobId: id },
    {
      tab: { id: 42, url: "https://x.com/a/" }
    }
  );
  assert.equal(bodies[0].cliJobId, id);
  assert.deepEqual(env.tabRemoves, [42]);
});

test("a tab with no marker is never closed by a NO_JOB answer", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ ok: true, type: "NO_JOB" }) });
  const env = loadBackground({ fetchImpl });
  await env.send(
    { type: "CLI_PAGE_READY", pageUrl: "https://x.com/a/", platform: "Twitter", account: "a" },
    {
      tab: { id: 43, url: "https://x.com/a/" }
    }
  );
  assert.deepEqual(env.tabRemoves, []);
});
