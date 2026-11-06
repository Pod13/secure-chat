# Threat Model (STRIDE): Secure Real-Time Chat

Covers the seven attackers required by Constitution X. "Residual" means the risk remains after the listed control and is accepted or tracked.

| Attacker | Threat (STRIDE) | Control | Residual |
|----------|-----------------|---------|----------|
| Compromised server | Information disclosure: read content or Contacts | E2EE with MLS; server stores ciphertext and the Data Inventory only | Timing, recipient and size buckets visible |
| | Spoofing: insert a key or Device | New Devices need existing-Device approval; Safety Codes; key-change warnings | Unverified Contacts may ignore warnings; key transparency deferred |
| | Tampering: swap the web client | Signed manifest, pinned assets, CSP, SRI, Trusted Types | First load of a new install trusts the server (research R3) |
| | Denial of service: drop or delay messages | Delivery status shown to sender; offline queue | Cannot prevent withholding |
| Network attacker | Eavesdrop, tamper, downgrade | TLS 1.3 only, HSTS preload, E2EE inside TLS | Traffic analysis of timing |
| | Replay | MLS epoch and generation checks; queue de-duplication | |
| Malicious Contact | Spam or harassment | Block revokes delivery token; reporting; per-token rate limits | New Contacts can still send before being blocked |
| | Impersonation via lookalike usernames | Usernames shown only to Contacts after Invite; Safety Codes | Social engineering |
| | Malformed content | Strict schemas, size limits, fuzzed parsers | |
| Malicious Group Member | Read after removal | MLS commit rotates keys on removal | Member keeps what they already received |
| | Forge admin actions | Admin roles enforced by Members' Devices from signed MLS state | |
| | Flood a Group | Per-token limits; admins can remove | |
| Stolen device | Read local data | All records encrypted; Argon2id passcode; auto-lock; optional wipe | Weak passcodes; no secure hardware on web |
| | Screen capture | Content hidden in app switcher; screenshot blocking where the platform allows | iOS cannot block screenshots (warned) |
| Compromised dependency | Supply-chain code execution | Exact pins, lockfile hashes, SBOM, provenance, review of crypto/auth/client dependencies, CSP | A malicious update in an audited crypto library |
| Malicious insider | Read data, push a bad client | No plaintext on servers; break-glass access with alerts; signed reproducible builds; two-person release | Insider with signing key and server control, mitigated by public build verification |

## Security tests required (written first)

1. A server-adversary harness inspects every table, queue, blob, log and metric during end-to-end flows and fails on any plaintext or key.
2. A key-change test shows a blocking warning for Verified Contacts before the next send.
3. A removal test shows a removed Member decrypts 0% of later messages.
4. A device-link test shows no Device can be added without an existing-Device signature.
5. A client-integrity test shows the service worker refuses an asset not in the manifest.
6. A local-storage test shows no readable data in IndexedDB or caches with the app locked.
7. Fuzzing covers every network parser and the MLS message handling.
