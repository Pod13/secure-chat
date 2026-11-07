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
| Compromised server | Information disclosure: learn who contacts whom through key-package fetches | Key packages fetched with a delivery token or Invite token, no account authentication, no requester logged | Timing and IP-prefix correlation within the 7-day abuse window |
| Stolen Recovery Key | Elevation of privilege: attacker recovers the Account | Contacts warned; every earlier Device is signed out with a visible reason; Backup holds no Device or MLS keys; recovery attempts rate limited | Attacker with the key reads the last Backup and receives future messages until the owner recovers again |
| Forged rejoin request | Spoofing: someone claims to be a recovered Device | Contacts' Devices verify the Device certificate chain to the stored identity key before adding it | Contacts who ignore the new-Device warning |
| Compromised signing key | Tampering: malicious client signed by a stolen key | Key pinning with rotation and revocation list; forced update floor | Window between theft and revocation |
| Unlinked Device | Information disclosure: still decrypts later messages | Remove commit from every Conversation group plus token revocation | A device offline during removal keeps already-received messages |

## Security tests required (written first)

1. A server-adversary harness inspects every table, queue, blob, log and metric during end-to-end flows and fails on any plaintext or key.
2. A key-change test shows a blocking warning for Verified Contacts before the next send.
3. A removal test shows a removed Member decrypts 0% of later messages.
4. A device-link test shows no Device can be added without an existing-Device signature.
5. A client-integrity test shows the service worker refuses an asset not in the manifest.
6. A local-storage test shows no readable data in IndexedDB or caches with the app locked.
7. Fuzzing covers every network parser and the MLS message handling.
8. Retention jobs purge every Data Inventory row at its stated age.
9. Account creation leaves no stored or logged link between the Invite and the new Account.
10. A key-package fetch needs no account authentication and logs no requester.
11. After unlinking, the Device is removed from every Conversation and decrypts 0% of later messages.
12. The server cannot derive the Recovery Key, the identity private key or the Backup key from stored data.
13. A manifest signed by a revoked key, or below the minimum version, is rejected by the service worker.
14. The lawful-request export returns only account creation date and last connection date.
15. Recovery signs out every earlier Device, deletes its server records, and removes its leaves from every Conversation.
16. Adding a Device by link or recovery alerts all the Account's other Devices.
17. A rejoin request with an invalid certificate chain is rejected.

## Sign-off

| Date | Reviewer | Scope | Outcome |
|------|----------|-------|---------|
| _pending_ | Project owner | This threat model, constitution 1.2.1 and the accepted risks in `docs/accepted-risks.md` | Not yet signed off. Fill in the date and name, then mark T013 done. |

The threat model is reviewed again at the close of each user story (the review task in each phase) and whenever a mitigation changes.
