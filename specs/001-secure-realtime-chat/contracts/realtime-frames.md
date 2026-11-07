# Real-Time Channel Contract

One WebSocket per Device at `/v1/ws`, authenticated at connect with the Device token. Frames are binary or JSON, schema-validated, size-limited, and carry only ciphertext and routing identifiers. Plaintext never appears, even inside TLS.

## Server to Device

| Frame | Fields | Meaning |
|-------|--------|---------|
| `envelope` | envelope_id, ciphertext, enqueued_at | A queued message for this Device |
| `queue-empty` | | All backlog delivered |
| `link-request` | request_id, new device public key | Another Device wants to link; the user approves on this Device |
| `device-unlinked` | reason (`unlinked` or `recovered`) | This Device was unlinked; wipe local data. With `recovered`, show that the Account was recovered on another Device |
| `error` | code | Protocol or limit error |

## Device to Server

| Frame | Fields | Meaning |
|-------|--------|---------|
| `ack` | envelope_id[] | Delivered and stored; the server deletes the envelopes |
| `ping` | | Keep-alive |

## Ordering and duplicates

Envelopes arrive in queue order. The client de-duplicates by envelope_id and by MLS epoch/generation; outgoing messages carry a client-generated id so retries never create duplicates (FR-015).

## What is deliberately absent

No typing, presence, read-receipt or delivery-status frames exist on the server channel. These signals travel as ordinary encrypted application messages between Devices, honouring each user's privacy settings (FR-070). Sender-visible "sent" status means the server accepted the envelope; "delivered" and "read" come from the recipient Device inside encrypted messages.
