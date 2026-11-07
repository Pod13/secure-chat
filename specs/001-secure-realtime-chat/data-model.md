# Data Model: Secure Real-Time Chat

Vocabulary follows [GLOSSARY.md](../../GLOSSARY.md). Two stores exist: the **server** (untrusted, minimal) and the **Device** (encrypted at rest). Retention lists are mirrored in [data-inventory.md](data-inventory.md).

## Server-side entities

### Account
| Field | Type | Notes |
|-------|------|-------|
| account_id | random 128-bit | Only identifier; no username, phone or email |
| identity_public_key | bytes | Long-term identity key, derived from the Recovery Key. Its private half exists only at sign-up and during recovery, where it signs Device certificates |
| created_at | date | Day precision; producible to lawful requests (FR-036) |
| last_connected_at | date | Day precision; producible to lawful requests |

### Device
| Field | Type | Notes |
|-------|------|-------|
| device_id | random 128-bit | |
| account_id | ref | |
| device_public_key | Ed25519 | Authentication |
| mls_key_packages | list | Public, single-use, replenished by the Device |
| push_subscription | opaque | Empty-payload wake-up endpoint |
| linked_at | date | |
| label_blob | encrypted | Device name, type and the Device's own last-active date, encrypted under the Account label key shared by the Account's Devices; unreadable by the server |

State: `pending-approval` -> `active` -> `unlinked` (record deleted). Approval requires a signature by an existing active Device.

### Delivery token
| Field | Type | Notes |
|-------|------|-------|
| token_hash | hash | Maps to a recipient Device queue |
| device_id | ref | |
| revoked | bool | Blocks enforced here |

A delivery token also authorises fetching key packages of its Device (`POST /key-packages/fetch`), so the server never learns who is asking.

### Queued envelope
| Field | Type | Notes |
|-------|------|-------|
| seq | integer | Arrival order within the queue. Internal; never sent to a client. Keeps delivery in order within one second |
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
| owner_account_id | ref | The creator, needed to revoke. The redeemer is never stored |
| kind | enum | `service`, `contact`, `group` |
| expires_at, max_uses, uses | | Group Invites may also require admin approval, which is enforced by Group admins' Devices, not the server |
| revoked | bool | |

Redeeming a service Invite increments `uses` only. No link between the Invite and the Account it created is stored or logged.

### Attachment blob and Backup blob
Opaque encrypted objects keyed by random IDs. Attachments are deleted when all recipients have fetched them or after the retention limit (30 days). Each Account has at most one Backup blob, overwritten on update, deleted with the Account. The Backup carries an `access_token_hash`: the hash of a token derived from the Recovery Key that authorises its download after recovery.

The server hosts no MLS group state: joining a Group and rejoining after recovery are done by a current member's Device with an add commit (research R16).

## Device-side entities (encrypted in IndexedDB)

- **Profile**: username, avatar, privacy settings.
- **Contact**: peer Account ID, username, verification state (`unverified` | `verified`), delivery token to reach them, block flag, "block on key change" flag.
- **Conversation**: MLS group state, disappearing timer, mute settings, draft.
- **Group**: name, avatar, Members, admin roles, Invite settings (all inside MLS state or encrypted app messages).
- **Message**: id, sender, body, attachments, reactions, edits, reply reference, status (`sending` | `sent` | `delivered` | `read`), timestamps, expiry.
- **Outgoing queue entry**: encrypted message waiting for connectivity, with a client-generated id for de-duplication.
- **Key material**: Device private key, MLS credentials and secrets; wrapped by the data key; the Account label key (for Device names); the Recovery Key is shown once and never stored.

## Relationships

- Account 1 - N Device.
- Device 1 - N Delivery token; Device 1 - N Queued envelope.
- Contact exists only on Devices, one per peer Account; it is never uploaded.
- Conversation (1:1) = two-member MLS group; Group = N-member MLS group. Membership is known to Devices, not the server.

## Validation rules

- All inbound network messages are checked against JSON Schemas in `contracts-schema/` with strict size limits before processing.
- Attachments over 100 MB, Groups over 256 Members, and Backups over the configured cap are rejected client-side and server-side.
- Disappearing timers start at first view and are enforced by each Device; an expired message and its attachment keys are erased locally.
