<!--
Sync Impact Report
- Version change: (unfilled template) → 1.0.0
- Modified principles: none renamed (previous file contained only template placeholders)
- Added principles: I–XII (all new)
- Added sections: Security Requirements & Constraints, Development Workflow & Quality Gates, Governance
- Removed sections: none
- Templates requiring updates (NOT modified by this command; follow-up needed):
  ⚠ .specify/templates/plan-template.md — Constitution Check must list Principles I–XII as gates
  ⚠ .specify/templates/spec-template.md — security & privacy requirements section must be mandatory
  ⚠ .specify/templates/tasks-template.md — every feature must include threat-model, security-test and review tasks
- Follow-up TODOs: update the three templates above
-->

# Secure Real-Time Chat Constitution

This constitution is the highest authority for this project. Every spec, plan, task, line of code, dependency, and operational decision must comply with it. When a requirement, deadline, or convenience conflicts with this document, this document wins.

**The core promise:** *No one except the people in a conversation can ever read it. Not the operator, not the hosting provider, not a network attacker, not someone holding a server backup, and not someone who steals a locked device.*

---

## Core Principles

### I. Zero-Trust Server (NON-NEGOTIABLE)

The server, its operators, its infrastructure provider, and anyone who gains access to them are treated as **adversaries**.

- The server MUST never receive, process, store, or log plaintext message content, attachments, reactions, edits, group names, group avatars, profile data, or contact lists.
- The server MUST never hold, generate, escrow, or be able to derive any user's private keys or message keys.
- No feature, admin tool, support process, debug mode, or legal request may require the server to access plaintext. If a feature requires it, the feature is rejected.
- Design reviews MUST answer: *"What can a fully compromised server learn or do?"* The answer must be documented and acceptable.

**Rationale:** Encryption the operator can bypass is a promise, not a guarantee. Security must not depend on anyone being trustworthy.

### II. End-to-End Encryption by Default, Everywhere (NON-NEGOTIABLE)

- All user content MUST be end-to-end encrypted on the sender's device before it leaves, and decrypted only on recipient devices.
- E2EE MUST be on by default, always on, and impossible to disable. There MUST be no unencrypted mode, no "server-side" chat type, and no plaintext fallback.
- Every protocol MUST provide **forward secrecy** and **post-compromise security**.
- Group messaging MUST guarantee that removed members cannot read later messages and new members cannot read earlier messages.
- Each device MUST have its own keys. Compromise of one device MUST NOT expose another device's keys.

**Rationale:** Security that users must enable will not be used. Partial encryption creates false confidence.

### III. No Custom Cryptography (NON-NEGOTIABLE)

- Only established, publicly specified, peer-reviewed protocols are permitted (e.g. Signal Protocol / X3DH-PQXDH + Double Ratchet for 1:1; MLS (RFC 9420) or Sender Keys for groups).
- Only well-maintained, audited cryptographic libraries are permitted (e.g. libsignal, OpenMLS, libsodium, platform WebCrypto). Hand-written implementations of primitives, protocols, padding, or key derivation are forbidden.
- Algorithms MUST be current and strong: AES-256-GCM or XChaCha20-Poly1305 for symmetric encryption; X25519 / Ed25519 for key agreement and signatures; HKDF for key derivation; Argon2id for passcode-derived keys. Broken or deprecated algorithms (MD5, SHA-1, RSA < 3072, ECB, CBC without MAC, etc.) are forbidden.
- The design MUST be **crypto-agile**: algorithms and protocol versions are versioned so they can be replaced without breaking the system.
- A **post-quantum** hybrid key agreement (e.g. ML-KEM combined with X25519) MUST be on the roadmap and adopted once supported by the chosen audited libraries.
- Any change to cryptographic code or configuration requires review by a designated cryptography reviewer.

**Rationale:** Almost all real-world cryptographic failures come from custom designs and implementation mistakes, not from broken mathematics.

### IV. Metadata Minimisation

Metadata is data. Who talks to whom, when, and how often can be as sensitive as content.

- The server MUST collect only metadata strictly required to route and deliver messages, and MUST delete it as soon as it is no longer needed.
- Accounts MUST NOT require phone numbers, email addresses, or real names.
- The design SHOULD hide sender identity from the server (sealed-sender-style delivery) and SHOULD keep group membership and social graphs opaque to the server.
- Message sizes SHOULD be padded to fixed buckets to reduce traffic analysis.
- Every metadata field the server stores MUST be listed in a public **Data Inventory** with its purpose and retention period. Anything not in the inventory MUST NOT be stored.

**Rationale:** Strong content encryption is undermined if the server can still build a map of who knows whom.

### V. Data at Rest: Encrypted, Minimal, Ephemeral

**On the server:**
- Encrypted messages MUST be deleted immediately after delivery to all recipient devices; undelivered messages MUST expire after a fixed maximum period (default 30 days).
- All server storage (databases, object storage, queues, backups, snapshots) MUST be encrypted at rest with keys held in a managed KMS/HSM, separate from the data, with rotation and access logging.
- Backups MUST contain no more than the live system does, and MUST follow the same retention rules.

**On the device:**
- All local data (messages, keys, attachments, search index, contacts, drafts, cache) MUST be encrypted at rest.
- Keys MUST be protected by the platform's secure hardware or key store (Android Keystore / StrongBox, iOS Secure Enclave / Keychain) or, on web, by a non-extractable WebCrypto key wrapped with an Argon2id passcode-derived key or WebAuthn.
- Decrypted content MUST NOT be written to unencrypted locations: no plaintext in OS logs, crash reports, clipboard history (where avoidable), file caches, thumbnails, notification history, or system backups.
- The app MUST support app lock, auto-lock timeout, content hiding in the app switcher, and optional wipe after failed unlocks.

**Rationale:** Data that is not stored cannot be stolen. Data that must be stored must be useless without keys the attacker does not have.

### VI. Verifiable Identity and Trust

- Users MUST be able to verify contacts out-of-band (safety numbers and QR codes).
- Any change to a contact's identity key or device list MUST produce a clear, unmissable warning before the next message is sent.
- New devices MUST be linkable only by approval from an existing device, never by password or server action alone.
- The server MUST NOT be able to silently add a device or key to any account. Key-directory changes SHOULD be published to an append-only, publicly auditable transparency log (key transparency).

**Rationale:** E2EE is only as strong as the guarantee that you are encrypting to the right person.

### VII. Verifiable Client Integrity

The web client is the hardest place to keep this promise, because a compromised server can serve malicious JavaScript.

- Web builds MUST be reproducible, signed, and published with hashes. Users and auditors MUST be able to verify that running code matches the published, reviewed source.
- The web app MUST use a strict Content Security Policy (no `unsafe-inline`, no `unsafe-eval`, no third-party script origins), Subresource Integrity on all assets, Trusted Types, and HSTS with preload.
- Mobile builds MUST be reproducible where the platform allows and MUST be signed with keys held in an HSM, never on developer machines.
- No client may load remote code at runtime (no remote scripts, dynamic code download, or over-the-air updates that bypass review and signing).

**Rationale:** If the code that holds the keys can be swapped without detection, every other principle can be bypassed.

### VIII. Secure by Default, Simple to Use

- The secure choice MUST be the default and MUST require no configuration. A user who never opens settings MUST receive full protection.
- Security warnings MUST be plain-language, actionable, and rare enough not to be ignored.
- Usability features (previews, backups, search, link previews, notifications) MUST NOT weaken security. If they cannot be built without weakening it, they ship disabled or not at all.
- Link previews, if offered, MUST be generated on the sender's device and MUST NOT leak recipient activity to third parties.
- Push notifications MUST carry no content or sender identity through third-party push services.

**Rationale:** Security that is confusing gets bypassed. Simplicity is a security feature.

### IX. Minimal Attack Surface and Supply-Chain Discipline

- Every dependency MUST be justified, pinned to an exact version, locked with integrity hashes, and continuously scanned for vulnerabilities.
- New dependencies in client code, crypto code, or authentication code require security review. Prefer fewer, well-known, well-maintained dependencies.
- No analytics, advertising, crash-reporting, or tracking SDKs from third parties are permitted in any client. Any telemetry MUST be opt-in, aggregated, contain no content or identifiers, and be listed in the Data Inventory.
- Build pipelines MUST be hardened: signed commits, protected branches, least-privilege CI credentials, isolated build runners, SBOM generated for every release, and provenance attestation (SLSA Level 3 target).
- Services MUST run with least privilege, network segmentation, and no direct human access to production data stores without break-glass procedures that are logged and alerted.

**Rationale:** Most modern breaches arrive through dependencies, build systems, and over-privileged access, not through cryptography.

### X. Threat Modelling and Security Testing First

- Every feature MUST have a written threat model (STRIDE or equivalent) before implementation, covering: compromised server, network attacker, malicious contact, malicious group member, stolen device, compromised dependency, and malicious insider.
- Every security requirement MUST have automated tests written before the implementation (test-first).
- CI MUST run on every change: static analysis (SAST), dependency scanning, secret scanning, and security unit / integration tests. Crypto and parsing code MUST be fuzz-tested.
- Security-critical code MUST be written in memory-safe languages (e.g. Rust, TypeScript, Kotlin, Swift). Unsafe blocks or native code require explicit justification and review.
- All input from the network, including from other clients, MUST be treated as hostile and validated with strict schemas and size limits.

**Rationale:** Security cannot be added at the end; it has to be designed in and proven by tests.

### XI. Independent Assurance and Transparency

- An independent security audit (cryptography, application, and infrastructure) MUST be completed before public launch, before any major cryptographic change, and at least annually. All critical and high findings MUST be fixed before release.
- Client and server source code MUST be published for public review.
- The project MUST publish and keep current: a security whitepaper, the Data Inventory, a plain-language privacy policy, and a transparency report of all legal requests received and what was (or could be) handed over.
- The project MUST operate a responsible disclosure policy with a published `security.txt` and, once feasible, a bug bounty.
- The project SHOULD maintain a warrant canary.

**Rationale:** Users should not have to take security claims on faith. Claims that are verifiable are claims that can be trusted.

### XII. Incident Readiness

- A written incident response plan MUST exist before launch, with defined roles, severity levels, and response times (critical vulnerabilities: mitigation within 24 hours, disclosure to affected users without undue delay).
- The system MUST support rapid key rotation, forced client updates for critical fixes, and revocation of compromised signing keys.
- Logs needed for incident response MUST be structured, tamper-evident, and contain no user content, keys, or unnecessary identifiers.
- Incidents MUST be followed by a blameless public post-mortem.

**Rationale:** Assume breach. Being ready limits the damage when something goes wrong.

---

## Security Requirements & Constraints

**Transport**
- TLS 1.3 only; HSTS with preload; certificate pinning on mobile clients with a backup pin and rotation plan.
- Real-time connections (e.g. WebSockets) MUST be authenticated per connection and MUST NOT carry plaintext content even within TLS.

**Authentication & sessions**
- Device authentication MUST use device-held key pairs, not passwords sent to the server.
- Session tokens MUST be short-lived, bound to the device, and revocable instantly when a device is unlinked.
- Rate limiting and abuse controls MUST work without access to message content.

**Account recovery**
- The operator MUST NOT be able to recover any account or content. Recovery is only possible with a user-held recovery key or user-created encrypted backup. The UX MUST make this trade-off clear at sign-up.

**Data handling**
- Logs, metrics, traces, and error reports MUST NOT contain content, keys, tokens, or full IP addresses. IP-derived data used for abuse prevention MUST be retained no more than 7 days.
- Secrets MUST live in a secrets manager, never in code, config files, images, or environment dumps.
- Production data MUST NEVER be copied to development or test environments.

**Lawful requests**
- The system MUST be designed so that the only data the operator can produce is: account creation date and last connection date. Any design that would let more be produced violates Principle I and IV.

**Compliance**
- The project MUST comply with POPIA, GDPR, and any other applicable data-protection laws. Compliance is a floor, not the goal; this constitution's requirements are stricter.

**Forbidden, without exception**
- Plaintext content or private keys on any server.
- Key escrow, backdoors, "lawful access" mechanisms, or master keys.
- Server-side content scanning, including client-side scanning that reports to the server without the user's explicit, per-message action.
- Third-party trackers, ad SDKs, or analytics in clients.
- Custom or unreviewed cryptography.
- Remote code loading in clients.
- Disabling or weakening E2EE for any feature, user, or environment, including tests that run against production.

---

## Development Workflow & Quality Gates

**Spec phase (`/speckit.specify`)**
- Every spec MUST include a security & privacy section stating what data the feature creates, where it lives, who can read it, and how long it lasts.

**Plan phase (`/speckit.plan`) — Constitution Check (blocking gate)**
Every plan MUST pass, and document, the following before tasks are generated:
1. Server learns nothing new in plaintext (I, II).
2. Only approved protocols and libraries are used (III).
3. New metadata is justified, minimised, and added to the Data Inventory (IV).
4. Storage, retention, and deletion are defined for server and device (V).
5. Identity and device-trust impact is assessed (VI).
6. Client integrity is preserved; no remote code (VII).
7. Secure defaults require no user configuration (VIII).
8. New dependencies are reviewed and justified (IX).
9. A threat model exists and security tests are listed (X).
Any violation MUST be recorded in the plan's Complexity Tracking table with justification, and violations of NON-NEGOTIABLE principles cannot be justified; the plan must change.

**Tasks phase (`/speckit.tasks`)**
- Every feature's task list MUST include: threat-model task, security test tasks (written first), security review task, and Data Inventory / documentation update task.

**Implementation & review**
- Every change requires at least one approving review; changes to crypto, authentication, key management, storage, or client integrity require approval from a designated security reviewer as well.
- CI security checks MUST pass; they cannot be bypassed or marked optional.
- Security debt MUST be tracked and prioritised; critical security debt blocks release.

**Release**
- Every release MUST be reproducibly built, signed, accompanied by an SBOM and provenance attestation, and free of known critical or high vulnerabilities.

---

## Governance

- This constitution supersedes all other practices, preferences, and deadlines.
- Amendments require: a written proposal, review by the security lead, an updated Sync Impact Report, and a migration plan for existing code and data.
- Principles marked **NON-NEGOTIABLE** (I, II, III) may be strengthened but MUST NEVER be weakened or removed.
- Versioning follows semantic versioning: **MAJOR** for removing or redefining a principle (never permitted to weaken a NON-NEGOTIABLE one), **MINOR** for adding a principle or materially expanding guidance, **PATCH** for clarifications and wording.
- Compliance MUST be reviewed at every plan, every pull request touching security-sensitive areas, every release, and in a full constitution audit at least every six months.
- Any team member may raise a constitution violation; violations block merge and release until resolved.

**Version**: 1.0.0 | **Ratified**: 2026-11-07 | **Last Amended**: 2026-11-07
