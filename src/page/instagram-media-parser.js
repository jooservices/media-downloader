(function initInstagramMediaParser(global) {
  "use strict";

  const { platforms } = global.PageMediaLib;
  const SHORTCODE = /^[A-Za-z0-9_-]{6,16}$/;

  const isFileUrl = (value, isHost) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && isHost("Instagram", url.hostname);
    } catch {
      return false;
    }
  };
  const isDirectVideoUrl = value => isFileUrl(value, platforms.isVideoHost);
  const isDirectImageUrl = value => isFileUrl(value, platforms.isFileHost);

  // The entry with the largest picture; the first one listed wins a tie. Used for
  // video files (several encodes of one size) and for photo candidates alike.
  function pickLargest(entries, accepts) {
    if (!Array.isArray(entries)) return null;
    let best = null;
    for (const entry of entries) {
      if (!accepts(entry?.url)) continue;
      const width = Number(entry.width) || 0;
      const height = Number(entry.height) || 0;
      if (!best || width * height > best.area) best = { url: entry.url, width, height, area: width * height };
    }
    return best;
  }
  const pickBestVersion = versions => pickLargest(versions, isDirectVideoUrl);
  const pickBestImage = candidates => pickLargest(candidates, isDirectImageUrl);

  function isPostNode(node) {
    return typeof node.code === "string" && SHORTCODE.test(node.code)
      && Boolean(node.video_versions || node.image_versions2 || node.carousel_media || node.taken_at || node.media_type);
  }

  // Videos and full-size photos of every post in a response. A video's own
  // image_versions2 is only its poster, so a node with video_versions never
  // yields a photo; photos of a carousel are numbered by their position in it.
  function extractMedia(root) {
    const found = new Map();
    const seen = new WeakSet();
    // A carousel's items carry a shortcode of their own, but they are part of the post.
    const carouselItems = new WeakSet();

    const addPhoto = (current, node, position) => {
      const best = pickBestImage(node?.image_versions2?.candidates);
      if (!best) return;
      found.set(`photo:${current.code}:${position}`, {
        platform: "Instagram", kind: "photo", id: current.code, index: position, owner: current.owner,
        width: best.width, height: best.height, url: best.url
      });
    };

    (function walk(node, post) {
      if (!node || typeof node !== "object" || seen.has(node)) return;
      seen.add(node);

      let current = post;
      const isPost = isPostNode(node) && !carouselItems.has(node);
      if (isPost) {
        current = {
          code: node.code,
          owner: node.user?.username || node.owner?.username || post?.owner || null,
          index: 0
        };
      }
      if (current && Array.isArray(node.video_versions) && node.video_versions.length) {
        const best = pickBestVersion(node.video_versions);
        if (best) {
          current.index++;
          found.set(`video:${current.code}:${current.index}`, {
            platform: "Instagram",
            kind: "video",
            id: current.code,
            index: current.index,
            owner: current.owner,
            durationMs: Math.round((Number(node.video_duration) || 0) * 1000),
            width: best.width,
            height: best.height,
            url: best.url
          });
        }
      }
      if (isPost && !Array.isArray(node.video_versions)) {
        if (Array.isArray(node.carousel_media)) {
          node.carousel_media.forEach((child, i) => {
            if (child && typeof child === "object") carouselItems.add(child);
            if (!Array.isArray(child?.video_versions)) addPhoto(current, child, i + 1);
          });
        } else {
          addPhoto(current, node, 1);
        }
      }

      for (const key of Object.keys(node)) walk(node[key], current);
    })(root, null);

    return [...found.values()];
  }

  (global.PageMediaParsers ||= {}).Instagram = Object.freeze({ extractMedia, pickBestVersion, pickBestImage, isDirectVideoUrl });
})(globalThis);
