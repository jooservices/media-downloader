// Videos saved through the platform's own download menu: the short-lived target
// the page arms, and the file name given to the browser download it triggers.
const VIDEO_EXTENSIONS = ["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp"];
const NATIVE_TARGET_LIFETIME_MS = 30000;

function fileExtension(filename) {
  const name = String(filename || "")
    .split(/[\\/]/)
    .pop();
  return name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
}

const originOf = url => {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
};

// Why arming this video would be pointless, or null when it should go ahead.
async function skipReason(state, key) {
  if (await ledgerHas(key)) {
    return "already-saved";
  }
  if (state.nativeTarget?.key === key) {
    return "already-armed";
  }
  const isPending =
    Object.values(state.nativePending).some(entry => entry?.key === key) ||
    Object.entries(state.pendingItems).some(([pendingKey, item]) => pendingKey === key || item?.key === key);
  if (isPending) {
    return "already-pending";
  }
  return Number(state.nativeAttempts[key] || 0) >= state.maxAttempts ? "retry-limit" : null;
}

// A target the site never answered counts as failed once another video is armed.
function failPreviousTarget(state, key) {
  const previous = state.nativeTarget;
  if (previous?.key && previous.key !== key) {
    state.nativeFailures[previous.key] = {
      platform: previous.platform,
      account: previous.account,
      error: "The site did not start the previous official video download."
    };
  }
}

async function setNativeVideoTarget(rawTarget) {
  const platform = rawTarget?.platform;
  const key = String(rawTarget?.key || "");
  if (!platforms.PLATFORMS.includes(platform) || !key) {
    return { ok: false, error: "The official video-download target is incomplete." };
  }

  const state = await reconcileDownloads();
  const reason = await skipReason(state, key);
  if (reason) {
    return { ok: true, skip: true, reason };
  }
  failPreviousTarget(state, key);
  state.nativeAttempts[key] = Number(state.nativeAttempts[key] || 0) + 1;
  delete state.nativeFailures[key];
  state.nativeTarget = {
    platform,
    account: cleanPart(rawTarget?.account),
    key,
    filename: cleanPart(rawTarget?.filename || "video.mp4", "video.mp4"),
    width: Number(rawTarget?.width) || 0,
    height: Number(rawTarget?.height) || 0,
    sourceOrigin: originOf(rawTarget?.sourceUrl),
    expiresAt: Date.now() + NATIVE_TARGET_LIFETIME_MS
  };
  await writeDownloadState(state);
  return { ok: true, armed: true };
}

function isNativeVideoDownload(item) {
  return /^video\//i.test(String(item.mime || "")) || VIDEO_EXTENSIONS.includes(fileExtension(item.filename));
}

function nativeDownloadHostAllowed(platform, item) {
  const hosts = [];
  for (const candidate of [item.url, item.referrer]) {
    try {
      hosts.push(new URL(candidate).hostname);
    } catch {
      /* ignore empty/opaque candidates */
    }
  }
  return hosts.some(host => platforms.isPlatformDomain(platform, host));
}

// Is this browser download the one the page armed: not expired, a video, from this platform, same origin?
function matchesArmedTarget(item, target) {
  if (!target || target.expiresAt < Date.now()) {
    return false;
  }
  if (!isNativeVideoDownload(item) || !nativeDownloadHostAllowed(target.platform, item)) {
    return false;
  }
  if (!target.sourceOrigin) {
    return true;
  }
  try {
    return new URL(item.referrer).origin === target.sourceOrigin;
  } catch {
    return true; // some platform downloads omit a referrer
  }
}

function nativeFilename(item, target) {
  const extension = fileExtension(item.filename);
  const allowedExtension = VIDEO_EXTENSIONS.includes(extension) ? extension : "mp4";
  const stem = String(target.filename || `video_${item.id}.mp4`).replace(/\.[a-z0-9]+$/i, "");
  const base = cleanPart(stem, `video_${item.id}`);
  return cleanPart(withResolution(`${base}.${allowedExtension}`, target.width, target.height), `video_${item.id}.mp4`);
}

// Claims the armed target for this download and names the file; null when it is not the one.
async function claimNativeDownload(item) {
  const state = await readDownloadState();
  const target = state.nativeTarget;
  if (!matchesArmedTarget(item, target)) {
    return null;
  }
  const account = cleanPart(target.account);
  const filename = nativeFilename(item, target);
  state.nativePending[String(item.id)] = { platform: target.platform, account, key: target.key, filename };
  state.nativeTarget = null;
  await writeDownloadState(state);
  return { filename: buildSavePath(target.platform, account, filename), conflictAction: "uniquify" };
}

// What the browser should be told for a download this extension started itself.
function suggestionFor(target) {
  if (typeof target === "string") {
    return { filename: target, conflictAction: "uniquify" };
  }
  if (target?.filename) {
    return { filename: target.filename, conflictAction: target.conflictAction || "uniquify" };
  }
  return null;
}

const answer = (suggest, suggestion) => (suggestion ? suggest(suggestion) : suggest());

// Native platform menu actions start a browser download. Route only a video
// download that matches the short-lived target armed by the content script.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  const pending =
    item.byExtensionId === chrome.runtime.id
      ? takeDownloadTarget(item.url).then(suggestionFor)
      : queueBatch(() => claimNativeDownload(item));
  pending.then(suggestion => answer(suggest, suggestion)).catch(() => suggest());
  return true;
});
