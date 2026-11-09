import assert from "node:assert/strict";
import test from "node:test";
import { runScript } from "../helpers/run-script.mjs";

const context = { URL };
context.globalThis = context;
for (const file of [
  "lib/sites.js",
  "lib/platforms.js",
  "src/page/x-media-parser.js",
  "src/page/instagram-media-parser.js",
  "src/page/facebook-media-parser.js",
  "src/page/tiktok-media-parser.js"
]) {
  runScript(file, context);
}
const parsers = context.PageMediaParsers;
const plain = value => JSON.parse(JSON.stringify(value));

// ---- X ----------------------------------------------------------------------------------

const xVideo = (url, bitrate, type = "video/mp4") => ({ content_type: type, bitrate, url });
const xTweet = (id, variants, extra = {}) => ({
  rest_id: id,
  core: { user_results: { result: { core: { screen_name: "NASA" } } } },
  legacy: {
    extended_entities: {
      media: [{ type: "video", video_info: { duration_millis: 5000, variants }, ...extra }]
    }
  }
});
const X_HOST = "https://video.twimg.com/ext_tw_video/1/vid/avc1/";

test("X: the highest bitrate progressive MP4 is kept, with size read from its path", () => {
  const tweet = xTweet("111", [
    xVideo(`${X_HOST}320x568/low.mp4`, 300),
    xVideo(`${X_HOST}720x1280/high.mp4`, 2000),
    xVideo(`${X_HOST}480x852/mid.mp4`, 800),
    xVideo(`${X_HOST}pl/list.m3u8`, 9999, "application/x-mpegURL")
  ]);
  const [saved] = plain(parsers.Twitter.extractMedia({ data: { tweet } }));
  assert.equal(saved.url, `${X_HOST}720x1280/high.mp4`);
  assert.equal(saved.width, 720);
  assert.equal(saved.height, 1280);
  assert.equal(saved.owner, "NASA");
  assert.equal(saved.durationMs, 5000);
  assert.equal(saved.animatedGif, false);
});

test("X: variants that are not a direct https MP4 on the video CDN are ignored", () => {
  const { pickBestMp4, isDirectVideoUrl } = parsers.Twitter;
  assert.equal(pickBestMp4(null), null);
  assert.equal(pickBestMp4("nope"), null);
  assert.equal(pickBestMp4([null, {}, xVideo("http://video.twimg.com/a.mp4", 1)]), null, "http is refused");
  assert.equal(pickBestMp4([xVideo("not a url", 1), xVideo("https://evil.example/a.mp4", 1)]), null);
  assert.equal(isDirectVideoUrl("https://pbs.twimg.com/media/a.jpg"), false, "a photo host is not a video host");
  assert.equal(pickBestMp4([xVideo(`${X_HOST}a.mp4`, undefined)]).bitrate, 0, "no bitrate counts as 0");
  assert.equal(
    pickBestMp4([xVideo(`${X_HOST}first.mp4`, 5), xVideo(`${X_HOST}second.mp4`, 5)]).url,
    `${X_HOST}first.mp4`
  );
});

test("X: a tweet with no usable video, a bad id, or no media yields nothing", () => {
  const { extractMedia } = parsers.Twitter;
  assert.deepEqual(plain(extractMedia(xTweet("112", [xVideo("https://evil.example/a.mp4", 1)]))), []);
  assert.deepEqual(plain(extractMedia(xTweet("not-a-number", [xVideo(`${X_HOST}a.mp4`, 1)]))), []);
  assert.deepEqual(
    plain(extractMedia({ rest_id: "113", legacy: { extended_entities: { media: [{ type: "photo" }] } } })),
    []
  );
  assert.deepEqual(plain(extractMedia(null)), []);
  assert.deepEqual(plain(extractMedia("text")), []);
});

test("X: an animated GIF is flagged, the owner may come from legacy, and a shared node is read once", () => {
  const tweet = xTweet("114", [xVideo(`${X_HOST}a.mp4`, 1)], { type: "animated_gif" });
  tweet.core = { user_results: { result: { legacy: { screen_name: "legacy_name" } } } };
  const root = { a: tweet, b: tweet };
  root.self = root; // cycles must not loop forever
  const found = plain(parsers.Twitter.extractMedia(root));
  assert.equal(found.length, 1);
  assert.equal(found[0].animatedGif, true);
  assert.equal(found[0].owner, "legacy_name");
  const ownerless = xTweet("115", [xVideo(`${X_HOST}b.mp4`, 1)]);
  delete ownerless.core;
  assert.equal(plain(parsers.Twitter.extractMedia(ownerless))[0].owner, null);
});

test("X: two videos in one tweet are numbered, and a file name without a size has none", () => {
  const tweet = xTweet("116", [xVideo(`${X_HOST}a.mp4`, 1)]);
  tweet.legacy.extended_entities.media.push(
    { type: "photo" },
    { type: "video", video_info: { variants: [xVideo(`${X_HOST}720x1280/b.mp4`, 1)] } }
  );
  const found = plain(parsers.Twitter.extractMedia(tweet));
  assert.deepEqual(
    found.map(entry => [entry.index, entry.width]),
    [
      [1, 0],
      [2, 720]
    ]
  );
  assert.equal(found[1].durationMs, 0);
});

// ---- Instagram ---------------------------------------------------------------------------

const IG = "https://scontent.cdninstagram.com/v/";
const igImage = (name, width, height) => ({ url: `${IG}${name}.jpg`, width, height });

test("Instagram: only the largest photo rendition is saved, never a smaller candidate", () => {
  const post = {
    code: "Dphoto0001",
    taken_at: 1,
    user: { username: "someone" },
    image_versions2: { candidates: [igImage("small", 150, 150), igImage("big", 1080, 1350), igImage("mid", 640, 800)] }
  };
  const found = plain(parsers.Instagram.extractMedia({ items: [post] }));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "photo");
  assert.equal(found[0].url, `${IG}big.jpg`);
  assert.equal(found[0].owner, "someone");
});

test("Instagram: no usable rendition means no photo and no thumbnail fallback", () => {
  const { extractMedia } = parsers.Instagram;
  const empty = { code: "Dempty0001", taken_at: 1, image_versions2: { candidates: [] } };
  const foreign = {
    code: "Dforeign01",
    taken_at: 1,
    image_versions2: {
      candidates: [
        { url: "https://evil.example/a.jpg", width: 9, height: 9 },
        { url: "http://scontent.cdninstagram.com/a.jpg" },
        {}
      ]
    }
  };
  const missing = { code: "Dmissing01", taken_at: 1 };
  const garbage = { code: "Dgarbage01", taken_at: 1, image_versions2: { candidates: "nope" } };
  assert.deepEqual(plain(extractMedia([empty, foreign, missing, garbage])), []);
  assert.deepEqual(
    plain(extractMedia({ code: "no", taken_at: 1 })),
    [],
    "a code that is not a shortcode is not a post"
  );
  assert.deepEqual(plain(extractMedia(null)), []);
});

test("Instagram: a reel keeps its largest video and never its poster as a photo", () => {
  const reel = {
    code: "Dreel00001",
    video_duration: 12.3456,
    owner: { username: "creator" },
    video_versions: [
      { url: `${IG}a.mp4`, width: 480, height: 854 },
      { url: `${IG}b.mp4`, width: 720, height: 1280 }
    ],
    image_versions2: { candidates: [igImage("poster", 720, 1280)] }
  };
  const found = plain(parsers.Instagram.extractMedia(reel));
  assert.deepEqual(
    found.map(entry => entry.kind),
    ["video"]
  );
  assert.equal(found[0].url, `${IG}b.mp4`);
  assert.equal(found[0].durationMs, 12346);
  assert.equal(found[0].owner, "creator");
  const unusable = {
    code: "Dreel00002",
    video_versions: [{ url: "https://evil.example/a.mp4" }],
    image_versions2: { candidates: [igImage("p", 1, 1)] }
  };
  assert.deepEqual(
    plain(parsers.Instagram.extractMedia(unusable)),
    [],
    "an unusable video never falls back to the poster"
  );
  assert.deepEqual(plain(parsers.Instagram.extractMedia({ code: "Dreel00003", video_versions: [] })), []);
});

test("Instagram: a carousel numbers its photos by position and keeps its videos", () => {
  const carousel = {
    code: "Dcarou0001",
    media_type: 8,
    user: { username: "u" },
    carousel_media: [
      {
        code: "Dchild0001",
        image_versions2: { candidates: [igImage("c1", 100, 100), igImage("c1big", 1000, 1000)] }
      },
      null,
      {
        video_versions: [{ url: `${IG}c3.mp4`, width: 10, height: 10 }],
        image_versions2: { candidates: [igImage("poster", 5, 5)] }
      },
      { image_versions2: { candidates: [igImage("c4", 800, 800)] } }
    ]
  };
  const found = plain(parsers.Instagram.extractMedia(carousel));
  assert.deepEqual(
    found.map(entry => `${entry.kind}:${entry.index}`).sort(),
    ["photo:1", "photo:4", "video:1"],
    "the child's own shortcode does not make it a second post"
  );
  assert.equal(found.find(entry => entry.index === 1 && entry.kind === "photo").url, `${IG}c1big.jpg`);
});

test("Instagram: a post nested in another inherits the owner and a node is not read twice", () => {
  const inner = { code: "Dinner0001", taken_at: 1, image_versions2: { candidates: [igImage("i", 300, 300)] } };
  const outer = { code: "Douter0001", taken_at: 1, user: { username: "boss" }, related: inner, again: inner };
  const found = plain(parsers.Instagram.extractMedia(outer));
  assert.equal(found.length, 1);
  assert.equal(found[0].owner, "boss");
});

test("Instagram: story frames are addressed by pk, and highlights by their items", () => {
  const story = (pk, extra = {}) => ({
    product_type: "story",
    pk,
    user: { username: "storyteller" },
    image_versions2: { candidates: [igImage("s-small", 100, 100), igImage("s-big", 720, 1280)] },
    ...extra
  });
  const { extractMedia } = parsers.Instagram;
  const photo = plain(extractMedia(story("3012345678901")))[0];
  assert.equal(photo.kind, "photo");
  assert.equal(photo.id, "3012345678901");
  assert.equal(photo.url, `${IG}s-big.jpg`);

  const fromId = plain(extractMedia({ ...story(undefined), id: "3022222222_555", pk: undefined }))[0];
  assert.equal(fromId.id, "3022222222", "an id of the form <pk>_<user> yields the pk");

  const video = plain(
    extractMedia(
      story("3033333333", { video_versions: [{ url: `${IG}v.mp4`, width: 720, height: 1280 }], video_duration: 4 })
    )
  )[0];
  assert.equal(video.kind, "video");
  assert.equal(video.durationMs, 4000);
  assert.equal(video.owner, "storyteller");

  assert.deepEqual(plain(extractMedia(story("12"))), [], "a pk that is too short is not a story");
  assert.deepEqual(plain(extractMedia(story("3044444444", { image_versions2: { candidates: [] } }))), []);
  assert.deepEqual(
    plain(
      extractMedia({
        product_type: "story",
        pk: "3055555555",
        video_versions: [{ url: "https://evil.example/v.mp4" }]
      })
    ),
    [],
    "a story with only unusable files is skipped, not replaced by its poster"
  );
  const owned = story("3066666666", { user: undefined, owner: { username: "viaowner" } });
  assert.equal(plain(extractMedia(owned))[0].owner, "viaowner");
  const anonymous = story("3077777777", { user: undefined });
  assert.equal(plain(extractMedia(anonymous))[0].owner, null);

  const highlight = { reel_type: "highlight_reel", items: [story("3088888888"), story("3099999999")] };
  assert.equal(extractMedia(highlight).length, 2);
  assert.equal(extractMedia({ id: "highlight:17", items: [story("3011111111")] }).length, 1);
  assert.deepEqual(plain(extractMedia({ reel_type: "highlight_reel", items: "none" })), []);
});

test("Instagram: pickBestVersion and pickBestImage reject foreign hosts", () => {
  const { pickBestVersion, pickBestImage, isDirectVideoUrl } = parsers.Instagram;
  assert.equal(pickBestVersion(undefined), null);
  assert.equal(pickBestImage([{ url: "garbage" }]), null);
  assert.equal(isDirectVideoUrl("https://example.com/a.mp4"), false);
  assert.equal(pickBestVersion([{ url: `${IG}a.mp4` }]).area, 0);
  assert.equal(
    pickBestVersion([
      { url: `${IG}a.mp4`, width: 2, height: 2 },
      { url: `${IG}b.mp4`, width: 2, height: 2 }
    ]).url,
    `${IG}a.mp4`,
    "first wins a tie"
  );
});

// ---- Facebook ----------------------------------------------------------------------------

const FB = "https://video.xx.fbcdn.net/v/";

test("Facebook: a photo keeps the largest listed rendition, not a thumbnail", () => {
  const photo = {
    __typename: "Photo",
    id: "1086989087485347",
    thumbnail: { uri: `${FB}t.jpg`, width: 100, height: 100 },
    image: { uri: `${FB}m.jpg`, width: 960, height: 720 },
    viewer_image: { uri: `${FB}l.jpg`, width: 2048, height: 1536 }
  };
  const [saved] = plain(parsers.Facebook.extractMedia({ node: photo }));
  assert.equal(saved.url, `${FB}l.jpg`);
  assert.equal(saved.width, 2048);
});

test("Facebook: a photo with no usable image, or a bad id, is skipped", () => {
  const { extractMedia, largestImage } = parsers.Facebook;
  assert.deepEqual(
    plain(extractMedia({ __typename: "Photo", id: "5", image: { uri: "https://evil.example/a.jpg" } })),
    []
  );
  assert.deepEqual(plain(extractMedia({ __typename: "Photo", id: "abc", image: { uri: `${FB}a.jpg` } })), []);
  assert.deepEqual(
    plain(extractMedia({ __typename: "Photo", id: "6", image: { uri: 5 }, other: null, text: "x" })),
    []
  );
  assert.equal(largestImage({}), null);
  assert.equal(largestImage({ a: { uri: `${FB}a.jpg` } }).area, 0);
  assert.equal(
    extractMedia([{ __typename: "Photo", id: "7", image: { uri: `${FB}a.jpg`, width: 1, height: 1 } }]).length,
    1
  );
});

test("Facebook: progressive HD beats SD, and DASH or foreign entries are ignored", () => {
  const { pickBestProgressive, isDirectVideoUrl } = parsers.Facebook;
  assert.equal(pickBestProgressive("nope"), null);
  assert.equal(isDirectVideoUrl("not a url"), false);
  const best = pickBestProgressive([
    { progressive_url: `${FB}sd.mp4`, metadata: { quality: "sd" } },
    { url: `${FB}hd.mp4`, metadata: { quality: "HD" } },
    { progressive_url: "https://evil.example/x.mp4", metadata: { quality: "HD" } },
    null
  ]);
  assert.equal(best.url, `${FB}hd.mp4`);
  assert.equal(best.quality, "HD");
  assert.equal(pickBestProgressive([{ progressive_url: `${FB}u.mp4` }]).rank, 0, "an unlabelled file is still usable");
});

test("Facebook: videos take their duration from either field and are saved once", () => {
  const { extractMedia } = parsers.Facebook;
  const fromMs = {
    __typename: "Video",
    id: "900",
    playable_duration_in_ms: 4500,
    progressive_urls: [{ progressive_url: `${FB}a.mp4`, metadata: { quality: "SD" } }]
  };
  const fromSeconds = { __typename: "Video", id: "901", length_in_second: 3, playable_url: `${FB}b.mp4` };
  const found = plain(extractMedia({ a: fromMs, b: fromSeconds, again: fromMs }));
  assert.deepEqual(
    found.map(entry => [entry.id, entry.durationMs, entry.quality]),
    [
      ["900", 4500, "SD"],
      ["901", 3000, "SD"]
    ]
  );
  const noDuration = plain(extractMedia({ __typename: "Video", id: "902", playable_url_quality_hd: `${FB}c.mp4` }));
  assert.equal(noDuration[0].durationMs, 0);
  assert.equal(noDuration[0].quality, "HD");
  assert.deepEqual(plain(extractMedia({ __typename: "Video", id: "903" })), [], "a video with no file is skipped");
  assert.deepEqual(plain(extractMedia(undefined)), []);
});

// ---- TikTok ------------------------------------------------------------------------------

const TT = "https://v16-webapp.tiktokcdn.com/";
const ttItem = (id, video, extra = {}) => ({ id, author: { unique_id: "@someone" }, video, ...extra });

test("TikTok: items without a numeric id or a video, and cover-only videos, give nothing", () => {
  const { extractMedia } = parsers.TikTok;
  assert.deepEqual(plain(extractMedia(ttItem("123", { cover: `${TT}cover.jpg` }))), [], "a cover is never saved");
  assert.deepEqual(plain(extractMedia(ttItem("12", { playAddr: `${TT}a.mp4` }))), [], "id too short");
  assert.deepEqual(plain(extractMedia({ id: "7123456789012345678" })), [], "no video node");
  assert.deepEqual(plain(extractMedia(ttItem("7123456789012345678", { playAddr: "https://evil.example/a.mp4" }))), []);
  assert.deepEqual(plain(extractMedia(null)), []);
});

test("TikTok: snake_case fields, urlList and a download address are understood", () => {
  const { extractMedia } = parsers.TikTok;
  const item = ttItem("7123456789012345678", {
    duration: 3.5,
    width: 100,
    height: 200,
    downloadAddr: `${TT}d.mp4`,
    bitRateInfo: [{ bitrate: 900000, width: 720, height: 1280, playAddr: { urlList: [`${TT}h.mp4`, 4] } }]
  });
  const [saved] = plain(extractMedia(item));
  assert.equal(saved.url, `${TT}h.mp4`);
  assert.equal(saved.durationMs, 3500);
  assert.equal(saved.owner, "someone");
  const noOwner = plain(extractMedia({ id: "7123456789012345679", video: { playAddr: `${TT}p.mp4` } }))[0];
  assert.equal(noOwner.owner, null);
  assert.equal(noOwner.durationMs, 0);
});

test("TikTok: a photo post keeps each slide's largest picture and skips previews", () => {
  const { extractMedia } = parsers.TikTok;
  const item = ttItem(
    "7123456789012345680",
    { cover: `${TT}cover.jpg`, playAddr: `${TT}music.mp4` },
    {
      imagePost: {
        images: [
          {
            imageURL: {
              urlList: [`${TT}a-thumb.jpg`, `${TT}a.jpg`, `${TT}a-long-name.jpg`, "https://evil.example/a.jpg"]
            },
            imageWidth: 1080,
            imageHeight: 1920
          },
          { displayImage: { UrlList: [`${TT}b.jpg`] }, width: 5, height: 6 },
          { imageUrl: `${TT}c-preview.jpg` },
          {}
        ]
      }
    }
  );
  const found = plain(extractMedia(item));
  assert.deepEqual(
    found.map(entry => [entry.kind, entry.index, entry.url]),
    [
      ["photo", 1, `${TT}a-long-name.jpg`],
      ["photo", 2, `${TT}b.jpg`]
    ]
  );
  assert.equal(found[0].width, 1080);
  assert.equal(found[1].height, 6);
  const snake = ttItem("7123456789012345681", {}, { image_post: { images: [{ imageUrl: `${TT}d.jpg` }] } });
  assert.equal(plain(extractMedia(snake))[0].width, 0);
});

test("TikTok: a duplicate item is saved once", () => {
  const item = ttItem("7123456789012345682", { playAddr: `${TT}x.mp4` });
  assert.equal(parsers.TikTok.extractMedia([item, { ...item }]).length, 1);
});
