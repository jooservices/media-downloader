# Queue operations and recovery

## Shutdown and restart

`serve` handles Ctrl+C (`SIGINT`), `SIGTERM`, and Windows Ctrl+Break (`SIGBREAK`). It stops accepting new bridge and REST connections, finishes the current queue pass, marks every still-running job `incomplete` with automatic retry disabled in bounded batches, closes the servers, and closes SQLite. Shutdown read or write failures are reported and cause a nonzero stop instead of being treated as clean. Jobs not acknowledged by the extension remain queued and are eligible to run after restart.

After an unclean process exit, a job that was `running` is changed to `incomplete` and marked `noRetry`. The extension may have saved files immediately before the process died, so the queue leaves the job visible for review instead of replaying a possibly active scan. Use `add <url> --again` when you have checked that a retry is appropriate. This favours at-most-once execution for interrupted scans; a job is retained in SQLite and is never silently discarded.

Watched URLs follow the same review hold: a latest `incomplete` job marked `noRetry` is not automatically scanned again, even after the usual watch interval. After checking the interrupted scan, an explicit `--again` run can complete and resume normal watch scheduling.

An acknowledged page that stops reporting progress for more than 15 minutes is also parked as `incomplete` with automatic retry disabled. A page that never acknowledges within 90 seconds can be retried after the configured attempt backoff. The boundaries are strict: exactly 90 seconds or 15 minutes has not expired yet.

## SQLite health

The job store uses SQLite WAL mode, `synchronous=NORMAL`, a 1-second busy timeout, and short exponential retries for `SQLITE_BUSY` and `SQLITE_LOCKED` operations. On open, SQLite runs `PRAGMA integrity_check`. If the database is damaged, `serve` stops with an error naming a timestamped `queue.db.corrupt-….bak` copy (plus WAL sidecars when present); preserve that backup for recovery or diagnosis before replacing the database.

If importing a legacy `jobs/` folder fails because SQLite cannot save a job, startup fails and the import transaction rolls back. The source folder remains available so the failure can be diagnosed and the import retried after the database issue is fixed.

## Logs and retained jobs

`logs/serve-YYYY-MM-DD.log` is capped at 2 MiB. At most three size-rotated backups are kept for that day, and the existing daily retention removes logs older than 14 days. A single log message is capped at 2,000 characters. Finished job history is pruned hourly after 30 days, retaining the newest job for every URL and all active jobs.

The REST API and its request/response contract are unchanged. Its job listing reads only the requested page and gets the total from a SQLite count; an individual job lookup reads by ID. `status` and metrics also use SQLite counts rather than materializing job history. The supervisor works from a bounded 500-job queued window plus up to 500 running rows, and recovery and reaper scans read pages of 500. The bridge keeps at most 500 recent in-memory page claims; durable job state remains in SQLite.
