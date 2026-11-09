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
async function downloadCachedMedia({ platform, account, ids, limit }) {
  if (!platforms.PLATFORMS.includes(platform)) {
    return { ok: false, error: "Unsupported platform for cached media." };
  }
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
  const availableSlots = Math.max(0, MAX_ACTIVE_DOWNLOADS - Object.keys(pendingDownloads).length);
  const hasLimit = Number.isInteger(limit) && limit >= 0;
  const freshLimit = hasLimit ? Math.min(limit, availableSlots) : availableSlots;
  const selected = await selectCachedItems(items, pendingDownloads, hasLimit, freshLimit);
  items.splice(0, items.length, ...selected);
  if (!items.length) {
    return { ok: true, started: 0, skipped: 0, failed: 0, pending: 0, errors: [], cached: 0, coveredIds, diag };
  }
  return { ...(await downloadBatch(items)), cached: items.length, coveredIds, diag };
}

async function selectCachedItems(items, pendingDownloads, hasLimit, freshLimit) {
  const selected = [];
  let freshCount = 0;
  for (let offset = 0; offset < items.length; offset += 100) {
    const batch = items.slice(offset, offset + 100);
    const savedKeys = await ledgerHasAny(batch.map(item => item.key));
    for (const item of batch) {
      const alreadyStarted = Object.hasOwn(pendingDownloads, item.key) || savedKeys.has(item.key);
      if (alreadyStarted) {
        if (!hasLimit) {
          selected.push(item);
        }
      } else if (freshCount < freshLimit) {
        selected.push(item);
        freshCount++;
      }
    }
    if (hasLimit && freshCount >= freshLimit) {
      break;
    }
  }
  return selected;
}
