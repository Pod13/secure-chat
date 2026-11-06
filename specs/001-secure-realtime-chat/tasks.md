---

description: "Task list for Secure Real-Time Chat"
---

# Tasks: Secure Real-Time Chat

**Input**: Design documents from `/specs/001-secure-realtime-chat/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, data-inventory.md, threat-model.md, contracts/, quickstart.md

**Tests**: Mandatory. Constitution X requires security tests written before implementation. In every story, write the tests first and confirm they fail.

**Organization**: Tasks are grouped by user story so each story can be implemented and tested independently.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story the task belongs to (US1 to US9)
- Every story ends with a security and simplicity review task that also updates `threat-model.md` and `data-inventory.md` (Constitution Development Workflow)
- Changes to `crypto-wasm/`, `server/src/auth/`, `web/src/store/`, `web/src/sw/` and `build/` need the designated security reviewer

## Path Conventions

Per plan.md: `server/` (Rust), `crypto-wasm/` (Rust to WASM), `web/` (Vite + React), `contracts-schema/`, `build/`, `docs/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and supply-chain controls

- [ ] T001 Create the repository layout from plan.md: `server/`, `crypto-wasm/`, `web/`, `contracts-schema/`, `build/`, `docs/`
- [ ] T002 [P] Initialize the Rust workspace in `server/Cargo.toml` with axum, tokio and sqlx pinned to exact versions, and commit `Cargo.lock`
- [ ] T003 [P] Initialize the `crypto-wasm/Cargo.toml` crate with OpenMLS pinned to an exact version
- [ ] T004 [P] Initialize the Vite + React + TypeScript app in `web/package.json` with exact version pins, strict `tsconfig.json`, and a lockfile with integrity hashes
- [ ] T005 [P] Configure clippy, rustfmt, ESLint and Prettier in `server/clippy.toml`, `web/.eslintrc.cjs` and `web/.prettierrc`, with complexity limits that fail CI: cyclomatic complexity ≤ 10, ≤ 50 lines per function, ≤ 400 lines per file
- [ ] T006 [P] Create the CI pipeline in `.github/workflows/ci.yml` running SAST, dependency scanning, secret scanning, unit and security tests; it cannot be bypassed
- [ ] T007 [P] Add CI coverage thresholds (100% branch coverage for `crypto-wasm/`, `server/src/auth/`, `web/src/store/`, `web/src/sw/`) and mutation testing with cargo-mutants and Stryker in `.github/workflows/ci.yml` and `docs/testing.md`
- [ ] T008 [P] Add dependency policy in `server/deny.toml` and `web/.npmrc` plus SBOM generation in `build/sbom.sh`
- [ ] T009 [P] Add commit signing and branch protection documentation to `docs/contributing.md`
- [ ] T010 [P] Add the secret-scanning pre-commit config in `.pre-commit-config.yaml` and a `.gitignore` for keys and env files

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Threat model, spikes and test harness (first)

- [ ] T011 Review and sign off `specs/001-secure-realtime-chat/threat-model.md` with the security lead (threat-model task, Constitution X)
- [ ] T012 Run spike T-spike-1: build OpenMLS to WASM, run it in Chrome, Safari, Firefox and Edge, measure a 256-Member re-key against the 5 s target, and record the result in `specs/001-secure-realtime-chat/research.md` (fallback: mls-rs)
- [ ] T013 [P] Write JSON Schemas with strict size limits for every message in `contracts/` into `contracts-schema/*.json`
- [ ] T014 [P] Write the server-adversary harness in `server/tests/adversary.rs`: dump all tables, blobs, logs and metrics during end-to-end flows and fail on plaintext or key material (must fail until features exist)
- [ ] T015 [P] Write schema-validation security tests (oversized, unknown-field and malformed inputs) in `server/tests/validation.rs`
- [ ] T016 Define injected I/O ports (clock, randomness, storage, network) for security-critical code in `server/src/ports.rs` and `web/src/ports.ts`, with in-memory fakes in `server/tests/fakes.rs` and `web/tests/fakes.ts`, so security logic is deterministic and testable

### Server foundation

- [ ] T017 Create the initial migrations for accounts, devices, delivery tokens, envelopes, invites and blobs in `server/migrations/0001_init.sql` per data-model.md
- [ ] T018 [P] Implement configuration and secrets loading (no secrets in files) in `server/src/config.rs`
- [ ] T019 [P] Implement structured, tamper-evident logging that excludes content, keys, tokens and full IPs in `server/src/logging.rs`
- [ ] T020 Write tests then implement Device challenge-response authentication and 15-minute Device-bound tokens in `server/src/auth/` (tests in `server/tests/auth.rs` first)
- [ ] T021 Implement request validation middleware using `contracts-schema/` in `server/src/api/validate.rs`
- [ ] T022 [P] Implement the rate-limiting framework without content access in `server/src/abuse/limits.rs`
- [ ] T023 [P] Configure TLS 1.3 only and security headers (HSTS preload, CSP, no third-party origins) in `server/src/api/headers.rs`
- [ ] T024 Implement the WebSocket channel and frames from `contracts/realtime-frames.md` in `server/src/api/ws.rs`
- [ ] T025 Implement the envelope queue with delete-on-ack and 30-day expiry job in `server/src/delivery/queue.rs`
- [ ] T026 [P] Configure encryption at rest for PostgreSQL and object storage with KMS-managed keys, plus backup retention matching live data, in `server/deploy/storage.md`

### Crypto and client foundation

- [ ] T027 Write tests then implement the OpenMLS wrapper (create group, add, remove, commit, encrypt, decrypt) with fixed-bucket padding in `crypto-wasm/src/lib.rs` and `crypto-wasm/src/padding.rs` (tests in `crypto-wasm/tests/` first)
- [ ] T028 [P] Add cargo-fuzz targets for MLS message handling and padding in `crypto-wasm/fuzz/`
- [ ] T029 [P] Add the typed crypto bridge in `web/src/crypto/bridge.ts` and the libsodium helpers (Argon2id, XChaCha20-Poly1305) in `web/src/crypto/sodium.ts`
- [ ] T030 Write tests then implement the encrypted local vault: data key, Argon2id passcode wrapping, encrypted IndexedDB records in `web/src/store/vault.ts` (tests in `web/tests/vault.test.ts` first)
- [ ] T031 [P] Implement the WebSocket client with automatic reconnect in `web/src/net/socket.ts`
- [ ] T032 Implement the encrypted outgoing queue with client-generated ids for de-duplication in `web/src/net/outbox.ts`
- [ ] T033 [P] Add the base React shell, routing, theme and accessible components in `web/src/app/App.tsx` and `web/src/app/components/`

### Client integrity

- [ ] T034 Write tests then implement the reproducible build, content-hashed assets and signed manifest in `build/build.sh` and `build/sign-manifest.ts`
- [ ] T035 Write tests then implement the service worker that refuses assets not in the manifest in `web/src/sw/sw.ts` (test in `web/tests/sw.test.ts` first)
- [ ] T036 [P] Enforce CSP without `unsafe-inline` or `unsafe-eval`, SRI and Trusted Types in `web/index.html` and `web/src/app/trustedTypes.ts`
- [ ] T037 [P] Add provenance attestation and release signing steps in `.github/workflows/release.yml` (signing keys in an HSM, never on developer machines)

**Checkpoint**: Foundation ready. User story implementation can now begin.

---

## Phase 3: User Story 1 - Create an account and start a private 1:1 chat (Priority: P1) 🎯 MVP

**Goal**: A user signs up by Invite and exchanges real-time end-to-end encrypted messages with a Contact.

**Independent Test**: Quickstart Scenario 1: two browsers sign up, connect, exchange messages online and offline; the adversary harness finds only ciphertext and Data Inventory fields.

### Tests for User Story 1 (write first, confirm they fail)

- [ ] T038 [P] [US1] Contract tests for `POST /accounts`, `/auth/*`, `/invites`, `/delivery-tokens`, `/deliver` in `server/tests/contract_accounts.rs`
- [ ] T039 [P] [US1] Security test: a server-side dump after a full chat contains no plaintext, username or Contact list in `server/tests/adversary_chat.rs`
- [ ] T040 [P] [US1] Security test: a delivery with a revoked or unknown token is rejected and sender identity is never logged in `server/tests/sealed_sender.rs`
- [ ] T041 [P] [US1] End-to-end test of Scenario 1 (online, offline, ordering, no duplicates) in `web/tests/e2e/chat.spec.ts`

### Implementation for User Story 1

- [ ] T042 [P] [US1] Implement Account and Device records and the Invite model in `server/src/accounts/mod.rs`
- [ ] T043 [US1] Implement `POST /accounts` with invite-only registration and operator seed Invites in `server/src/accounts/signup.rs`
- [ ] T044 [US1] Implement Invite creation, revocation, expiry and use limits in `server/src/accounts/invites.rs`
- [ ] T045 [US1] Implement delivery tokens and sealed-sender `POST /deliver` with per-token and per-recipient rate limits in `server/src/delivery/sealed.rs`
- [ ] T046 [US1] Implement key-package storage and `GET /key-packages/{account_id}` in `server/src/accounts/keypackages.rs`
- [ ] T047 [P] [US1] Build the sign-up flow (username, passcode, Recovery Key explanation) in `web/src/app/screens/SignUp.tsx`
- [ ] T048 [US1] Generate keys on the Device and create the Account in `web/src/crypto/account.ts`
- [ ] T049 [US1] Build Invite creation, sharing and QR code in `web/src/app/screens/Invite.tsx`
- [ ] T050 [US1] Implement joining by Invite and starting a 1:1 Conversation in `web/src/app/screens/JoinInvite.tsx` and `web/src/crypto/conversation.ts`
- [ ] T051 [US1] Build the conversation view with text sending, receive, and status (sending, sent, delivered) in `web/src/app/screens/Conversation.tsx`
- [ ] T052 [US1] Implement acknowledgements, status messages and offline catch-up in `web/src/net/delivery.ts`
- [ ] T053 [US1] Notify the sender when a message expires undelivered in `web/src/net/expiry.ts`
- [ ] T054 [US1] Security and simplicity review for US1 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md` (security review and documentation task)

**Checkpoint**: User Story 1 is fully functional and testable on its own.

---

## Phase 4: User Story 2 - Verify a contact's identity (Priority: P1)

**Goal**: Users compare Safety Codes and get blocking warnings on key changes.

**Independent Test**: Quickstart Scenario 2.

### Tests for User Story 2 (write first)

- [ ] T055 [P] [US2] Security test: a key change on a Verified Contact blocks the next send until acknowledged in `web/tests/e2e/keychange.spec.ts`
- [ ] T056 [P] [US2] Unit test: Safety Code is identical on both sides and changes with either key in `web/tests/safetycode.test.ts`

### Implementation for User Story 2

- [ ] T057 [P] [US2] Implement Safety Code and QR generation in `web/src/crypto/safetycode.ts`
- [ ] T058 [US2] Build the contact details screen with scan and compare in `web/src/app/screens/ContactDetails.tsx`
- [ ] T059 [US2] Track verification state on the Device and reset it on a key change in `web/src/store/contacts.ts`
- [ ] T060 [US2] Build plain-language key-change and new-Device warnings, including "block on key change", in `web/src/app/components/KeyChangeWarning.tsx`
- [ ] T061 [US2] Security and simplicity review for US2 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

**Checkpoint**: Stories 1 and 2 work independently.

---

## Phase 5: User Story 3 - Install on Android and iPhone (Priority: P1)

**Goal**: A user installs the PWA on a phone with guided steps and receives empty-payload pushes.

**Independent Test**: Quickstart Scenario 3.

### Tests for User Story 3 (write first)

- [ ] T062 [P] [US3] Security test: a push payload contains no text, sender or preview data in `server/tests/push_payload.rs`
- [ ] T063 [P] [US3] Test the platform-specific install guidance logic in `web/tests/install.test.ts`

### Implementation for User Story 3

- [ ] T064 [P] [US3] Add the web app manifest, icons and full-screen display config in `web/public/manifest.webmanifest`
- [ ] T065 [US3] Build one-step install prompts with Android and iOS instructions in `web/src/app/screens/InstallGuide.tsx`
- [ ] T066 [US3] Implement the empty-payload push endpoint and registration in `server/src/api/push.rs`
- [ ] T067 [US3] Wake the service worker on push, fetch ciphertext, decrypt locally and show a generic or opted-in preview notification in `web/src/sw/push.ts`
- [ ] T068 [US3] Run Scenario 3 on real Android and iOS 16.4+ devices and record results in `specs/001-secure-realtime-chat/research.md` (R10)
- [ ] T069 [US3] Security and simplicity review for US3 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

**Checkpoint**: P1 stories complete. This is the MVP.

---

## Phase 6: User Story 4 - Link and unlink devices (Priority: P2)

**Goal**: Add a Device only by approval from an existing one; unlink instantly.

**Independent Test**: Quickstart Scenario 4 (first half).

### Tests for User Story 4 (write first)

- [ ] T070 [P] [US4] Security test: a Device cannot be linked without an existing-Device signature in `server/tests/device_link.rs`
- [ ] T071 [P] [US4] Security test: an unlinked Device's token stops working immediately and the Device wipes local data in `web/tests/e2e/unlink.spec.ts`

### Implementation for User Story 4

- [ ] T072 [US4] Implement link requests, approval, listing and unlink endpoints in `server/src/accounts/devices.rs`
- [ ] T073 [US4] Add the `link-request` and `device-unlinked` frames in `server/src/api/ws.rs`
- [ ] T074 [P] [US4] Build the "link new device" flow with QR approval in `web/src/app/screens/LinkDevice.tsx`
- [ ] T075 [US4] Build the Device list with name, type and last-active time in `web/src/app/screens/Devices.tsx`
- [ ] T076 [US4] Notify Contacts when a Device is added to an Account in `web/src/crypto/devicechange.ts`
- [ ] T077 [US4] Wipe local data when unlinked in `web/src/store/wipe.ts`
- [ ] T078 [US4] Security and simplicity review for US4 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

---

## Phase 7: User Story 5 - Group conversations (Priority: P2)

**Goal**: Create Groups, invite by link, manage membership, and rotate keys on removal.

**Independent Test**: Quickstart Scenario 4 (second half).

### Tests for User Story 5 (write first)

- [ ] T079 [P] [US5] Security test: a removed Member decrypts 0% of later messages and a new Member decrypts 0% of earlier ones in `crypto-wasm/tests/membership.rs`
- [ ] T080 [P] [US5] Test Invite expiry, use limits, approval and revocation in `web/tests/e2e/group_invites.spec.ts`
- [ ] T081 [P] [US5] Performance test: a 256-Member re-key completes within 5 s in `crypto-wasm/tests/rekey_bench.rs`

### Implementation for User Story 5

- [ ] T082 [US5] Implement Group creation, add, remove and commit handling in `crypto-wasm/src/group.rs`
- [ ] T083 [US5] Keep admin roles and settings inside signed MLS state, enforced by Members' Devices, in `web/src/crypto/groupstate.ts`
- [ ] T084 [P] [US5] Build the Group create, settings and Members screens in `web/src/app/screens/Group.tsx`
- [ ] T085 [US5] Implement Group Invites with expiry, limits, approval and revocation in `web/src/crypto/groupinvites.ts` and `server/src/accounts/invites.rs`
- [ ] T086 [US5] Post system messages for membership changes in `web/src/app/screens/Conversation.tsx`
- [ ] T087 [US5] Security and simplicity review for US5 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

---

## Phase 8: User Story 6 - Protect data on a device (Priority: P2)

**Goal**: Locked Devices expose nothing; the app hides content and can wipe.

**Independent Test**: Quickstart Scenario 5 (first half).

### Tests for User Story 6 (write first)

- [ ] T088 [P] [US6] Security test: with the app locked, IndexedDB and caches contain no readable messages, keys or contacts in `web/tests/e2e/locked_storage.spec.ts`
- [ ] T089 [P] [US6] Test auto-lock, failed-unlock wipe and app-switcher hiding in `web/tests/e2e/applock.spec.ts`

### Implementation for User Story 6

- [ ] T090 [US6] Implement app lock with passcode and auto-lock timeout (passcode-only unlock in v1) in `web/src/store/applock.ts`
- [ ] T091 [US6] Implement wipe after N failed unlocks in `web/src/store/wipe.ts`
- [ ] T092 [P] [US6] Hide content in the app switcher and on blur in `web/src/app/privacyShield.ts`
- [ ] T093 [US6] Block screenshots where the platform allows and warn on iOS in `web/src/app/screenGuard.ts`
- [ ] T094 [US6] Ensure no plaintext reaches logs, caches, thumbnails or notification history in `web/src/app/audit.test.ts`
- [ ] T095 [US6] Security and simplicity review for US6 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

---

## Phase 9: User Story 7 - Disappearing messages and deletion (Priority: P2)

**Goal**: Per-Conversation timers, delete for everyone, and account deletion.

**Independent Test**: Quickstart Scenario 5 (second half).

### Tests for User Story 7 (write first)

- [ ] T096 [P] [US7] Test that timers start at first view and erase messages and attachment keys on all Devices in `web/tests/e2e/disappearing.spec.ts`
- [ ] T097 [P] [US7] Security test: `DELETE /accounts/me` removes every server record listed in data-inventory.md in `server/tests/account_delete.rs`

### Implementation for User Story 7

- [ ] T098 [US7] Implement the Device-enforced disappearing timer and the settings text about its limit in `web/src/store/timers.ts` and `web/src/app/screens/ConversationSettings.tsx`
- [ ] T099 [US7] Implement "delete for everyone" as an encrypted control message in `web/src/crypto/delete.ts`
- [ ] T100 [US7] Implement account deletion in `server/src/accounts/delete.rs` and notify Contacts in `web/src/crypto/accountdeleted.ts`
- [ ] T101 [US7] Security and simplicity review for US7 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

---

## Phase 10: User Story 8 - Send files, images and voice notes (Priority: P3)

**Goal**: Encrypted attachments up to 100 MB, with metadata stripped.

**Independent Test**: Send an image and a PDF; the server holds only an encrypted blob.

### Tests for User Story 8 (write first)

- [ ] T102 [P] [US8] Security test: uploaded blobs are ciphertext, bucket-padded, and deleted after all recipients fetch or after retention in `server/tests/blobs.rs`
- [ ] T103 [P] [US8] Test that EXIF and location data are stripped in `web/tests/metadata.test.ts`

### Implementation for User Story 8

- [ ] T104 [US8] Implement blob upload, download and expiry in `server/src/blobs/mod.rs`
- [ ] T105 [US8] Encrypt attachments on the Device and send the key inside the message in `web/src/crypto/attachments.ts`
- [ ] T106 [P] [US8] Strip image metadata before encryption in `web/src/app/media/strip.ts`
- [ ] T107 [US8] Build attach, preview and voice-note recording in `web/src/app/components/Attachments.tsx`
- [ ] T108 [US8] Security and simplicity review for US8 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

---

## Phase 11: User Story 9 - Block, report and control privacy signals (Priority: P3)

**Goal**: Blocking, user-driven reports, and privacy toggles.

**Independent Test**: Block a Contact and confirm no more messages arrive; turn off read receipts and confirm "read" is never sent.

### Tests for User Story 9 (write first)

- [ ] T109 [P] [US9] Security test: blocking revokes the delivery token so the server rejects further deliveries in `server/tests/block.rs`
- [ ] T110 [P] [US9] Test that disabled read receipts, typing and last-seen emit nothing in `web/tests/privacy_signals.test.ts`

### Implementation for User Story 9

- [ ] T111 [US9] Implement block and unblock, including token revocation, in `web/src/crypto/block.ts` and `server/src/delivery/tokens.rs`
- [ ] T112 [US9] Build the report flow showing exactly what will be forwarded, sent to the moderation Account or Group admins, in `web/src/app/screens/Report.tsx`
- [ ] T113 [US9] Implement privacy settings for read receipts, typing and last-seen in `web/src/store/privacy.ts`
- [ ] T114 [US9] Security and simplicity review for US9 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

---

## Phase 12: Backup, Recovery and Polish

**Purpose**: Cross-cutting requirements, assurance and launch readiness

- [ ] T115 [P] Write tests then implement the encrypted Backup upload and restore using the Recovery Key in `web/src/crypto/backup.ts` and `server/src/blobs/backup.rs` (FR-041, FR-042)
- [ ] T116 [P] Accessibility audit against WCAG 2.2 AA with fixes in `web/src/app/`
- [ ] T117 [P] Publish the Data Inventory, privacy policy and `security.txt` in `docs/data-inventory.md`, `docs/privacy.md` and `web/public/.well-known/security.txt`
- [ ] T118 [P] Write the security whitepaper in `docs/whitepaper.md`
- [ ] T119 [P] Write the incident response plan (roles, severities, 24-hour critical mitigation, key rotation, forced update, signing-key revocation) in `docs/incident-response.md`
- [ ] T120 Run load tests for 10,000 concurrent connections against SC-003 and SC-011 in `server/tests/load/`
- [ ] T121 Run the full quickstart scenarios in `specs/001-secure-realtime-chat/quickstart.md` and record results
- [ ] T122 Publish client and server source and the reproducible-build verification instructions in `docs/verify-build.md`
- [ ] T123 Simplicity audit: remove unused code, options and dependencies, confirm every complexity limit and coverage threshold is met, and record deferred features in `docs/deferred.md`
- [ ] T124 Commission the independent audit (cryptography, application, infrastructure); fix all critical and high findings before public launch

---

## Dependencies & Execution Order

- **Setup (Phase 1)**: no dependencies; start immediately.
- **Foundational (Phase 2)**: depends on Setup and blocks all stories. T011 and T012 (threat model and the MLS spike) come first; their outcome can change T027.
- **User stories**: all depend on Phase 2. US1 first; US2 and US3 need US1's Conversation but are otherwise independent; US4 to US9 depend only on Phase 2 plus US1 for message flow.
- **Polish (Phase 12)**: T115 needs US1 and US4. T124 follows everything else.
- Within a story: tests, then models, then services and endpoints, then UI, then the security review.

## Parallel Opportunities

- Setup tasks T002 to T010 touch separate files.
- In Phase 2: T013, T014, T015 in parallel; then T018, T019, T022, T023, T026 in parallel on the server side while T028, T029, T031, T033, T036 run on the client side.
- After Phase 2, US2, US3, US4 and US6 can be built in parallel by different people.
- All tests marked [P] within a story run in parallel.

## Implementation Strategy

1. **MVP**: Phases 1, 2, then US1, US2 and US3. This delivers private 1:1 chat with verification and phone install, which is the core promise.
2. Release to a closed group only after the audit (T124). Public launch needs zero open critical or high findings (SC-009).
3. Add US4 to US7 next (devices, Groups, device protection, disappearing messages), then US8 and US9.
4. If the T012 spike fails, switch to mls-rs and update ADR 0002 before continuing.

## Notes

- The constitution requires a threat-model task, security tests first, a security review, a simplicity review and a Data Inventory update for the feature; these are T011, the test tasks in each story, the review task closing each story, the simplicity audit, and T117. Complexity limits, coverage thresholds and mutation testing (Principle XIII) are set up in T005 and the coverage task that follows T006.
- Voice and video calls are out of scope (spec Assumptions).
