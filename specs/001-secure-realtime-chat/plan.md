# Implementation Plan: Secure Real-Time Chat

**Branch**: `001-secure-realtime-chat` | **Date**: 2026-11-07 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `/specs/001-secure-realtime-chat/spec.md`

## Summary

An invite-only, end-to-end encrypted chat delivered as an installable PWA (web, Android, iPhone). The browser client does all cryptography and holds all keys; a Rust relay server routes opaque ciphertext, queues it until delivery, and stores only the metadata listed in the Data Inventory. Every Conversation, 1:1 or Group, uses MLS (RFC 9420). The design follows Constitution XIII: the smallest set of parts, with security-critical logic written as deterministic code that tests can verify. This replaces the earlier "Signal for 1:1" idea, because libsignal has no supported browser build (see [research.md](research.md) R2).

**Framework recommendation (you asked for Next.js, open to advice):** the client is a Vite + React + TypeScript single-page app, not Next.js. Constitution VII needs a strict CSP, Subresource Integrity, reproducible builds and a pinned asset manifest, and IX asks for a minimal dependency tree. Next.js's server rendering, inline bootstrap scripts and larger dependency tree work against all three. Next.js with `output: 'export'` is a viable fallback if you want React Server Components' tooling and accept hash-based CSP for its inline scripts; reasoning in [research.md](research.md) R1.

## Technical Context

**Language/Version**: TypeScript 5.x (client), Rust stable (server and the crypto WASM module)

**Primary Dependencies**: React 18, Vite; OpenMLS (compiled to WASM) for MLS; libsodium (WASM) for Argon2id and XChaCha20-Poly1305; platform WebCrypto; axum + tokio (server); sqlx + PostgreSQL

**Storage**: Server: PostgreSQL (delivery queue, account/device records, opaque backup blobs) and S3-compatible object storage (encrypted attachments). Device: IndexedDB with every record encrypted under a passcode-wrapped data key (passcode-only unlock in v1)

**Testing**: Vitest + Playwright (client and end-to-end), cargo test + proptest (server), cargo-fuzz (parsers, MLS message handling), a server-adversary test harness that asserts no plaintext reaches storage or logs; 100% branch coverage and mutation testing (cargo-mutants, Stryker) on security-critical modules; complexity limits enforced in CI

**Target Platform**: Current Chrome, Safari, Firefox, Edge; installed PWA on Android and iOS 16.4+; Linux server

**Project Type**: web-service plus web application (PWA)

**Performance Goals**: 95% of online messages delivered under 1 s, 99% under 3 s; 10,000 concurrent connections (SC-003, SC-011); Group re-key for 256 Members under 5 s

**Constraints**: no remote code at runtime; no third-party scripts, analytics or fonts; TLS 1.3 only; server never sees plaintext or private keys; offline outgoing queue

**Scale/Scope**: 10,000 concurrent users, Groups to 256 Members, attachments to 100 MB, about 12 screens

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-checked after Phase 1 design.*

| # | Gate | Status | Evidence |
|---|------|--------|----------|
| 1 | Server learns nothing new in plaintext (I, II) | PASS | Server handles only MLS ciphertext, sealed-sender envelopes and opaque blobs. Compromised-server analysis in [research.md](research.md) R9 |
| 2 | Only approved protocols and libraries (III) | PASS, with spike | MLS RFC 9420 via OpenMLS; libsodium; WebCrypto. OpenMLS-in-WASM maturity is verified in task T-spike-1; fallback is mls-rs. Post-quantum hybrid stays on the roadmap |
| 3 | New metadata justified, minimised, in Data Inventory (IV) | PASS | [data-inventory.md](data-inventory.md) lists every stored field with purpose and retention |
| 4 | Storage, retention and deletion defined (V) | PASS | Delete on delivery, 30-day expiry, KMS-managed encryption at rest, device records encrypted. See [data-model.md](data-model.md) |
| 5 | Identity and device-trust impact (VI) | PASS | Safety Codes, blocking key-change warnings, device linking only by approval from an existing Device. Key transparency deferred and on the roadmap (SHOULD, not MUST) |
| 6 | Client integrity, no remote code (VII) | PASS with risk | Signed manifest plus pinning service worker, strict CSP, SRI, Trusted Types. Residual risk: first load of a fresh install trusts the server (research R3) |
| 7 | Secure defaults, no configuration (VIII) | PASS | E2EE always on; app lock prompted at sign-up; empty push payloads |
| 8 | New dependencies reviewed and justified (IX) | PASS | Dependency list with justification in [research.md](research.md) R8 |
| 9 | Threat model exists, security tests listed (X) | PASS | [threat-model.md](threat-model.md); test list in [quickstart.md](quickstart.md) |
| 10 | Simplest design that meets the spec, testable by construction (XIII) | PASS | Rules and trade-offs in [research.md](research.md) R12: three units, one protocol, injected I/O ports, CI-enforced limits, mutation testing, WebAuthn deferred |

No NON-NEGOTIABLE principle (I, II, III) is violated, and no security control was removed for simplicity.

## Project Structure

### Documentation (this feature)

```text
specs/001-secure-realtime-chat/
├── plan.md              # This file (/speckit-plan command output)
├── research.md          # Phase 0 output (/speckit-plan command)
├── data-model.md        # Phase 1 output (/speckit-plan command)
├── data-inventory.md    # Phase 1 output (/speckit-plan command)
├── threat-model.md      # Phase 1 output (/speckit-plan command)
├── quickstart.md        # Phase 1 output (/speckit-plan command)
├── contracts/           # Phase 1 output (/speckit-plan command)
│   ├── http-api.md
│   └── realtime-frames.md
└── tasks.md             # Phase 2 output (/speckit-tasks command - NOT created by /speckit-plan)
```

### Source Code (repository root)

```text
server/                      # Rust relay server
├── src/
│   ├── api/                 # HTTP + WebSocket handlers
│   ├── auth/                # device challenge-response, short-lived tokens
│   ├── delivery/            # queues, sealed-sender envelopes, expiry
│   ├── blobs/               # attachments and backups (opaque)
│   └── abuse/               # rate limits without content access
├── migrations/
└── tests/

crypto-wasm/                 # Rust crate -> WASM: OpenMLS wrapper, only crypto entry point for the client
├── src/
└── tests/

web/                         # Vite + React PWA
├── src/
│   ├── app/                 # routes, screens, install guidance
│   ├── crypto/              # typed bridge to crypto-wasm and libsodium
│   ├── store/               # encrypted IndexedDB layer, app lock
│   ├── net/                 # WebSocket client, outgoing queue
│   └── sw/                  # service worker with manifest pinning
└── tests/

contracts-schema/            # shared JSON Schemas for every network message (strict, size-limited)

build/                       # reproducible build, manifest signing, SBOM and provenance scripts
docs/                        # ADRs, published Data Inventory, whitepaper drafts
```

**Structure Decision**: Three deployable units (server, crypto-wasm, web) plus one shared schema package. Separating crypto-wasm keeps all key handling in one reviewable module that needs the designated cryptography reviewer (Constitution III).

## Complexity Tracking

No Constitution Check violations. The complexity below is kept deliberately; each item is justified in research R12.

| Complexity kept | Why needed | Simpler alternative rejected because |
|-----------------|------------|--------------------------------------|
| WASM MLS module (`crypto-wasm/`) | Only audited route to MLS in a browser (III) | Hand-written or ported crypto is forbidden |
| Sealed-sender delivery tokens | Hides sender from the server (IV) and carries block and rate limits | Sender-identified delivery leaks the social graph |
| Signed manifest and pinning service worker | Detects a swapped web client (VII) | No other browser mechanism exists today |
