# Changelog

All notable changes to this project are documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
