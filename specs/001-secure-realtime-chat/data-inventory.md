# Data Inventory (server)

Anything not listed here MUST NOT be stored (Constitution IV). This file is the source for the public Data Inventory.

| Data | Purpose | Readable by operator | Retention |
|------|---------|----------------------|-----------|
| Account ID | Identify an Account for routing | Yes | Until account deletion |
| Identity public key | Let Contacts verify the Account; verify recovery signatures | Yes (public) | Until account deletion |
| Account creation date (day) | Lawful-request response; abuse review | Yes | Until account deletion |
| Last connection date (day) | Lawful-request response | Yes | Until account deletion |
| Device ID, Device public key, link date | Authenticate and list Devices | Yes | Until the Device is unlinked |
| Encrypted Device label (name, type, own last-active date) | Let the user recognise their Devices | No (ciphertext) | Until the Device is unlinked |
| MLS key packages (public) | Let others start or join Conversations | Yes (public) | Until used or 30 days |
| Web Push subscription | Send empty wake-up pushes | Yes | Until the Device is unlinked |
| Delivery token hash | Route sealed-sender envelopes | Hash only | Until revoked or Device unlinked |
| Queued ciphertext envelope | Deliver to offline Devices | No (ciphertext) | Deleted on delivery; max 30 days |
| Encrypted attachment blob | Deliver attachments | No (ciphertext) | Until all fetched; max 30 days |
| Encrypted Backup blob and hash of its access token | Restore history after recovery | No (ciphertext) | Until replaced or account deletion |
| Invite token hash, owner Account (none for operator seed Invites), expiry, use count, revoked flag | Enforce and revoke Invites. The owner is the creator; the redeemer is never stored | Hash only | Until expiry plus 30 days |
| Device login nonce | Challenge-response login | No (random) | 5 minutes |
| Session token hash | Authenticate requests from a Device | Hash only | 15 minutes |
| Pending link request (public keys) | Let a new Device ask an existing one for approval | Yes (public) | 10 minutes |
| Blob and Backup metadata (size, expiry, fetches remaining) | Serve and expire encrypted objects | Yes | As the blob or Backup |
| Truncated IP address and request counts | Abuse prevention, rate limits | Yes | 7 days maximum |
| Operator audit log of admin actions | Incident response | Yes (no user content) | 1 year, tamper-evident |

Not stored: which Account used an Invite, usernames, phone numbers, emails, message content, Group names or membership, Contact lists, sender identity of a delivery, read receipts, typing or presence signals.

## On the Device (never sent to the server)

Everything below lives in the browser's IndexedDB. Each value is sealed with XChaCha20-Poly1305 under a random data key; the data key is wrapped by an Argon2id key made from the passcode. Names are keyed hashes, so storage shows neither content nor record names.

| Data | Purpose |
|------|---------|
| Username, Device name, Device signing key, label key | Show who you are; log in to the relay |
| MLS state (keys, credentials, group secrets) | Continue every Conversation after a reload |
| Conversation records (group id, other side's delivery tokens, own tokens and their ids) | Know where to send, and which tokens to revoke |
| Conversation history and message status | Show messages; show sending, sent, delivered or expired |
| Outbox (ciphertext waiting to be sent) | Send exactly once after an outage |

Not kept anywhere: the passcode, the Recovery Key (shown once), the Account identity private key (it only signs the Device certificate at sign-up).
