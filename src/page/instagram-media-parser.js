(function initInstagramMediaParser(global) {
  "use strict";

  const { platforms } = global.PageMediaLib;
  // Most posts use an 11-character shortcode, but some accounts' posts are addressed by a 39-character one.
  const SHORTCODE = /^[A-Za-z0-9_-]{6,40}$/;

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
    if (!Array.isArray(entries)) {
      return null;
    }
    let best = null;
    for (const entry of entries) {
      if (!accepts(entry?.url)) {
        continue;
      }
      const width = Number(entry.width) || 0;
      const height = Number(entry.height) || 0;
      if (!best || width * height > best.area) {
        best = { url: entry.url, width, height, area: width * height };
      }
    }
    return best;
  }
  const pickBestVersion = versions => pickLargest(versions, isDirectVideoUrl);
  const pickBestImage = candidates => pickLargest(candidates, isDirectImageUrl);

  // Without declared original dimensions, an available candidate may still be
  // a resized grid rendition. Leave it uncovered so opening the post can fetch
  // the largest candidate from the full response.
  function isFullSizeImage(node, best) {
    if (!best) {
      return false;
    }
    const width = Number(node?.original_width) || 0;
    const height = Number(node?.original_height) || 0;
    if (width > 0 && height > 0) {
      return best.width >= width && best.height >= height;
    }
    return false;
  }

  function isPostNode(node) {
    return (
      typeof node.code === "string" &&
      SHORTCODE.test(node.code) &&
      Boolean(node.video_versions || node.image_versions2 || node.carousel_media || node.taken_at || node.media_type)
    );
  }

  // Story frames are addressed by a numeric pk, not a post shortcode. `id` is sometimes "<pk>_<user>".
  function storyPk(node) {
    const raw = node?.pk ?? String(node?.id ?? "").split("_")[0];
    const id = String(raw);
    return /^\d{3,40}$/.test(id) ? id : null;
  }

  // A highlight reel's frames are archived stories. They are saved by the same largest-file rule.
  function highlightItems(node) {
    const id = String(node?.id || "");
    if (node?.reel_type !== "highlight_reel" && !id.startsWith("highlight:")) {
      return [];
    }
    return Array.isArray(node.items) ? node.items : [];
  }

  function isStoryItem(node) {
    return (
      node?.product_type === "story" && Boolean(storyPk(node)) && Boolean(node.video_versions || node.image_versions2)
    );
  }

  // Videos and full-size photos of every post in a response. A video's own
  // image_versions2 is only its poster, so a node with video_versions never
  // yields a photo; photos of a carousel are numbered by their position in it.
  function extractMedia(root) {
    const found = new Map();
    const seen = new WeakSet();
    // A carousel's items carry a shortcode of their own, but they are part of the post.
    const carouselItems = new WeakSet();

    const addPhoto = (current, node, position, expectedItems = 1) => {
      const best = pickBestImage(node?.image_versions2?.candidates);
      if (!best) {
        return;
      }
      found.set(`photo:${current.code}:${position}`, {
        platform: "Instagram",
        kind: "photo",
        id: current.code,
        index: position,
        owner: current.owner,
        width: best.width,
        height: best.height,
        url: best.url,
        fullSize: isFullSizeImage(node, best),
        expectedItems
      });
    };

    const addVideo = (current, node) => {
      const best =
        Array.isArray(node.video_versions) && node.video_versions.length ? pickBestVersion(node.video_versions) : null;
      if (!best) {
        return;
      }
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
    };

    // A story's poster is not a photo. The largest listed file is the only one kept.
    const addStory = node => {
      const id = storyPk(node);
      const owner = node.user?.username || node.owner?.username || null;
      const video =
        Array.isArray(node.video_versions) && node.video_versions.length ? pickBestVersion(node.video_versions) : null;
      const photo = video ? null : pickBestImage(node.image_versions2?.candidates);
      const best = video || photo;
      if (!best) {
        return;
      }
      found.set(`${video ? "video" : "photo"}:${id}:1`, {
        platform: "Instagram",
        kind: video ? "video" : "photo",
        id,
        index: 1,
        owner,
        durationMs: video ? Math.round((Number(node.video_duration) || 0) * 1000) : undefined,
        width: best.width,
        height: best.height,
        url: best.url,
        fullSize: Boolean(video || isFullSizeImage(node, best))
      });
    };

    const addPostPhotos = (current, node) => {
      if (!Array.isArray(node.carousel_media)) {
        addPhoto(current, node, 1);
        return;
      }
      const expectedItems = node.carousel_media.filter(child => child && !Array.isArray(child.video_versions)).length;
      node.carousel_media.forEach((child, i) => {
        if (child && typeof child === "object") {
          carouselItems.add(child);
        }
        if (!Array.isArray(child?.video_versions)) {
          addPhoto(current, child, i + 1, expectedItems);
        }
      });
    };

    (function walk(node, post) {
      if (!node || typeof node !== "object" || seen.has(node)) {
        return;
      }
      seen.add(node);

      for (const item of highlightItems(node)) {
        addStory(item);
      }
      if (isStoryItem(node)) {
        addStory(node);
        for (const key of Object.keys(node)) {
          walk(node[key], null);
        }
        return;
      }

      let current = post;
      const isPost = isPostNode(node) && !carouselItems.has(node);
      if (isPost) {
        current = {
          code: node.code,
          owner: node.user?.username || node.owner?.username || post?.owner || null,
          index: 0
        };
      }
      if (current) {
        addVideo(current, node);
      }
      if (isPost && !Array.isArray(node.video_versions)) {
        addPostPhotos(current, node);
      }

      for (const key of Object.keys(node)) {
        walk(node[key], current);
      }
    })(root, null);

    return [...found.values()];
  }

  global.PageMediaParsers ??= {};
  global.PageMediaParsers.Instagram = Object.freeze({
    extractMedia,
    pickBestVersion,
    pickBestImage,
    isDirectVideoUrl,
    isFullSizeImage
  });
})(globalThis);
