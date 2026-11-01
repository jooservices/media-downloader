// Shared helpers for the service worker files. Every file in src/background/ is
// loaded with importScripts from index.js, so they share one global scope.
const { platforms, paths } = PageMediaLib;
const { cleanPart, buildSavePath, withResolution, imageExtension } = paths;
const { samePage } = PageMediaLib.urls;

const MAX_ACTIVE_DOWNLOADS = 8;
const MAX_ATTEMPTS = 3;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let batchQueue = Promise.resolve();
let filenameQueue = Promise.resolve();

function queueBatch(operation) {
  const result = batchQueue.then(operation, operation);
  batchQueue = result.then(() => undefined, () => undefined);
  return result;
}

function queueFilenameOperation(operation) {
  const result = filenameQueue.then(operation, operation);
  filenameQueue = result.then(() => undefined, () => undefined);
  return result;
}
