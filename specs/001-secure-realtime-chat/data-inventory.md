# Data Inventory (server)

Anything not listed here MUST NOT be stored (Constitution IV). This file is the source for the public Data Inventory.

| Data | Purpose | Readable by operator | Retention |
|------|---------|----------------------|-----------|
| Account ID | Identify an Account for routing | Yes | Until account deletion |
| Identity public key | Let Contacts verify the Account | Yes (public) | Until account deletion |
| Account creation date (day) | Lawful-request response; abuse review | Yes | Until account deletion |
| Last connection date (day) | Lawful-request response; dormant account cleanup | Yes | Until account deletion |
| Device ID, Device public key, link date | Authenticate and list Devices | Yes | Until the Device is unlinked |
| MLS key packages (public) | Let others start or join Conversations | Yes (public) | Until used or 30 days |
| Web Push subscription | Send empty wake-up pushes | Yes | Until the Device is unlinked |
| Delivery token hash | Route sealed-sender envelopes | Hash only | Until revoked or Device unlinked |
| Queued ciphertext envelope | Deliver to offline Devices | No (ciphertext) | Deleted on delivery; max 30 days |
| Encrypted attachment blob | Deliver attachments | No (ciphertext) | Until all fetched; max 30 days |
| Encrypted Backup blob | Recovery by the Account holder | No (ciphertext) | Until replaced or account deletion |
| Invite token hash, expiry, use count, revoked flag | Enforce Invites | Hash only | Until expiry plus 30 days |
| Truncated IP address and request counts | Abuse prevention, rate limits | Yes | 7 days maximum |
| Operator audit log of admin actions | Incident response | Yes (no user content) | 1 year, tamper-evident |

Not stored: usernames, phone numbers, emails, message content, Group names or membership, Contact lists, sender identity of a delivery, read receipts, typing or presence signals.
