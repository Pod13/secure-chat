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
- Changes to `crypto-wasm/`, `server/src/auth/`, `web/src/crypto/`, `web/src/store/`, `web/src/sw/` and `build/` need the designated security reviewer; changes to `crypto-wasm/` and `web/src/crypto/` also need the designated cryptography reviewer

## Path Conventions

Per plan.md: `server/` (Rust), `crypto-wasm/` (Rust to WASM), `web/` (Vite + React), `contracts-schema/`, `build/`, `docs/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and supply-chain controls

- [X] T001 Create the repository layout from plan.md: `server/`, `crypto-wasm/`, `web/`, `contracts-schema/`, `build/`, `docs/`
- [X] T002 [P] Initialize the Rust workspace in `server/Cargo.toml` with axum, tokio and sqlx pinned to exact versions, and commit `Cargo.lock`
- [X] T003 [P] Initialize the `crypto-wasm/Cargo.toml` crate with OpenMLS pinned to an exact version
- [X] T004 [P] Initialize the Vite + React + TypeScript app in `web/package.json` with exact version pins, strict `tsconfig.json`, and a lockfile with integrity hashes
- [X] T005 [P] Configure clippy, rustfmt, ESLint and Prettier in `server/clippy.toml`, `web/.eslintrc.cjs` and `web/.prettierrc`, with complexity limits that fail CI: cyclomatic complexity ≤ 10, ≤ 50 lines per function, ≤ 400 lines per file, and `forbid(unsafe_code)` outside reviewed, justified modules
- [X] T006 [P] Create the CI pipeline in `.github/workflows/ci.yml` running SAST, dependency scanning, secret scanning, unit and security tests; it cannot be bypassed
- [ ] T007 [P] Add CI coverage thresholds (100% branch coverage for `crypto-wasm/`, `server/src/auth/`, `web/src/crypto/`, `web/src/store/`, `web/src/sw/`, `build/`) and mutation testing with cargo-mutants and Stryker in `.github/workflows/ci.yml` and `docs/testing.md`
- [X] T008 [P] Add dependency policy in `server/deny.toml` and `web/.npmrc` plus SBOM generation in `build/sbom.sh`
- [X] T009 [P] Add commit signing and branch protection documentation to `docs/contributing.md`
- [X] T010 [P] Add the secret-scanning pre-commit config in `.pre-commit-config.yaml` and a `.gitignore` for keys and env files
- [X] T011 [P] Configure the Playwright browser matrix for Chrome, Safari (WebKit), Firefox and Edge in `web/playwright.config.ts` and run it in CI (FR-060)
- [X] T012 [P] Document and enforce operational hardening: break-glass production access with logging and alerts, least-privilege CI credentials, isolated build runners, in `docs/operations.md` and `.github/workflows/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

**⚠️ CRITICAL**: No user story work can begin until this phase is complete

### Threat model, spikes and test harness (first)

- [ ] T013 Review and sign off `specs/001-secure-realtime-chat/threat-model.md` with the security lead (threat-model task, Constitution X)
- [X] T014 Run spike T-spike-1: build OpenMLS to WASM, run it in Chrome, Safari, Firefox and Edge, measure a 256-Member re-key against the 5 s target, confirm no `crypto-bigint` code is reachable in the built WASM (accepted risk RUSTSEC-2026-0387, `docs/accepted-risks.md`), and record the result in `specs/001-secure-realtime-chat/research.md` (fallback: mls-rs)
- [X] T015 [P] Write JSON Schemas with strict size limits for every message in `contracts/` into `contracts-schema/*.json`
- [X] T016 [P] Write the server-adversary harness in `server/tests/adversary.rs`: dump all tables, blobs, logs and metrics during end-to-end flows and fail on plaintext or key material (must fail until features exist)
- [X] T017 [P] Write schema-validation security tests (oversized, unknown-field and malformed inputs) in `server/tests/validation.rs`
- [X] T018 Define injected I/O ports (clock, randomness, storage, network) for security-critical code in `server/src/ports.rs` and `web/src/ports.ts`, with in-memory fakes in `server/tests/fakes.rs` and `web/tests/fakes.ts`, so security logic is deterministic and testable

### Server foundation

- [X] T019 Create the initial migrations for accounts, devices, delivery tokens, envelopes, invites and blobs in `server/migrations/0001_init.sql` per data-model.md, with no column that links an Invite to the Account it created
- [ ] T020 [P] Implement configuration and secrets loading (no secrets in files) in `server/src/config.rs`
- [ ] T021 [P] Implement structured, tamper-evident logging that excludes content, keys, tokens and full IPs in `server/src/logging.rs`
- [ ] T022 Write tests then implement Device challenge-response authentication and 15-minute Device-bound tokens in `server/src/auth/` (tests in `server/tests/auth.rs` first)
- [ ] T023 Implement request validation middleware using `contracts-schema/` in `server/src/api/validate.rs`
- [ ] T024 [P] Implement the rate-limiting framework without content access in `server/src/abuse/limits.rs`
- [ ] T025 [P] Configure TLS 1.3 only and security headers (HSTS preload, CSP, no third-party origins) in `server/src/api/headers.rs`
- [ ] T026 Implement the WebSocket channel and frames from `contracts/realtime-frames.md` in `server/src/api/ws.rs`
- [ ] T027 Implement the envelope queue with delete-on-ack and 30-day expiry job in `server/src/delivery/queue.rs`
- [ ] T028 Write tests then implement scheduled retention purges for every Data Inventory row: abuse data (7 days), expired Invites (+30 days), key packages (30 days), audit log (1 year) in `server/src/retention/mod.rs` (tests in `server/tests/retention.rs` first)
- [ ] T029 [P] Configure encryption at rest for PostgreSQL and object storage with KMS-managed keys, plus backup retention matching live data, in `server/deploy/storage.md`

### Crypto and client foundation

- [ ] T030 Write tests then implement the OpenMLS wrapper (create group, add, remove, commit, encrypt, decrypt) with fixed-bucket padding, accepting only the one configured ciphersuite and rejecting all others with a test (accepted risk RUSTSEC-2026-0387) in `crypto-wasm/src/lib.rs` and `crypto-wasm/src/padding.rs` (tests in `crypto-wasm/tests/` first)
- [ ] T031 [P] Add cargo-fuzz targets for MLS message handling and padding in `crypto-wasm/fuzz/`
- [ ] T032 [P] Add cargo-fuzz targets for the HTTP request, WebSocket frame and schema-validation parsers in `server/fuzz/`
- [ ] T033 [P] Add the typed crypto bridge in `web/src/crypto/bridge.ts` and the libsodium helpers (Argon2id, XChaCha20-Poly1305) in `web/src/crypto/sodium.ts`
- [ ] T034 Write tests then implement the encrypted local vault: data key, Argon2id passcode wrapping, encrypted IndexedDB records in `web/src/store/vault.ts` (tests in `web/tests/vault.test.ts` first)
- [ ] T035 [P] Implement the WebSocket client with automatic reconnect in `web/src/net/socket.ts`
- [ ] T036 Implement the encrypted outgoing queue with client-generated ids for de-duplication in `web/src/net/outbox.ts`
- [ ] T037 [P] Add the base React shell, routing, theme and accessible components in `web/src/app/App.tsx` and `web/src/app/components/`

### Client integrity

- [ ] T038 Write tests then implement the reproducible build, content-hashed assets and signed manifest in `build/build.sh` and `build/sign-manifest.ts`
- [ ] T039 Write tests then implement the service worker that refuses assets not in the manifest in `web/src/sw/sw.ts` (test in `web/tests/sw.test.ts` first)
- [ ] T040 [P] Enforce CSP without `unsafe-inline` or `unsafe-eval`, SRI and Trusted Types in `web/index.html` and `web/src/app/trustedTypes.ts`
- [ ] T041 [P] Add provenance attestation and release signing steps in `.github/workflows/release.yml` (signing keys in an HSM, never on developer machines)
- [ ] T042 Write tests then implement forced update: the signed manifest carries a minimum client version, and the service worker blocks the app and prompts an update when the installed version is lower, in `web/src/sw/update.ts` (tests in `web/tests/update.test.ts` first)
- [ ] T043 Write tests then implement manifest signing-key rotation and revocation: the app pins a key list and a revocation list carried in signed manifests, and rejects a manifest signed by a revoked key, in `web/src/sw/keys.ts` and `build/rotate-signing-key.ts` (tests first)
- [ ] T044 [P] Write the server secrets and KMS key rotation procedure with a rehearsal test in `server/deploy/rotation.md` and `server/tests/rotation.rs`

**Checkpoint**: Foundation ready. User story implementation can now begin.

---

## Phase 3: User Story 1 - Create an account and start a private 1:1 chat (Priority: P1) 🎯 MVP

**Goal**: A user signs up by Invite and exchanges real-time end-to-end encrypted messages with a Contact.

**Independent Test**: Quickstart Scenario 1: two browsers sign up, connect, exchange messages online and offline; the adversary harness finds only ciphertext and Data Inventory fields.

### Tests for User Story 1 (write first, confirm they fail)

- [ ] T045 [P] [US1] Contract tests for `POST /accounts`, `/auth/*`, `/invites`, `/delivery-tokens`, `/deliver` in `server/tests/contract_accounts.rs`
- [ ] T046 [P] [US1] Security test: a server-side dump after a full chat contains no plaintext, username or Contact list in `server/tests/adversary_chat.rs`
- [ ] T047 [P] [US1] Security test: a delivery with a revoked or unknown token is rejected and sender identity is never logged in `server/tests/sealed_sender.rs`
- [ ] T048 [P] [US1] End-to-end test of Scenario 1 (online, offline, ordering, no duplicates) in `web/tests/e2e/chat.spec.ts`
- [ ] T049 [P] [US1] Security test: account creation leaves no stored or logged link between the Invite and the new Account in `server/tests/no_invite_link.rs`
- [ ] T050 [P] [US1] Security test: key-package fetch and Invite redemption need no account authentication and log no requester in `server/tests/keypackage_fetch.rs`
- [ ] T051 [P] [US1] Unit tests for replies, reactions and edits (only the author can edit; unknown targets are ignored) in `web/tests/messagetypes.test.ts`

### Implementation for User Story 1

- [ ] T052 [P] [US1] Implement Account and Device records and the Invite model in `server/src/accounts/mod.rs`
- [ ] T053 [US1] Implement `POST /accounts` with invite-only registration, operator seed Invites, storing the identity public key and no link between the Invite and the new Account in `server/src/accounts/signup.rs`
- [ ] T054 [US1] Implement Invite creation, revocation, expiry and use limits in `server/src/accounts/invites.rs`
- [ ] T055 [US1] Implement delivery tokens and sealed-sender `POST /deliver` with per-token and per-recipient rate limits in `server/src/delivery/sealed.rs`
- [ ] T056 [US1] Implement key-package storage and `POST /key-packages/fetch` and `POST /invites/redeem` (Contact and Group Invites), a last-resort key package per Device, and per-token fetch rate limits in `server/src/accounts/keypackages.rs`
- [ ] T057 [P] [US1] Build the sign-up flow (username, passcode, Recovery Key explanation) in `web/src/app/screens/SignUp.tsx`
- [ ] T058 [US1] Generate keys on the Device and create the Account in `web/src/crypto/account.ts`
- [ ] T059 [US1] Generate the Recovery Key at sign-up, show it once, and derive the Account identity key (its private half only signs Device certificates at sign-up and recovery and is never stored), Backup key and Backup access token with HKDF using distinct labels in `web/src/crypto/recoverykeys.ts`
- [ ] T060 [US1] Build Invite creation, sharing and QR code in `web/src/app/screens/Invite.tsx`
- [ ] T061 [US1] Implement joining by Invite and starting a 1:1 Conversation in `web/src/app/screens/JoinInvite.tsx` and `web/src/crypto/conversation.ts`
- [ ] T062 [US1] Build the conversation view with text sending, receive, and status (sending, sent, delivered) in `web/src/app/screens/Conversation.tsx`
- [ ] T063 [US1] Implement replies, reactions and edits as encrypted application messages in `web/src/crypto/messagetypes.ts` and render them in `web/src/app/screens/Conversation.tsx` (FR-013)
- [ ] T064 [US1] Implement acknowledgements, status messages and offline catch-up in `web/src/net/delivery.ts`
- [ ] T065 [US1] Notify the sender when a message expires undelivered in `web/src/net/expiry.ts`
- [ ] T066 [US1] Security and simplicity review for US1 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md` (security review and documentation task)

**Checkpoint**: User Story 1 is fully functional and testable on its own.

---

## Phase 4: User Story 2 - Verify a contact's identity (Priority: P1)

**Goal**: Users compare Safety Codes and get blocking warnings on key changes.

**Independent Test**: Quickstart Scenario 2.

### Tests for User Story 2 (write first)

- [ ] T067 [P] [US2] Security test: a key change on a Verified Contact blocks the next send until acknowledged in `web/tests/e2e/keychange.spec.ts`
- [ ] T068 [P] [US2] Unit test: Safety Code is identical on both sides and changes with either key in `web/tests/safetycode.test.ts`

### Implementation for User Story 2

- [ ] T069 [P] [US2] Implement Safety Code and QR generation in `web/src/crypto/safetycode.ts`
- [ ] T070 [US2] Build the contact details screen with scan and compare in `web/src/app/screens/ContactDetails.tsx`
- [ ] T071 [US2] Track verification state on the Device and reset it on a key change in `web/src/store/contacts.ts`
- [ ] T072 [US2] Build plain-language key-change and new-Device warnings, including "block on key change", in `web/src/app/components/KeyChangeWarning.tsx`
- [ ] T073 [US2] Security and simplicity review for US2 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

**Checkpoint**: Stories 1 and 2 work independently.

---

## Phase 5: User Story 3 - Install on Android and iPhone (Priority: P1)

**Goal**: A user installs the PWA on a phone with guided steps and receives empty-payload pushes.

**Independent Test**: Quickstart Scenario 3.

### Tests for User Story 3 (write first)

- [ ] T074 [P] [US3] Security test: a push payload contains no text, sender or preview data in `server/tests/push_payload.rs`
- [ ] T075 [P] [US3] Test the platform-specific install guidance logic in `web/tests/install.test.ts`

### Implementation for User Story 3

- [ ] T076 [P] [US3] Add the web app manifest, icons and full-screen display config in `web/public/manifest.webmanifest`
- [ ] T077 [US3] Build one-step install prompts with Android and iOS instructions in `web/src/app/screens/InstallGuide.tsx`
- [ ] T078 [US3] Implement the empty-payload push endpoint and registration in `server/src/api/push.rs`
- [ ] T079 [US3] Wake the service worker on push and show a generic "New message" notification without fetching or decrypting; previews are not offered in v1 in `web/src/sw/push.ts`
- [ ] T080 [US3] Run Scenario 3 on real Android and iOS 16.4+ devices and record results in `specs/001-secure-realtime-chat/research.md` (R10)
- [ ] T081 [US3] Security and simplicity review for US3 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

**Checkpoint**: P1 stories complete. This is the MVP.

---

## Phase 6: User Story 4 - Link and unlink devices (Priority: P2)

**Goal**: Add a Device only by approval from an existing one; unlink instantly.

**Independent Test**: Quickstart Scenario 4 (first half).

### Tests for User Story 4 (write first)

- [ ] T082 [P] [US4] Security test: a Device cannot be linked without an existing-Device signature in `server/tests/device_link.rs`
- [ ] T083 [P] [US4] Security test: an unlinked Device's token stops working immediately and the Device wipes local data in `web/tests/e2e/unlink.spec.ts`
- [ ] T084 [P] [US4] Security test: after unlinking, the Device is removed from every Conversation's encryption group and decrypts 0% of later messages in `crypto-wasm/tests/device_membership.rs`
- [ ] T085 [P] [US4] Security test: a newly linked Device is added to every existing Conversation, decrypts later messages and no earlier ones, in `crypto-wasm/tests/device_membership.rs`

### Implementation for User Story 4

- [ ] T086 [US4] Implement link requests, approval, listing and unlink endpoints in `server/src/accounts/devices.rs`
- [ ] T087 [US4] Add the `link-request` and `device-unlinked` frames in `server/src/api/ws.rs`
- [ ] T088 [P] [US4] Build the "link new device" flow with QR approval in `web/src/app/screens/LinkDevice.tsx`
- [ ] T089 [US4] Build the Device list with decrypted name, type and last-active date read from the Device's own encrypted label in `web/src/app/screens/Devices.tsx`
- [ ] T090 [US4] Share the Account label key at link approval and store each Device's encrypted name, type and own last-active date in `web/src/crypto/devicelabel.ts`
- [ ] T091 [US4] Implement add-Device and remove-Device commits across all Conversations in `crypto-wasm/src/devices.rs` and `web/src/crypto/devicemembership.ts` (FR-052)
- [ ] T092 [US4] Alert the Account's other Devices and notify Contacts when a Device is added by link or recovery, with a test that all of them receive the alert in `web/src/crypto/devicechange.ts`
- [ ] T093 [US4] Wipe local data when unlinked, and when the reason is `recovered` show that the Account was recovered on another Device in `web/src/store/wipe.ts`
- [ ] T094 [US4] Security and simplicity review for US4 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

---

## Phase 7: User Story 5 - Group conversations (Priority: P2)

**Goal**: Create Groups, invite by link, manage membership, and rotate keys on removal.

**Independent Test**: Quickstart Scenario 4 (second half).

### Tests for User Story 5 (write first)

- [ ] T095 [P] [US5] Security test: a removed Member decrypts 0% of later messages and a new Member decrypts 0% of earlier ones in `crypto-wasm/tests/membership.rs`
- [ ] T096 [P] [US5] Test Invite expiry, use limits, approval and revocation, and that a joiner waits until a member's Device is online in `web/tests/e2e/group_invites.spec.ts`
- [ ] T097 [P] [US5] Performance test: a 256-Member re-key completes within 5 s in `crypto-wasm/tests/rekey_bench.rs`
- [ ] T098 [P] [US5] Security test: a Member who leaves a Group decrypts 0% of later messages in `crypto-wasm/tests/leave.rs`

### Implementation for User Story 5

- [ ] T099 [US5] Implement Group policy (creation with admins and roles, who may add or remove) on top of the OpenMLS wrapper's add, remove and commit primitives in `crypto-wasm/src/group.rs`
- [ ] T100 [US5] Keep admin roles and settings inside signed MLS state, enforced by Members' Devices, in `web/src/crypto/groupstate.ts`
- [ ] T101 [P] [US5] Build the Group create, settings and Members screens in `web/src/app/screens/Group.tsx`
- [ ] T102 [US5] Implement Group Invites as encrypted join requests sent to the creator's Device, where a current member's Device verifies them and applies an add commit when online, enforcing expiry, limits, approval and revocation, with a "waiting to be added" state in `web/src/crypto/groupinvites.ts` and `server/src/accounts/invites.rs`
- [ ] T103 [US5] Post system messages for membership changes in `web/src/app/screens/Conversation.tsx`
- [ ] T104 [US5] Implement leaving a Group as a self-remove commit with a system message in `web/src/crypto/leave.ts` (FR-071)
- [ ] T105 [US5] Security and simplicity review for US5 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

---

## Phase 8: User Story 6 - Protect data on a device (Priority: P2)

**Goal**: Locked Devices expose nothing; the app hides content and can wipe.

**Independent Test**: Quickstart Scenario 5 (first half).

### Tests for User Story 6 (write first)

- [ ] T106 [P] [US6] Security test: with the app locked, IndexedDB and caches contain no readable messages, keys or contacts in `web/tests/e2e/locked_storage.spec.ts`
- [ ] T107 [P] [US6] Test auto-lock, failed-unlock wipe and app-switcher hiding in `web/tests/e2e/applock.spec.ts`

### Implementation for User Story 6

- [ ] T108 [US6] Implement app lock with passcode and auto-lock timeout (passcode-only unlock in v1) in `web/src/store/applock.ts`
- [ ] T109 [US6] Implement wipe after N failed unlocks in `web/src/store/wipe.ts`
- [ ] T110 [P] [US6] Hide content in the app switcher and on blur in `web/src/app/privacyShield.ts`
- [ ] T111 [US6] Block screenshots where the platform allows and warn on iOS in `web/src/app/screenGuard.ts`
- [ ] T112 [US6] Ensure no plaintext reaches logs, caches, thumbnails or notification history in `web/src/app/audit.test.ts`
- [ ] T113 [US6] Security and simplicity review for US6 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

---

## Phase 9: User Story 7 - Disappearing messages and deletion (Priority: P2)

**Goal**: Per-Conversation timers, delete for everyone, and account deletion.

**Independent Test**: Quickstart Scenario 5 (second half).

### Tests for User Story 7 (write first)

- [ ] T114 [P] [US7] Test that timers start at first view and erase messages and attachment keys on all Devices in `web/tests/e2e/disappearing.spec.ts`
- [ ] T115 [P] [US7] Security test: `DELETE /accounts/me` removes every server record listed in data-inventory.md in `server/tests/account_delete.rs`

### Implementation for User Story 7

- [ ] T116 [US7] Implement the Device-enforced disappearing timer and the settings text about its limit in `web/src/store/timers.ts` and `web/src/app/screens/ConversationSettings.tsx`
- [ ] T117 [US7] Implement "delete for everyone" as an encrypted control message in `web/src/crypto/delete.ts`
- [ ] T118 [US7] Implement account deletion in `server/src/accounts/delete.rs` and notify Contacts in `web/src/crypto/accountdeleted.ts`
- [ ] T119 [US7] Security and simplicity review for US7 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

---

## Phase 10: User Story 8 - Send files, images and voice notes (Priority: P3)

**Goal**: Encrypted attachments up to 100 MB, with metadata stripped.

**Independent Test**: Send an image and a PDF; the server holds only an encrypted blob.

### Tests for User Story 8 (write first)

- [ ] T120 [P] [US8] Security test: uploaded blobs are ciphertext, bucket-padded, and deleted after all recipients fetch or after retention in `server/tests/blobs.rs`
- [ ] T121 [P] [US8] Test that EXIF and location data are stripped in `web/tests/metadata.test.ts`

### Implementation for User Story 8

- [ ] T122 [US8] Implement blob upload, download and expiry in `server/src/blobs/mod.rs`
- [ ] T123 [US8] Encrypt attachments on the Device and send the key inside the message in `web/src/crypto/attachments.ts`
- [ ] T124 [P] [US8] Strip image metadata before encryption in `web/src/app/media/strip.ts`
- [ ] T125 [US8] Build attach, preview and voice-note recording in `web/src/app/components/Attachments.tsx`
- [ ] T126 [US8] Security and simplicity review for US8 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

---

## Phase 11: User Story 9 - Block, report and control privacy signals (Priority: P3)

**Goal**: Blocking, user-driven reports, and privacy toggles.

**Independent Test**: Block a Contact and confirm no more messages arrive; turn off read receipts and confirm "read" is never sent.

### Tests for User Story 9 (write first)

- [ ] T127 [P] [US9] Security test: blocking revokes the delivery token so the server rejects further deliveries in `server/tests/block.rs`
- [ ] T128 [P] [US9] Test that disabled read receipts, typing and last-seen emit nothing in `web/tests/privacy_signals.test.ts`

### Implementation for User Story 9

- [ ] T129 [US9] Implement block and unblock, including token revocation, in `web/src/crypto/block.ts` and `server/src/delivery/tokens.rs`
- [ ] T130 [US9] Build the report flow showing exactly what will be forwarded, sent to the moderation Account or Group admins, in `web/src/app/screens/Report.tsx`
- [ ] T131 [US9] Implement privacy settings for read receipts, typing and last-seen in `web/src/store/privacy.ts`
- [ ] T132 [US9] Send read receipts and typing indicators as encrypted application messages only when enabled, and show "read" only when both sides allow it, in `web/src/net/signals.ts` (FR-012, FR-070)
- [ ] T133 [US9] Security and simplicity review for US9 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

---

## Phase 12: User Story 10 - Recover an account after losing every device (Priority: P2)

**Goal**: Restore an Account, and its Backup if one exists, on a new Device using only the Recovery Key.

**Independent Test**: Quickstart Scenario 7.

### Tests for User Story 10 (write first)

- [ ] T134 [P] [US10] Unit tests for Recovery Key derivation: distinct labels, and no derived value can produce another, in `web/tests/recoverykeys.test.ts`
- [ ] T135 [P] [US10] Security test: the server cannot derive the Recovery Key, identity private key or Backup key from stored data in `server/tests/recovery_privacy.rs`
- [ ] T136 [P] [US10] Security test: recovery signs out every earlier Device, deletes its server records and delivery tokens, and the Contacts' Devices remove its leaves so it decrypts 0% of later messages, in `server/tests/recovery_revokes.rs` and `crypto-wasm/tests/rejoin.rs`
- [ ] T137 [P] [US10] Security test: a rejoin request with an invalid certificate chain, or from an Account that is not a Member, is rejected in `crypto-wasm/tests/rejoin_forged.rs`
- [ ] T138 [P] [US10] End-to-end test: lose all Devices, recover with the key, Contacts see a new-Device warning, history is restored from the Backup, other signed-in Devices are signed out with an explanation, a wrong key reveals nothing and is rate limited, and the whole recovery takes under 5 minutes (SC-013), in `web/tests/e2e/recovery.spec.ts`

### Implementation for User Story 10

- [ ] T139 [US10] Implement `POST /recovery/devices` (signature by the identity key re-derived from the Recovery Key, rate limited; deletes every earlier Device, its tokens, push subscriptions and delivery tokens, and sends `device-unlinked` with reason `recovered`) and `GET /backup` by access token in `server/src/accounts/recovery.rs` and `server/src/blobs/backup.rs`
- [ ] T140 [US10] Implement the encrypted Backup of Contacts, Group memberships and history, uploaded with its access-token hash, in `web/src/crypto/backup.ts`
- [ ] T141 [US10] Implement rejoin requests: the recovered Device sends its new key package and Device certificate to each Contact; a Contact's Device verifies the certificate chain to the stored identity key and, in one commit, removes the Account's stale leaves and adds the new Device, in `web/src/crypto/rejoin.ts` and `crypto-wasm/src/rejoin.rs`
- [ ] T142 [US10] Implement the recovery flow: enter the key, add a new Device, restore the Backup read-only, send rejoin requests to Contacts using delivery tokens from the Backup, show "waiting to be added", and explain plainly when no Backup exists, in `web/src/app/screens/Recover.tsx` and `web/src/crypto/restore.ts`
- [ ] T143 [US10] Security and simplicity review for US10 (a reviewer other than the author can explain the code; complexity limits met), then update `threat-model.md` and `data-inventory.md`

**Checkpoint**: A user can lose every Device and still recover their Account.

---

## Phase 13: Polish and Cross-Cutting Concerns

**Purpose**: Cross-cutting requirements, assurance and launch readiness

- [ ] T144 [P] Accessibility audit against WCAG 2.2 AA with fixes in `web/src/app/`
- [ ] T145 [P] Publish the Data Inventory, privacy policy and `security.txt` in `docs/data-inventory.md`, `docs/privacy.md` and `web/public/.well-known/security.txt`
- [ ] T146 [P] Write the security whitepaper in `docs/whitepaper.md`
- [ ] T147 [P] Write the incident response plan (roles, severities, 24-hour critical mitigation, key rotation, forced update, signing-key revocation, and a blameless public post-mortem template) in `docs/incident-response.md`
- [ ] T148 [P] Write tests then implement the operator lawful-request export that returns only account creation date and last connection date in `server/src/bin/lawful_export.rs` (test in `server/tests/lawful_request.rs` first; FR-036, SC-008)
- [ ] T149 [P] Write the transparency report template and publication process for legal requests in `docs/transparency-report.md` (Constitution XI)
- [ ] T150 [P] Add tests for cleared browser storage (the Device becomes unlinked and asks to re-link), simultaneous sends from two Devices (same order everywhere) and a skewed Device clock (timers and ordering still correct) in `web/tests/e2e/edge_cases.spec.ts`
- [ ] T151 Run usability studies for SC-001, SC-002 and SC-010 (timed sign-up, first-attempt install, Safety Code warning comprehension) and record results in `docs/usability-results.md`
- [ ] T152 Run load tests for 10,000 concurrent connections against SC-003 and SC-011 in `server/tests/load/`
- [ ] T153 Run the full quickstart scenarios in `specs/001-secure-realtime-chat/quickstart.md` and record results
- [ ] T154 Publish client and server source and the reproducible-build verification instructions in `docs/verify-build.md`
- [ ] T155 Simplicity audit: remove unused code, options and dependencies, confirm every complexity limit and coverage threshold is met, and record deferred features in `docs/deferred.md`
- [ ] T156 Commission the independent audit (cryptography, application, infrastructure); fix all critical and high findings before public launch

---

## Dependencies & Execution Order

- **Setup (Phase 1)**: no dependencies; start immediately.
- **Foundational (Phase 2)**: depends on Setup and blocks all stories. T013 and T014 (threat model and the MLS spike) come first; their outcome can change T030.
- **User stories**: all depend on Phase 2. US1 first; US2 and US3 need US1's Conversation but are otherwise independent; US4 to US10 depend only on Phase 2 plus US1 for message flow.
- **Recovery (Phase 12)**: needs US1 (Recovery Key at sign-up) and the Device add and remove commits from US4. Its Backup storage uses the object storage set up in T029; the Backup endpoint does not depend on US8. Polish (Phase 13) comes last. T156 follows everything else.
- Within a story: tests, then models, then services and endpoints, then UI, then the security review.

## Parallel Opportunities

- Setup tasks T002 to T012 touch separate files.
- In Phase 2: T015, T016, T017 in parallel; then T020, T021, T024, T025, T029 in parallel on the server side while T031, T033, T035, T037, T040 run on the client side.
- After Phase 2, US2, US3, US4 and US6 can be built in parallel by different people.
- All tests marked [P] within a story run in parallel.

## Implementation Strategy

1. **MVP**: Phases 1, 2, then US1, US2 and US3. This delivers private 1:1 chat with verification and phone install, which is the core promise.
2. Release to a closed group only after the audit (T156). Public launch needs zero open critical or high findings (SC-009).
3. Add US4 to US7 and US10 next (devices, Groups, device protection, disappearing messages, recovery), then US8 and US9.
4. If the T014 spike fails, switch to mls-rs and update ADR 0002 before continuing.

## Notes

- The constitution requires a threat-model task, security tests first, a security review, a simplicity review and a Data Inventory update for the feature; these are T013, the test tasks in each story, the review task closing each story, the simplicity audit, and T145. Complexity limits, coverage thresholds and mutation testing (Principle XIII) are set up in T005 and the coverage task that follows T006.
- Voice and video calls are out of scope (spec Assumptions).
