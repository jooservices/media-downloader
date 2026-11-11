// Canary runs are queue entries: this helper has no scraper or browser interface.
export function queueCanaryAccounts(config, jobs, addUrls) {
  if (!config?.canary) {
    return { created: [], skipped: [] };
  }
  const activeUrls = new Set(
    jobs
      .filter(job => !["complete", "incomplete", "paused", "error"].includes(job.status))
      .map(job => job.url?.toLowerCase())
  );
  const accounts = config.canary.accounts.filter(url => !activeUrls.has(url.toLowerCase()));
  return accounts.length ? addUrls(accounts, { force: true, limit: config.limit }) : { created: [], skipped: [] };
}
