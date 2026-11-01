import assert from "node:assert/strict";
import test from "node:test";
import { loadBackground } from "./helpers/background.mjs";

for (const example of [
  {
    platform: "Twitter",
    account: "asagi2211",
    url: "https://video.twimg.com/ext_tw_video/123/pu/vid/1280x720/a1b2.mp4",
    expected: "Twitter/asagi2211/video_status-123.mp4"
  },
  {
    platform: "Instagram",
    account: "naiverosie",
    url: "https://scontent.cdninstagram.com/v/t50.2886-16/reel-123.mp4",
    expected: "Instagram/naiverosie/video_reel-123.mp4"
  },
  {
    platform: "Facebook",
    account: "lamoon.ladyofmoon",
    url: "https://video.fbsbx.com/v/t42.1790-2/video-123.mp4",
    expected: "Facebook/lamoon.ladyofmoon/video_fb-123.mp4"
  }
]) {
  test(`routes an official ${example.platform} video into its account folder and records completion`, async () => {
    const key = `${example.platform}:${example.account}:video:${example.expected}`;
    const harness = loadBackground({
      storage: {
        nativeVideoTarget: {
          platform: example.platform,
          account: example.account,
          key,
          filename: example.expected.split("/").at(-1),
          sourceOrigin: example.platform === "Twitter" ? "https://x.com" : `https://www.${example.platform.toLowerCase()}.com`,
          expiresAt: Date.now() + 30000
        }
      }
    });
    const item = {
      id: 71,
      url: example.url,
      referrer: harness.storage.nativeVideoTarget.sourceOrigin,
      filename: "platform-video.mp4",
      mime: "video/mp4"
    };

    const suggestion = await harness.determine(item);
    assert.equal(suggestion[0].filename, example.expected);
    assert.equal(harness.storage.nativeVideoTarget, null);
    assert.equal(harness.storage.nativeVideoPending["71"].key, key);

    harness.downloads.set(71, { id: 71, state: "complete" });
    await harness.listeners.changed[0]({ id: 71, state: { current: "complete" } });
    assert.ok(await harness.ledger.has(key));
    assert.equal(Object.keys(harness.storage.nativeVideoPending).length, 0);
  });
}

test("does not reroute a download when no native video target is armed", async () => {
  const harness = loadBackground();
  const suggestion = await harness.determine({
    id: 88,
    url: "https://video.twimg.com/video.mp4",
    referrer: "https://x.com/home",
    filename: "video.mp4",
    mime: "video/mp4"
  });

  assert.deepEqual(suggestion, []);
  assert.equal(harness.storage.nativeVideoPending, undefined);
});

test("rejects a native download that comes from another platform's host", async () => {
  const harness = loadBackground({
    storage: {
      nativeVideoTarget: {
        platform: "Instagram", account: "a", key: "Instagram:a:video:1", filename: "video_1.mp4",
        sourceOrigin: "", expiresAt: Date.now() + 30000
      }
    }
  });
  const suggestion = await harness.determine({
    id: 5, url: "https://video.twimg.com/v.mp4", referrer: "https://x.com/a/status/1", filename: "v.mp4", mime: "video/mp4"
  });
  assert.deepEqual(suggestion, []);
  assert.ok(harness.storage.nativeVideoTarget, "the armed target is kept for the real download");
});
