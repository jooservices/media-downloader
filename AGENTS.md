# jooservices/media-downloader

This file adds project-only rules.

- Node.js `>= 22.13`; no runtime dependencies (dev tooling only)
- Manifest V3 extension (`manifest.json`) plus a Node ESM CLI (`cli/`); `lib/` is shared by the page, the service worker and Node
- The extension's scripts are classic scripts sharing one global scope (`importScripts` in the worker, the manifest's script list in pages). ESLint learns each file's cross-file globals from `eslint.config.mjs`; a new top-level name in `src/background/` needs no extra config
- Lints run strict: ESLint with SonarJS rules at `--max-warnings 0`, Prettier; fix the source instead of suppressing
- Tests are `node --test`; page scripts are loaded into fake pages with `tests/helpers/run-script.mjs` so coverage is attributed to the real files; parser fixtures are captured from the real sites
- CI runs on GitHub-hosted `ubuntu-latest`; the CLI's Edge integration is Windows-only and is not exercised in CI
- Only the largest rendition of a photo is ever saved; never fall back to a thumbnail
- Never put cookies, tokens or media into logs, fixtures or issues
