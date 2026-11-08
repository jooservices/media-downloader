# Changelog

All notable changes to this project are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- One profile link is the whole account. An Instagram profile opens its current stories and highlight reels as well as the grid. A Facebook profile is also scanned on its Photos, Reels and Videos tabs
- `watch` rescans the accounts in `%LOCALAPPDATA%\PageMediaSaver\watch.txt` every 6 hours (`watch add <url>` remembers them). Files already saved are skipped
- After a pass, the CLI reports the account folder and how many files were new versus already saved
- `npm run sync-edge` copies the extension and CLI into the unpacked Edge folder and bumps that copy's version so Edge can reload it
- The CLI runs on Windows, macOS and Linux with Edge, Chrome or Firefox. `install`, `install chrome` or `install firefox` remembers which profile has the extension loaded
- A site is one record in `lib/sites.js` (hosts, URL shapes, sign-in, download labels). The scanners look that record up instead of branching on the site name
- TikTok profiles (`/@name`) and single video or photo posts can be saved while you are signed in. The largest file the page lists is kept; cover images are not
- `service install` starts the queue at sign-in. While it runs, `POST http://127.0.0.1:38542/downloads` with `{"url":"https://..."}` queues that account. The API listens on loopback only
- Instagram stories: `/stories/<username>/` and `/stories/<username>/<id>/` can be scanned on their own. Only the largest photo or video the story data lists is saved
- A dashboard (the extension's options page, opened on first install and from the popup): paste profile links, see each profile's progress, pause, stop, retry or remove, and change workers per site, the pause between profiles, retries and files per profile. English and Vietnamese
- The extension runs its own download queue, so no Node.js or command line is needed for normal use
- Sign-in check before anything starts: the extension looks at the names of each site's session cookies and holds that site's queue with a clear message and a button to open its sign-in page; a sign-in wall met mid-run does the same and keeps the link. Needs the new `cookies` and `alarms` permissions (cookie values are never read)
- `serve` and `add` CLI commands: a queue that runs unattended. Profiles can be added at any time with `add <url>` or by listing them in an inbox file; `serve` works through them, retries transient failures and recovers jobs left by a crashed run
- Several jobs at once: `workers` in `config.json` sets how many pages each site (X, Instagram, Facebook) may scan in parallel (default 1), with a random `delaySeconds` pause between accounts on the same site
- `downloadDir` in `config.json` (also `move` command): finished files are moved from the browser's Downloads folder to a folder of your choice, including a network share. Files are copied and verified before the original is removed, never overwritten, and files still being written are left alone
- The extension tracks one CLI job per tab, so several tabs can run jobs at the same time
- The extension closes the tab a CLI job used once the job ends

### Fixed

- The packaged zip left out the scripts a page loads (`popup.js` was missing, so the popup did nothing in a packaged build); the packager now includes them
- X: promoted, suggested and reposted posts no longer land in the scanned account's folder (cached media, page photos and menu videos)
- Instagram: the page hook now reads `POST /api/graphql` responses (it only matched URLs ending in `/graphql/`), and posts addressed by 39-character codes are accepted
- Job files: a rename blocked for a moment by antivirus or an indexer (`EPERM`/`EBUSY`) is retried instead of failing the update, and concurrent updates to one job file are applied in order

### Changed

- `.nvmrc` moves to Node 26 (current LTS); `engines` stays `>=22`
- `status` lists every saved job with a count per state

## [0.5.0] - 2026-11-01

First release from this repository.

### Added

- GitHub repository with the JOOservices quality chain: strict ESLint (SonarJS), Prettier, commitlint, c8 coverage floor, manifest validation and extension packaging
- CI, post-merge CI, release, CodeQL, workflow audit, link check, OpenSSF Scorecard, stale, labeler and semantic PR title workflows
- README, WORKFLOWS, CONTRIBUTING, SECURITY, SUPPORT, GOVERNANCE, CODE_OF_CONDUCT and AGENTS documents

### Changed

- Source split into small modules (`lib/`, `src/background/`, `src/content/`, `src/page/`, `cli/`) and refactored to pass the strict lint rules without behavior changes
- Tests reorganised into `tests/unit` and `tests/integration`; page scripts run through `tests/helpers/run-script.mjs` so coverage is attributed to the real files

### Capture

- Photo and video capture for X, Instagram and Facebook from the data the pages already receive, with a per-platform parser for each
- A media cache in the service worker and a page-world hook feeding it
- An IndexedDB ledger so the same media is never saved twice, whichever account folder it was found under
- `--limit N` and `--unlimited` for the CLI (default 10), and a limit setting in the popup
- Real-site fixtures for the parsers

### Behavior

- Only the largest rendition of a photo is saved; thumbnails are never a fallback
- File names end in the real pixel size (`_WxH`) and live under `Downloads/<Site>/<profile>/`
- Job ids are validated before they reach a file path
