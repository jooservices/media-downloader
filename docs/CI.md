# CI

The `CI` workflow in `.github/workflows/ci.yml` runs for every pull request, no matter which branch it targets, and for pushes to `develop` and `master`. It has no path filters, so changes to application code, tests, documentation, or workflows receive the same required quality checks.

Each new run cancels the older run for that pull request or branch. The workflow uses `pull_request`, which does not expose repository secrets to fork pull requests. Coverage thresholds and all ordinary CI jobs still run for forks; Codecov and SonarQube uploads are skipped for fork and bot pull requests. Dependency Review runs only for pull requests.

The existing job names are preserved for branch protection. The full gate includes manifest validation and packaging, ESLint, Prettier, documentation link checks, unit and integration coverage, E2E, container, each supported OS/CPU test job, security scans, and the combined coverage floor. The Windows-only Edge integration is not exercised on GitHub-hosted CI runners.

Workflow file changes also run the path-scoped workflow audit (`actionlint` and `zizmor`) on pull requests to any base branch and on pushes to `develop` or `master`.
