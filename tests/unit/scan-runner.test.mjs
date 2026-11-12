import assert from "node:assert/strict";
import test from "node:test";
import { loadPage } from "../helpers/fake-page.mjs";

test("a TikTok grid pass with missing collected items tolerates the absent field", async () => {
  const page = loadPage({ url: "https://www.tiktok.com/@alice/" });
  page.ns.videoSources.collectPageMedia = async () => ({ items: undefined });

  const reply = await page.request({
    type: "AUTO_START_CLI",
    job: { jobId: "scan-tiktok-grid", url: "https://www.tiktok.com/@alice/", limit: null }
  });
  assert.equal(reply.ok, true, reply.error);
  const state = await page.finish();

  assert.equal(state.running, false);
  assert.equal(state.status, "incomplete");
  assert.doesNotMatch(state.message, /Cannot read properties of undefined.*filter/);
});
