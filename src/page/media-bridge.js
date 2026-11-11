(() => {
  if (globalThis.__pageMediaSaverMediaBridge) {
    return;
  }
  globalThis.__pageMediaSaverMediaBridge = true;

  const CHANNEL = "page-media-saver:media";
  // The service worker is the one that knows which platforms and file hosts are valid and drops the rest. The
  // bridge must not depend on any other script having loaded first: the browser does not promise an order across
  // content-script entries, and a data response can arrive before the page is even parsed.

  function fullSizeOf(entry) {
    if (entry?.kind === "photo" && ["Instagram", "Facebook"].includes(entry.platform)) {
      return entry.fullSize === true;
    }
    return entry?.fullSize !== false;
  }

  const stringOrEmpty = value => String(value || "");
  const numberOrZero = value => Number(value) || 0;
  const expectedItemsOf = entry => Math.max(1, Number(entry?.expectedItems) || 1);

  function normalizeMedia(entry) {
    return {
      platform: stringOrEmpty(entry?.platform),
      kind: entry?.kind === "photo" ? "photo" : "video",
      id: stringOrEmpty(entry?.id),
      index: Number(entry?.index) || 1,
      owner: entry?.owner ? String(entry.owner) : null,
      durationMs: numberOrZero(entry?.durationMs),
      width: numberOrZero(entry?.width),
      height: numberOrZero(entry?.height),
      fullSize: fullSizeOf(entry),
      expectedItems: expectedItemsOf(entry),
      url: stringOrEmpty(entry?.url)
    };
  }

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) {
      return;
    }
    if (event.data?.channel !== CHANNEL) {
      return;
    }
    if ([420, 429].includes(Number(event.data.rateLimitStatus))) {
      chrome.runtime
        .sendMessage({ type: "PLATFORM_RATE_LIMIT", status: Number(event.data.rateLimitStatus) })
        .catch(() => {});
    }
    if (!Array.isArray(event.data.media)) {
      return;
    }
    const media = event.data.media
      .slice(0, 100)
      .map(normalizeMedia)
      .filter(entry => entry.platform && entry.id);
    if (media.length) {
      chrome.runtime.sendMessage({ type: "MEDIA_FOUND", media }).catch(() => {});
    }
  });
})();
