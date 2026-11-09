# REST API and MCP security

## Threat model

The optional CLI queue exposes a local HTTP REST API and an MCP adapter that talks to that API. The API can start browser jobs, cancel jobs, and change the watch list. The primary trust boundary is the local operating-system user: processes that can read the queue's data directory can read the bearer token and control the API. The bridge between the browser extension and CLI is a separate loopback service and is not the REST API.

The API is designed to resist accidental exposure to websites and other local network clients. It does not protect against a compromised account, malware running as the same OS user, or a malicious administrator. MCP stdio is intended to be launched by a trusted local MCP client; anyone who can invoke that process as the same user can exercise the token's API permissions.

## Checked and changed

- Bearer tokens are compared with `timingSafeEqual` after checking equal byte lengths. API calls other than `GET /v1/health` require the token.
- `api-token` is generated from 256 random bits. On POSIX systems, it is created and repaired to mode `0600`. Windows permissions inherit from the per-user data directory and depend on that directory's ACL.
- `node cli/mediasaver.mjs api-token rotate` atomically replaces the token without displaying it. Restart `serve` or its installed service after rotation, and have clients reread the token file.
- The API applies a per-remote-address fixed-window limit of 120 requests per minute and returns `429` with `Retry-After`. This is an in-memory limit and resets when the process restarts.
- JSON request bodies are limited to 8 KiB, require `application/json`, must be JSON objects, and reject unsupported fields or invalid field types. Job and watch URLs are parsed by the shared URL rules and restricted to recognized Instagram, Facebook, X, or TikTok profile and supported post URLs. Their length is capped at 2,048 characters. The API does not fetch the supplied URL itself.
- Job-list query parameters are allow-listed, validated, and may not be repeated. Watch path segments are decoded safely and constrained to supported platform names and bounded account identifiers.
- The server checks `Host`, rejects requests carrying `Origin`, sends no CORS headers, and does not answer cross-origin preflights. It binds to `127.0.0.1` by default. The health route remains token-free but is subject to the same host, origin, and rate checks.
- API errors use `application/problem+json`. Unexpected backend errors return a generic 500 detail instead of exposing file paths, stack traces, or backend messages. The MCP adapter forwards API problem details and keeps protocol output on stdout.
- `downloadDir` is a local configuration setting, not an API input. It must be an absolute path; drive roots, Windows system folders, null bytes, and explicit `.`/`..` segments are rejected. The configured directory is user-controlled and must be trusted.

## Remote binding

Remote binding is an explicit opt-in through `PMS_API_HOST` and requires a token. Set `PMS_API_ALLOWED_HOSTS` to the exact `Host` header values that a trusted client or reverse proxy will send. The API itself speaks plain HTTP and does not provide TLS. Keep it bound to loopback and put a TLS-terminating reverse proxy in front of it when remote access is needed; restrict proxy access, preserve the expected Host header, and do not expose the upstream listener. If binding the API directly to a network interface, provide TLS outside this process and use network firewall rules as an additional boundary. A bearer token sent over plain HTTP can be observed or replayed by anyone able to inspect that network traffic.

## Residual risks

- The rate limiter is process-local, uses the socket peer address, and is not a distributed denial-of-service control. A local process can consume the allowance shared by other local callers.
- Host and Origin checks do not authenticate clients. The bearer token remains the API credential, and a same-user process that can read it can use it.
- HTTPS URL validation restricts the platform hostname and accepted path shape, but the browser later visits that platform and resolves its DNS. Compromised platform DNS, browser extensions, or platform content are outside this API's SSRF boundary.
- The API has no built-in TLS. Remote deployments need a correctly configured TLS proxy or equivalent network termination.
- On Windows, Node's POSIX mode bits do not establish a restrictive ACL. Keep `%LOCALAPPDATA%\PageMediaSaver` private to the signed-in user.
- The MCP server reads the token from the local data directory and sends it to loopback. Protect the MCP client configuration and the local account that runs it.
