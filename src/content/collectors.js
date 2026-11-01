// Reads the photos on an X page. Instagram and Facebook photos come from the data
// those pages receive (src/page/*-media-parser.js), never from the thumbnails in the
// page, so only the largest rendition is ever saved.
// Loaded as a content script before src/content/index.js; modules share the
// PageMediaSaver namespace and are safe to load twice.
globalThis.PageMediaSaver ??= {};
(function initCollectors(ns) {
  const { clean } = ns.page;
  const collectPageMedia = (...args) => ns.videoSources.collectPageMedia(...args);

  // A srcset entry's size: its width in pixels, or its pixel density scaled by the image's own width.
  function srcsetScore(unit, value, densityBase) {
    if (unit === "w") {
      return value;
    }
    return unit === "x" ? value * densityBase : densityBase;
  }

  function largestSrcset(srcset, img) {
    if (!srcset) {
      return null;
    }
    let best = null;
    for (const entry of srcset.split(",")) {
      const match = entry.trim().match(/^(\S+)(?:\s+(\d+(?:\.\d+)?)([wx]))?$/);
      if (!match) {
        continue;
      }
      const value = Number(match[2] || 1);
      const densityBase = Math.max(img?.naturalWidth || 0, img?.width || 0, 1);
      const score = srcsetScore(match[3], value, densityBase);
      if (!best || score > best.score) {
        best = { url: match[1], score };
      }
    }
    return best;
  }

  function imageUrl(img, platform) {
    const srcsets = [img.getAttribute("srcset")];
    const picture = img.closest("picture");
    if (picture) {
      srcsets.push(...[...picture.querySelectorAll("source")].map(source => source.getAttribute("srcset")));
    }
    let best = null;
    for (const srcset of srcsets) {
      const candidate = largestSrcset(srcset, img);
      if (candidate && (!best || candidate.score > best.score)) {
        best = candidate;
      }
    }
    const current = img.currentSrc || img.src;
    const candidate = best?.url || current;
    if (!candidate) {
      return null;
    }
    try {
      const url = new URL(candidate, location.href);
      if (platform === "Twitter" && url.hostname === "pbs.twimg.com" && url.pathname.includes("/media/")) {
        url.searchParams.set("name", "orig");
      }
      return url.href;
    } catch {
      return null;
    }
  }

  const extensionFor = PageMediaLib.paths.imageExtension;

  function makeItem({ platform, account, id, index, url }) {
    if (!url) {
      return null;
    }
    const ext = extensionFor(url);
    const stableId = clean(id || `image-${index}`, `image-${index}`);
    return {
      platform,
      account,
      key: PageMediaLib.keys.photoKey(platform, stableId, index),
      url,
      filename: `${stableId}_${String(index).padStart(2, "0")}.${ext}`
    };
  }

  function isLarge(img) {
    const width = Math.max(img.naturalWidth || 0, img.width || 0, 0);
    const height = Math.max(img.naturalHeight || 0, img.height || 0, 0);
    return width >= 160 && height >= 160;
  }

  async function collectX(account) {
    const items = [];
    const seen = new Set();
    const articles = [...document.querySelectorAll("article")];
    for (let a = 0; a < articles.length; a++) {
      const article = articles[a];
      const statusLink = article.querySelector('a[href*="/status/"]');
      const statusId = statusLink?.href.match(/\/status\/(\d+)/)?.[1] || `post-${a + 1}`;
      if (globalThis.PageMediaDetection.isVideoPost(article)) {
        continue;
      } // Never save a video poster as if it were a photo.

      let photoIndex = 0;
      for (const img of article.querySelectorAll(
        'img[src*="pbs.twimg.com/media"], img[srcset*="pbs.twimg.com/media"]'
      )) {
        if (!isLarge(img)) {
          continue;
        }
        const url = imageUrl(img, "Twitter");
        if (!url || seen.has(url)) {
          continue;
        }
        seen.add(url);
        items.push(makeItem({ platform: "Twitter", account, id: statusId, index: ++photoIndex, url }));
      }
    }
    return { items: items.filter(Boolean), ...(await collectPageMedia("Twitter", account)) };
  }

  ns.collectors = { collectX };
})(globalThis.PageMediaSaver);
