# Storage encryption and backups

Everything the server stores is already ciphertext or minimal metadata (`specs/001-secure-realtime-chat/data-inventory.md`). Encryption at rest is a second layer, so a stolen disk, snapshot or backup reveals nothing readable even about the metadata.

## Rules

1. **PostgreSQL**: the volume (or managed-service storage) MUST be encrypted with a customer-managed KMS key. Automated backups, snapshots and read replicas inherit that key. Unencrypted replicas or snapshots are not allowed.
2. **Object storage** (attachment and Backup blobs): the bucket MUST enforce default server-side encryption with a customer-managed KMS key, block all public access, and deny any request not made over TLS 1.3 (bucket policy `aws:SecureTransport` or the provider's equivalent).
3. **Separate keys**: one KMS key for the database, one for object storage. The server's runtime role may use the object-storage key only to read and write blobs. It has no permission to change key policies, disable keys or schedule key deletion; those belong to a separate administrator role with two-person approval.
4. **Key rotation**: automatic yearly rotation is on. The manual rotation and emergency-revocation steps are in `docs/operations.md` (T044).
5. **No keys in the database**: no KMS key material, token or Recovery Key is ever stored in PostgreSQL. Only hashes of tokens are stored, as the schema shows.

## Backup retention matches live data

A backup must not keep data longer than the live system is allowed to. Messages are deleted on delivery and expire after 30 days, so:

| Item | Retention |
|------|-----------|
| PostgreSQL point-in-time recovery window | 7 days |
| PostgreSQL snapshots | 7 days, then deleted automatically |
| Object-storage versioning | Off for blobs, so deleting a blob deletes it. If the provider forces versioning, a lifecycle rule deletes non-current versions after 1 day |
| Logs of the storage layer | 30 days at most, and they hold no message data |

Restoring a snapshot can bring back envelopes or blobs that were already delivered and deleted. After every restore the retention job (`server/src/retention/`) MUST run before the service takes traffic, and the restore runbook records that it did. Because the window is 7 days and the longest data lifetime is 30 days, no restored row can outlive its own expiry.

## Verification

These settings live in the cloud account, so tests cannot prove them. Before launch and then every quarter, an operator who did not apply the settings runs this check and records the result in the operations log:

- [ ] The database volume, every snapshot and every replica report the customer-managed key.
- [ ] Creating a bucket object without encryption headers still produces an encrypted object.
- [ ] A plain `http://` request to the bucket is denied.
- [ ] A listing of public access settings shows everything blocked.
- [ ] The server role cannot call the key-deletion or key-policy APIs (try it and expect `AccessDenied`).
- [ ] The oldest snapshot is no older than 7 days.
