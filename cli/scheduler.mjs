// Decides which waiting jobs may open their page now. Pure: it only looks at what it is given,
// so the rules (workers per site, pause between accounts) are easy to test.

const isOpen = job => job.status === "running" || (job.status === "queued" && Boolean(job.openedAt));

// `jobs` is every saved job; `lastOpenedAt` maps a site to the time (ms) its last page was opened.
// Returns the jobs to open now (oldest first) and the updated `lastOpenedAt`.
export function pickJobsToOpen({ jobs, config, now, lastOpenedAt = {}, random = Math.random }) {
  const busy = new Map();
  for (const job of jobs.filter(isOpen)) {
    busy.set(job.platform, (busy.get(job.platform) || 0) + 1);
  }
  const due = job => (job.notBefore ? Date.parse(job.notBefore) : 0) <= now;
  const waiting = jobs
    .filter(job => job.status === "queued" && !job.openedAt && due(job))
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  const picked = [];
  const opened = { ...lastOpenedAt };
  const { min, max } = config.delaySeconds;
  for (const job of waiting) {
    const running = busy.get(job.platform) || 0;
    const pause = (min + random() * (max - min)) * 1000;
    const tooSoon = opened[job.platform] !== undefined && now - opened[job.platform] < pause;
    if (running >= (config.workers[job.platform] ?? 1) || tooSoon) {
      continue;
    }
    picked.push(job);
    busy.set(job.platform, running + 1);
    opened[job.platform] = now;
  }
  return { picked, lastOpenedAt: opened };
}
