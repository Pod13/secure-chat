# Research: Secure Real-Time Chat

Each entry: Decision, Rationale, Alternatives considered. Items marked **verify** rest on my existing knowledge and have not been checked against live sources in this session; the spike tasks confirm them before implementation depends on them.

## R1. Client framework: Vite + React SPA, not Next.js

- **Decision**: Vite + React + TypeScript, built to static, content-hashed assets.
- **Rationale**: The client must run with no server involvement in rendering. Constitution VII needs a CSP with no `unsafe-inline`, SRI, a pinned manifest and reproducible builds. Next.js adds server rendering and server actions, which we must never use for user data, and its static export still emits inline bootstrap scripts that need per-build CSP hashes. It also adds a much larger dependency tree against IX. Vite output is plain hashed files, easy to pin and reproduce.
- **Alternatives**: Next.js `output: 'export'` (viable fallback, costs above); SvelteKit static (smaller output, but the team preference is React); a hand-rolled bundler setup (more build code to audit).

## R2. One protocol for everything: MLS, including 1:1

- **Decision**: Use MLS (RFC 9420) for 1:1 and Group Conversations; a 1:1 is a two-member group.
- **Rationale**: libsignal's JavaScript package is a Node native addon and, to my knowledge, has no supported browser build (**verify**). Using it in a PWA would mean porting it ourselves, which breaks "no custom crypto". MLS gives forward secrecy and post-compromise security, efficient re-keying at 256 Members, and one code path to audit. This supersedes the Signal-for-1:1 note in [plan-inputs.md](plan-inputs.md).
- **Alternatives**: libsignal for 1:1 plus MLS for Groups (two protocols, browser gap); Sender Keys (weaker post-compromise security).
- **Spike T-spike-1**: confirm OpenMLS builds to WASM, runs in the supported browsers, and meets the 5 s re-key target at 256 Members. Fallback library: mls-rs.
- **Roadmap**: post-quantum hybrid ciphersuite once the chosen library supports one (Constitution III).

## R3. Client integrity

- **Decision**: Content-hashed assets, a signed manifest, a service worker that refuses assets not in the manifest, CSP `default-src 'none'` with explicit self-only sources, SRI, Trusted Types, HSTS preload.
- **Rationale**: Only practical way to detect a swapped client. Residual risk: the very first visit trusts the server, and the service worker could be replaced by a compromised first load. Mitigations: publish manifest hash out of band (the whitepaper and transparency page), offer a verification page that compares served hashes to the published signed manifest, and add a browser extension verifier later.
- **Alternatives**: Signed web bundles / isolated web apps (not broadly supported); native apps (deferred by ADR 0001).

## R4. Local key storage on web

- **Decision**: A random data key encrypts every IndexedDB record (XChaCha20-Poly1305 via libsodium). The data key is wrapped by an Argon2id key derived from the passcode. WebAuthn is deferred: it adds a second unlock path and browser-specific behaviour to the most sensitive code. The wrapping uses non-extractable WebCrypto keys at runtime.
- **Rationale**: Matches Constitution V. Browsers have no Secure Enclave access, so passcode strength is the main protection; the app enforces a minimum passcode length and Argon2id parameters tuned to about 500 ms on a mid-range phone.
- **Alternatives**: WebAuthn PRF unlock (deferred, see above); storing keys only in a non-extractable WebCrypto key without a passcode (protects against file copy but not against a device user); platform keystores (native apps only).

## R5. Server stack

- **Decision**: Rust with axum/tokio, PostgreSQL for the queue and records, S3-compatible storage for blobs.
- **Rationale**: Memory-safe (X), mature async runtime for 10,000 WebSockets, and PostgreSQL gives transactional delete-on-delivery. Disk, database and object storage are encrypted at rest with KMS-held keys.
- **Alternatives**: Redis queues (persistence and backup retention are harder to bound); Node server (acceptable language, but less guarantee on memory safety in native deps).

## R6. Device authentication and sessions

- **Decision**: Each Device holds an Ed25519 key. It authenticates with a server nonce signed by that key and receives a short-lived token (15 minutes) bound to the Device. Unlinking deletes the Device record, which invalidates the token at once.
- **Rationale**: Constitution Security Requirements: device-held keys, no passwords to the server.

## R7. Sealed sender and abuse control

- **Decision**: When two Accounts become Contacts, each side gives the other a random delivery token inside an encrypted message. A sender presents the recipient's token to the server; the server maps the token to a recipient Device queue without learning who sent it. Rate limits apply per token and per recipient, plus per-IP limits on unauthenticated endpoints. Revoking a token is how a block is enforced server-side.
- **Rationale**: FR-031a and FR-074 without content or sender identity. Residual leak: the server sees the recipient and timing (documented in the threat model).
- **Alternatives**: Full sender identification (leaks the social graph); anonymous credentials such as Privacy Pass (stronger, deferred).

## R8. Dependency list and justification

| Dependency | Where | Why |
|------------|-------|-----|
| OpenMLS (WASM) | crypto-wasm | MLS implementation (III) |
| libsodium | web | Argon2id and XChaCha20-Poly1305 (III) |
| React, Vite | web | UI and build; kept minimal, pinned |
| axum, tokio, sqlx | server | HTTP/WebSocket and database access |
| serde + JSON Schema validator | server, web | strict input validation (X) |
| Playwright, Vitest, proptest, cargo-fuzz | dev only | tests required by X |

All pinned to exact versions with lockfile hashes, scanned in CI. No analytics, crash reporters or third-party fonts.

## R9. What a fully compromised server can learn or do

- **Learns**: Account IDs and creation dates, Device public keys, last-connection time, recipient Device and timing of each delivery, ciphertext sizes (bucketed), Backup blob existence and size, truncated IP addresses for up to 7 days.
- **Cannot learn**: message content, attachment content, Group names and membership (kept in encrypted MLS state), usernames, Contact lists, Safety Codes, Recovery Keys.
- **Can do**: drop, delay or replay messages (replay is rejected by MLS), refuse service, serve a malicious client to a first-time visitor (R3), withhold a Device's removal from the directory (Safety Code checks mitigate), correlate traffic timing.
- **Cannot do**: add a Device or key silently (new Devices need approval from an existing Device and trigger contact warnings).

## R10. Push

- **Decision**: Web Push with an empty payload. Registration reveals to the push provider only that a given browser subscription exists. The service worker wakes, fetches ciphertext, decrypts locally, and shows either a generic notification or an opted-in preview.
- **Rationale**: FR-027. Notification timing is visible to the push provider and cannot be hidden.
- **Verify**: iOS wake-ups may be throttled; the install guide sets expectations.

## R11. Message size padding

- **Decision**: Pad ciphertext to fixed buckets (256 B, 1 KiB, 4 KiB, 16 KiB, then 64 KiB multiples) before MLS encryption; attachments are padded to buckets of 64 KiB multiples up to the limit.

## R12. Simplicity rules (Constitution XIII)

- **Decision**: Keep three deployable units and one schema package; no further services. Security-critical logic (`crypto-wasm/`, `server/src/auth/`, `web/src/store/`, `web/src/sw/`) is written as deterministic functions with clock, randomness, storage and network injected through small ports (`server/src/ports.rs`, `web/src/ports.ts`), with in-memory fakes for tests. CI enforces cyclomatic complexity ≤ 10, ≤ 50 lines per function and ≤ 400 lines per file, 100% branch coverage on security-critical modules, and mutation testing (cargo-mutants, Stryker) on them.
- **Rationale**: Small deterministic modules are readable by an auditor and testable without mocking internals. Mutation testing shows the assertions are meaningful, not only that lines ran.
- **Simplifications taken**: passcode-only unlock (no WebAuthn); one protocol (MLS) for every Conversation (ADR 0002); one transport per direction (HTTP requests, one WebSocket for delivery); no cache layer, message broker or separate worker service (PostgreSQL holds the queue; expiry is a scheduled query).
- **Complexity kept, with justification**: the WASM MLS module (no audited browser alternative); sealed-sender delivery tokens (one table, one endpoint; they also carry block enforcement and rate limiting); the signed manifest plus pinning service worker (only way to detect a swapped web client).
- **Candidates to defer if the schedule needs cuts, none required by this plan**: voice notes, message edits, screenshot blocking, "block on key change" as a separate setting.
