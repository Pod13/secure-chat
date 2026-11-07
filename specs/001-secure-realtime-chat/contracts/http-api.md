# HTTP API Contract

Base path `/v1`. TLS 1.3 only. Every request and response body is JSON validated against a schema in `contracts-schema/` with a hard size limit; unknown fields are rejected. Authenticated calls carry a short-lived bearer token bound to the Device. No endpoint accepts or returns plaintext message content, usernames or Contact lists.

| Method and path | Auth | Purpose | Request (key fields) | Response |
|-----------------|------|---------|----------------------|----------|
| POST `/accounts` | Invite token | Create an Account (FR-001, FR-006) | invite_token, identity_public_key, device_public_key, key_packages | account_id, device_id |
| POST `/auth/challenge` | none | Start Device login | device_id | nonce |
| POST `/auth/token` | none | Finish Device login | device_id, nonce signature | token (15 min) |
| DELETE `/accounts/me` | Token | Delete account and all server data (FR-047) | signature | 204 |
| POST `/devices/link-requests` | none | New Device asks to link | new device public key, ephemeral key | request_id |
| POST `/devices/link-requests/{id}/approve` | Token (existing Device) | Approve a link (FR-050) | signature over new Device key | device_id |
| GET `/devices` | Token | List Devices | | devices[{id, encrypted label}] |
| DELETE `/devices/{id}` | Token | Unlink a Device; kills its tokens immediately (FR-052) | | 204 |
| PUT `/devices/me/key-packages` | Token | Replenish single-use MLS key packages | key_packages | 204 |
| POST `/key-packages/fetch` | Delivery token (no account auth) | Fetch key packages of the token's Device, so the server never learns who asks | token | key_packages |
| POST `/invites/redeem` | Invite token (no account auth) | Redeem a Contact or Group Invite: returns the creator's per-Device delivery tokens and key packages, so the redeemer can send a join request | invite_token | devices[{delivery_token, key_packages}] |
| POST `/invites` | Token | Create an Invite (service, Contact or Group) | kind, expires_at, max_uses | invite_token, invite_id |
| DELETE `/invites/{id}` | Token | Revoke an Invite; `id` is the `invite_id` returned at creation, owner only | | 204 |
| POST `/delivery-tokens` | Token | Mint a delivery token for a new Contact | | token (shared only inside encrypted messages), token_id (to revoke it) |
| DELETE `/delivery-tokens/{id}` | Token | Revoke (block); `id` is the `token_id`, the Device's own tokens only | | 204 |
| POST `/deliver` | Delivery token (no account auth) | Sealed-sender send of one envelope | token, ciphertext (bucketed) | envelope_id |
| POST `/blobs` | Token | Upload an encrypted attachment, up to 100 MB | size-bucketed bytes | blob_id |
| GET `/blobs/{id}` | Token | Download an encrypted attachment | | bytes |
| PUT `/backup` | Token | Replace the Account's single encrypted Backup | bytes, access_token_hash | 204 |
| POST `/recovery/devices` | Identity-key signature (rate limited) | Add a new Device after recovery; signed by the identity key re-derived from the Recovery Key. Deletes every earlier Device of the Account (records, tokens, push subscriptions, delivery tokens) and sends each a `device-unlinked` frame with reason `recovered` | device public key, key_packages, signature | device_id |
| GET `/backup` | Access token derived from the Recovery Key | Fetch the Backup after recovery | | bytes |
| PUT `/push-subscription` | Token | Register an empty-payload wake-up endpoint | subscription | 204 |

## Privacy rules

- `POST /accounts` consumes an Invite use but MUST NOT store or log any link between the Invite and the new Account.
- Anonymous endpoints (`/deliver`, `/key-packages/fetch`, `/invites/redeem`) log no requester identity.
- Removing a Device from the server (`DELETE /devices/{id}`) is not enough on its own: clients also remove it from every Conversation's encryption group (tasks US4).

## Details fixed during implementation

- Secrets are random 32-byte values sent as unpadded base64url. The server stores only their SHA-256 hash. An `invite_id` or `token_id` is the first 16 bytes of that hash: it names the secret for revoking without revealing it.
- A Device certificate is the Account identity key's Ed25519 signature over `secure-chat/device-certificate/v1` followed by the Device public key. `POST /accounts` checks it before using up the Invite.
- Invites live at most 90 days, allow 1 to 1000 uses, and one Account may have at most 100 live Invites. Operator seed Invites (service kind, no owner) are made with `server seed-invite <days> <uses>`.
- Created resources answer 201. A refused sign-up, delivery or redemption answers 401 for every reason (unknown, expired, revoked, used up, wrong kind), so nothing can be probed.
- Key-package fetch hands out the oldest single-use package (and deletes it), then the Device's last-resort package, which can be handed out again.
- Rate-limited requests answer 429 with `retry_after` and a `Retry-After` header. Counters are named by a truncated network prefix or a token-hash prefix, never by an Account or Device.

## Errors

Problem-details style JSON with a stable code and no echo of request content. Rate-limit responses return 429 with a retry delay.

## Rate limits (no content access)

Per IP-prefix on `/accounts`, `/auth/*` and `/invites`; per delivery token and per recipient on `/deliver`; per Account on blob uploads.
