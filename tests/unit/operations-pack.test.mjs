import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = relative => readFile(path.join(ROOT, relative), "utf8");

test("runbook covers installation, service lifecycle, recovery, troubleshooting, and incidents", async () => {
  const runbook = await read("docs/runbook.md");
  for (const required of [
    "Windows, macOS, or Linux",
    "systemd user service",
    "macOS launchd",
    "Windows Task Scheduler",
    "Upgrade and rollback",
    "Backup and restore",
    "queue.db",
    "serve-YYYY-MM-DD.log",
    "Extension not connected",
    "Extension out of date",
    "Platform login expired",
    "Bridge port in use",
    "Job stuck at",
    "0 media found",
    "NAS or UNC download directory unavailable",
    "\\\\nas01\\media",
    "installer persists `PMS_DATA_DIR`",
    "systemctl --user show page-media-saver.service -p Environment",
    "EnvironmentVariables",
    "PageMediaSaver.vbs",
    "docker compose stop media-downloader",
    "docker compose stop login",
    "Never run `browser login` alongside a queue process",
    "Incident checklist"
  ]) {
    assert.ok(runbook.includes(required), `runbook should include ${required}`);
  }
});

test("observability parsers reject malformed YAML and JSON", () => {
  assert.throws(() => parse("groups: [unfinished"));
  assert.throws(() => JSON.parse('{"panels": ['));
});

test("Prometheus rules and Grafana dashboard are valid and use exposed metrics", async () => {
  const rules = parse(await read("deploy/prometheus-alerts.yml"));
  const dashboard = JSON.parse(await read("deploy/grafana-dashboard.json"));
  assert.equal(rules.groups[0].name, "media-downloader");
  assert.ok(rules.groups[0].rules.length >= 3);
  assert.equal(dashboard.title, "Page Media Saver Operations");

  const metricsSource = await read("cli/api.mjs");
  const exposed = ["pms_jobs", "pms_extension_seen_timestamp_seconds", "pms_uptime_seconds"];
  const alertText = JSON.stringify(rules);
  const dashboardText = JSON.stringify(dashboard);
  for (const metric of exposed) {
    assert.ok(metricsSource.includes(metric), `API exposes ${metric}`);
    assert.ok(alertText.includes(metric) || dashboardText.includes(metric), `assets use ${metric}`);
  }
  for (const panel of dashboard.panels) {
    assert.match(panel.targets[0].expr, /pms_jobs|pms_extension_seen_timestamp_seconds|pms_uptime_seconds|up\{/);
  }
});

test("Compose healthcheck calls the API's real unauthenticated health route", async () => {
  const compose = parse(await read("docker-compose.yml"));
  const service = compose.services["media-downloader"];
  const check = compose.services["media-downloader"].healthcheck;
  assert.deepEqual(check.test.slice(0, 3), ["CMD", "node", "-e"]);
  assert.ok(check.test[3].includes("/v1/health"));
  assert.equal(check.interval, "30s");

  const apiSource = await read("cli/api.mjs");
  assert.match(apiSource, /pattern: new RegExp\(`\^\$\{API_BASE\}\/health\$`\),\s*open: true/);
  assert.equal(service.environment.PMS_API_HOST, "0.0.0.0");
  assert.ok(service.environment.PMS_API_ALLOWED_HOSTS.split(",").includes("media-downloader:38542"));
  assert.equal(service.ports[0], "127.0.0.1:38542:38542");
  const runbook = await read("docs/runbook.md");
  assert.ok(runbook.includes('targets: ["media-downloader:38542"]'));
  assert.ok(runbook.includes("credentials_file: /run/secrets/media-downloader-api-token"));
});
