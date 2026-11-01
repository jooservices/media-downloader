import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runScript } from "../helpers/run-script.mjs";

const fixture = name => JSON.parse(fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8"));
const plain = value => JSON.parse(JSON.stringify(value));

const context = { URL };
context.globalThis = context;
for (const file of [
  "lib/platforms.js",
  "src/page/x-media-parser.js",
  "src/page/instagram-media-parser.js",
  "src/page/facebook-media-parser.js"
]) {
  runScript(file, context);
}
const parsers = context.PageMediaParsers;

test("X: the real TweetDetail response yields the 4K mp4 with the owner and size", () => {
  const videos = plain(parsers.Twitter.extractMedia(fixture("x-tweetdetail-nasa-video.json")));
  assert.equal(videos.length, 1);
  const [video] = videos;
  assert.equal(video.platform, "Twitter");
  assert.equal(video.id, "2115779022722630042");
  assert.equal(video.owner, "NASA");
  assert.equal(video.durationMs, 24045);
  assert.equal(video.bitrate, 25128000);
  assert.equal(`${video.width}x${video.height}`, "3840x2160");
  assert.match(
    video.url,
    /^https:\/\/video\.twimg\.com\/amplify_video\/2115778808452198400\/vid\/avc1\/3840x2160\/.+\.mp4$/
  );
});

test("X: the real response lists HLS too, and it is never chosen", () => {
  const media = fixture("x-tweetdetail-nasa-video.json").data.threaded_conversation_with_injections_v2.instructions[0]
    .entries[0].content.itemContent.tweet_results.result.legacy.extended_entities.media[0];
  assert.ok(media.video_info.variants.some(variant => variant.content_type === "application/x-mpegURL"));
  assert.ok(!/m3u8/.test(parsers.Twitter.extractMedia(fixture("x-tweetdetail-nasa-video.json"))[0].url));
});

test("Instagram: the real embedded reel block yields the post code, owner and size", () => {
  const videos = plain(parsers.Instagram.extractMedia(fixture("instagram-reel-embedded.json")));
  assert.equal(videos.length, 1);
  const [video] = videos;
  assert.equal(video.platform, "Instagram");
  assert.equal(video.id, "DezPoWNzXMt");
  assert.equal(video.owner, "jasondchen");
  assert.equal(video.index, 1);
  assert.equal(`${video.width}x${video.height}`, "720x1280");
  assert.match(video.url, /^https:\/\/instagram\.[\w.-]+\.fbcdn\.net\/.+\.mp4$/);
});

test("Facebook: the real embedded reel block yields the HD file under the reel id", () => {
  const videos = plain(parsers.Facebook.extractMedia(fixture("facebook-reel-embedded.json")));
  assert.equal(videos.length, 1);
  const [video] = videos;
  assert.equal(video.platform, "Facebook");
  assert.equal(video.id, "2059757664673295");
  assert.equal(video.quality, "HD");
  assert.equal(video.owner, null);
  const sources = fixture("facebook-reel-embedded.json");
  const entries =
    sources.require[0][0][0].__bbox.require[0][0][0].__bbox.result.data.video.creation_story.attachments[0].media
      .videoDeliveryResponseFragment.videoDeliveryResponseResult.progressive_urls;
  assert.equal(video.url, entries.find(entry => entry.metadata.quality === "HD").progressive_url);
});

test("the real fixtures contain no signed query strings or captured text", () => {
  for (const name of fs.readdirSync(new URL("../fixtures/", import.meta.url)).filter(file => file.endsWith(".json"))) {
    const text = fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /https?:\/\/[^"]*\?/, `${name} has a URL query string`);
  }
});

test("each parser ignores the other platforms' real responses", () => {
  assert.equal(parsers.Twitter.extractMedia(fixture("instagram-reel-embedded.json")).length, 0);
  assert.equal(parsers.Instagram.extractMedia(fixture("facebook-reel-embedded.json")).length, 0);
  assert.equal(parsers.Facebook.extractMedia(fixture("x-tweetdetail-nasa-video.json")).length, 0);
});

test("the hook's embedded-script path reads the real Instagram and Facebook blocks", async () => {
  for (const [host, platform, file, id] of [
    ["www.instagram.com", "Instagram", "instagram-reel-embedded.json", "DezPoWNzXMt"],
    ["www.facebook.com", "Facebook", "facebook-reel-embedded.json", "2059757664673295"]
  ]) {
    const posted = [];
    const script = { textContent: fs.readFileSync(new URL(`../fixtures/${file}`, import.meta.url), "utf8") };
    const page = {
      location: { hostname: host, origin: `https://${host}` },
      fetch: async () => ({}),
      postMessage: message => posted.push(message),
      XMLHttpRequest: class {},
      setTimeout: fn => fn(),
      MutationObserver: class {
        observe() {}
      },
      PageMediaParsers: parsers,
      document: {
        readyState: "complete",
        documentElement: {},
        querySelectorAll: () => [script]
      }
    };
    page.XMLHttpRequest.prototype.open = function open() {};
    page.globalThis = page;
    runScript("src/page/media-network-hook.js", page);
    assert.equal(posted.length, 1, platform);
    assert.equal(posted[0].media[0].id, id, platform);
  }
});

test("Instagram: a real carousel yields its full-size photos by position and never a video's poster", () => {
  const media = plain(parsers.Instagram.extractMedia(fixture("instagram-carousel-embedded.json")));
  const photos = media.filter(entry => entry.kind === "photo");
  const videos = media.filter(entry => entry.kind === "video");
  assert.deepEqual(
    photos.map(entry => [entry.id, entry.index, `${entry.width}x${entry.height}`, entry.owner]),
    [
      ["DaS4ZNAlFGr", 2, "3072x4096", "jasondchen"],
      ["DaS4ZNAlFGr", 5, "3072x4096", "jasondchen"]
    ]
  );
  assert.deepEqual(
    videos.map(entry => [entry.id, entry.index, entry.owner]),
    [
      ["DaS4ZNAlFGr", 1, "jasondchen"],
      ["DaS4ZNAlFGr", 2, "jasondchen"],
      ["DaS4ZNAlFGr", 3, "jasondchen"]
    ]
  );
  // Every item of a real carousel has a shortcode of its own; none may become a separate post.
  assert.ok(
    media.every(entry => entry.id === "DaS4ZNAlFGr"),
    "all media is filed under the post's own code"
  );
  assert.equal(media.length, 5, "3 videos and 2 photos, nothing duplicated under the items' codes");
  assert.ok(photos.every(entry => !/\.mp4/.test(entry.url)));
  // Positions 1, 3 and 4 are videos: their 720x960 posters must not appear as photos.
  assert.ok(!photos.some(entry => [1, 3, 4].includes(entry.index)));
  assert.ok(
    photos.every(entry => entry.width >= 3000),
    "no thumbnail-sized rendition is chosen"
  );
});

test("Facebook: the real photos tab yields each photo at its largest listed size", () => {
  const media = plain(parsers.Facebook.extractMedia(fixture("facebook-photos-tab.json")));
  assert.deepEqual(
    media.map(entry => [entry.kind, entry.id, `${entry.width}x${entry.height}`, entry.owner]),
    [
      ["photo", "1092860713564851", "1152x1440", null],
      ["photo", "1086989087485347", "2048x1365", null]
    ]
  );
  assert.ok(media.every(entry => /^https:\/\/scontent\.[\w.-]+\.fbcdn\.net\//.test(entry.url)));
});

test("Facebook: of several renditions on a photo, the largest one wins", () => {
  const photo = {
    __typename: "Photo",
    id: "777",
    image: { uri: "https://scontent.x.fbcdn.net/small.jpg", width: 206, height: 206 },
    viewer_image: { uri: "https://scontent.x.fbcdn.net/big.jpg", width: 1920, height: 1080 },
    photo_image: { uri: "https://scontent.x.fbcdn.net/mid.jpg", width: 960, height: 540 }
  };
  const [entry] = parsers.Facebook.extractMedia({ photo });
  assert.equal(entry.url, "https://scontent.x.fbcdn.net/big.jpg");
  assert.equal(`${entry.width}x${entry.height}`, "1920x1080");
  assert.equal(
    parsers.Facebook.extractMedia({
      photo: {
        ...photo,
        viewer_image: { uri: "https://evil.example/x.jpg", width: 9999, height: 9999 },
        photo_image: null,
        image: { uri: "https://scontent.x.fbcdn.net/small.jpg", width: 206, height: 206 }
      }
    })[0].url,
    "https://scontent.x.fbcdn.net/small.jpg",
    "a foreign host is never chosen"
  );
});

test("Instagram: a single photo post yields its largest candidate; a reel yields no photo", () => {
  const photoPost = {
    code: "Dphoto001",
    media_type: 1,
    user: { username: "u" },
    image_versions2: {
      candidates: [
        { width: 320, height: 427, url: "https://scontent.cdninstagram.com/s.jpg" },
        { width: 1440, height: 1920, url: "https://scontent.cdninstagram.com/l.jpg" },
        { width: 640, height: 853, url: "https://scontent.cdninstagram.com/m.jpg" }
      ]
    }
  };
  const [photo] = plain(parsers.Instagram.extractMedia({ photoPost }));
  assert.equal(photo.url, "https://scontent.cdninstagram.com/l.jpg");
  assert.equal(`${photo.kind} ${photo.index} ${photo.width}x${photo.height}`, "photo 1 1440x1920");
  const reel = {
    code: "Dreel0001",
    media_type: 2,
    user: { username: "u" },
    video_versions: [{ width: 720, height: 1280, url: "https://scontent.cdninstagram.com/v.mp4" }],
    image_versions2: { candidates: [{ width: 720, height: 1280, url: "https://scontent.cdninstagram.com/poster.jpg" }] }
  };
  assert.deepEqual(
    plain(parsers.Instagram.extractMedia({ reel })).map(entry => entry.kind),
    ["video"]
  );
});
