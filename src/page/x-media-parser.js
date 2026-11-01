(function initXMediaParser(global) {
  "use strict";

  const { platforms } = global.PageMediaLib;

  function screenNameOf(tweet) {
    const user = tweet?.core?.user_results?.result;
    return user?.core?.screen_name || user?.legacy?.screen_name || null;
  }

  function isDirectVideoUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && platforms.isVideoHost("Twitter", url.hostname);
    } catch {
      return false;
    }
  }

  // Highest-bitrate progressive MP4 on the X video CDN. HLS playlists are ignored.
  function pickBestMp4(variants) {
    if (!Array.isArray(variants)) return null;
    let best = null;
    for (const variant of variants) {
      if (variant?.content_type !== "video/mp4" || !isDirectVideoUrl(variant.url)) continue;
      const bitrate = Number(variant.bitrate) || 0;
      if (!best || bitrate > best.bitrate) best = { url: variant.url, bitrate };
    }
    return best;
  }

  function sizeFromUrl(url) {
    const match = new URL(url).pathname.match(/\/(\d+)x(\d+)\//);
    return match ? { width: Number(match[1]), height: Number(match[2]) } : { width: 0, height: 0 };
  }

  function extractMedia(root) {
    const found = new Map();
    const seen = new WeakSet();

    (function walk(node) {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);

      const media = node.legacy?.extended_entities?.media;
      if (/^\d+$/.test(String(node.rest_id || "")) && Array.isArray(media)) {
        const tweetId = String(node.rest_id);
        const screenName = screenNameOf(node);
        let index = 0;
        for (const entry of media) {
          if (!entry?.video_info) continue;
          index++;
          const best = pickBestMp4(entry.video_info.variants);
          if (!best) continue;
          found.set(`${tweetId}:${index}`, {
            platform: "Twitter",
            kind: "video",
            id: tweetId,
            index,
            owner: screenName,
            durationMs: Number(entry.video_info.duration_millis) || 0,
            animatedGif: entry.type === "animated_gif",
            bitrate: best.bitrate,
            url: best.url,
            ...sizeFromUrl(best.url)
          });
        }
      }

      for (const key of Object.keys(node)) walk(node[key]);
    })(root);

    return [...found.values()];
  }

  global.XMediaParser = Object.freeze({ extractMedia, pickBestMp4, isDirectVideoUrl });
  (global.PageMediaParsers ||= {}).Twitter = global.XMediaParser;
})(globalThis);
