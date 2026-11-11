(function initFacebookVideoParser(global) {
  "use strict";

  const { platforms } = global.PageMediaLib;
  const QUALITY_RANK = { HD: 2, SD: 1 };

  function isDirectImageUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && platforms.isFileHost("Facebook", url.hostname);
    } catch {
      return false;
    }
  }

  function isDirectVideoUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && platforms.isVideoHost("Facebook", url.hostname);
    } catch {
      return false;
    }
  }

  // `progressive_urls` entries are muxed MP4s labelled SD or HD; DASH and HLS
  // manifests (separate audio and video tracks) are ignored.
  function pickBestProgressive(entries) {
    if (!Array.isArray(entries)) {
      return null;
    }
    let best = null;
    for (const entry of entries) {
      const url = entry?.progressive_url || entry?.url;
      if (!isDirectVideoUrl(url)) {
        continue;
      }
      const quality = String(entry?.metadata?.quality || "").toUpperCase();
      const rank = QUALITY_RANK[quality] || 0;
      if (!best || rank > best.rank) {
        best = { url, quality, rank };
      }
    }
    return best;
  }

  function legacyUrl(node) {
    for (const key of ["browser_native_hd_url", "playable_url_quality_hd", "browser_native_sd_url", "playable_url"]) {
      if (isDirectVideoUrl(node[key])) {
        return { url: node[key], quality: /hd/.test(key) ? "HD" : "SD" };
      }
    }
    return null;
  }

  // Of the renditions a Photo node lists (viewer_image, image, ...), the largest one.
  function largestImage(node) {
    let best = null;
    for (const key of Object.keys(node)) {
      const image = node[key];
      if (!image || typeof image !== "object" || typeof image.uri !== "string" || !isDirectImageUrl(image.uri)) {
        continue;
      }
      const area = (Number(image.width) || 0) * (Number(image.height) || 0);
      if (!best || area > best.area) {
        best = { url: image.uri, width: Number(image.width) || 0, height: Number(image.height) || 0, area };
      }
    }
    return best;
  }

  function extractMedia(root) {
    const found = new Map();
    const seen = new WeakSet();

    (function walk(node, video) {
      if (!node || typeof node !== "object" || seen.has(node)) {
        return;
      }
      seen.add(node);

      if (node.__typename === "Photo" && /^\d+$/.test(String(node.id || ""))) {
        const best = largestImage(node);
        if (best) {
          found.set(`photo:${node.id}`, {
            platform: "Facebook",
            kind: "photo",
            id: String(node.id),
            index: 1,
            owner: null,
            width: best.width,
            height: best.height,
            url: best.url,
            // Grid edges often contain only `image`; `viewer_image` is the
            // full rendition returned for an opened photo.
            fullSize: Boolean(node.viewer_image?.uri && best.url === node.viewer_image.uri)
          });
        }
      }

      let current = video;
      if (node.__typename === "Video" && /^\d+$/.test(String(node.id || ""))) {
        current = {
          id: String(node.id),
          durationMs: Math.round(Number(node.playable_duration_in_ms ?? node.length_in_second * 1000) || 0)
        };
      }
      if (current && !found.has(`video:${current.id}`)) {
        const best = pickBestProgressive(node.progressive_urls) || legacyUrl(node);
        if (best) {
          found.set(`video:${current.id}`, {
            platform: "Facebook",
            kind: "video",
            id: current.id,
            index: 1,
            owner: null, // the node only carries an opaque owner id; the page supplies the account name
            durationMs: current.durationMs,
            quality: best.quality,
            url: best.url
          });
        }
      }

      for (const key of Object.keys(node)) {
        walk(node[key], current);
      }
    })(root, null);

    return [...found.values()];
  }

  global.PageMediaParsers ??= {};
  global.PageMediaParsers.Facebook = Object.freeze({
    extractMedia,
    pickBestProgressive,
    isDirectVideoUrl,
    largestImage
  });
})(globalThis);
