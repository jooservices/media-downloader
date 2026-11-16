# Releasing

Releases need the owner's explicit approval (see [GOVERNANCE.md](../GOVERNANCE.md)); nobody tags or merges into `master` without it. The tag drives everything after that: [release.yml](../.github/workflows/release.yml) validates, lints, tests with the coverage floor, builds the extension zip, scans, writes the SBOM and creates the GitHub Release.

## 1. Pre-flight on `develop`

All of these must pass on the commit that will ship:

| Check                                                | Command                                                                  | Passes when                                                                                                                  |
| ---------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Validate, lint, unit and integration tests, coverage | `npm run ci`                                                             | exit 0; coverage at or above the floor (90%)                                                                                 |
| End to end (real browser, extension, queue, API)     | `npm run test:e2e`                                                       | every test passes                                                                                                            |
| Soak (hours, forced crashes)                         | `npm run soak -- 120 3 15`                                               | summary has `stuckOrFailed: []`, `restarts` equal to the kills, and flat memory (last-third average within 10% of the first) |
| Container                                            | `docker build -t media-downloader .` then start it and call `/v1/health` | health answers `ok`                                                                                                          |
| Dependencies                                         | `npm run audit`                                                          | no high or critical findings                                                                                                 |
| Required GitHub checks                               | the PR into `develop`                                                    | all green                                                                                                                    |

## 2. Prepare the version

1. Cut `release/<version>` from `develop`.
2. Set the same version in `manifest.json` and `package.json`. The release workflow refuses a tag that differs from `manifest.json`.
3. In `CHANGELOG.md`, rename `[Unreleased]` to `[<version>] - <date>` and start a new empty `[Unreleased]`.
4. Open a PR from `release/<version>` into `master`. Fix anything found there on the release branch, not on `develop`.

## 3. Ship (owner only)

1. Merge the PR into `master`.
2. Tag the merge commit `v<version>` and push the tag. The workflow refuses a tag that is not on `origin/master`.
3. Check the GitHub Release: the zip, the SBOM and the notes are there, and the zip loads as an unpacked extension.
4. Merge `master` back into `develop`.

## 4. After the release

- Update the machine that runs the queue as described in the [runbook](runbook.md): stop `serve`, install the release, run `browser setup`, start `serve`, and confirm a fresh extension report in `/v1/status`.
- Watch `GET /v1/status` and `/v1/metrics` for a day: `failuresByReason` should stay at zero for links whose newest job finished.

## Roll back

Releases are tags, so rolling back means shipping again: revert on `release/<version+1>` or `hotfix/<version+1>`, repeat sections 2 and 3, and install that release on the queue machine. Never move or delete a published tag.
