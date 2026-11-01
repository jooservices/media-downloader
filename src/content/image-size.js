// Measures real image sizes so saved file names state them.
// Loaded as a content script before src/content/index.js; modules share the
// PageMediaSaver namespace and are safe to load twice.
globalThis.PageMediaSaver ??= {};
(function initImageSize(ns) {
  // Real pixel size of an image, measured by loading it, so the saved file name
  // states what the file actually is. Results are kept per URL; null when the
  // image cannot be measured (the file is then saved without a size suffix).
  const imageSizes = new Map();

  function measureImage(url) {
    if (imageSizes.has(url)) {
      return Promise.resolve(imageSizes.get(url));
    }
    return new Promise(resolve => {
      const image = new Image();
      const finish = size => {
        clearTimeout(timer);
        imageSizes.set(url, size);
        resolve(size);
      };
      const timer = setTimeout(() => finish(null), 5000);
      image.onload = () =>
        finish(
          image.naturalWidth && image.naturalHeight ? { width: image.naturalWidth, height: image.naturalHeight } : null
        );
      image.onerror = () => finish(null);
      image.src = url;
    });
  }

  async function addImageSizes(items) {
    const sized = [];
    for (let i = 0; i < items.length; i += 6) {
      sized.push(
        ...(await Promise.all(
          items.slice(i, i + 6).map(async item => ({ ...item, ...(await measureImage(item.url)) }))
        ))
      );
    }
    return sized;
  }

  ns.imageSize = { addImageSizes };
})(globalThis.PageMediaSaver);
