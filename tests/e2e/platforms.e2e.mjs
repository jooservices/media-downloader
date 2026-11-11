// End to end for the sites whose media arrives through the page's own data (Instagram, Facebook, TikTok, and X
// videos): the real queue starts a real browser with the real extension, a fake site sends the same shapes of
// data the real ones do, and every kind of media (photo, video, reel, carousel item, story) must end up as a file.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { chromiumPath, listFiles, makePng, startEnvironment } from "./harness.mjs";
import { IG_HOSTS, instagramRoutes } from "./sites/instagram.mjs";
import { FB_HOSTS, facebookRoutes } from "./sites/facebook.mjs";
import { TIKTOK_HOSTS, tiktokRoutes } from "./sites/tiktok.mjs";
import { X_ACCOUNT, X_VIDEO_HOSTS, xVideoRoutes } from "./sites/x-video.mjs";

const executable = await chromiumPath();
const skip = !executable && "no Chromium found";

test(
  "Instagram: photos, a reel, a carousel and stories are all saved, and a second run saves nothing again",
  { skip, timeout: 900_000 },
  async t => {
    const account = "igtest";
    const env = await startEnvironment(t, { routes: instagramRoutes(account), siteHosts: IG_HOSTS });
    const saved = () => listFiles(path.join(env.sandbox.media, "Instagram", account));

    const first = await env.runJob(`https://www.instagram.com/${account}/`);
    assert.deepEqual(
      first.map(job => job.status),
      ["complete"],
      `${first.map(job => job.message).join(" | ")}\n${env.diagnostics()}`
    );
    const files = await saved();
    const photos = files.filter(file => !file.endsWith(".mp4"));
    const videos = files.filter(file => file.endsWith(".mp4"));
    assert.equal(photos.length, 4, `photos: a post, two carousel photos, a story photo\n${files.join("\n")}`);
    assert.equal(videos.length, 3, `videos: a reel, a carousel video, a story video\n${files.join("\n")}`);
    assert.ok(
      env.state.requests.filter(line => line === "www.instagram.com/api/graphql").length >= 3,
      "the profile and each uncovered photo post return page data"
    );
    for (const file of videos) {
      assert.ok((await readFile(file)).includes(Buffer.from("mdat-")), "a video file holds the video bytes");
    }
    for (const file of photos) {
      assert.deepEqual(
        (await readFile(file)).subarray(0, 8),
        makePng(1, 1, "x").subarray(0, 8),
        "a photo file holds the picture"
      );
    }
    assert.ok(
      env.state.requests.some(line => line.endsWith("IGPHOTOONE1_big.jpg")),
      "the largest rendition was fetched"
    );
    assert.ok(
      !env.state.requests.some(line => line.endsWith("IGPHOTOONE1_small.jpg")),
      "the small rendition never was"
    );
    assert.ok(
      env.state.requests.some(line => line.endsWith("IGREELONE01_hd.mp4")),
      "the best video encode was fetched"
    );
    assert.ok(!env.state.requests.some(line => line.endsWith("IGREELONE01_sd.mp4")), "the worse encode never was");

    const again = await env.runJob(`https://www.instagram.com/${account}/`, true);
    assert.equal(again[0].status, "complete", again[0].message);
    assert.equal(again[0].counts.started, 0, "nothing is saved twice");
    assert.deepEqual(await saved(), files);
  }
);

test(
  "TikTok: videos at their best quality and the slides of a photo post are saved, and a second run saves nothing again",
  { skip, timeout: 900_000 },
  async t => {
    const account = "ttest";
    const env = await startEnvironment(t, { routes: tiktokRoutes(account), siteHosts: TIKTOK_HOSTS });
    const saved = () => listFiles(path.join(env.sandbox.media, "TikTok", account));

    const first = await env.runJob(`https://www.tiktok.com/@${account}/`);
    assert.deepEqual(
      first.map(job => job.status),
      ["complete"],
      `${first.map(job => job.message).join(" | ")}\n${env.diagnostics()}`
    );
    const files = await saved();
    assert.equal(files.filter(file => file.endsWith(".mp4")).length, 2, `two videos\n${files.join("\n")}`);
    assert.equal(files.filter(file => !file.endsWith(".mp4")).length, 2, `two slides\n${files.join("\n")}`);
    assert.ok(
      env.state.requests.some(line => line.endsWith("7100000000000000001_high.mp4")),
      "the best encode was fetched"
    );
    assert.ok(
      !env.state.requests.some(line => line.endsWith("7100000000000000001_low.mp4")),
      "the worse one never was"
    );

    const again = await env.runJob(`https://www.tiktok.com/@${account}/`, true);
    assert.equal(again[0].status, "complete", again[0].message);
    assert.equal(again[0].counts.started, 0, "nothing is saved twice");
    assert.deepEqual(await saved(), files);
  }
);

test(
  "Facebook: the photos, a reel and a video of one profile are saved from its tabs, at their best quality",
  { skip, timeout: 1_200_000 },
  async t => {
    const account = "fbtest";
    const env = await startEnvironment(t, { routes: facebookRoutes(account), siteHosts: FB_HOSTS });
    const saved = () => listFiles(path.join(env.sandbox.media, "Facebook", account));

    const jobs = await env.runJob(`https://www.facebook.com/${account}/`, false, 600_000);
    assert.equal(jobs.length, 4, "a profile link is the profile plus its Photos, Reels and Videos tabs");
    assert.deepEqual(
      jobs.map(job => job.status),
      ["complete", "complete", "complete", "complete"],
      `${jobs.map(job => job.message).join(" | ")}\n${env.diagnostics()}`
    );
    const files = await saved();
    const videos = files.filter(file => file.endsWith(".mp4"));
    const photos = files.filter(file => !file.endsWith(".mp4"));
    assert.equal(photos.length, 3, `three photos\n${files.join("\n")}`);
    assert.equal(videos.length, 2, `a reel and a video\n${files.join("\n")}`);
    assert.ok(
      env.state.requests.some(line => line.endsWith("video_2000000000000000001_hd.mp4")),
      "HD was fetched"
    );
    assert.ok(!env.state.requests.some(line => line.endsWith("video_2000000000000000001_sd.mp4")), "SD never was");

    const again = await env.runJob(`https://www.facebook.com/${account}/`, true, 600_000);
    assert.ok(
      again.every(job => job.status === "complete"),
      again.map(job => job.message).join(" | ")
    );
    assert.equal(
      again.reduce((sum, job) => sum + job.counts.started, 0),
      0,
      "nothing is saved twice"
    );
    assert.deepEqual(await saved(), files);
  }
);

test(
  "X: a video post is saved at its highest bitrate, a photo post at the original size, and nothing twice",
  { skip, timeout: 900_000 },
  async t => {
    const env = await startEnvironment(t, { routes: xVideoRoutes(), siteHosts: X_VIDEO_HOSTS });
    const saved = () => listFiles(path.join(env.sandbox.media, "Twitter", X_ACCOUNT));

    const first = await env.runJob(`https://x.com/${X_ACCOUNT}/`);
    assert.deepEqual(
      first.map(job => job.status),
      ["complete"],
      `${first.map(job => job.message).join(" | ")}\n${env.diagnostics()}`
    );
    const files = await saved();
    assert.equal(files.filter(file => file.endsWith(".mp4")).length, 1, `one video\n${files.join("\n")}`);
    assert.equal(files.filter(file => !file.endsWith(".mp4")).length, 1, `one photo\n${files.join("\n")}`);
    assert.ok(
      env.state.requests.some(line => line.endsWith("t6HbgwW1cZ-Al2Y3.mp4")),
      "the 4K encode was fetched"
    );
    assert.ok(!env.state.requests.some(line => line.endsWith("a7Uc8fNlQVz3gAWf.mp4")), "the smallest never was");

    const again = await env.runJob(`https://x.com/${X_ACCOUNT}/`, true);
    assert.equal(again[0].status, "complete", again[0].message);
    assert.equal(again[0].counts.started, 0);
    assert.deepEqual(await saved(), files);
  }
);
