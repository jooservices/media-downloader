# Contributing

Thank you for considering a contribution to `jooservices/media-downloader`.

## Requirements

- Node.js `>= 22.4` (see `.nvmrc`) and npm
- Microsoft Edge (or another Chromium browser) to try the extension by hand
- Windows for the CLI's Edge integration (`install`, `download`, `resume`, `repair-root`); everything else, including the whole test suite, runs on Linux and macOS

## Setup

```bash
make install   # npm ci; installs the git hooks
make ci        # validate + lint + tests with coverage
```

Git hooks are installed by `simple-git-hooks` (`npm run prepare`): `commit-msg` runs commitlint, `pre-commit` runs the linters, `pre-push` runs the tests.

**Never bypass hooks with `--no-verify`.**

## Git workflow

- `master` — production; receives only approved release and hotfix merges
- `develop` — integration branch for normal work
- create `feature/*`, `fix/*`, `chore/*` branches from the latest `develop`, then open the PR back into `develop`
- releases: cut `release/<version>` from `develop`, stabilize, PR into `master`, tag `v<version>` from `master`, merge `master` back into `develop`
- hotfixes: `hotfix/*` from `master`, merged back into both `master` and `develop`
- never commit directly to `develop` or `master`; every change arrives via PR with green checks

## Commit convention

Conventional Commits are enforced in three places:

- locally by the `commit-msg` hook (commitlint)
- on every commit in a PR by `commitlint.yml`
- on PR titles by `semantic-pr.yml` (the subject must start with an uppercase letter)

```text
feat(instagram): Save every photo of a carousel
fix(ledger): Keep keys written by older versions
docs(readme): Document the CLI limit flags
```

Rules: imperative mood, uppercase first letter of the subject, no trailing period.

## Quality gates

Run the relevant gates before every push. CI runs the same chain and **every job is required**:

| Command              | Purpose                                                            |
| -------------------- | ------------------------------------------------------------------ |
| `make validate`      | Manifest is MV3, matches `package.json`, and references real files |
| `make lint`          | ESLint (strict, with SonarJS rules), Prettier, Markdown link check |
| `make test`          | Unit and integration tests (`node --test`)                         |
| `make test-coverage` | Tests with c8 coverage; fails below the thresholds in `.c8rc.json` |
| `make build`         | Packages the extension into `build/media-downloader-<version>.zip` |
| `make audit`         | `npm audit` at `high`                                              |
| `make ci`            | validate + lint + coverage (local CI parity)                       |

Coding rules:

- ESLint runs with `--max-warnings 0`; fix the source instead of suppressing a finding
- `lib/` is shared by the page, the service worker and Node, so keep it free of browser-only and Node-only APIs
- the extension's scripts are classic scripts that share one global scope; a new top-level name in `src/background/` becomes visible to the other files there
- keep changes consistent with SOLID, DRY, KISS and YAGNI; avoid unrelated refactors

## Testing expectations

- every behavior change ships with tests; a bug fix ships with a regression test
- parser tests use responses captured from the real sites (`tests/fixtures/`, see its README), not invented ones
- coverage must stay above the floor in `.c8rc.json`; raise the floor when coverage rises, never lower it

## Pull requests

A good PR explains:

- **what** changed
- **why** the change is needed
- **how** it was tested (include command output or test names)

Also target `develop`, keep the diff focused, and make sure every required CI check is green.

## Reporting issues

- bugs and feature requests: [GitHub Issues](https://github.com/jooservices/media-downloader/issues)
- **security vulnerabilities: never in public issues** — follow [SECURITY.md](SECURITY.md)

## AI-assisted contributors

AI and agent-assisted contributions must follow [AGENTS.md](AGENTS.md): inspect the real repository state before changing anything, stop and ask when requirements conflict, and run the same quality gates as human contributors.

## License

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
