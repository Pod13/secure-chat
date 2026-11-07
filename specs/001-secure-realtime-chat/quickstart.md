# Quickstart: Validation Guide

Runnable scenarios that prove the feature works end to end. Contracts: [http-api.md](contracts/http-api.md), [realtime-frames.md](contracts/realtime-frames.md). Entities: [data-model.md](data-model.md). Setup commands will be filled in by the tasks phase once the repository scaffolding exists.

## Prerequisites

- Rust stable, Node LTS, PostgreSQL, an S3-compatible store (local MinIO is fine), two browser profiles (or one browser plus one phone).
- A test KMS stub; production keys are never used. Production data is never copied to test environments.

## Scenario 1: Two people, one encrypted conversation (Story 1)

1. Start the server and the web app.
2. Operator issues a seed Invite; browser A signs up with it (username plus passcode, no phone or email).
3. A creates a Contact Invite; browser B opens it, signs up, and lands in a Conversation with A.
4. A sends a message; B sees it within 1 s. Take B offline, send again, reconnect, and confirm delivery and sent/delivered status.
5. **Expected**: the server-adversary harness dumps all tables, blobs, logs and traffic and finds only ciphertext and Data Inventory fields.

## Scenario 2: Identity verification (Story 2)

Compare Safety Codes; mark Verified. Reinstall A's app; B sees a blocking warning and the Contact becomes unverified before any further message is sent.

## Scenario 3: Install on phones (Story 3)

Open the app on Android Chrome and iOS Safari (16.4+); follow the guided install; open full-screen; receive an empty-payload push and confirm it contains no text or sender name.

## Scenario 4: Devices and Groups (Stories 4, 5)

Link a laptop by scanning a QR code from the phone; unlink it and confirm it loses access and wipes. Create a Group of 5, remove one Member, and confirm the removed Member decrypts 0% of later messages.

## Scenario 5: Device protection and expiry (Stories 6, 7)

Lock the app, copy IndexedDB, and confirm nothing is readable. Set a 5-minute timer and confirm messages vanish from all Devices and the server.

## Scenario 6: Client integrity (FR-033)

Serve a modified asset from the server; confirm the service worker refuses to load it and shows a clear warning.

## Scenario 7: Recovery (Story 10)

Sign up and save the Recovery Key, turn on Backup, send messages, then wipe every Device. Recover on a fresh browser with the key: the Account works, history from the last Backup is readable, and Contacts see a new-Device warning. Keep one other Device signed in beforehand and confirm it is signed out with an explanation. Repeat with a wrong key and confirm nothing is revealed.

## Test suites

Unit and contract tests (Vitest, cargo test), property tests (proptest), fuzzers (cargo-fuzz) on parsers and MLS handling, Playwright end-to-end for Scenarios 1–7, plus the server-adversary harness. Security tests are written before implementation (Constitution X).
