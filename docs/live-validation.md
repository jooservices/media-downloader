# Facebook and TikTok live validation

Date: 2026-11-10  
Branch: `fix/live-fb-tiktok`  
Deployed Edge copy: `C:\Claude\PageMediaSaver`, version `0.5.35`

The live matrix submitted five Facebook accounts and five TikTok accounts from the supplied account list. The queue returned terminal job states, but the latest runs could not verify every account: Edge intermittently reported `No SW`, and Facebook/TikTok cache requests timed out while the page data hook continued reading profile responses. Edge was restarted while idle, the extension copy was synchronized, and a final one-account-at-a-time attempt reproduced the timeout. The final report separates verified completed job counts from jobs stopped before a completed result.

## Facebook

| Account          | Pages | New files verified | Skipped | Failed | Result                                                                                                      |
| ---------------- | ----: | -----------------: | ------: | -----: | ----------------------------------------------------------------------------------------------------------- |
| `thaonhu0502`    |     4 |                  8 |       0 |      0 | Two feed pages completed with 3 and 5 page-data files. Later pages timed out waiting for the cache handler. |
| `na.haru.492758` |     4 |                  0 |       0 |      0 | Not verified; Edge did not acknowledge several queued pages (`No SW`).                                      |
| `pehuyen.huyen`  |     4 |                  0 |       0 |      0 | Completed; four end checks found no older rows and no pending or failed files.                              |
| `oanhta1611`     |     4 |                  0 |       0 |      0 | Not verified; the cache request timed out before a completed account result.                                |
| `TieuHyOfficial` |     4 |                  0 |       0 |      0 | Not verified; Edge did not acknowledge the queued pages (`No SW`).                                          |

## TikTok

| Account        | Pages | New files verified | Skipped | Failed | Result                                                                                                                    |
| -------------- | ----: | -----------------: | ------: | -----: | ------------------------------------------------------------------------------------------------------------------------- |
| `unnie.93newg` |     1 |                116 |       0 |      0 | Completed probe saved 116 page-data files; the site no longer serves 545 other items. Later reruns hit the cache timeout. |
| `nasa`         |     1 |                  0 |       0 |      0 | Completed; 62 items were no longer served by the site, with no pending or failed files.                                   |
| `natgeo`       |     1 |                  0 |       0 |      0 | Not verified in the final run; repeated cache timeouts prevented a completed result.                                      |
| `nba`          |     1 |                  0 |       0 |      0 | Not verified; Edge did not acknowledge the queued page (`No SW`).                                                         |
| `redbull`      |     1 |                  0 |       0 |      0 | Not verified; Edge did not acknowledge the queued page (`No SW`).                                                         |

Counts above are from completed job summaries. A zero for a page stopped before completion means zero files were verified in its job record, not that the account has no media. The live queue process predates the repository's page-data counter changes, so its REST matrix summary omitted some video counters; completed job messages were used for these counts.

## Limits and follow-up

- Facebook profile scans cover the feed, photos, reels, and videos tabs. Facebook Stories are not exposed by the current profile parser.
- TikTok profile scans save the largest video rendition and photo slides delivered by the page. TikTok Stories are not exposed by the current profile parser.
- The site may stop serving older media; those items are reported as unavailable rather than failed.
- A human needs to reload the unpacked Page Media Saver extension in Edge, then rerun the five accounts marked “Not verified.” The managed queue reported `No SW` even after the `.35` sync and an idle Edge restart. No passwords or CAPTCHAs were entered.

## Verification

`npm run ci` passed: 720 tests; 98.84% statements and lines, 95.65% branches, and 98.75% functions. `node tools/sync-edge.mjs` deployed version `0.5.35` to the unpacked Edge extension copy.
