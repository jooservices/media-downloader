// Runs a list of accounts through the running queue's REST API and writes a report of what each one did.
// Usage: node tools/live-matrix.mjs <accounts.json> [report.md]
// accounts.json: { "Instagram": ["https://www.instagram.com/a/"], "Twitter": [...], ... }
// It only calls the API of the queue that is already running on this machine; it never opens a browser itself.
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FINISHED = new Set(["complete", "incomplete", "error", "paused"]);

export function summarize(jobs) {
  const rows = new Map();
  for (const job of jobs) {
    const key = `${job.platform}|${String(job.account).toLowerCase()}`;
    const row = rows.get(key) ?? {
      platform: job.platform,
      account: job.account,
      pages: 0,
      started: 0,
      skipped: 0,
      failed: 0,
      statuses: new Set(),
      notes: new Set()
    };
    row.pages++;
    row.started += job.counts?.started ?? 0;
    row.skipped += job.counts?.skipped ?? 0;
    row.failed += job.counts?.failed ?? 0;
    row.statuses.add(job.status);
    if (job.status !== "complete" && job.message) {
      row.notes.add(job.message.slice(0, 140));
    }
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.platform.localeCompare(b.platform) || a.account.localeCompare(b.account));
}

export function renderReport(rows, { startedAt, finishedAt, extensionVersion }) {
  const lines = [
    "# Live matrix",
    "",
    `Started ${startedAt}, finished ${finishedAt}. Extension in the browser reported version ${extensionVersion ?? "unknown"}.`,
    "",
    "| Site | Account | Pages | New files | Already saved | Failed | Result |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |"
  ];
  for (const row of rows) {
    const result = [...row.statuses].join(" + ");
    lines.push(
      `| ${row.platform} | ${row.account} | ${row.pages} | ${row.started} | ${row.skipped} | ${row.failed} | ${result} |`
    );
  }
  const notes = rows.filter(row => row.notes.size);
  if (notes.length) {
    lines.push("", "## Notes", "");
    for (const row of notes) {
      lines.push(`- ${row.platform}/${row.account}: ${[...row.notes].join(" / ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function runMatrix({
  accounts,
  api,
  sleep,
  now = () => new Date(),
  pollMs = 30_000,
  maxMs = 10 * 3600_000
}) {
  const startedAt = now().toISOString();
  const ids = [];
  for (const urls of Object.values(accounts)) {
    for (const url of urls) {
      const reply = await api.queue(url);
      ids.push(...(reply.items ?? []).map(item => item.id));
    }
  }
  const deadline = now().getTime() + maxMs;
  let jobs = [];
  while (now().getTime() < deadline) {
    jobs = await api.jobs(ids);
    if (jobs.length === ids.length && jobs.every(job => FINISHED.has(job.status))) {
      break;
    }
    await sleep(pollMs);
  }
  const status = await api.status();
  return {
    rows: summarize(jobs),
    startedAt,
    finishedAt: now().toISOString(),
    extensionVersion: status?.extension?.version ?? null,
    complete: jobs.length === ids.length && jobs.every(job => FINISHED.has(job.status))
  };
}

function localApi(port, token) {
  const base = `http://127.0.0.1:${port}/v1`;
  const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    queue: async url => {
      const response = await fetch(`${base}/jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ url, again: true })
      });
      return response.json();
    },
    jobs: async ids => {
      const all = [];
      for (let offset = 0; ; offset += 100) {
        const page = await (await fetch(`${base}/jobs?limit=100&offset=${offset}`, { headers })).json();
        all.push(...page.items);
        if (offset + 100 >= page.page.total) {
          break;
        }
      }
      return all.filter(job => ids.includes(job.id));
    },
    status: async () => (await fetch(`${base}/status`, { headers })).json()
  };
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const [accountsFile, reportFile = "live-matrix-report.md"] = process.argv.slice(2);
  if (!accountsFile) {
    throw new Error("Usage: node tools/live-matrix.mjs <accounts.json> [report.md]");
  }
  const accounts = JSON.parse(await readFile(accountsFile, "utf8"));
  const appDir = path.join(process.env.LOCALAPPDATA || os.homedir(), "PageMediaSaver");
  const token = (await readFile(path.join(appDir, "api-token"), "utf8")).trim();
  const api = localApi(Number(process.env.PMS_API_PORT) || 38542, token);
  const result = await runMatrix({ accounts, api, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
  await writeFile(reportFile, renderReport(result.rows, result));
  process.stdout.write(`${result.complete ? "Finished" : "Stopped early"}; report written to ${reportFile}\n`);
}
