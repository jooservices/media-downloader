# Governance

## Project model

`jooservices/media-downloader` is an owner-driven project (benevolent-leader style). JOOservices maintains it; the project owner holds final decision authority.

## Roles

| Role                    | Holder                 | Responsibility                                                                       |
| ----------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| Owner / lead maintainer | Viet Vu (JOOservices)  | Roadmap, architecture decisions, release approval, access control, final arbitration |
| Maintainers             | Appointed by the owner | Review PRs, keep CI green, uphold the quality gates                                  |
| Contributors            | Everyone else          | Propose changes via issues and PRs following [CONTRIBUTING.md](CONTRIBUTING.md)      |

## Decision making

- Day-to-day changes merge through PR review against [CONTRIBUTING.md](CONTRIBUTING.md) rules
- Design changes and scope additions are decided by the owner after discussion in an issue or PR
- **Releases require explicit owner approval** — no tag or GitHub Release happens without it
- Support for a new platform, or a change to what the extension is allowed to save, is a scope decision for the owner

## Quality authority

The repository quality gates (strict ESLint with `--max-warnings 0`, Prettier, the c8 coverage floor in `.c8rc.json`, the required CI chain) may only be relaxed by the owner.

## Conduct enforcement

Code of Conduct reports go to [admin@jooservices.com](mailto:admin@jooservices.com) and are handled by the maintainers per the [Code of Conduct](CODE_OF_CONDUCT.md).

## Changes to this document

Amendments require owner approval via PR.
