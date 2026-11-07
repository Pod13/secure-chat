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
- **Spike result (T014, 2026-11-07)**: OpenMLS 0.9.2 builds to `wasm32-unknown-unknown` using its `js` feature plus `getrandom` 0.2 `js`. Run in Chromium 156, Firefox 157 and WebKit 27.2 (Playwright), a 256-member group re-keys (remove commit plus one member processing it) in 21.5 ms, 30 ms and 32 ms; native is 3.9 ms. The target is 5 s, so the margin is over 150x. Other timings at 256 members: key generation 35 to 46 ms, a single add commit for all 255 members 28 to 42 ms, joining from a Welcome 14 to 20 ms. The WASM is 1.85 MB after `wasm-opt`. Microsoft Edge was not run directly; it uses the same Chromium engine as the Chromium run. Edge is added to the CI browser matrix (task T011). Spike code: `spikes/openmls-wasm/`.
- **Ciphersuite**: MLS has no suite that pairs X25519/Ed25519 with AES-256-GCM or XChaCha20-Poly1305. The plan uses `MLS_128_DHKEMX25519_CHACHA20POLY1305_SHA256_Ed25519` (256-bit ChaCha20-Poly1305 keys, Ed25519 signatures). Constitution III should be clarified to permit the MLS-standard AEADs; the decision is pending with the security lead.
- **NIST-curve code is linked in**: the provider picks its algorithm at runtime, so `p256`/`p384` and their `crypto-bigint` dependency are in the WASM even though our suite never calls them. See `docs/accepted-risks.md`.
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

- **Decision**: When two Accounts become Contacts, each side gives the other a random delivery token inside an encrypted message. A sender presents the recipient's token to the server; the server maps the token to a recipient Device queue without learning who sent it. Rate limits apply per token and per recipient, plus per-IP limits on unauthenticated endpoints. The same token authorises anonymous key-package fetches (`POST /key-packages/fetch`) so the server cannot see who contacts whom. Revoking a token is how a block is enforced server-side.
- **Rationale**: FR-031a and FR-074 without content or sender identity. Residual leak: the server sees the recipient and timing (documented in the threat model).
- **Alternatives**: Full sender identification (leaks the social graph); anonymous credentials such as Privacy Pass (stronger, deferred).

## R8. Dependency list and justification

| Dependency | Where | Why |
|------------|-------|-----|
| OpenMLS (WASM) | crypto-wasm | MLS implementation (III) |
| libsodium | web | Argon2id and XChaCha20-Poly1305 (III) |
| React, Vite | web | UI and build; kept minimal, pinned |
| axum, tokio, sqlx | server | HTTP/WebSocket and database access |
| jsonschema (no network features), serde_json | server | strict input validation against `contracts-schema/` (X) |
| ed25519-dalek 2.2.0 | server | verifies Device login signatures; already in the tree through OpenMLS, so one version to track (III) |
| sha2 | server | hashes session tokens and chains log lines; RustCrypto (III) |
| getrandom | server | operating-system randomness behind the `Random` port |
| rustls 0.23 (ring), tokio-rustls, rustls-pki-types | server | TLS 1.3 only, in the server itself; rustls was already in the tree through sqlx (III) |
| rcgen | server tests only | makes throwaway certificates for TLS tests |
| Playwright, Vitest, proptest, cargo-fuzz | dev only | tests required by X |

All pinned to exact versions with lockfile hashes, scanned in CI. No analytics, crash reporters or third-party fonts.

## R9. What a fully compromised server can learn or do

- **Learns**: that some holder of a delivery token fetched key packages (not who), Account IDs and creation dates, Device public keys, last-connection time, recipient Device and timing of each delivery, ciphertext sizes (bucketed), Backup blob existence and size, truncated IP addresses for up to 7 days.
- **Cannot learn**: message content, attachment content, Group names and membership (kept in encrypted MLS state), usernames, Contact lists, Safety Codes, Recovery Keys.
- **Can do**: drop, delay or replay messages (replay is rejected by MLS), refuse service, serve a malicious client to a first-time visitor (R3), withhold a Device's removal from the directory (Safety Code checks mitigate), correlate traffic timing.
- **Cannot do**: add a Device or key silently (new Devices need approval from an existing Device and trigger contact warnings).

## R10. Push

- **Decision**: Web Push with an empty payload. Registration reveals to the push provider only that a given browser subscription exists. The service worker wakes and shows a generic "New message" notification. It does not fetch or decrypt, because the Device key and data key are wrapped by the passcode and are unavailable while the app is locked. Previews are deferred (simplicity, and no way to offer them without weakening local protection).
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

## R13. Recovery design

- **Decision**: At sign-up the Device generates a random Recovery Key and shows it once. Distinct HKDF labels derive three values: the Account identity key pair, a Backup encryption key, and a Backup access token (only its hash is stored). The identity private key is used only to sign Device certificates at sign-up and recovery, and is not kept on any Device. Recovery on a new Device re-derives the identity key, signs a certificate for the new Device, and downloads the Backup with the access token. Recovery signs out every earlier Device (server records, tokens and push subscriptions are deleted; earlier Devices receive `device-unlinked` with reason `recovered`). Contacts' Devices remove the Account's stale leaves and add the new one (R16).
- **Rationale**: The identity key, and so the Safety Code, survives recovery; only the Device changes. Device keys stay separate (II), the server needs no trust (I), and recovery works even without a Backup (identity only, no Contacts, no history). One fewer key than a separate recovery signing key.
- **Trade-off**: A stolen Recovery Key means full takeover of the Account for future messages. It is the same trust as any account root secret, and the signed-out Devices make the takeover visible to the owner.
- **Alternatives**: Identity key stored in the Backup (shares one key across Devices); a separate recovery signing key (an extra key and identity change on recovery); an escrowed recovery code (forbidden).

## R14. Operational readiness (Constitution XII)

- **Forced update**: the signed manifest carries a minimum client version; the service worker blocks the app and prompts an update when the installed version is lower.
- **Signing-key rotation and revocation**: the app pins a list of valid manifest-signing keys and a revocation list that ships inside signed manifests; a manifest signed by a revoked key is rejected.
- **Server secrets and KMS keys**: a documented rotation procedure with a rehearsal test.
- **Post-mortem**: a blameless public template in the incident response plan.

## R15. Devices inside encryption groups

- **Decision**: Each Device is its own leaf in every Conversation's MLS group. Linking a Device adds it to every existing Conversation (an add commit from a Device that is already a member). Unlinking removes it from every Conversation (a remove commit). The server's token revocation is a second, separate layer.
- **Rationale**: Without the remove commit, an unlinked Device keeps decryptable keys for later messages (II).

## R16. Joining and rejoining without server-hosted group state

- **Decision**: The server never holds GroupInfo or any MLS group state. A person joining a Group by Invite redeems it (`POST /invites/redeem`) to get the creator's delivery tokens and key packages, then sends an encrypted join request. A recovered Device sends each Contact a rejoin request (its new key package and Device certificate) using delivery tokens from the Backup. In both cases a current member's Device verifies the request and applies an add commit; for a rejoin it removes the Account's stale leaves in the same commit. Group admins and the Invite's expiry, limits and approval rules are enforced by members' Devices.
- **Certificates**: A Device certificate is signed by the Account identity key (sign-up, recovery) or by an existing Device (linking). Receivers verify the chain back to the identity key they stored for that Contact.
- **Rationale**: Adds no server data (Constitution IV) and no new protocol such as external commits. The cost is that joining waits until a member's Device is online, which the UI states.
- **Alternatives**: External commits with a hosted, encrypted GroupInfo (new server data and endpoints); requiring an admin to be online at redemption (same wait, worse for users).
- **Key-package exhaustion**: each Device also publishes a last-resort key package, which is reused when single-use packages run out, and fetches are rate limited per token.
