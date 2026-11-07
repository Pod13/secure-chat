# Operations

Operational controls required by the constitution (IX, XII). Anything here that is not yet enforced by tooling is a launch blocker tracked in `tasks.md`.

## Production access (break-glass)

- No standing human access to production data stores.
- Access is granted per incident through a break-glass procedure: a named approver, a time limit of at most 4 hours, and a recorded reason.
- Every access is logged to the tamper-evident audit log and raises an alert to the security lead.
- Review all break-glass use within 24 hours of the event.

## CI and build

- CI credentials are least-privilege and short-lived; workflows default to `contents: read`.
- GitHub Actions are pinned to full commit SHAs.
- Release builds run on isolated, ephemeral runners with no access to production secrets. Signing keys live in an HSM and are never on developer machines or in CI variables.
- Each release produces an SBOM (`build/sbom.sh`) and a provenance attestation.

## Data hygiene

- Production data is never copied to development or test environments. Tests use generated data only.
- Secrets live in a secrets manager and are never in code, configuration files, images or environment dumps.
- Logs, metrics and traces contain no content, keys, tokens or full IP addresses.

## Platform notes

- The client is a PWA (ADR 0001), so mobile certificate pinning does not apply. Transport security relies on TLS 1.3 only plus HSTS with preload.

## Later (not blocking v1)

- Warrant canary (Constitution XI, SHOULD).
- Bug bounty once the first audit is complete.
- Annual independent audit, and an audit before any major cryptographic change.

## Serving the web app

Whatever serves the built files (`build/out/web`) MUST send the same policy as an HTTP header, because a `<meta>` policy cannot carry `frame-ancestors`:

- `Content-Security-Policy`: the value of `CSP` in `web/vite.security.ts`, plus `; frame-ancestors 'none'`.
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`.
- `Cache-Control: no-cache` for `index.html`, `sw.js` and `manifest.json`; long-lived `immutable` for `assets/*` (their names carry a content hash).
- Publish `manifest.json` last, after every file it lists is in place.
