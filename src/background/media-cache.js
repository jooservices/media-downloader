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

// `ids` (post or media ids read from the page's own links) selects entries on
// pages where the cached owner is unknown; without them only entries whose
// cached owner matches `account` are saved, so unrelated feed media never lands
// in the wrong folder.
async function downloadCachedMedia({ platform, account, ids, limit }) {
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
        ? wantedIds.has(entry.id)
        : Boolean(entry.owner) && (!wantedAccount || entry.owner.toLowerCase() === wantedAccount))
  );
  const coveredIds = [...new Set(entries.map(entry => entry.id))];
  const items = entries.map(entry => cachedMediaItem(entry, account));
  // Items already saved or pending are skipped by downloadBatch, so only they may
  // use the allowance: trim to the not-yet-started ones before applying `limit`.
  if (Number.isInteger(limit) && limit >= 0) {
    const { pendingDownloads = {} } = await chrome.storage.local.get({ pendingDownloads: {} });
    const fresh = [];
    for (const item of items) {
      if (fresh.length >= limit) {
        break;
      }
      if (!Object.hasOwn(pendingDownloads, item.key) && !(await ledgerHas(item.key))) {
        fresh.push(item);
      }
    }
    items.splice(0, items.length, ...fresh);
  }
  if (!items.length) {
    return { ok: true, started: 0, skipped: 0, failed: 0, pending: 0, errors: [], cached: 0, coveredIds };
  }
  return { ...(await downloadBatch(items)), cached: items.length, coveredIds };
}
