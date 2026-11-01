(() => {
  if (globalThis.__pageMediaSaverMediaBridge) {
    return;
  }
  globalThis.__pageMediaSaverMediaBridge = true;

  const CHANNEL = "page-media-saver:media";
  const PLATFORMS = new Set(["Twitter", "Instagram", "Facebook"]);

  window.addEventListener("message", event => {
    if (event.source !== window || event.origin !== location.origin) {
      return;
    }
    if (event.data?.channel !== CHANNEL || !Array.isArray(event.data.media)) {
      return;
    }
    const media = event.data.media
      .slice(0, 100)
      .map(entry => ({
        platform: String(entry?.platform || ""),
        kind: entry?.kind === "photo" ? "photo" : "video",
        id: String(entry?.id || ""),
        index: Number(entry?.index) || 1,
        owner: entry?.owner ? String(entry.owner) : null,
        durationMs: Number(entry?.durationMs) || 0,
        width: Number(entry?.width) || 0,
        height: Number(entry?.height) || 0,
        url: String(entry?.url || "")
      }))
      .filter(entry => PLATFORMS.has(entry.platform) && entry.id);
    if (media.length) {
      chrome.runtime.sendMessage({ type: "MEDIA_FOUND", media }).catch(() => {});
    }
  });
})();
