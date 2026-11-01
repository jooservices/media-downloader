import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { runScript } from "../helpers/run-script.mjs";
import { loadBackground } from "../helpers/background.mjs";

const read = name => fs.readFileSync(new URL(`../../${name}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("manifest.json"));

const parserContext = { URL };
parserContext.globalThis = parserContext;
for (const file of [
  "lib/platforms.js",
  "src/page/x-media-parser.js",
  "src/page/instagram-media-parser.js",
  "src/page/facebook-media-parser.js"
]) {
  runScript(file, parserContext);
}
const { extractMedia, pickBestMp4 } = parserContext.XMediaParser;
const instagram = parserContext.PageMediaParsers.Instagram;
const facebook = parserContext.PageMediaParsers.Facebook;
// Objects built inside vm contexts have foreign prototypes, which strict deepEqual rejects.
const plain = value => JSON.parse(JSON.stringify(value));

const cdn = path => `https://video.twimg.com/amplify_video/111/${path}`;
const variants = [
  { content_type: "application/x-mpegURL", url: cdn("pl/list.m3u8") },
  { content_type: "video/mp4", bitrate: 632000, url: cdn("vid/avc1/320x568/a.mp4?tag=29") },
  { content_type: "video/mp4", bitrate: 2176000, url: cdn("vid/avc1/720x1280/c.mp4?tag=29") },
  { content_type: "video/mp4", bitrate: 950000, url: cdn("vid/avc1/480x852/b.mp4?tag=29") }
];

const tweet = (restId, screenName, media) => ({
  rest_id: restId,
  core: { user_results: { result: { core: { screen_name: screenName } } } },
  legacy: { extended_entities: { media } }
});

test("registers one parser per platform", () => {
  assert.deepEqual(plain(Object.keys(parserContext.PageMediaParsers).sort()), ["Facebook", "Instagram", "Twitter"]);
});

test("picks the highest-bitrate mp4 and ignores HLS playlists", () => {
  const best = pickBestMp4(variants);
  assert.equal(best.bitrate, 2176000);
  assert.match(best.url, /720x1280/);
  assert.equal(pickBestMp4([variants[0]]), null);
});

test("rejects variants that are not on the X video CDN over https", () => {
  assert.equal(pickBestMp4([{ content_type: "video/mp4", bitrate: 1, url: "https://evil.example/v.mp4" }]), null);
  assert.equal(pickBestMp4([{ content_type: "video/mp4", bitrate: 1, url: "http://video.twimg.com/v.mp4" }]), null);
});

test("extracts videos from a nested TweetDetail-style response", () => {
  const response = {
    data: {
      threaded_conversation_with_injections_v2: {
        instructions: [
          {
            entries: [
              {
                content: {
                  itemContent: {
                    tweet_results: {
                      result: {
                        __typename: "TweetWithVisibilityResults",
                        tweet: tweet("2116511528275030211", "Fxtyoo", [
                          { type: "photo", media_url_https: "https://pbs.twimg.com/media/x.jpg" },
                          { type: "video", video_info: { duration_millis: 74960, variants } }
                        ])
                      }
                    }
                  }
                }
              }
            ]
          }
        ]
      }
    }
  };
  const [video, ...rest] = extractMedia(response);
  assert.equal(rest.length, 0);
  assert.equal(video.platform, "Twitter");
  assert.equal(video.id, "2116511528275030211");
  assert.equal(video.owner, "Fxtyoo");
  assert.equal(video.durationMs, 74960);
  assert.equal(video.width, 720);
  assert.equal(video.height, 1280);
  assert.equal(video.animatedGif, false);
  assert.match(video.url, /^https:\/\/video\.twimg\.com\//);
});

test("indexes several videos in one post and keeps animated GIFs", () => {
  const gif = {
    type: "animated_gif",
    video_info: {
      variants: [{ content_type: "video/mp4", bitrate: 0, url: "https://video.twimg.com/tweet_video/g.mp4" }]
    }
  };
  const videos = extractMedia({ list: [tweet("5", "a", [{ type: "video", video_info: { variants } }, gif])] });
  assert.deepEqual(plain(videos.map(video => [video.index, video.animatedGif])), [
    [1, false],
    [2, true]
  ]);
});

test("attributes a retweeted video to its original post", () => {
  const original = tweet("20", "origin", [{ type: "video", video_info: { variants } }]);
  const retweet = { rest_id: "30", legacy: { retweeted_status_result: { result: original } } };
  const videos = extractMedia({ retweet });
  assert.deepEqual(plain(videos.map(video => [video.id, video.owner])), [["20", "origin"]]);
});

test("ignores responses without video and survives circular data", () => {
  assert.equal(extractMedia({ data: { user: { rest_id: "1" } } }).length, 0);
  const loop = { a: {} };
  loop.a.self = loop;
  assert.equal(extractMedia(loop).length, 0);
});

const igUrl = path => `https://scontent.cdninstagram.com/o1/v/t2/${path}.mp4?oh=1`;
const igPost = (code, extra = {}) => ({
  code,
  taken_at: 1,
  user: { username: "creator" },
  video_duration: 12.5,
  video_versions: [
    { width: 480, height: 854, type: 102, url: igUrl("small") },
    { width: 720, height: 1280, type: 101, url: igUrl("big-first") },
    { width: 720, height: 1280, type: 103, url: igUrl("big-second") }
  ],
  ...extra
});

test("Instagram: keeps the largest listed version and the post owner", () => {
  const [video, ...rest] = instagram.extractMedia({ data: { xdt: { items: [igPost("DezPoWNzXMt")] } } });
  assert.equal(rest.length, 0);
  assert.equal(video.platform, "Instagram");
  assert.equal(video.id, "DezPoWNzXMt");
  assert.equal(video.owner, "creator");
  assert.equal(video.durationMs, 12500);
  assert.equal(video.width, 720);
  assert.match(video.url, /big-first/);
});

test("Instagram: numbers carousel videos under the parent post and skips photos", () => {
  const post = {
    code: "Cabc1234",
    taken_at: 1,
    user: { username: "creator" },
    carousel_media: [
      { image_versions2: {} },
      { video_versions: [{ width: 640, height: 640, url: igUrl("one") }] },
      { video_versions: [{ width: 640, height: 640, url: igUrl("two") }] }
    ]
  };
  const videos = instagram.extractMedia(post);
  assert.deepEqual(plain(videos.map(video => [video.id, video.index, video.owner])), [
    ["Cabc1234", 1, "creator"],
    ["Cabc1234", 2, "creator"]
  ]);
});

test("Instagram: ignores unrelated codes and URLs outside Instagram's CDN", () => {
  assert.equal(
    instagram.extractMedia({ code: "US", video_versions: [{ width: 1, height: 1, url: igUrl("x") }] }).length,
    0
  );
  assert.equal(
    instagram.extractMedia(
      igPost("Dxyz12345", { video_versions: [{ width: 9, height: 9, url: "https://evil.example/v.mp4" }] })
    ).length,
    0
  );
  assert.equal(
    instagram.extractMedia(
      igPost("Dxyz12345", { video_versions: [{ width: 9, height: 9, url: "http://scontent.cdninstagram.com/v.mp4" }] })
    ).length,
    0
  );
});

const fbUrl = quality => `https://scontent.fsgn1-1.fna.fbcdn.net/o1/v/t2/${quality}.mp4?oh=1`;
const fbVideo = (id, extra = {}) => ({
  __typename: "Video",
  id,
  owner: { __typename: "User", id: "100" },
  videoDeliveryResponseFragment: {
    videoDeliveryResponseResult: {
      id,
      dash_manifest_urls: [{ manifest_url: "https://video.fbcdn.net/dash.mpd" }],
      progressive_urls: [
        { progressive_url: fbUrl("sd"), metadata: { quality: "SD" } },
        { progressive_url: fbUrl("hd"), metadata: { quality: "HD" } }
      ]
    }
  },
  ...extra
});

test("Facebook: prefers the HD progressive file and ignores DASH manifests", () => {
  const [video, ...rest] = facebook.extractMedia({
    a: { viewer: { edges: [{ node: { attachments: [{ media: fbVideo("2059757664673295") }] } }] } }
  });
  assert.equal(rest.length, 0);
  assert.equal(video.platform, "Facebook");
  assert.equal(video.id, "2059757664673295");
  assert.equal(video.owner, null);
  assert.equal(video.quality, "HD");
  assert.match(video.url, /\/hd\.mp4/);
});

test("Facebook: reads the legacy playable_url fields and rejects foreign hosts", () => {
  const legacy = {
    __typename: "Video",
    id: "77",
    browser_native_sd_url: fbUrl("legacy-sd"),
    browser_native_hd_url: fbUrl("legacy-hd")
  };
  assert.match(facebook.extractMedia(legacy)[0].url, /legacy-hd/);
  assert.equal(
    facebook.extractMedia({ __typename: "Video", id: "78", playable_url: "https://evil.example/v.mp4" }).length,
    0
  );
  assert.equal(
    facebook.extractMedia({ progressive_urls: [{ progressive_url: fbUrl("hd"), metadata: { quality: "HD" } }] }).length,
    0,
    "no video id, no entry"
  );
});

test("manifest loads every parser and the hook in the page world before the bridge", () => {
  const hook = manifest.content_scripts.find(entry => entry.world === "MAIN");
  assert.deepEqual(hook.js, [
    "lib/platforms.js",
    "src/page/x-media-parser.js",
    "src/page/instagram-media-parser.js",
    "src/page/facebook-media-parser.js",
    "src/page/media-network-hook.js"
  ]);
  assert.equal(hook.run_at, "document_start");
  for (const host of ["instagram.com", "facebook.com", "x.com", "twitter.com"]) {
    assert.ok(
      hook.matches.some(match => match.includes(host)),
      host
    );
  }
  assert.ok(
    manifest.content_scripts.indexOf(hook) <
      manifest.content_scripts.findIndex(entry => entry.js.includes("src/content/index.js"))
  );
  assert.ok(
    manifest.content_scripts.some(
      entry => entry.js.includes("src/page/media-bridge.js") && entry.run_at === "document_start"
    )
  );
});

function loadHook(hostname, fetchImpl) {
  const posted = [];
  const page = {
    location: { hostname, origin: `https://${hostname}` },
    fetch: fetchImpl,
    postMessage: (message, origin) => posted.push({ message, origin }),
    XMLHttpRequest: class {
      static open() {}
    },
    setTimeout,
    PageMediaParsers: parserContext.PageMediaParsers,
    document: null
  };
  page.XMLHttpRequest.prototype.open = function open() {};
  page.globalThis = page;
  runScript("src/page/media-network-hook.js", page);
  return { page, posted };
}

test("hook publishes videos from a platform data response once and ignores other URLs", async () => {
  const body = JSON.stringify({ data: { items: [igPost("Dhook0001")] } });
  const { page, posted } = loadHook("www.instagram.com", async () => ({
    clone: () => ({ text: async () => `for (;;);${body}` })
  }));
  await page.fetch("https://www.instagram.com/api/v1/clips/");
  await page.fetch("https://www.instagram.com/api/v1/clips/");
  await page.fetch("https://www.instagram.com/static/app.js");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(posted.length, 1);
  assert.equal(posted[0].origin, "https://www.instagram.com");
  assert.equal(posted[0].message.channel, "page-media-saver:media");
  assert.equal(posted[0].message.media[0].id, "Dhook0001");
});

test("hook reads line-delimited Facebook responses", async () => {
  const lines = [JSON.stringify({ label: "x" }), JSON.stringify({ data: { media: fbVideo("555") } })].join("\n");
  const { page, posted } = loadHook("www.facebook.com", async () => ({ clone: () => ({ text: async () => lines }) }));
  await page.fetch("https://www.facebook.com/api/graphql/");
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(plain(posted[0].message.media.map(video => video.id)), ["555"]);
});

const found = (id, url, extra = {}) => ({
  platform: "Twitter",
  id,
  index: 1,
  owner: "Fxtyoo",
  durationMs: 1000,
  url,
  ...extra
});

test("caches reported videos and downloads them into the account folder", async () => {
  const { send, storage, started } = loadBackground();
  const good = found("123", "https://video.twimg.com/amplify_video/1/vid/avc1/720x1280/a.mp4?tag=29");
  const bad = found("124", "https://evil.example/a.mp4");
  const wrongHost = found("125", "https://pbs.twimg.com/media/a.jpg");
  assert.deepEqual(plain(await send({ type: "MEDIA_FOUND", media: [good, bad, wrongHost] })), {
    ok: true,
    added: 1,
    cached: 1
  });
  assert.deepEqual(plain(Object.keys(storage.mediaCache)), ["Twitter:video:123:1"]);

  const result = await send({ type: "DOWNLOAD_CACHED_MEDIA", platform: "Twitter", account: "fxtyoo" });
  assert.equal(result.ok, true);
  assert.equal(result.started, 1);
  assert.equal(started[0].filename, "Twitter/Fxtyoo/video_123.mp4");
  assert.equal(started[0].url, good.url);
  assert.ok(storage.pendingDownloads["Twitter|video|123|1"]);
});

test("does not download a cached video twice and filters by account", async () => {
  const { send, started } = loadBackground();
  await send({
    type: "MEDIA_FOUND",
    media: [
      found("1001", "https://video.twimg.com/v/1001.mp4"),
      found("1002", "https://video.twimg.com/v/1002.mp4", { owner: "other" }),
      found("1003", "https://video.twimg.com/v/1003.mp4", { owner: null })
    ]
  });
  await send({ type: "DOWNLOAD_CACHED_MEDIA", platform: "Twitter", account: "Fxtyoo" });
  const again = await send({ type: "DOWNLOAD_CACHED_MEDIA", platform: "Twitter", account: "Fxtyoo" });
  assert.equal(started.length, 1);
  assert.equal(again.started, 0);
  assert.equal(again.skipped, 1);
});

test("Instagram and Facebook videos are chosen by the page's ids and never cross platforms", async () => {
  const { send, started } = loadBackground();
  await send({
    type: "MEDIA_FOUND",
    media: [
      {
        platform: "Instagram",
        id: "DezPoWNzXMt",
        index: 1,
        owner: "creator",
        url: "https://scontent.cdninstagram.com/a.mp4"
      },
      {
        platform: "Instagram",
        id: "Dother0001",
        index: 1,
        owner: "someone",
        url: "https://scontent.cdninstagram.com/b.mp4"
      },
      {
        platform: "Facebook",
        id: "2059757664673295",
        index: 1,
        owner: null,
        url: "https://scontent.fsgn1-1.fna.fbcdn.net/c.mp4"
      },
      { platform: "Facebook", id: "999", index: 1, owner: null, url: "https://scontent.fsgn1-1.fna.fbcdn.net/d.mp4" },
      {
        platform: "Instagram",
        id: "Devil00001",
        index: 1,
        owner: "x",
        url: "https://scontent.fsgn1-1.fna.fbcdn.net/e.mp4"
      }
    ]
  });

  const ig = await send({
    type: "DOWNLOAD_CACHED_MEDIA",
    platform: "Instagram",
    account: "creator",
    ids: ["DezPoWNzXMt"]
  });
  assert.equal(ig.started, 1);
  assert.equal(started[0].filename, "Instagram/creator/video_DezPoWNzXMt.mp4");

  const fb = await send({
    type: "DOWNLOAD_CACHED_MEDIA",
    platform: "Facebook",
    account: "page.name",
    ids: ["2059757664673295"]
  });
  assert.equal(fb.started, 1);
  assert.equal(started[1].filename, "Facebook/page.name/video_2059757664673295.mp4");
  assert.equal(started.length, 2, "ids that are not on the page stay in the cache");

  const noIds = await send({ type: "DOWNLOAD_CACHED_MEDIA", platform: "Facebook", account: "page.name" });
  assert.equal(noIds.started, 0, "an unknown owner is never guessed without page ids");
  assert.equal((await send({ type: "DOWNLOAD_CACHED_MEDIA", platform: "Nope" })).ok, false);
});
