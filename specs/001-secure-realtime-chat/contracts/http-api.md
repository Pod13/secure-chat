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
| POST `/invites` | Token | Create an Invite (service or Contact) | kind, expires_at, max_uses | invite_token |
| DELETE `/invites/{id}` | Token | Revoke an Invite | | 204 |
| POST `/delivery-tokens` | Token | Mint a delivery token for a new Contact | | token (shared only inside encrypted messages) |
| DELETE `/delivery-tokens/{id}` | Token | Revoke (block) | | 204 |
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

## Errors

Problem-details style JSON with a stable code and no echo of request content. Rate-limit responses return 429 with a retry delay.

## Rate limits (no content access)

Per IP-prefix on `/accounts`, `/auth/*` and `/invites`; per delivery token and per recipient on `/deliver`; per Account on blob uploads.
