# Data Model: Secure Real-Time Chat

Vocabulary follows [GLOSSARY.md](../../GLOSSARY.md). Two stores exist: the **server** (untrusted, minimal) and the **Device** (encrypted at rest). Retention lists are mirrored in [data-inventory.md](data-inventory.md).

## Server-side entities

### Account
| Field | Type | Notes |
|-------|------|-------|
| account_id | random 128-bit | Only identifier; no username, phone or email |
| identity_public_key | bytes | Long-term identity key |
| created_at | date | Day precision; producible to lawful requests (FR-036) |
| last_connected_at | date | Day precision; producible to lawful requests |
| invite_used | token hash | Which Invite created it, deleted after 30 days |

### Device
| Field | Type | Notes |
|-------|------|-------|
| device_id | random 128-bit | |
| account_id | ref | |
| device_public_key | Ed25519 | Authentication |
| mls_key_packages | list | Public, single-use, replenished by the Device |
| push_subscription | opaque | Empty-payload wake-up endpoint |
| linked_at | date | |

State: `pending-approval` -> `active` -> `unlinked` (record deleted). Approval requires a signature by an existing active Device.

### Delivery token
| Field | Type | Notes |
|-------|------|-------|
| token_hash | hash | Maps to a recipient Device queue |
| device_id | ref | |
| revoked | bool | Blocks enforced here |

### Queued envelope
| Field | Type | Notes |
|-------|------|-------|
| envelope_id | random | |
| recipient_device_id | ref | |
| ciphertext | bytes | Padded MLS message, bucketed size |
| enqueued_at | timestamp | |
| expires_at | timestamp | enqueued_at + 30 days maximum |

Deleted when the recipient Device acknowledges it, or at expiry.

### Invite (service, Contact or Group)
| Field | Type | Notes |
|-------|------|-------|
| invite_token_hash | hash | |
| kind | enum | `service`, `contact`, `group` |
| expires_at, max_uses, uses | | Group Invites may also require admin approval, which is enforced by Group admins' Devices, not the server |
| revoked | bool | |

### Attachment blob and Backup blob
Opaque encrypted objects keyed by random IDs. Attachments are deleted when all recipients have fetched them or after the retention limit (30 days). Each Account has at most one Backup blob, overwritten on update, deleted with the Account.

## Device-side entities (encrypted in IndexedDB)

- **Profile**: username, avatar, privacy settings.
- **Contact**: peer Account ID, username, verification state (`unverified` | `verified`), delivery token to reach them, block flag, "block on key change" flag.
- **Conversation**: MLS group state, disappearing timer, mute settings, draft.
- **Group**: name, avatar, Members, admin roles, Invite settings (all inside MLS state or encrypted app messages).
- **Message**: id, sender, body, attachments, reactions, edits, reply reference, status (`sending` | `sent` | `delivered` | `read`), timestamps, expiry.
- **Outgoing queue entry**: encrypted message waiting for connectivity, with a client-generated id for de-duplication.
- **Key material**: Device private key, MLS credentials and secrets; wrapped by the data key.

## Relationships

- Account 1 - N Device.
- Device 1 - N Delivery token; Device 1 - N Queued envelope.
- Contact exists only on Devices, one per peer Account; it is never uploaded.
- Conversation (1:1) = two-member MLS group; Group = N-member MLS group. Membership is known to Devices, not the server.

## Validation rules

- All inbound network messages are checked against JSON Schemas in `contracts-schema/` with strict size limits before processing.
- Attachments over 100 MB, Groups over 256 Members, and Backups over the configured cap are rejected client-side and server-side.
- Disappearing timers start at first view and are enforced by each Device; an expired message and its attachment keys are erased locally.
