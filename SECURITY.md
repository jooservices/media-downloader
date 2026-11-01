# Security Policy

## Supported versions

| Version line                    | Status                                      |
| ------------------------------- | ------------------------------------------- |
| `1.5.x` (this repository)       | Current supported — receives security fixes |
| Older, pre-repository snapshots | Not supported                               |

## Reporting a vulnerability

**Do not open public GitHub issues for suspected vulnerabilities.**

Preferred: GitHub [private vulnerability reporting](https://github.com/jooservices/media-downloader/security/advisories/new) (Security Advisories).

Alternatively, email [admin@jooservices.com](mailto:admin@jooservices.com) with:

- a clear summary of the issue
- affected version(s) / commit
- impact and expected risk
- reproduction details or proof of concept when available

If you are unsure whether something is security-related, contact us privately first rather than opening a public issue.

## What happens next

1. We acknowledge the report as soon as possible.
2. We investigate and validate, keeping you informed of progress.
3. Fixes land in the supported line with a coordinated disclosure; you are credited unless you prefer otherwise.

No guaranteed SLA is offered; handling time depends on severity, exploitability, and release risk.

## Scope

This policy covers repository-managed behavior, including:

- the extension's content scripts, page-world hook and service worker
- the loopback bridge between the extension and the CLI (host and origin checks, job id handling)
- file-name and path building for downloads (path traversal, reserved names)
- the local job and ledger storage
- dependency and CI/security-workflow configuration that affects users or repository integrity

The extension never sends cookies, tokens or media to a server of its own; reports that contradict this are in scope.

Automated scanning runs on every change and on schedule:

- `npm audit` and OSV Scanner (dependency vulnerabilities)
- Gitleaks (secrets)
- Semgrep OSS (JavaScript SAST)
- CodeQL (JavaScript and GitHub Actions workflows)
- Dependency Review (on pull requests)
- Trivy filesystem scan (on release tags)
- OpenSSF Scorecard and zizmor (workflow supply-chain audit)
- SBOM generation on release tags

## Non-security issues

Bugs, feature requests, questions, and documentation improvements belong in [GitHub Issues](https://github.com/jooservices/media-downloader/issues).
