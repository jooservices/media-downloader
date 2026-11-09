// Videos and photo posts TikTok already delivered in its own data. A cover image is never
// saved. A photo post keeps the largest listed picture of each slide and not the slideshow preview.
(function initTikTokMediaParser(global) {
  "use strict";

  const { platforms } = global.PageMediaLib;
  const ITEM_ID = /^\d{6,24}$/;

  function isFileUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && platforms.isFileHost("TikTok", url.hostname);
    } catch {
      return false;
    }
  }

  function urlList(value) {
    if (typeof value === "string") {
      return [value];
    }
    const listed = value?.UrlList || value?.urlList;
    return Array.isArray(listed) ? listed.filter(item => typeof item === "string") : [];
  }

  function bestAddress(candidates) {
    let best = null;
    for (const candidate of candidates) {
      if (!isFileUrl(candidate.url)) {
        continue;
      }
      const score =
        (Number(candidate.bitrate) || 0) * 1_000_000 + (Number(candidate.width) || 0) * (Number(candidate.height) || 0);
      if (!best || score > best.score) {
        best = { ...candidate, score };
      }
    }
    return best;
  }

  function bestVideo(video) {
    const entries = [];
    const info = video?.bitrateInfo || video?.bitRateInfo || [];
    for (const entry of info) {
      const width = entry.Width || entry.width || video.width;
      const height = entry.Height || entry.height || video.height;
      for (const url of urlList(entry.PlayAddr || entry.playAddr)) {
        entries.push({ url, bitrate: entry.Bitrate || entry.bitrate, width, height });
      }
    }
    for (const url of [video?.downloadAddr, video?.playAddr]) {
      entries.push({ url, bitrate: 0, width: video?.width, height: video?.height });
    }
    return bestAddress(entries);
  }

  function bestImage(image) {
    const usable = urlList(image?.imageURL || image?.imageUrl || image?.displayImage).filter(
      url => isFileUrl(url) && !/thumb|shrink|preview/i.test(url)
    );
    const url = usable.sort((a, b) => b.length - a.length)[0];
    if (!url) {
      return null;
    }
    return {
      url,
      width: Number(image.imageWidth || image.width) || 0,
      height: Number(image.imageHeight || image.height) || 0
    };
  }

  function asItem(node) {
    const id = String(node?.id ?? "");
    if (!ITEM_ID.test(id) || !node.video) {
      return null;
    }
    const owner = node.author?.uniqueId || node.author?.unique_id || "";
    return {
      id,
      owner: String(owner).replace(/^@/, "") || null,
      video: node.video,
      images: node.imagePost?.images || node.image_post?.images || []
    };
  }

  function addItem(found, item) {
    if (Array.isArray(item.images) && item.images.length) {
      item.images.forEach((image, index) => {
        const best = bestImage(image);
        const key = `photo:${item.id}:${index + 1}`;
        if (best && !found.has(key)) {
          found.set(key, {
            platform: "TikTok",
            kind: "photo",
            id: item.id,
            index: index + 1,
            owner: item.owner,
            width: best.width,
            height: best.height,
            url: best.url
          });
        }
      });
      return;
    }
    const best = bestVideo(item.video);
    if (best && !found.has(`video:${item.id}`)) {
      found.set(`video:${item.id}`, {
        platform: "TikTok",
        kind: "video",
        id: item.id,
        index: 1,
        owner: item.owner,
        durationMs: Math.round(Number(item.video.duration) * 1000) || 0,
        width: best.width,
        height: best.height,
        url: best.url
      });
    }
  }

  function extractMedia(root) {
    const found = new Map();
    const seen = new WeakSet();
    (function walk(node) {
      if (!node || typeof node !== "object" || seen.has(node)) {
        return;
      }
      seen.add(node);
      const item = asItem(node);
      if (item) {
        addItem(found, item);
      }
      for (const key of Object.keys(node)) {
        walk(node[key]);
      }
    })(root);
    return [...found.values()];
  }

  global.PageMediaParsers ??= {};
  global.PageMediaParsers.TikTok = Object.freeze({ extractMedia });
})(globalThis);
