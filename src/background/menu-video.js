// Videos saved through the platform's own download menu: the short-lived target
// the page arms, and the file name given to the browser download it triggers.
async function setNativeVideoTarget(rawTarget) {
  const platform = rawTarget?.platform;
  const account = cleanPart(rawTarget?.account);
  const key = String(rawTarget?.key || "");
  const filename = cleanPart(rawTarget?.filename || "video.mp4", "video.mp4");
  if (!["Instagram", "Facebook", "Twitter"].includes(platform) || !key) {
    return { ok: false, error: "The official video-download target is incomplete." };
  }

  const state = await reconcileDownloads();
  if (await ledgerHas(key)) return { ok: true, skip: true, reason: "already-saved" };
  if (state.nativeTarget?.key === key) return { ok: true, skip: true, reason: "already-armed" };
  if (Object.values(state.nativePending).some(entry => entry?.key === key)
    || Object.entries(state.pendingItems).some(([pendingKey, item]) => pendingKey === key || item?.key === key)) {
    return { ok: true, skip: true, reason: "already-pending" };
  }

  const attempts = Number(state.nativeAttempts[key] || 0);
  if (attempts >= MAX_ATTEMPTS) return { ok: true, skip: true, reason: "retry-limit" };
  if (state.nativeTarget?.key && state.nativeTarget.key !== key) {
    state.nativeFailures[state.nativeTarget.key] = {
      platform: state.nativeTarget.platform,
      account: state.nativeTarget.account,
      error: "The site did not start the previous official video download."
    };
  }
  state.nativeAttempts[key] = attempts + 1;
  delete state.nativeFailures[key];
  state.nativeTarget = {
    platform,
    account,
    key,
    filename,
    width: Number(rawTarget?.width) || 0,
    height: Number(rawTarget?.height) || 0,
    sourceOrigin: (() => { try { return new URL(rawTarget?.sourceUrl).origin; } catch { return ""; } })(),
    expiresAt: Date.now() + 30000
  };
  await writeDownloadState(state);
  return { ok: true, armed: true };
}

function isNativeVideoDownload(item) {
  const extension = String(item.filename || "").split(/[\\/]/).pop().match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return /^video\//i.test(String(item.mime || ""))
    || ["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp"].includes(extension);
}

function nativeDownloadHostAllowed(platform, item) {
  const hosts = [];
  for (const candidate of [item.url, item.referrer]) {
    try { hosts.push(new URL(candidate).hostname); } catch { /* ignore empty/opaque candidates */ }
  }
  return hosts.some(host => platforms.isPlatformDomain(platform, host));
}

// Native platform menu actions start a browser download. Route only a video
// download that matches the short-lived target armed by the content script.
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId === chrome.runtime.id) {
    takeDownloadTarget(item.url).then(target => {
      if (typeof target === "string") suggest({ filename: target, conflictAction: "uniquify" });
      else if (target?.filename) suggest({ filename: target.filename, conflictAction: target.conflictAction || "uniquify" });
      else suggest();
    }).catch(() => suggest());
    return true;
  }
  queueBatch(async () => {
    const state = await readDownloadState();
    const nativeVideoTarget = state.nativeTarget;
    if (!nativeVideoTarget || nativeVideoTarget.expiresAt < Date.now()
      || !isNativeVideoDownload(item) || !nativeDownloadHostAllowed(nativeVideoTarget.platform, item)) return null;
    if (nativeVideoTarget.sourceOrigin) {
      try {
        const referrerOrigin = new URL(item.referrer).origin;
        if (referrerOrigin !== nativeVideoTarget.sourceOrigin) return null;
      } catch { /* some platform downloads omit a referrer */ }
    }

    const extension = String(item.filename || "").split(/[\\/]/).pop().match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
    const allowedExtension = ["mp4", "mov", "m4v", "webm", "mkv", "avi", "3gp"].includes(extension) ? extension : "mp4";
    const targetStem = String(nativeVideoTarget.filename || `video_${item.id}.mp4`).replace(/\.[a-z0-9]+$/i, "");
    const filename = withResolution(
      `${cleanPart(targetStem, `video_${item.id}`)}.${allowedExtension}`,
      nativeVideoTarget.width,
      nativeVideoTarget.height
    );
    state.nativePending[String(item.id)] = {
      platform: nativeVideoTarget.platform,
      account: cleanPart(nativeVideoTarget.account),
      key: nativeVideoTarget.key,
      filename
    };
    state.nativeTarget = null;
    await writeDownloadState(state);
    return {
      filename: buildSavePath(nativeVideoTarget.platform, cleanPart(nativeVideoTarget.account), filename),
      conflictAction: "uniquify"
    };
  }).then(target => {
    if (target) suggest(target);
    else suggest();
  }).catch(() => suggest());
  return true;
});
