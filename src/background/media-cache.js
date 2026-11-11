// Full-size photos and video files each platform's page already delivered in its
// own data responses, reported by the page-world hook and saved from here without
// any extra request to the site. Kept in storage so a service-worker restart does
// not lose what the page loaded earlier. Thumbnails are never saved: only the
// largest rendition the page's data lists.
const MEDIA_CACHE_LIMIT = 4000;
let mediaCacheQueue = Promise.resolve();

const MEDIA_KINDS = ["photo", "video"];

const httpsHostname = value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.hostname.toLowerCase() : "";
  } catch {
    return "";
  }
};

// A reported entry is kept only when its platform, kind, id and file host all check out.
function acceptedEntry(entry) {
  const platform = entry?.platform;
  const kind = entry?.kind || "video";
  const validShape =
    platforms.PLATFORMS.includes(platform) &&
    MEDIA_KINDS.includes(kind) &&
    /^[\w-]{3,40}$/.test(String(entry?.id || ""));
  if (!validShape) {
    return null;
  }
  const host = httpsHostname(entry.url);
  const hostOk = kind === "photo" ? platforms.isFileHost(platform, host) : platforms.isVideoHost(platform, host);
  if (!hostOk) {
    return null;
  }
  return {
    platform,
    kind,
    id: String(entry.id),
    index: Number(entry.index) || 1,
    owner: entry.owner ? cleanPart(entry.owner) : null,
    durationMs: Number(entry.durationMs) || 0,
    width: Number(entry.width) || 0,
    height: Number(entry.height) || 0,
    url: entry.url
  };
}

async function storeMedia(media) {
  if (!Array.isArray(media)) {
    return { ok: false, error: "No media was provided." };
  }
  const { mediaCache = {} } = await chrome.storage.local.get({ mediaCache: {} });
  let added = 0;
  for (const reported of media.slice(0, 100)) {
    const entry = acceptedEntry(reported);
    if (!entry) {
      continue;
    }
    const cacheKey = `${entry.platform}:${entry.kind}:${entry.id}:${entry.index}`;
    if (!Object.hasOwn(mediaCache, cacheKey)) {
      added++;
    }
    delete mediaCache[cacheKey]; // re-added at the end, so the oldest entries are the ones dropped
    mediaCache[cacheKey] = entry;
  }
  const keys = Object.keys(mediaCache);
  for (const key of keys.slice(0, Math.max(0, keys.length - MEDIA_CACHE_LIMIT))) {
    delete mediaCache[key];
  }
  await chrome.storage.local.set({ mediaCache });
  return { ok: true, added, cached: Object.keys(mediaCache).length };
}

function cacheMedia(media) {
  const result = mediaCacheQueue.then(() => storeMedia(media));
  mediaCacheQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

// The download for one cached entry. A photo is named <post id>_<position>, which
// is how photos were always named; a video is video_<post id>[_<n>].
function cachedMediaItem(entry, account) {
  const owner = cleanPart(entry.owner || account);
  if (entry.kind === "photo") {
    return {
      platform: entry.platform,
      account: owner,
      key: PageMediaLib.keys.imageKey(entry.platform, entry.id, entry.index),
      url: entry.url,
      width: entry.width,
      height: entry.height,
      filename: `${entry.id}_${String(entry.index).padStart(2, "0")}.${imageExtension(entry.url)}`
    };
  }
  const suffix = entry.index > 1 ? `_${String(entry.index).padStart(2, "0")}` : "";
  return {
    platform: entry.platform,
    account: owner,
    key: PageMediaLib.keys.videoKey(entry.platform, entry.id, entry.index),
    url: entry.url,
    width: entry.width,
    height: entry.height,
    filename: `video_${entry.id}${suffix}.mp4`
  };
}

// A known owner must be the scanned account: promoted, suggested and reposted
// posts on the same page carry ids too, and must not land in another folder.
function ownerMatches(entry, wantedAccount) {
  return !entry.owner || !wantedAccount || entry.owner.toLowerCase() === wantedAccount;
}

function cacheDiagnostics(mediaCache, platform, wantedIds, wantedAccount, selected) {
  const platformEntries = Object.values(mediaCache).filter(entry => entry.platform === platform);
  return {
    cached: platformEntries.length,
    owned: platformEntries.filter(entry => entry.owner && ownerMatches(entry, wantedAccount)).length,
    idMatched: wantedIds ? platformEntries.filter(entry => wantedIds.has(entry.id)).length : null,
    wantedIds: wantedIds ? wantedIds.size : null,
    selected
  };
}

// `ids` (post or media ids read from the page's own links) selects entries on
// pages where the cached owner is unknown; without them only entries whose
// cached owner matches `account` are saved, so unrelated feed media never lands
// in the wrong folder.
const queuedCachedKeys = new Set();
const pendingCachedRequests = new Map();
const cachedMediaRequests = new Map();
let nextCachedMediaRequestId = 1;

function downloadCachedMedia(request) {
  if (["Facebook", "TikTok"].includes(request.platform)) {
    const ids = Array.isArray(request.ids) ? [...new Set(request.ids.map(String))].sort() : null;
    const requestKey = `${request.platform}|${String(request.account || "").toLowerCase()}|${JSON.stringify(ids)}|${JSON.stringify(request.limit ?? null)}`;
    const pending = pendingCachedRequests.get(requestKey);
    if (pending) {
      return deferredCachedMediaReply(pending.requestId);
    }
    const requestId = `cached-${nextCachedMediaRequestId++}`;
    const work = queueBatch(() => downloadCachedMediaNow(request, { inQueue: true }));
    pendingCachedRequests.set(requestKey, { requestId, work });
    cachedMediaRequests.set(requestId, { requestKey, work });
    const cleanup = setTimeout(() => releaseCachedMediaRequest(requestId), 120_000);
    cleanup.unref?.();
    return deferredCachedMediaReply(requestId);
  }
  return downloadCachedMediaNow(request);
}

function deferredCachedMediaReply(requestId) {
  return {
    ok: true,
    deferred: true,
    requestId,
    started: 0,
    queued: 0,
    skipped: 0,
    failed: 0,
    pending: 0,
    diag: { deferred: true }
  };
}

function releaseCachedMediaRequest(requestId) {
  const request = cachedMediaRequests.get(requestId);
  if (!request) {
    return;
  }
  cachedMediaRequests.delete(requestId);
  if (pendingCachedRequests.get(request.requestKey)?.requestId === requestId) {
    pendingCachedRequests.delete(request.requestKey);
  }
}

async function getCachedMediaResult(requestId) {
  const request = cachedMediaRequests.get(requestId);
  if (!request) {
    return { ok: false, error: "The cached-media request is no longer available." };
  }
  try {
    return await request.work;
  } finally {
    releaseCachedMediaRequest(requestId);
  }
}

async function downloadCachedMediaNow({ platform, account, ids, limit }, { inQueue = false } = {}) {
  if (!platforms.PLATFORMS.includes(platform)) {
    return { ok: false, error: "Unsupported platform for cached media." };
  }
  await mediaCacheQueue;
  const { mediaCache = {} } = await chrome.storage.local.get({ mediaCache: {} });
  const wantedIds = Array.isArray(ids) ? new Set(ids.map(String)) : null;
  const wantedAccount = account ? cleanPart(account).toLowerCase() : null;
  const entries = Object.values(mediaCache).filter(
    entry =>
      entry.platform === platform &&
      (wantedIds
        ? wantedIds.has(entry.id) && ownerMatches(entry, wantedAccount)
        : Boolean(entry.owner) && ownerMatches(entry, wantedAccount))
  );
  const coveredIds = [...new Set(entries.map(entry => entry.id))];
  // What the cache held for this page, so a scan that saves nothing can say why.
  const diag = cacheDiagnostics(mediaCache, platform, wantedIds, wantedAccount, entries.length);
  const items = entries.map(entry => cachedMediaItem(entry, account));
  // A cache request must not wait for a download slot: the page's message channel can
  // close while a different tab is draining downloads. Read the persisted pending
  // set directly; the scan's drain step reconciles completed downloads before retrying.
  const { pendingDownloads = {} } = await chrome.storage.local.get({ pendingDownloads: {} });
  const { deferredDownloads = [] } = await chrome.storage.local.get({ deferredDownloads: [] });
  const queuedKeys = new Set([...queuedCachedKeys, ...deferredDownloads.map(item => item.key)]);
  const hasLimit = Number.isInteger(limit) && limit >= 0;
  const freshLimit = hasLimit ? limit : MAX_BATCH_ITEMS;
  const { selected, skipped, pending } = await selectCachedItems(items, pendingDownloads, freshLimit, queuedKeys);
  items.splice(0, items.length, ...selected);
  if (!items.length) {
    return { ok: true, started: 0, skipped, failed: 0, pending, errors: [], cached: 0, coveredIds, diag };
  }
  const reservedKeys = items.map(item => item.key);
  for (const key of reservedKeys) {
    queuedCachedKeys.add(key);
  }
  // Do not keep the page's message channel open behind unrelated download
  // reconciliation. The queue serializes the actual state change; reservations
  // prevent another page pass from enqueueing the same media first.
  const releaseReservations = () => {
    for (const key of reservedKeys) {
      queuedCachedKeys.delete(key);
    }
  };
  const operation = () => downloadBatch(items, { reconcile: false });
  if (inQueue) {
    try {
      const result = await operation();
      return { ...result, skipped: result.skipped + skipped, cached: items.length, coveredIds, diag };
    } finally {
      releaseReservations();
    }
  }
  const queued = queueBatch(operation);
  let timeoutId;
  const result = await Promise.race([
    queued,
    new Promise(resolve => {
      timeoutId = setTimeout(() => resolve(null), 100);
    })
  ]);
  clearTimeout(timeoutId);
  if (result) {
    releaseReservations();
    return { ...result, skipped: result.skipped + skipped, cached: items.length, coveredIds, diag };
  }
  void queued.then(releaseReservations, releaseReservations);
  return {
    ok: true,
    deferred: true,
    started: 0,
    queued: items.length,
    skipped,
    failed: 0,
    pending: items.length,
    errors: [],
    cached: items.length,
    coveredIds,
    diag
  };
}

async function selectCachedItems(items, pendingDownloads, freshLimit, queuedKeys = new Set()) {
  const selected = [];
  let skipped = 0;
  let pending = 0;
  let freshCount = 0;
  for (let offset = 0; offset < items.length; offset += 100) {
    const batch = items.slice(offset, offset + 100);
    const savedKeys = await ledgerHasAny(batch.map(item => item.key));
    for (const item of batch) {
      if (savedKeys.has(item.key)) {
        skipped++;
      } else if (Object.hasOwn(pendingDownloads, item.key) || queuedKeys.has(item.key)) {
        pending++;
      } else if (freshCount < freshLimit) {
        selected.push(item);
        freshCount++;
      }
    }
    if (freshCount >= freshLimit) {
      break;
    }
  }
  return { selected, skipped, pending };
}
