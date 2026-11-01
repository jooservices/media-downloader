import assert from "node:assert/strict";
import test from "node:test";
import { runScript } from "../helpers/run-script.mjs";

function loadDetection() {
  const context = {};
  runScript("src/content/media-detection.js", context);
  return context.PageMediaDetection;
}

function visibleNode(properties = {}) {
  return {
    isConnected: true,
    getClientRects: () => [{}],
    ...properties
  };
}

function fakeDocument(articles, videos = []) {
  return {
    querySelectorAll(selector) {
      if (selector === 'article, [role="article"], [role="dialog"]') {
        return articles;
      }
      if (selector === "video") {
        return videos;
      }
      return [];
    }
  };
}

test("recognizes an X video before its native video element appears", () => {
  const detection = loadDetection();
  const playButton = visibleNode();
  const article = visibleNode({
    querySelector(selector) {
      if (selector === 'button[aria-label^="Play Video" i]') {
        return playButton;
      }
      return null;
    },
    querySelectorAll: () => [],
    closest: () => article
  });

  const candidates = detection.collectVideoContainers(fakeDocument([article]));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].container, article);
  assert.equal(candidates[0].video, null);
});

test("does not mistake an image-only post for a video", () => {
  const detection = loadDetection();
  const article = visibleNode({ querySelector: () => null, querySelectorAll: () => [] });
  assert.equal(detection.hasVisibleVideoPost(fakeDocument([article])), false);
});

test("deduplicates a player marker and its native video element", () => {
  const detection = loadDetection();
  const video = visibleNode({ closest: () => article });
  const article = visibleNode({
    querySelector: selector => (selector === "video" ? video : null),
    querySelectorAll: selector => (selector === "video" ? [video] : [])
  });

  const candidates = detection.collectVideoContainers(fakeDocument([article], [video]));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].container, article);
  assert.equal(candidates[0].video, video);
});
