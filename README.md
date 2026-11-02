# jooservices/media-downloader

[![CI](https://github.com/jooservices/media-downloader/actions/workflows/ci-post-merge.yml/badge.svg?branch=develop)](https://github.com/jooservices/media-downloader/actions/workflows/ci-post-merge.yml)
[![CodeQL](https://github.com/jooservices/media-downloader/actions/workflows/codeql.yml/badge.svg?branch=develop)](https://github.com/jooservices/media-downloader/actions/workflows/codeql.yml)
[![Coverage (develop)](https://codecov.io/gh/jooservices/media-downloader/branch/develop/graph/badge.svg)](https://codecov.io/gh/jooservices/media-downloader/branch/develop)
[![Quality Gate](https://sonarcloud.io/api/project_badges/measure?project=jooservices_media-downloader&metric=alert_status)](https://sonarcloud.io/summary/new_code?id=jooservices_media-downloader)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/jooservices/media-downloader/badge)](https://securityscorecards.dev/viewer/?uri=github.com/jooservices/media-downloader)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-339933.svg?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Manifest V3](https://img.shields.io/badge/Chrome%20Extension-Manifest%20V3-4285F4.svg?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/intro/)
[![GitHub Release](https://img.shields.io/github/v/release/jooservices/media-downloader?display_name=tag)](https://github.com/jooservices/media-downloader/releases)
[![Code style: Prettier](https://img.shields.io/badge/code%20style-prettier-ff69b4.svg)](https://prettier.io/)
[![Linted with ESLint](https://img.shields.io/badge/linted%20with-ESLint-4B32C3.svg?logo=eslint&logoColor=white)](https://eslint.org/)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-FE5196.svg?logo=conventionalcommits&logoColor=white)](https://www.conventionalcommits.org/)
[![Dependabot](https://img.shields.io/badge/Dependabot-enabled-025E8C.svg?logo=dependabot&logoColor=white)](.github/dependabot.yml)
[![Last commit](https://img.shields.io/github/last-commit/jooservices/media-downloader/develop)](https://github.com/jooservices/media-downloader/commits/develop)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Page Media Saver: a Manifest V3 Edge/Chromium extension and a local Windows CLI that save the full-size photos and videos of Instagram, Facebook and X pages you are signed in to, without sending anything to a server.

## Features

- Photos and videos from profile grids, timelines, posts and reels on X, Instagram and Facebook.
- Largest rendition only (never a thumbnail), named with its real pixel size.
- No duplicates: a local ledger remembers what was saved, whichever account folder it was found under.
- A CLI with `--limit N` (default 10) and `--unlimited`, resumable jobs and a loopback-only bridge to the extension.

## Requirements

- Microsoft Edge or another Chromium browser (Manifest V3)
- Node.js `>= 22` for the CLI and for development
- Windows for the CLI's Edge integration; the tests and the other tools run anywhere

## Development

```bash
npm ci
npm run ci        # validate + lint + tests with coverage
npm run build     # build/media-downloader-<version>.zip
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the git flow, commit convention and quality gates, and [WORKFLOWS.md](WORKFLOWS.md) for the CI/CD pipeline.

A Manifest V3 Edge extension and local CLI for saving photos exposed by the page while signed in, plus videos when the platform offers its own download action. It uses page DOM and Edge's download manager; it does not use AI or send collected media to a server.

## Install in Microsoft Edge

1. Download `media-downloader-<version>.zip` from the [latest release](https://github.com/jooservices/media-downloader/releases/latest) (or run `npm run build`) and extract it to a permanent folder.
2. Open `edge://extensions`.
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose the extracted folder. Allow the extension to access Instagram, Facebook, and X when Edge asks.
5. In PowerShell, from the extracted folder, run `node .\cli\mediasaver.mjs install`. This records the loaded extension ID and signed-in Edge profile for the current Windows user; it does not need administrator access.
6. Run `node .\cli\mediasaver.mjs download <profile-or-post-URL>`. The CLI opens the URL in the existing Edge profile and runs a local bridge on `127.0.0.1:38541`. The extension accepts bridge requests only from its configured extension origin. It scrolls Instagram/Facebook grids and X profile timelines, including X's `/media` tab; a direct Instagram post/reel, Facebook video/reel, or X status URL is scanned once. It saves visible photos and eligible video downloads, skips duplicates, limits concurrent downloads, retries interrupted image downloads up to three times, and waits for native video downloads to settle. You can switch to another Edge tab while the job runs. Keep the CLI process open until the job completes. Use `node .\cli\mediasaver.mjs status` to check progress and `node .\cli\mediasaver.mjs resume` to reconnect to a queued or interrupted job.

To repair known image files that landed directly in the Downloads root, create `%LOCALAPPDATA%\PageMediaSaver\repair-root-manifest.json` with a `jobs` array. Each job has `url`, `platform`, `account`, and `files`; each file has its root-level `basename` and absolute `rootPath`. Run `node .\cli\mediasaver.mjs repair-root`. The extension matches those source filenames on the corresponding profile grid, downloads the largest rendition exposed there, and overwrites the account-folder target. The CLI removes a root file only after all targets for that account are found and each destination file is nonempty and newer than the repair job. If any target is missing or fails, all original root files for that account are retained.

On X, Instagram, and Facebook, the extension can scan a profile/timeline through the CLI or **Download currently loaded media** in the popup. A direct Instagram post/reel, Facebook video/reel, or X status URL runs a one-page scan; the CLI resolves the account from the loaded page. It opens a visible post's options and clicks only a recognized platform download action. It routes the resulting browser download to the matching account folder, tracks completion, skips already-saved post IDs, and retries an interrupted native download when the post is scanned again. Automatic profile scanning processes video players exposed in the page DOM; Instagram and Facebook profile grids do not always load video players until a video tile is opened.

X's Help Center says video downloads are available only on certain posts and that an uploader can disable them; videos posted before July 25, 2023 are not downloadable through this control. The extension uses X's **Download video** item when it appears. [X video download guidance](https://help.x.com/en/using-x/x-videos)

Instagram and Facebook expose video download controls only for eligible content and account contexts. Facebook also documents downloading your own Live videos from the full-screen player's menu, and Meta Accounts Center provides a data export/transfer route for your own Facebook and Instagram media. If a post/player has no platform download action, it is skipped. [Facebook Live video download guidance](https://about.fb.com/news/2025/02/updating-our-facebook-live-video-storage-policy/), [Meta Accounts Center data tools](https://about.fb.com/news/2023/10/manage-your-information-across-apps/)

The extension popup reports the local CLI bridge status, and the CLI reports a clear error if Edge does not acknowledge a job within 90 seconds. The local bridge binds to loopback only and checks both the request host and extension origin. Remove the bridge configuration with `node .\cli\mediasaver.mjs uninstall`.

## Running a queue

`download` handles one URL and then exits. To work through many profiles unattended, use the queue:

```powershell
node .\cli\mediasaver.mjs serve                 # keep running; stop with Ctrl+C
node .\cli\mediasaver.mjs add <url> [<url>...]  # from another window, at any time
```

`serve` also reads an inbox file once a few seconds, one profile URL per line (default `%LOCALAPPDATA%\PageMediaSaver\inbox.txt`, or `serve --inbox <file>`). Pasting a link with tracking parameters (`?e=…&g=5`) is fine. A profile that has already run, even one that failed, is not queued again; use `add <url> --again` to run it anew.

Each job is retried a few times when Edge does not answer or the page is closed (`maxAttempts`). Jobs left running by a crashed or stopped `serve` are recovered when it starts again. While `serve` is running, `download <url>` hands its URL to the queue instead of competing for the bridge. `status` shows every job and its state. Logs are written to `%LOCALAPPDATA%\PageMediaSaver\logs\`.

`serve` keeps going only while the computer is awake, Edge is available and you are still signed in to the sites.

## Configuration

`serve` creates `%LOCALAPPDATA%\PageMediaSaver\config.json` with the defaults the first time it runs. It is read again every pass, so changes apply without a restart; a file with a mistake is reported and the previous settings stay in use.

```json
{
  "workers": { "x": 1, "instagram": 1, "facebook": 1 },
  "delaySeconds": { "min": 15, "max": 60 },
  "maxAttempts": 3,
  "downloadDir": "D:\\Media"
}
```

| Setting        | Meaning                                                                                                                                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workers`      | How many pages each site may scan at once (1 to 8, default 1). X, Instagram and Facebook run side by side regardless; this only sets the number **per site**.                                                  |
| `delaySeconds` | A random pause (between `min` and `max`) before the next account on the same site is opened.                                                                                                                   |
| `maxAttempts`  | How many times a job that failed for a transient reason is tried (1 to 20).                                                                                                                                    |
| `downloadDir`  | Where finished files go, as `<downloadDir>\<Site>\<account>\`. A full path, local or a network share. Leave it out to keep files in the browser's Downloads folder. Cannot be a drive root or a system folder. |

**Download location.** A browser extension can only save inside the browser's own Downloads folder, so the CLI moves finished files afterwards (in the background while `serve` runs, or once with `node .\cli\mediasaver.mjs move`). A file is copied, checked against the original's size and only then removed. An existing file is never overwritten: an identical one is treated as a duplicate and a different one gets a `(1)` suffix. Files still being written, and anything outside the `Instagram`, `Facebook` and `Twitter` folders, are not touched. If a site folder in Downloads is a link to another location, it is left as it is. `downloadDir` must not be, contain or sit inside the Downloads folder.

**More than one worker.** Sites decide for themselves what counts as unusual use, and running several scans against the same site from one account is a faster way to be rate-limited, asked to confirm your identity or blocked. The default of one worker per site, with a pause between accounts, is the cautious choice; raising it is your decision and your risk. Pages in background tabs are also slowed down by the browser, so extra workers do not scale linearly. Videos saved through a site's own download menu (the fallback for videos that never reach the page's data) use a single armed slot in the extension, so keep `workers` at 1 for a site if you rely on that path.

## Largest size only

Only the largest rendition is ever saved; a thumbnail is never a fallback.

- **X:** the photo URL is forced to `name=orig`.
- **Instagram:** the largest `image_versions2` candidate of each photo (a carousel's photos are numbered by their position, `<code>_02`, `<code>_05`, ...). A video's poster is not a photo. A profile grid carries only thumbnails, so the scan opens a few posts per pass to make Instagram load each post's own data.
- **Facebook:** the largest image the photo's data lists (`viewer_image`, up to 2048 px). The 206 px tiles in the photos tab are not used.

If the page's data does not list a full-size file for something, that item is skipped rather than saved small. The file name ends in the real pixel size (`_3072x4096`).

## Not downloading the same media twice

Every saved file is recorded in a ledger in the extension's IndexedDB (`src/background/ledger.js`), keyed by what the media is (`Platform|photo|<post id>|<n>` or `Platform|video|<post id>|<n>`, see `lib/keys.js`), not by the account folder it was found under. The same post reached through two accounts, or as a cached video and then through the platform's menu, is saved once. There is no size cap. Keys written by earlier versions are moved into the ledger the first time it is opened, so nothing already saved is downloaded again.

The ledger records what the extension saved, not what is still on disk: if you delete a file, the extension will not fetch it again. Uninstalling the extension clears the ledger. On a single post or reel page only that post's video is saved, even when the page links to related posts.

## Layout

```
lib/        shared rules, usable in the page, the service worker and Node
            platforms.js (hosts) · urls.js (profile/post URLs) · paths.js (file names) · settings.js (popup limit)
src/
  background/  service worker: download queue, video cache, menu videos, CLI bridge client
  content/     page scripts: page info, photo collectors, video sources, scan runner
  page/        runs in the page world: response parsers per platform, hook, bridge to the extension
  popup/       popup UI
cli/        mediasaver.mjs (entry) · args · jobs · bridge-server · edge · repair · status · store
tests/      node --test; fixtures/ holds real captured site responses
```

Run the tests with `npm test`; see [CONTRIBUTING.md](CONTRIBUTING.md) for the full quality gates.

Use **Stop automatic download** in the extension popup to pause a Facebook or Instagram run. The extension remembers successfully downloaded items so the same page can be scanned again without intentionally duplicating them. Interrupted downloads are retried up to three times and are reported separately from pending downloads. CLI jobs and their status are stored under `%LOCALAPPDATA%\PageMediaSaver` so they survive closing the CLI window.

## Destination

Files are placed under the browser's Downloads folder:

- `Instagram/<account>/...`
- `Facebook/<account>/...`
- `Twitter/<account>/...`

The extension chooses the largest image source exposed by the loaded page, checking both image `srcset` candidates and `<picture>` sources. On Instagram, this means the largest rendition the profile grid provides to the current session; Instagram may expose a larger rendition on the individual post page. The extension does not guess or rewrite private CDN URLs. X photos request the `name=orig` rendition where the image URL supports it.

For videos, the extension first uses the files the page already receives in its own data responses and in the JSON embedded in the page. A page-world hook (`media-network-hook.js`) reads those, and one parser per platform picks the best progressive MP4: `x-media-parser.js` (highest bitrate on `video.twimg.com`), `instagram-media-parser.js` (largest `video_versions` entry on Instagram's CDN) and `facebook-media-parser.js` (HD over SD `progressive_urls` on `fbcdn.net`). The background worker downloads each into `<Platform>/<account>/video_<id>.mp4`. No extra request is made to the platform's API and no cookies or tokens are read. Videos the cache does not cover fall back to clicking the platform's own download menu item when it is available. Facebook responses do not name the account, so Facebook and Instagram videos are matched by the post and video ids found in the page's own links.

A scan stops after it has started a limited number of files (photos and videos together; files already saved do not count, so running the same profile again continues with the next batch). The CLI stops after 10 files by default: use `--limit N` for another number or `--unlimited` for no limit. The popup has its own setting, a number (default 10) and an Unlimited checkbox, used only for scans started from the popup; the CLI never reads it. If the CLI is closed and not resumed within 45 seconds, the scan in Edge stops by itself. This path can save videos whose author turned off the download option, so use it only for your own content or content you have permission to save.

## Permissions and data

- `activeTab` and `scripting`: inspect and scroll pages when you start a download from the popup.
- `downloads`: write selected files and track completion.
- `storage`: remember item keys to avoid repeated downloads and route platform-provided video downloads into the account folder.
- `http://127.0.0.1/*`: communicate with the CLI's loopback-only bridge while a job is running.
- Instagram, Facebook, and X site access: inject the content script on profile/timeline pages opened by the CLI, without requiring a popup click.

No account password, cookie, or page contents are transmitted to an external service. Media bytes are downloaded by Edge from platform hosts after the page's supported download action runs.

## Notes

- Automatic scrolling is available on Facebook and Instagram grids and X profile timelines. Video capture requires a loaded video player with an eligible platform download action.
- Hidden Edge tabs can be throttled or temporarily frozen by the browser. The job state is saved and the page can resume when Edge wakes it; keep the profile tab open until the job reports completion.
- Only progressive MP4 files already present in the page's own responses are used; DASH and HLS streams, which keep audio and video apart, are skipped. Videos that never reach the page that way fall back to the platform's menu action, and are skipped when it is not offered. The extension does not call hidden endpoints itself or rewrite media URLs.
- The X API documents media variants, but requests require an authorized developer plan and do not replace the post's own download eligibility. Instagram's official API is scoped to professional accounts connected to the app; Meta's maintained [Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api) describes those limits. The extension does not use API media URLs to override post settings.
- Facebook downloads use the largest image URL currently exposed by the Photos page. Platform visibility and account access still determine what the page can show.
- A site may change its page layout, which can require updating the video player markers in `src/content/media-detection.js`, the photo selectors in `src/content/collectors.js`, or the response parsers in `src/page/`.

## Browser API references

- [Chrome Downloads API](https://developer.chrome.com/docs/extensions/reference/api/downloads)
- [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)
- [Chrome extension service workers](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers)
