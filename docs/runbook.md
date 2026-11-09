# Operations runbook

This runbook covers the optional CLI queue and its browser-owned mode. The browser must have an active platform login; this service cannot refresh platform sessions. Keep the host awake and its download destination writable. The browser-owned setup supports Chrome/Edge on Windows, macOS, and Linux on the CPU architectures for which Node.js and the browser are available. The container image targets amd64 and arm64.

## Install

### Windows, macOS, or Linux

1. Install Node.js 22.13 or newer and a supported Chromium browser (Chrome or Edge). On Linux, install the browser's OS libraries as well.
2. Check out or extract this project to a permanent directory. From that directory run `npm ci` only when installing from source; runtime has no npm package dependencies.
3. Set the queue data directory (`PMS_DATA_DIR`) and download directory (`PMS_DOWNLOAD_DIR`) in the environment before installing the service if the defaults are not suitable. `service install` saves these two values into its generated launcher/unit/plist and uses them for the immediate start too. The download directory must be writable by the account that runs the queue. For a NAS, mount it before starting the queue and use its mounted path. If either variable is unset, that setting uses its normal default.
4. Create and sign in to the queue-owned browser profile:

   ```sh
   node cli/mediasaver.mjs browser setup
   node cli/mediasaver.mjs browser login
   ```

   Complete sign-in in the browser window for each platform, then close it. The profile and extension are stored under the queue data directory. Sign-in is required again when a platform expires the session. `browser status` checks whether the managed browser is running.

5. Start the queue with `node cli/mediasaver.mjs serve`. Add a profile from another terminal with `node cli/mediasaver.mjs add https://www.instagram.com/example/`; inspect it with `node cli/mediasaver.mjs status`.

For container install, use the repository's `docker-compose.yml`:

```sh
docker compose build
docker compose up -d
docker compose ps
```

The service stores queue state in `./data`, downloads media under `./media`, and publishes the API only on host loopback. The API also listens on the Compose network so a Prometheus container in the same Compose network can scrape it; requests there require the API token. The login service and queue use the same browser profile, so only one may run at a time. For first sign-in, run:

```sh
docker compose stop media-downloader
docker compose --profile login up -d login
# Connect a VNC client to 127.0.0.1:5900 and finish sign-in.
docker compose stop login
docker compose up -d media-downloader
```

Wait for the login container to become ready before connecting. Do not start the queue until the login container is stopped.

## Run as a service

Run as the same non-root desktop account that owns the browser profile and can write the media destination. `node cli/mediasaver.mjs service install` installs the platform's user-level start-at-login entry and starts the queue. The installer persists `PMS_DATA_DIR` and `PMS_DOWNLOAD_DIR` from its environment. Set them before running `service install`, and rerun install after changing either value. `node cli/mediasaver.mjs service remove` removes the entry.

### Linux systemd user service

The installer writes `~/.config/systemd/user/page-media-saver.service` and enables it. For a machine that must start the user service at boot without an interactive login, enable lingering for that account:

```sh
sudo loginctl enable-linger "$USER"
systemctl --user status page-media-saver.service
systemctl --user restart page-media-saver.service
journalctl --user -u page-media-saver.service -f
```

The unit uses `Restart=on-failure` and a 10-second restart delay. Remove it with `node cli/mediasaver.mjs service remove`.

Check that configured values were persisted with `systemctl --user cat page-media-saver.service`; the unit contains `Environment=` lines for each configured directory. Confirm the loaded unit matches with `systemctl --user show page-media-saver.service -p Environment`.

### macOS launchd

The installer writes `~/Library/LaunchAgents/dev.jooservices.page-media-saver.plist` and loads it in the current user's GUI domain. Check or restart it with:

```sh
launchctl print "gui/$(id -u)/dev.jooservices.page-media-saver"
launchctl kickstart -k "gui/$(id -u)/dev.jooservices.page-media-saver"
```

Keep the user session available for the owned browser. Remove it with `node cli/mediasaver.mjs service remove`.

Inspect the persisted values with `plutil -p ~/Library/LaunchAgents/dev.jooservices.page-media-saver.plist`; they appear under `EnvironmentVariables`. Confirm the agent is loaded with the `launchctl print` command above.

### Windows Task Scheduler or Startup

`node cli/mediasaver.mjs service install` writes a hidden launcher to the current user's Startup folder. For a Task Scheduler entry, create an **At log on** task for the account that owns the browser profile. Set **Run only when user is logged on**, **Start in** to the project directory, and the action to `node.exe` with arguments `"C:\path\to\media-downloader\cli\mediasaver.mjs" serve`. This allows the browser to open in the signed-in desktop session. A Session 0 Windows service is not supported because it cannot use that desktop browser. Remove the Startup entry using `node cli/mediasaver.mjs service remove`, or delete the scheduled task in Task Scheduler.

The generated Startup VBS launcher writes configured directory values into the child process environment. Inspect `%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\PageMediaSaver.vbs` to verify them. A manually created Task Scheduler action does not use that launcher: use a `.cmd` launcher that sets both variables before invoking Node, and point the task action at that file. For example:

```bat
@echo off
set "PMS_DATA_DIR=C:\PageMediaSaver"
set "PMS_DOWNLOAD_DIR=\\nas01\media"
"C:\Program Files\nodejs\node.exe" "C:\path\to\media-downloader\cli\mediasaver.mjs" serve
```

Verify the task action path and confirm the service is writing under the expected data directory.

## Upgrade and rollback

1. Record the current release/commit and check `node cli/mediasaver.mjs status`. Stop `serve` through the service manager (Linux/macOS `service remove` unloads it; on Windows, stop the running task/process as well as unregistering its startup entry).
2. Back up the data and media folders as described below.
3. Install the new release in a separate versioned project directory, or update the existing checkout to the chosen release. Source installs run `npm ci`. Keep the same `PMS_DATA_DIR` and `PMS_DOWNLOAD_DIR` values.
4. Start the queue with `node cli/mediasaver.mjs serve` or reinstall the service. In browser-owned mode, run `node cli/mediasaver.mjs browser setup` after upgrading so the managed profile receives the release's extension, then restart the service. `browser login` is needed only if the platform session has expired.
5. Check `/v1/health`, `/v1/status`, logs, and a controlled test job before returning the service to normal traffic.

To roll back, stop the service, reinstall the previous application version and its matching extension with `browser setup`, then restore the matching data backup if the newer version changed the queue schema or the old version cannot read it. Keep the backup untouched until the rollback has been verified. Never run two queue versions against the same SQLite database at once.

## Backup and restore

The default data directory is `%LOCALAPPDATA%\PageMediaSaver` on Windows and `~/PageMediaSaver` on macOS/Linux; `PMS_DATA_DIR` overrides it. It contains `queue.db` (SQLite queue), `config.json`, `api-token`, browser profile metadata/profile data, watch and inbox files, and logs. Media is separate, in the browser download destination or `PMS_DOWNLOAD_DIR`.

For a consistent backup, stop `serve` first so SQLite has closed and checkpointed its database. Copy the entire data directory, including `queue.db`, `config.json`, `api-token`, and managed browser profile, plus the media destination. Protect the backup: `api-token` grants API access, and the browser profile contains the user's sign-in session. Do not put either in source control or an unsecured shared folder.

To restore, stop the service, restore the complete data directory and media destination to the same paths, verify ownership and write access, then start the same application version. If moving to a different host, rerun `browser setup` and `browser login` on that host rather than relying on a copied browser session. The API token is restored with the data folder; rotate it by stopping the service, replacing `api-token` with a new random token, and restarting.

## Logs and health endpoints

- Queue log files: `<PMS_DATA_DIR>/logs/serve-YYYY-MM-DD.log`; the queue also writes to stdout/stderr. Old logs are pruned by the running queue.
- systemd: `journalctl --user -u page-media-saver.service`; macOS: inspect the launch agent and process output; Windows: inspect Task Scheduler history or run `serve` in a terminal for live output.
- Docker: `docker compose logs -f media-downloader`.
- `GET /v1/health` is an unauthenticated liveness check. `GET /v1/status` and `GET /v1/metrics` require `Authorization: Bearer <api-token>`; the token is in `<PMS_DATA_DIR>/api-token` (in Compose, `./data/api-token`). The health check proves the API responds, not that the extension is connected or a platform session is valid.

For the Compose deployment, place Prometheus on the same Compose network as `media-downloader`; the API listens on that private network, requires its bearer token, and accepts the service DNS Host header. The host port remains published only on loopback. Mount `./data/api-token` read-only into the Prometheus container as `/run/secrets/media-downloader-api-token`, with file permissions restricted to the Prometheus process. Configure this scrape job:

```yaml
scrape_configs:
  - job_name: media-downloader
    metrics_path: /v1/metrics
    static_configs:
      - targets: ["media-downloader:38542"]
    authorization:
      type: Bearer
      credentials_file: /run/secrets/media-downloader-api-token
```

The scrape target and Host allowlist are configured together in `docker-compose.yml` (`PMS_API_ALLOWED_HOSTS` includes `media-downloader:38542`). Do not publish port 38542 on a non-loopback host interface. For Prometheus on a different host, use a TLS authenticated reverse proxy over a private network and set its exact `host:port` in `PMS_API_ALLOWED_HOSTS`; retain bearer-token auth and restrict the firewall to the scraper.

Load [`../deploy/prometheus-alerts.yml`](../deploy/prometheus-alerts.yml) as a Prometheus rule file. Import [`../deploy/grafana-dashboard.json`](../deploy/grafana-dashboard.json) into Grafana and select the Prometheus datasource. Configure authenticated TLS or a private trusted network before exposing the API beyond loopback.

## Troubleshooting decision tree

Start with `node cli/mediasaver.mjs status`, the latest queue log, `node cli/mediasaver.mjs browser status`, and `GET /v1/health`. Keep URLs and logs private; never paste tokens or session data into an incident.

```text
Is GET /v1/health failing?
├─ Yes -> Is the queue process/service running?
│  ├─ No -> inspect service logs and restart once; resolve startup/config/permission errors first.
│  └─ Yes -> check bind address, API port, process errors, and local firewall.
└─ No -> Is the job still "Automatic download starting" after 90 seconds?
   ├─ Yes -> extension connected? -> no: follow Extension not connected.
   │         connected? -> no: follow Extension out of date.
   │         current? -> check browser login, then browser ownership/headless startup and logs.
   └─ No -> Did the scan finish with 0 media found?
      ├─ Yes -> confirm visible media exists and the profile URL/account is correct; see 0 media found.
      └─ No -> Is the destination a NAS/UNC path?
         ├─ Yes -> follow NAS/UNC unavailable; verify mount/credentials and write access as service user.
         └─ No -> check free space, destination permissions, and native download completion.
```

### Extension not connected

1. Check the `extension` field in `/v1/status` and `pms_extension_seen_timestamp_seconds` in `/v1/metrics`. A zero timestamp means the service has not received a report yet; an old timestamp means reports stopped.
2. Confirm the queue-owned browser is running (`browser status`) and that its profile has Page Media Saver enabled. In a regular browser setup, confirm the extension is loaded and enabled in the same browser/profile the CLI uses.
3. Restart the browser-owned profile with `node cli/mediasaver.mjs browser setup` and restart the queue. Check whether the heartbeat timestamp advances.

### Extension out of date

If the popup or job says it must reload/update, close the queue-owned browser, run `node cli/mediasaver.mjs browser setup` from the intended release, then restart the queue and browser. In a manually loaded browser, load the release's unpacked extension (or install its updated package) and reload it from the browser extension page. Verify a fresh extension report in `/v1/status`.

### Platform login expired

The API health check can remain green while a platform login has expired. Stop the queue service first so it closes the managed browser and releases its profile. Run `node cli/mediasaver.mjs browser login`, sign in to the affected platform in the queue-owned browser, close the login window, then restart the queue service and retry the failed job with `node cli/mediasaver.mjs add <profile-url> --again`. Never run `browser login` alongside a queue process using that profile. Do not copy cookies or passwords into config or logs.

### Bridge port in use

The extension bridge uses `PMS_BRIDGE_PORT` (default 38541) and the REST API uses `PMS_API_PORT` (default 38542). A startup message saying a port is already in use usually means another queue process is running. Check for a duplicate service/manual `serve` process and stop the duplicate. If another application owns that port, choose an unused port consistently in the queue environment and restart the extension/browser profile as needed. Do not start two queue processes against one data directory.

### Job stuck at “Automatic download starting”

This message means the extension has not acknowledged the opened job. Allow the documented 90-second acknowledgement window, then check extension heartbeat, extension version, browser status, and browser-owned profile startup in that order. If those are healthy, inspect queue logs and close/reopen the managed browser before retrying the job. Avoid repeatedly adding duplicates; use `--again` after confirming the previous attempt is terminal or paused.

### 0 media found

Confirm the URL is a supported profile/post and the signed-in account can view it. Check that the profile actually exposes media to the current session and that the browser page finished loading. Automatic profile scans can only collect media exposed by the current page; some platform video grids require opening a video tile. If no eligible media is visible or the platform offers no download action, zero is an expected result. Retry after verifying the correct account and URL.

### NAS or UNC download directory unavailable

The queue process must see the destination under its own identity. On Windows, mapped drive letters are often absent to a scheduled task; use a UNC path such as `\\nas01\media` and grant the task account share and filesystem write permissions. On macOS/Linux, mount the share before the user service starts and use the mounted path. Test creating and deleting a harmless file as the service account, verify free space, then restart the queue. Do not put NAS passwords in `config.json`; use the OS's credential store/mount mechanism.

## Incident checklist

1. Record UTC start time, impact, affected job IDs/platforms, last successful job, API health, extension last-seen time, and recent deploy/config changes.
2. Preserve the relevant queue logs and `/v1/status` output; redact profile URLs and all tokens/session data before sharing.
3. Check host health, service restart history, disk space, SQLite/data directory write access, media destination availability, browser process, extension heartbeat/version, and platform login state.
4. Contain duplicate workers or repeated retries; keep one queue process per data directory. Pause or stop the queue if it is corrupting state or overwhelming a destination.
5. Restore service by fixing the identified dependency, restarting once, and verifying health, fresh extension heartbeat, and one controlled job.
6. If state or media was lost, restore the latest consistent backup with the queue stopped. Confirm restored data and destination permissions before resuming.
7. Record recovery time, root cause, affected output, backup/rollback actions, and follow-up prevention work.
