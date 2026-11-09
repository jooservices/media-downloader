// Tells you when a scan brings new files or runs into trouble, by posting to one URL (ntfy, Discord, Telegram
// bridges, Home Assistant and the like). A job is announced once; a trouble message for one site is repeated
// at most every few hours, so an expired sign-in does not become hundreds of messages.
const COOLDOWN_MS = 6 * 60 * 60 * 1000;

const filesOf = job => Number(job.started || 0) + Number(job.videoStarted || 0);

// "new-content" for a finished scan that saved something; "problem" for one that stopped short; otherwise nothing.
export function classify(job) {
  if (job.status === "complete") {
    return filesOf(job) > 0 ? "new-content" : null;
  }
  if (job.status === "incomplete" || (job.status === "error" && !job.noRetry)) {
    return "problem";
  }
  return null;
}

export function describe(kind, job) {
  const who = `${job.platform}/${job.account}`;
  if (kind === "new-content") {
    return { title: `New from ${who}`, text: `${filesOf(job)} new file(s) saved.` };
  }
  return { title: `Problem with ${who}`, text: String(job.message || "The scan did not finish.").slice(0, 300) };
}

export async function sendNotification(notify, kind, job, { fetchImpl = fetch, now = () => new Date() } = {}) {
  const { title, text } = describe(kind, job);
  const common = { method: "POST", signal: AbortSignal.timeout(10_000) };
  const request =
    notify.format === "text"
      ? { ...common, headers: { "Content-Type": "text/plain; charset=utf-8", Title: title }, body: text }
      : {
          ...common,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            event: kind,
            title,
            text,
            platform: job.platform,
            account: job.account,
            url: job.url,
            files: filesOf(job),
            jobId: job.jobId,
            at: now().toISOString()
          })
        };
  const response = await fetchImpl(notify.url, request);
  if (!response.ok) {
    throw new Error(`The notification address answered HTTP ${response.status}.`);
  }
}

export function createNotifier({
  loadConfig,
  changedSince,
  markNotified,
  fetchImpl = fetch,
  now = () => new Date(),
  log = () => {},
  cooldownMs = COOLDOWN_MS
}) {
  const since = now().toISOString();
  const lastProblem = new Map();

  async function announce(notify, job) {
    const kind = classify(job);
    if (!kind || !notify.events.includes(kind)) {
      return;
    }
    if (kind === "problem") {
      const last = lastProblem.get(job.platform);
      if (last !== undefined && now().getTime() - last < cooldownMs) {
        return;
      }
      lastProblem.set(job.platform, now().getTime());
    }
    try {
      await sendNotification(notify, kind, job, { fetchImpl, now });
    } catch (error) {
      log(`Could not send a notification: ${error?.message || error}`);
    }
  }

  return {
    async tick() {
      const config = await loadConfig().catch(() => null);
      if (!config?.notify) {
        return;
      }
      for (const job of changedSince(since)) {
        if (job.notifiedAt || !["complete", "incomplete", "error"].includes(job.status)) {
          continue;
        }
        await markNotified(job.jobId);
        await announce(config.notify, job);
      }
    }
  };
}
