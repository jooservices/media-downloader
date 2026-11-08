import assert from "node:assert/strict";
import test from "node:test";
import { runScript } from "../helpers/run-script.mjs";

const context = { URL };
context.globalThis = context;
for (const file of ["lib/sites.js", "lib/platforms.js", "src/page/tiktok-media-parser.js"]) {
  runScript(file, context);
}
const { extractMedia } = context.PageMediaParsers.TikTok;
const plain = value => JSON.parse(JSON.stringify(value));

const video = (id, extra = {}) => ({
  id,
  author: { uniqueId: "unnie.93newg" },
  video: {
    width: 576,
    height: 1024,
    duration: 12,
    cover: "https://p16-sign.tiktokcdn.com/cover/thumb.jpg",
    playAddr: "https://v16-webapp.tiktokcdn.com/small.mp4",
    downloadAddr: "https://v16-webapp.tiktokcdn.com/download.mp4",
    bitrateInfo: [
      {
        Bitrate: 400000,
        Width: 576,
        Height: 1024,
        PlayAddr: { UrlList: ["https://v16-webapp.tiktokcdn.com/low.mp4"] }
      },
      {
        Bitrate: 1200000,
        Width: 720,
        Height: 1280,
        PlayAddr: { UrlList: ["https://v16-webapp.tiktokcdn.com/high.mp4"] }
      }
    ],
    ...extra
  }
});

test("a TikTok video keeps the highest bitrate file and never its cover", () => {
  const [saved] = plain(extractMedia({ itemInfo: { itemStruct: video("7123456789012345678") } }));
  assert.equal(saved.kind, "video");
  assert.equal(saved.owner, "unnie.93newg");
  assert.equal(saved.url, "https://v16-webapp.tiktokcdn.com/high.mp4");
  assert.equal(saved.width, 720);
  assert.equal(
    extractMedia(video("7123456789012345678")).some(entry => entry.url.includes("cover")),
    false
  );
});

test("a TikTok photo post keeps each slide and skips the slideshow preview", () => {
  const item = video("7000000000000000001", {
    playAddr: "https://v16-webapp.tiktokcdn.com/preview.mp4"
  });
  item.imagePost = {
    images: [
      {
        imageWidth: 1080,
        imageHeight: 1920,
        imageURL: {
          urlList: ["https://p16-sign.tiktokcdn.com/a-shrink.jpg", "https://p16-sign.tiktokcdn.com/a-full.jpg"]
        }
      },
      { imageWidth: 1080, imageHeight: 1920, imageURL: { urlList: ["https://p16-sign.tiktokcdn.com/b-full.jpg"] } }
    ]
  };
  const saved = plain(extractMedia(item));
  assert.deepEqual(
    saved.map(entry => entry.url),
    ["https://p16-sign.tiktokcdn.com/a-full.jpg", "https://p16-sign.tiktokcdn.com/b-full.jpg"]
  );
  assert.equal(
    saved.some(entry => entry.kind === "video"),
    false
  );
});

test("a file on another host is ignored", () => {
  const item = video("7000000000000000002", {
    bitrateInfo: [],
    playAddr: "https://evil.example/v.mp4",
    downloadAddr: "http://v16-webapp.tiktokcdn.com/plain.mp4"
  });
  assert.equal(extractMedia(item).length, 0);
});
