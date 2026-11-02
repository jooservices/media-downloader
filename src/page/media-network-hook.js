(function initMediaNetworkHook(global) {
  "use strict";
  if (global.__pageMediaSaverMediaHook) {
    return;
  }

  const host = global.location.hostname.toLowerCase();
  const HOST_PLATFORMS = [
    [/(^|\.)(x|twitter)\.com$/, "Twitter"],
    [/(^|\.)instagram\.com$/, "Instagram"],
    [/(^|\.)facebook\.com$/, "Facebook"]
  ];
  const platform = HOST_PLATFORMS.find(([pattern]) => pattern.test(host))?.[1] ?? null;
  const parser = platform && global.PageMediaParsers?.[platform];
  if (!parser) {
    return;
  }
  global.__pageMediaSaverMediaHook = true;

  // Only the platform's own data endpoints are read; everything else is left alone.
  const DATA_URL = {
    Twitter: /\/i\/api\/graphql\//,
    Instagram: /\/graphql(?:[/?]|$)|\/api\/v1\//,
    Facebook: /\/api\/graphql\/|\/ajax\/bulk-route-definitions|\/video\/video_data/
  }[platform];

  const CHANNEL = "page-media-saver:media";
  const announced = new Set();

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

  function publishDocuments(documents) {
    const fresh = [];
    for (const document of documents) {
      let found = [];
      try {
        found = parser.extractMedia(document);
      } catch {
        /* an unexpected shape must not break the page */
      }
      for (const entry of found) {
        const key = `${entry.platform}:${entry.kind}:${entry.id}:${entry.index}`;
        if (announced.has(key)) {
          continue;
        }
        announced.add(key);
        fresh.push(entry);
      }
    }
    if (fresh.length) {
      global.postMessage({ channel: CHANNEL, media: fresh }, global.location.origin);
    }
  }

  const publishText = text => publishDocuments(parseJsonLoose(text));

  const nativeFetch = global.fetch;
  global.fetch = async function pageMediaSaverFetch(input, init) {
    const response = await nativeFetch.call(this, input, init);
    try {
      const url = typeof input === "string" ? input : input?.url || String(input);
      if (DATA_URL.test(url)) {
        response
          .clone()
          .text()
          .then(publishText)
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
      this.addEventListener("load", () => {
        try {
          if (this.responseType === "" || this.responseType === "text") {
            publishText(this.responseText);
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
  if (platform !== "Twitter" && global.document) {
    const scanned = new WeakSet();
    const scanEmbedded = () => {
      const documents = [];
      for (const script of global.document.querySelectorAll('script[type="application/json"]')) {
        if (scanned.has(script)) {
          continue;
        }
        scanned.add(script);
        if (
          !/video_versions|image_versions2|progressive_urls|viewer_image|playable_url|browser_native/.test(
            script.textContent
          )
        ) {
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
