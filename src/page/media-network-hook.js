(function initMediaNetworkHook(global) {
  "use strict";
  if (global.__pageMediaSaverMediaHook) {
    return;
  }

  const site = global.PageMediaLib?.sites?.forHost(global.location.hostname);
  const platform = site?.name ?? null;
  const parser = platform && global.PageMediaParsers?.[platform];
  if (!parser) {
    return;
  }
  global.__pageMediaSaverMediaHook = true;

  // Only the platform's own data endpoints are read; everything else is left alone.
  const DATA_URL = site.dataUrl;

  const CHANNEL = "page-media-saver:media";
  const announced = new Map();

  function requestPageContext() {
    try {
      const url = new URL(
        global.location.href || `https://${global.location.hostname}${global.location.pathname || "/"}`
      );
      const segments = url.pathname.split("/").filter(Boolean);
      const page = site.classify?.(segments, url);
      let postId = null;
      let storyAccount = null;
      if (platform === "Instagram" && page?.mediaPage) {
        if (page.kind === "post") {
          postId = segments[1];
        } else if (page.kind === "story" && segments.length === 3) {
          postId = segments[2];
        } else if (page.kind === "story" && segments.length === 2) {
          storyAccount = page.account;
        }
      }
      return { instagramPostId: postId || null, instagramStoryAccount: storyAccount || null };
    } catch {
      return { instagramPostId: null, instagramStoryAccount: null };
    }
  }

  // The scan runs in another world but shares the page's DOM, so the hook leaves its counters on the root
  // element. When a scan finds nothing, they tell whether the hook ran and what it could read.
  const stats = { documents: 0, found: 0 };
  function publishStats() {
    try {
      global.document?.documentElement?.setAttribute("data-pms-hook", JSON.stringify(stats));
    } catch {
      /* the page has no root element yet; the next response sets it */
    }
  }
  publishStats();

  function parseJsonLoose(text) {
    const body = String(text).replace(/^for \(;;\);/, "");
    try {
      return [JSON.parse(body)];
    } catch {
      // Some Facebook endpoints answer with one JSON document per line.
      const documents = [];
      for (const line of body.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          documents.push(JSON.parse(line));
        } catch {
          /* skip non-JSON lines */
        }
      }
      return documents;
    }
  }

  function publishDocuments(documents, context = requestPageContext()) {
    const fresh = [];
    stats.documents += documents.length;
    for (const document of documents) {
      let found = [];
      try {
        found = parser
          .extractMedia(document)
          .map(entry =>
            entry.kind === "photo" &&
            entry.platform === "Instagram" &&
            entry.fullSize === null &&
            (entry.id === context.instagramPostId ||
              (/^\d{3,40}$/.test(entry.id) &&
                typeof context.instagramStoryAccount === "string" &&
                entry.owner?.toLowerCase() === context.instagramStoryAccount.toLowerCase()))
              ? { ...entry, fullSize: true }
              : entry
          );
      } catch {
        /* an unexpected shape must not break the page */
      }
      stats.found += found.length;
      for (const entry of found) {
        const key = `${entry.platform}:${entry.kind}:${entry.id}:${entry.index}`;
        const previous = announced.get(key);
        if (previous && !(entry.fullSize === true && previous.fullSize !== true)) {
          continue;
        }
        announced.set(key, entry);
        fresh.push(entry);
      }
    }
    publishStats();
    if (fresh.length) {
      global.postMessage({ channel: CHANNEL, media: fresh }, global.location.origin);
    }
  }

  function publishRateLimit(status) {
    if (status === 429 || status === 420) {
      global.postMessage({ channel: CHANNEL, rateLimitStatus: status }, global.location.origin);
    }
  }

  const publishText = (text, context) => publishDocuments(parseJsonLoose(text), context);

  const nativeFetch = global.fetch;
  global.fetch = async function pageMediaSaverFetch(input, init) {
    const context = requestPageContext();
    const response = await nativeFetch.call(this, input, init);
    try {
      const url = typeof input === "string" ? input : input?.url || String(input);
      if (DATA_URL.test(url)) {
        publishRateLimit(response.status);
        response
          .clone()
          .text()
          .then(text => publishText(text, context))
          .catch(() => {});
      }
    } catch {
      /* never interfere with the page's own request */
    }
    return response;
  };

  const nativeOpen = global.XMLHttpRequest.prototype.open;
  global.XMLHttpRequest.prototype.open = function pageMediaSaverOpen(method, url, ...rest) {
    if (DATA_URL.test(String(url))) {
      const context = requestPageContext();
      this.addEventListener("load", () => {
        try {
          publishRateLimit(this.status);
          if (this.responseType === "" || this.responseType === "text") {
            publishText(this.responseText, context);
          }
        } catch {
          /* ignore unreadable responses */
        }
      });
    }
    return nativeOpen.call(this, method, url, ...rest);
  };

  // Instagram and Facebook render their first screens from JSON embedded in the
  // page, so read those blocks too, including ones added while scrolling.
  if (site.embeddedBootstrap && global.document) {
    const scanned = new WeakSet();
    const scanEmbedded = () => {
      const documents = [];
      const selector = site.embeddedSelector || 'script[type="application/json"]';
      const hint =
        site.embeddedHint || /video_versions|image_versions2|progressive_urls|viewer_image|playable_url|browser_native/;
      for (const script of global.document.querySelectorAll(selector)) {
        if (scanned.has(script)) {
          continue;
        }
        scanned.add(script);
        if (!hint.test(script.textContent)) {
          continue;
        }
        try {
          documents.push(JSON.parse(script.textContent));
        } catch {
          /* not a data block */
        }
      }
      if (documents.length) {
        publishDocuments(documents);
      }
    };
    let timer = null;
    const schedule = () => {
      if (timer) {
        return;
      }
      timer = global.setTimeout(() => {
        timer = null;
        scanEmbedded();
      }, 300);
    };
    const start = () => {
      scanEmbedded();
      new global.MutationObserver(schedule).observe(global.document.documentElement, {
        childList: true,
        subtree: true
      });
    };
    if (global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", start, { once: true });
    } else {
      start();
    }
  }
})(globalThis);
