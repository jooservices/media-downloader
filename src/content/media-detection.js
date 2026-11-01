(function initPageMediaDetection(global) {
  "use strict";

  const VIDEO_MARKERS = [
    "video",
    '[data-testid="videoPlayer"]',
    '[data-testid="videoComponent"]',
    '[data-testid*="videoPlayer" i]',
    '[data-testid*="videoComponent" i]',
    '[aria-label="Embedded video" i]',
    'button[aria-label^="Play Video" i]',
    '[role="button"][aria-label^="Play Video" i]',
    'button[aria-label^="Video Settings" i]',
    '[role="button"][aria-label^="Video Settings" i]'
  ];

  function isVisible(node) {
    return Boolean(
      node &&
      node.isConnected !== false &&
      (typeof node.getClientRects !== "function" || node.getClientRects().length > 0)
    );
  }

  function videoContainer(node) {
    const closest = node?.closest?.('article, [role="article"], [role="dialog"]');
    if (closest) {
      return closest;
    }

    let current = node;
    for (let depth = 0; current && depth < 16; depth++, current = current.parentElement) {
      if (current.matches?.('article, [role="article"], [role="dialog"]')) {
        return current;
      }
    }
    return null;
  }

  function isVideoPost(container) {
    if (!container?.querySelector) {
      return false;
    }
    return VIDEO_MARKERS.some(selector => {
      try {
        return Boolean(container.querySelector(selector));
      } catch {
        return false;
      }
    });
  }

  function collectVideoContainers(doc) {
    const found = new Map();
    const articleLike = [...doc.querySelectorAll('article, [role="article"], [role="dialog"]')];

    for (const container of articleLike) {
      if (!isVisible(container) || !isVideoPost(container)) {
        continue;
      }
      const video =
        [...container.querySelectorAll("video")].find(isVisible) || container.querySelector("video") || null;
      found.set(container, { container, video });
    }

    for (const video of doc.querySelectorAll("video")) {
      if (!isVisible(video)) {
        continue;
      }
      const container = videoContainer(video);
      if (container && isVisible(container) && !found.has(container)) {
        found.set(container, { container, video });
      }
    }

    return [...found.values()];
  }

  global.PageMediaDetection = Object.freeze({
    isVideoPost,
    videoContainer,
    collectVideoContainers,
    hasVisibleVideoPost: doc => collectVideoContainers(doc).length > 0
  });
})(globalThis);
