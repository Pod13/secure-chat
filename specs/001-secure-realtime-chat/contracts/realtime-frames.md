# Real-Time Channel Contract

One WebSocket per Device at `/v1/ws`. The session token is sent in the `Sec-WebSocket-Protocol` header as `chat.v1, auth.<token>` (base64url, never in the URL, because browsers cannot set an Authorization header on a WebSocket and URLs end up in logs). The server checks it before upgrading: a missing, malformed, unknown or expired token gets HTTP 401, and a storage failure gets 503. The server selects only `chat.v1`, so the token is never echoed. Frames are binary or JSON, schema-validated, size-limited, and carry only ciphertext and routing identifiers. Plaintext never appears, even inside TLS.

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

## Limits

- Frames are text JSON only; binary frames close the connection.
- A client frame is at most 8 KiB. An `ack` carries at most 100 envelope ids.
- At most 100 client frames per 10 seconds; more closes the connection after an `error` frame with code `rate_limited`.
- A connection with no frames for the idle timeout (default 90 s) is closed, so clients send a `ping` about every 30 seconds.
- An invalid frame gets an `error` frame (`invalid_request` or `too_large`) and the connection closes.
- Envelopes are sent oldest first, each once per connection, until acknowledged. Unacknowledged envelopes are sent again on the next connection.

