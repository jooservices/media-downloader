import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { loadBackground, plain } from "../helpers/background.mjs";

const loadLib = name => {
  const context = vm.createContext({ URL });
  const load = fileName => {
    const file = new URL(`../../lib/${fileName}.js`, import.meta.url);
    new vm.Script(fs.readFileSync(file, "utf8"), { filename: file.pathname }).runInContext(context);
  };
  if (name === "keys") {
    load("sites");
  }
  load(name);
  return context.PageMediaLib[name];
};

const { cleanPart, buildSavePath, withResolution, imageExtension } = loadLib("paths");
const PageKeys = loadLib("keys");

const photo = (extra = {}) => ({
  platform: "Instagram",
  account: "creator",
  key: "Instagram:creator:abc:1",
  url: "https://scontent.cdninstagram.com/x.jpg",
  filename: "abc_01.jpg",
  ...extra
});

test("the path is <site>/<account>/<name> and nothing else", () => {
  assert.equal(buildSavePath("Instagram", "creator", "a_01.jpg"), "Instagram/creator/a_01.jpg");
});

test("withResolution adds _<width>x<height> before the extension only for real sizes", () => {
  assert.equal(withResolution("abc_01.jpg", 1080, 1350), "abc_01_1080x1350.jpg");
  assert.equal(withResolution("video_1.mp4", 720, 1280), "video_1_720x1280.mp4");
  assert.equal(withResolution("noext", 10, 20), "noext_10x20");
  for (const [w, h] of [
    [0, 100],
    [100, 0],
    [10.5, 100],
    [undefined, 100],
    ["", ""],
    [-5, 5]
  ]) {
    assert.equal(withResolution("a.jpg", w, h), "a.jpg", `${w}x${h}`);
  }
});

test("cleanPart removes characters Windows rejects and trailing dots", () => {
  assert.equal(cleanPart("My<Media>|Saver?"), "My_Media__Saver_");
  assert.equal(cleanPart("name. "), "name");
  assert.equal(cleanPart(""), "account");
  assert.equal(cleanPart("", "folder"), "folder");
  assert.equal(cleanPart("a".repeat(200)).length, 80);
});

test("imageExtension reads the extension and falls back to jpg", () => {
  assert.equal(imageExtension("https://x.com/a/b.JPEG?x=1"), "jpg");
  assert.equal(imageExtension("https://x.com/a/b.webp"), "webp");
  assert.equal(imageExtension("not a url"), "jpg");
});

test("photos are saved straight under Downloads with their measured size", async () => {
  const { send, started } = loadBackground();
  await send({ type: "DOWNLOAD_ITEMS", items: [photo({ width: 1080, height: 1350 })] });
  assert.equal(started[0].filename, "Instagram/creator/abc_01_1080x1350.jpg");
});

test("a photo with an unknown size keeps its plain name", async () => {
  const { send, started } = loadBackground();
  await send({
    type: "DOWNLOAD_ITEMS",
    items: [
      photo({ key: "k1", filename: "a_01.jpg" }),
      photo({ key: "k2", filename: "b_01.jpg", width: 0, height: 100 })
    ]
  });
  assert.deepEqual(plain(started.map(options => options.filename)), [
    "Instagram/creator/a_01.jpg",
    "Instagram/creator/b_01.jpg"
  ]);
});

test("a download from a host outside the platform's CDN is skipped", async () => {
  const { send, started } = loadBackground();
  const result = await send({ type: "DOWNLOAD_ITEMS", items: [photo({ url: "https://evil.example/x.jpg" })] });
  assert.equal(started.length, 0);
  assert.equal(result.skipped, 1);
});

test("cached videos carry their real size into the path", async () => {
  const { send, started } = loadBackground();
  await send({
    type: "MEDIA_FOUND",
    media: [
      {
        platform: "Twitter",
        id: "1001",
        index: 1,
        owner: "acct",
        width: 720,
        height: 1280,
        url: "https://video.twimg.com/v/1001.mp4"
      },
      {
        platform: "Facebook",
        id: "2002",
        index: 1,
        owner: null,
        url: "https://scontent.fsgn1-1.fna.fbcdn.net/v/2002.mp4"
      }
    ]
  });
  await send({ type: "DOWNLOAD_CACHED_MEDIA", platform: "Twitter", account: "acct" });
  await send({ type: "DOWNLOAD_CACHED_MEDIA", platform: "Facebook", account: "page", ids: ["2002"] });
  assert.equal(started[0].filename, "Twitter/acct/video_1001_720x1280.mp4");
  assert.equal(
    started[1].filename,
    "Facebook/page/video_2002.mp4",
    "no size is invented when the page does not expose one"
  );
});

test("videos saved through the platform menu use the player's size", async () => {
  const { determine, storage } = loadBackground({
    storage: {
      nativeVideoTarget: {
        platform: "Twitter",
        account: "acct",
        key: "Twitter:acct:video:77",
        filename: "video_77.mp4",
        width: 1280,
        height: 720,
        sourceOrigin: "https://x.com",
        expiresAt: Date.now() + 30000
      }
    }
  });
  const [suggestion] = await determine({
    id: 5,
    url: "https://video.twimg.com/v.mp4",
    referrer: "https://x.com/acct/status/77",
    filename: "x.mp4",
    mime: "video/mp4"
  });
  assert.equal(suggestion.filename, "Twitter/acct/video_77_1280x720.mp4");
  assert.equal(storage.nativeVideoPending["5"].filename, "video_77_1280x720.mp4");
});

test("a cached full-size photo is saved as <post id>_<position>_<WxH>.<ext> in the owner's folder", async () => {
  const harness = loadBackground();
  await harness.send({
    type: "MEDIA_FOUND",
    media: [
      {
        platform: "Instagram",
        kind: "photo",
        id: "DaS4ZNAlFGr",
        index: 2,
        owner: "jasondchen",
        width: 3072,
        height: 4096,
        url: "https://scontent.cdninstagram.com/l.jpg"
      },
      {
        platform: "Instagram",
        kind: "video",
        id: "DaS4ZNAlFGr",
        index: 1,
        owner: "jasondchen",
        width: 720,
        height: 960,
        url: "https://scontent.cdninstagram.com/v.mp4"
      }
    ]
  });
  const result = await harness.send({
    type: "DOWNLOAD_CACHED_MEDIA",
    platform: "Instagram",
    account: "jasondchen",
    ids: ["DaS4ZNAlFGr"]
  });
  assert.equal(result.started, 2);
  assert.deepEqual(plain(result.coveredIds), ["DaS4ZNAlFGr"]);
  assert.deepEqual(plain(harness.started.map(options => options.filename).sort()), [
    "Instagram/jasondchen/DaS4ZNAlFGr_02_3072x4096.jpg",
    "Instagram/jasondchen/video_DaS4ZNAlFGr_720x960.mp4"
  ]);
});

test("a photo and a video of the same post do not block each other", async () => {
  const harness = loadBackground();
  await harness.ledger.add(PageKeys.videoKey("Instagram", "Dpost0001", 1));
  await harness.send({
    type: "MEDIA_FOUND",
    media: [
      {
        platform: "Instagram",
        kind: "photo",
        id: "Dpost0001",
        index: 1,
        owner: "u",
        width: 1440,
        height: 1920,
        url: "https://scontent.cdninstagram.com/p.jpg"
      },
      {
        platform: "Instagram",
        kind: "video",
        id: "Dpost0001",
        index: 1,
        owner: "u",
        width: 720,
        height: 1280,
        url: "https://scontent.cdninstagram.com/v.mp4"
      }
    ]
  });
  const result = await harness.send({
    type: "DOWNLOAD_CACHED_MEDIA",
    platform: "Instagram",
    account: "u",
    ids: ["Dpost0001"]
  });
  assert.equal(result.started, 1, "only the photo is new");
  assert.match(harness.started[0].filename, /Dpost0001_01_1440x1920\.jpg$/);
});

test("a photo from a host outside the platform's CDN is not cached", async () => {
  const harness = loadBackground();
  const result = await harness.send({
    type: "MEDIA_FOUND",
    media: [
      {
        platform: "Facebook",
        kind: "photo",
        id: "12345",
        index: 1,
        owner: null,
        width: 2048,
        height: 1365,
        url: "https://evil.example/x.jpg"
      },
      {
        platform: "Facebook",
        kind: "photo",
        id: "12346",
        index: 1,
        owner: null,
        width: 2048,
        height: 1365,
        url: "https://scontent.fsgn19-1.fna.fbcdn.net/x.jpg"
      }
    ]
  });
  assert.equal(result.added, 1);
});

test("a photo URL is not accepted as a video and a video URL not as a photo kind on X", async () => {
  const harness = loadBackground();
  const result = await harness.send({
    type: "MEDIA_FOUND",
    media: [
      {
        platform: "Twitter",
        kind: "photo",
        id: "5551212",
        index: 1,
        owner: "a",
        width: 1,
        height: 1,
        url: "https://pbs.twimg.com/media/x.jpg"
      },
      {
        platform: "Twitter",
        kind: "video",
        id: "5551213",
        index: 1,
        owner: "a",
        width: 1,
        height: 1,
        url: "https://pbs.twimg.com/media/x.jpg"
      }
    ]
  });
  assert.equal(result.added, 1, "pbs.twimg.com is a photo host, not a video host");
});
