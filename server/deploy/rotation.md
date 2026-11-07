# Rotating secrets and KMS keys

Secrets never live in code, images or the repository; the server reads them from its environment and from files mounted by the secrets manager (`config.rs`, `tls.md`). Rotation is therefore a **rolling restart**: start a new instance with the new material, check it is healthy, move traffic, stop the old instance. `server/tests/rotation.rs` rehearses this with real TLS handshakes and proves the failure modes close safely.

## What rotates, and how often

| Secret | Where it lives | Routine rotation | Rotate at once when |
|--------|----------------|------------------|---------------------|
| TLS certificate and key | `TLS_CERT_FILE`, `TLS_KEY_FILE` (secrets manager) | Before expiry (automated renewal, at most 90 days) | The key may have been read by anyone not authorised |
| Database credentials | `DATABASE_URL` (secrets manager) | Every 90 days | A person with access leaves, or the URL appears in a log or ticket |
| KMS keys for storage (`storage.md`) | KMS | Automatic yearly rotation | A key policy was changed unexpectedly, or an administrator account is suspect |
| Manifest-signing keys | HSM; public keys in `build/signing-keys.json` | Yearly | The HSM or a signer is suspect; see "Signing keys" below |

## Rolling restart (TLS and database credentials)

1. Put the new material in the secrets manager. For the database, create the new credential **alongside** the old one (two roles or two passwords) so both work during the change.
2. Start a new instance with the new files and `DATABASE_URL`. It refuses to start if the certificate and key do not match, or if either file is missing or unreadable (rehearsed by `the_new_instance_is_not_taken_into_service_if_its_material_is_wrong` and `missing_empty_or_garbage_files_are_refused`). A refusal prints no key material (`refusals_never_repeat_key_material`).
3. Check `GET /healthz` over TLS 1.3 against the new instance and confirm it presents the new certificate.
4. Move traffic to the new instance. The old and new instance can run together during this step (`both_instances_can_run_side_by_side_during_the_changeover`).
5. Stop the old instance, then **remove the old database credential** and confirm the old `DATABASE_URL` no longer connects.
6. Record the date, who did it, and the next due date in the operations log.

Devices reconnect on their own: the WebSocket client retries with growing, jittered delays (`web/src/net/socket.ts`), and sessions are short-lived, so no user action is needed.

## KMS keys

- Automatic yearly rotation is switched on for the database and object-storage keys. Old key versions stay available only to decrypt existing data.
- Manual or emergency rotation: create a new key version, re-encrypt the volume or bucket with it, verify, then schedule the old version for deletion only after the backup window in `storage.md` (7 days) has passed, so that no backup still needs it.
- Never grant the server's runtime role permission to change key policies, disable keys or schedule deletion (`storage.md`, rule 3).

## Signing keys

Handled by `build/rotate-signing-key.ts`; the app trusts only keys pinned in its build and carried in signed manifests (`web/src/sw/keys.ts`).

- **Planned rotation:** generate the new key in the HSM, run `node build/rotate-signing-key.ts add <id> <public-key>`, ship a release signed by the old key (it introduces the new key), then sign later releases with the new key.
- **Revocation:** run `node build/rotate-signing-key.ts revoke <id>` and ship a release signed by a still-trusted key. Installed apps then refuse anything signed by the revoked key, and no later release may drop the revocation. The tool refuses to revoke the last trusted key, so add the replacement first.

## Drill

Every quarter, a person other than the last operator follows this page on staging, from step 1 to step 6, and records the result. A drill that cannot be completed from this page alone is a defect in this page. After any real incident, add what was learned here.
