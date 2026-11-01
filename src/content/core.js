// Tiny helpers shared by the content modules.
// Loaded as a content script before src/content/index.js; modules share the
// PageMediaSaver namespace and are safe to load twice.
globalThis.PageMediaSaver ??= {};
(function initCore(ns) {
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  ns.core = { pause };
})(globalThis.PageMediaSaver);
