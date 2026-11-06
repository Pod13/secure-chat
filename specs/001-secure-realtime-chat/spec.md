# Feature Specification: Secure Real-Time Chat

**Feature Branch**: `001-secure-realtime-chat`
**Created**: 2026-11-07
**Status**: Draft
**Input**: User description: "A very secure real-time chat that I can share with people. It should be intuitive and easy to install, start with web but must be installable on Android and iPhone. Security around conversations and data is absolute, in transit and at rest."

---

## Guiding Principle

**The service operator must never be able to read a conversation.** Every requirement below assumes that the servers, the hosting provider, the network, and anyone who obtains a copy of server data are untrusted. Only the participants' own devices can see message content.

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Create an account and start a private 1:1 chat (Priority: P1)

A new user opens the web app, creates an account in under two minutes without giving a phone number or email, and sends an end-to-end encrypted message to a contact who has joined through an invite link.

**Why this priority**: This is the smallest slice that delivers the core value: a private conversation that nobody else, including the operator, can read.

**Independent Test**: Two people on two separate browsers can sign up, connect through an invite, and exchange messages in real time. Inspection of all server-side storage and network traffic shows no readable message content.

**Acceptance Scenarios**:

1. **Given** a visitor with no account, **When** they open the app and choose a username and a device passcode, **Then** an account is created and encryption keys are generated on their device only.
2. **Given** a signed-in user, **When** they create an invite link and share it, **Then** the recipient can open it, sign up or sign in, and land directly in a conversation with the sender.
3. **Given** two connected users who are both online, **When** one sends a message, **Then** the other sees it within 1 second in normal network conditions.
4. **Given** a recipient who is offline, **When** a message is sent, **Then** it is delivered as soon as the recipient's device reconnects, and the sender sees sent / delivered status.
5. **Given** any message in transit or stored on the server, **When** it is inspected by someone with full server access, **Then** only ciphertext and the minimum routing metadata are visible.

---

### User Story 2 - Verify a contact's identity (Priority: P1)

A user confirms that they are really talking to the intended person, and not someone in the middle, by comparing a safety code in person or by scanning a QR code.

**Why this priority**: End-to-end encryption is only meaningful if users can detect an impersonated or swapped key. Without this, the operator could silently insert itself into a conversation.

**Independent Test**: Two users compare safety codes and mark each other verified. A simulated key change for one user produces a visible warning for the other before any further message is sent.

**Acceptance Scenarios**:

1. **Given** an open conversation, **When** a user opens contact details, **Then** they see a safety code and a scannable QR code unique to that pair of identities.
2. **Given** a verified contact, **When** that contact's identity key changes (for example a reinstall or new device), **Then** the user sees a clear warning, the contact is marked unverified, and the user must acknowledge before sending.
3. **Given** a user who has enabled "block on key change" for a contact, **When** that contact's key changes, **Then** outgoing messages are held until the user re-verifies.

---

### User Story 3 - Install on Android and iPhone (Priority: P1)

A user who started on the web installs the app on their phone from a simple, guided flow and keeps using the same account.

**Why this priority**: Mobile install is a stated hard requirement, and most chat use happens on phones.

**Independent Test**: From the web app, a user follows the install prompt on an Android phone and an iPhone, opens the installed app, links it to their existing account, and receives new messages there.

**Acceptance Scenarios**:

1. **Given** a user on a mobile browser, **When** they open the app, **Then** they are shown a one-step install prompt with instructions specific to their platform.
2. **Given** an installed mobile app, **When** it is launched, **Then** it opens full-screen without browser controls and works like a native app.
3. **Given** the installed app is closed, **When** a new message arrives, **Then** the user gets a push notification that does **not** contain the message text or the sender's name unless the user has opted in to previews, which are decrypted on the device.

---

### User Story 4 - Link and unlink devices (Priority: P2)

A user adds a second device (for example phone plus laptop) by approving it from a device they already have, and can remove a lost device remotely.

**Why this priority**: Most people use more than one device, and a lost phone must not become a way into their conversations.

**Independent Test**: A user links a laptop by scanning a QR code with their phone, sees messages on both, then unlinks the laptop from the phone; the laptop immediately loses access and receives no new messages.

**Acceptance Scenarios**:

1. **Given** a user signed in on one device, **When** they start "link new device", **Then** the new device can only be added by approval from an existing device (QR scan or code), never by password alone.
2. **Given** a user with several linked devices, **When** they view their device list, **Then** they see each device's name, type, and last-active time.
3. **Given** a linked device, **When** the user unlinks it from another device, **Then** that device can no longer decrypt new messages and its local data is erased the next time it connects.
4. **Given** a new device is linked, **When** contacts next message the user, **Then** contacts are notified that a new device was added to that account.

---

### User Story 5 - Group conversations (Priority: P2)

A user creates a group, invites people by link, and manages membership. All group messages are end-to-end encrypted to current members only.

**Why this priority**: Sharing with "people" implies groups, but 1:1 must work first.

**Independent Test**: A user creates a group of 5, sends messages, removes one member, and confirms the removed member cannot read anything sent after removal.

**Acceptance Scenarios**:

1. **Given** a user, **When** they create a group and share its invite link, **Then** people who join can see messages sent after they joined, but not before.
2. **Given** a group admin, **When** they remove a member, **Then** the group's keys rotate and the removed member cannot decrypt any later message.
3. **Given** a group admin, **When** they set an invite link to expire, limit uses, require admin approval, or revoke it, **Then** the link behaves accordingly.
4. **Given** a group, **When** membership changes, **Then** all members see a system message describing the change.

---

### User Story 6 - Protect data on a device (Priority: P2)

A user's local message history stays protected even if their phone or laptop is lost, stolen, or inspected.

**Why this priority**: End-to-end encryption protects data in transit and on the server; device-level protection closes the remaining gap.

**Independent Test**: With the app locked, copy its local storage off the device. None of it can be read without the user's passcode.

**Acceptance Scenarios**:

1. **Given** the app has been idle for the user's chosen timeout, **When** the user returns, **Then** they must unlock with their passcode.
2. **Given** the app is in the background or app switcher, **When** the screen is viewed, **Then** conversation content is hidden.
3. **Given** a user enters the wrong passcode a configurable number of times, **When** the limit is reached, **Then** local data is wiped (if the user enabled this option).
4. **Given** all locally stored messages, keys, and attachments, **When** the device storage is read directly, **Then** everything is encrypted with keys protected by the platform's secure key storage or the user's passcode.

---

### User Story 7 - Disappearing messages and deletion (Priority: P2)

A user sets messages in a conversation to disappear after a chosen time, and can delete messages they sent for everyone.

**Why this priority**: Limiting how long sensitive content exists reduces risk if a device is later compromised.

**Independent Test**: Set a 5-minute timer, send messages, and confirm they are removed from all participant devices and the server after 5 minutes.

**Acceptance Scenarios**:

1. **Given** a conversation, **When** any participant (or group admin, if restricted) sets a disappearing timer, **Then** all participants see the change and new messages are erased from every device after that time.
2. **Given** a message the user sent, **When** they choose "delete for everyone", **Then** it is removed from all recipient devices that are online or come online later.
3. **Given** the user's account, **When** they choose "delete account", **Then** all their server-side data is destroyed and contacts see that the account no longer exists.

---

### User Story 8 - Send files, images and voice notes (Priority: P3)

A user shares photos, documents, and voice notes with the same protection as text.

**Why this priority**: Expected in any modern chat, but text chat is usable without it.

**Independent Test**: Send an image and a PDF; confirm the server only ever holds an encrypted blob it cannot open, and the recipient views both normally.

**Acceptance Scenarios**:

1. **Given** a conversation, **When** a user attaches a file up to the size limit, **Then** it is encrypted on the device before upload and only participants can decrypt it.
2. **Given** an image or file, **When** it is shared, **Then** location and camera metadata are stripped by default.
3. **Given** an attachment on the server, **When** all recipients have downloaded it or its retention limit passes, **Then** it is deleted from the server.

---

### User Story 9 - Block, report and control privacy signals (Priority: P3)

A user blocks unwanted contacts, reports abuse, and controls whether others see read receipts, typing indicators, and online status.

**Why this priority**: Needed for safe sharing with people beyond close contacts.

**Independent Test**: Block a contact and confirm no further messages arrive; turn off read receipts and confirm the other side never sees "read".

**Acceptance Scenarios**:

1. **Given** a contact, **When** the user blocks them, **Then** the user receives no messages, calls, or invites from them.
2. **Given** an abusive message, **When** the user reports it, **Then** the user is shown exactly what will be shared, and only the messages they choose are sent to moderation, by the user's own device.
3. **Given** privacy settings, **When** read receipts, typing indicators, or last-seen are turned off, **Then** no such signals are sent from that user's devices.

---

### Edge Cases

- A user loses their only device and has no encrypted backup: the account can be recovered only by the method in FR-041; past messages are unrecoverable by design, and the user is told this clearly at sign-up.
- A message is sent to a contact whose key changed mid-conversation: the sender is warned before delivery (see Story 2).
- A recipient stays offline longer than the server's retention period for undelivered messages: the sender is notified that the message expired undelivered.
- Two devices of the same user send at the same moment: both messages appear in a consistent order on all devices.
- Network drops mid-send: the message stays in an outgoing queue on the device, still encrypted, and retries automatically without duplication.
- A user is removed from a group while offline: when they reconnect they cannot decrypt anything sent after removal.
- An invite link is shared publicly by mistake: the creator can revoke it, and links can be set to expire and cap the number of uses.
- The web app is served from a compromised server: users and auditors must be able to detect that the delivered client code differs from the published version (see FR-033).
- The device clock is wrong: disappearing timers and message ordering still behave correctly.
- Browser storage is cleared by the user or the browser: the device is treated as unlinked and must be re-linked; no data is lost from other devices.
- A very large group (at the member limit) changes membership frequently: re-keying still completes within the target time.

---

## Requirements *(mandatory)*

### Functional Requirements

**Accounts & onboarding**

- **FR-001**: System MUST let a user create an Account with only a username and a local passcode; phone number and email MUST NOT be required. The server MUST identify an Account only by a random Account ID; the username is held in encrypted profile data and shown only to Contacts.
- **FR-002**: System MUST generate all of a user's private keys on the user's device; private keys MUST never leave the device in readable form.
- **FR-003**: System MUST let users connect with each other through shareable invite links and QR codes, without needing to search a public directory.
- **FR-004**: Usernames MUST NOT be discoverable by search; there is no search endpoint.
- **FR-005**: Sign-up MUST be completable in under 2 minutes by a first-time user with no instructions.
- **FR-006**: Registration MUST be invite-only: an Account can be created only through an Invite from an existing Account. The operator issues the seed Invites.

**Real-time messaging**

- **FR-010**: System MUST deliver messages between online users in real time (target: under 1 second, 95th percentile).
- **FR-011**: System MUST queue messages for offline recipients and deliver them on reconnect, in order.
- **FR-012**: System MUST show per-message status: sending, sent, delivered, and (if both parties allow) read.
- **FR-013**: System MUST support 1:1 and group conversations with text, emoji reactions, replies, and edits.
- **FR-014**: System MUST support attachments (images, documents, voice notes) up to a defined size limit.
- **FR-015**: System MUST queue outgoing messages while offline and send them automatically when connectivity returns, without duplicates.

**Encryption & conversation security (in transit)**

- **FR-020**: All message content, attachments, reactions, edits, group names, group avatars, and profile details MUST be end-to-end encrypted so that only intended recipients' devices can decrypt them.
- **FR-021**: The encryption scheme MUST provide **forward secrecy** (compromise of current keys does not expose past messages) and **post-compromise security** (the conversation heals after a temporary key compromise).
- **FR-022**: The system MUST use well-established, publicly reviewed cryptographic protocols and primitives; custom cryptography MUST NOT be used.
- **FR-023**: All client-server traffic MUST additionally be protected by modern transport encryption with certificate validation; downgrade to unencrypted or weak transport MUST be impossible.
- **FR-024**: Users MUST be able to verify each contact via a safety code and QR code (Story 2).
- **FR-025**: Users MUST be warned on any Contact identity-key change and on any new Device added to a Contact's Account. For Verified Contacts, outgoing messages MUST be blocked by default until the user acknowledges; for unverified Contacts the user MUST be warned and acknowledge before sending.
- **FR-026**: Removing a member from a group MUST rotate group keys so the removed member cannot read later messages; new members MUST NOT be able to read messages sent before they joined.
- **FR-027**: Push notifications MUST NOT carry readable message content or sender identity through third-party push services; any preview MUST be decrypted on the device. Push payloads MUST be an empty wake-up signal with no sender hint and no preview text.

**Server-side data protection (at rest)**

- **FR-030**: Servers MUST store only encrypted message payloads and the minimum metadata needed for delivery.
- **FR-031**: Encrypted messages MUST be deleted from the server immediately after delivery to all recipient devices, and undelivered messages MUST be deleted after a fixed retention period (default 30 days).
- **FR-031a**: Message delivery MUST use sealed-sender-style delivery so the server learns the recipient Device but not the sender; rate limits apply per recipient and per delivery token.
- **FR-032**: The system SHOULD minimise metadata visible to the server — including who is messaging whom, group membership, and contact lists — and MUST NOT store contact lists or social graphs in readable form.
- **FR-033**: The web client MUST be delivered in a way that lets users or independent auditors verify that the code they are running matches the published, reviewed version. A client whose code does not match the published version MUST refuse to run instead of loading.
- **FR-034**: All server storage (databases, file storage, backups) MUST be encrypted at rest, in addition to end-to-end encryption, with keys managed separately from the data.
- **FR-035**: Server logs MUST NOT contain message content, keys, or attachment data; IP addresses and other identifying connection data MUST NOT be retained beyond what is needed for abuse prevention (default: 7 days maximum).
- **FR-036**: The operator MUST be able to respond to any lawful data request truthfully with only: account creation date and last connection date.

**Device-side data protection (at rest)**

- **FR-040**: All local data (messages, keys, attachments, contact list, search index) MUST be encrypted on the device, with keys held in the platform's secure key storage or derived from the user's passcode.
- **FR-041**: Account recovery after losing all devices MUST be possible only through a user-held recovery key or encrypted backup created by the user; the operator MUST NOT be able to restore access or content.
- **FR-042**: Users MUST be able to create an optional end-to-end encrypted backup protected by a Recovery Key only they hold. The Backup MUST cover identity keys, Contacts, Groups and history, and be stored on the server as a single opaque blob.
- **FR-043**: The app MUST support an app lock (passcode) with a user-selectable auto-lock timeout.
- **FR-044**: The app MUST hide conversation content in the app switcher and, where the platform allows, block screenshots and screen recording (user can turn off).
- **FR-045**: Users MUST be able to optionally wipe local data after a set number of failed unlock attempts.
- **FR-046**: Users MUST be able to set disappearing-message timers per conversation, and delete their own messages for everyone. Timers MUST start at first view and be enforced by each Device; the settings screen MUST state that a recipient who screenshots or modifies their client cannot be prevented from keeping content.
- **FR-047**: Users MUST be able to delete their account, destroying all server-side data related to it.

**Multi-device**

- **FR-050**: Users MUST be able to link additional devices only by approval from an already-linked device.
- **FR-051**: Each device MUST have its own keys; compromising one device MUST NOT expose another device's keys.
- **FR-052**: Users MUST be able to view and remotely unlink any device; unlinked devices MUST lose access immediately.
- **FR-053**: History on a newly linked device MUST start empty; past messages are not transferred to it in v1.

**Platforms & installation**

- **FR-060**: The first release MUST be a web app that works in current versions of Chrome, Safari, Firefox, and Edge on desktop and mobile.
- **FR-061**: The app MUST be installable on Android and iPhone home screens and run full-screen with push notifications.
- **FR-062**: Mobile distribution MUST be as an installable web app (PWA) only in v1; native store apps are deferred (see docs/adr/0001-pwa-only-v1.md).
- **FR-063**: The app MUST show platform-specific, step-by-step install guidance on first visit from a mobile browser.
- **FR-064**: The same account MUST work across web, Android, and iPhone, with the same features and security guarantees on all.

**Privacy controls, safety & abuse**

- **FR-070**: Users MUST be able to turn off read receipts, typing indicators, and online / last-seen status.
- **FR-071**: Users MUST be able to block contacts and leave groups.
- **FR-072**: Users MUST be able to report abuse by choosing specific messages to forward from their own device; nothing else is shared. Reports go to an operator moderation Account as user-forwarded encrypted messages; reports about Group content go to Group admins.
- **FR-073**: Group admins MUST be able to manage members, admins, invite links (expiry, use limits, approval, revocation), and who can change group settings.
- **FR-074**: The system MUST rate-limit sign-ups, invite creation, and message sending to prevent spam and abuse, without needing to read content.
- **FR-075**: Images MUST have location and camera metadata stripped before sending by default.

**Usability & accessibility**

- **FR-080**: Security features MUST be on by default and require no configuration; a user who never opens settings MUST still get full end-to-end encryption.
- **FR-081**: Security warnings MUST use plain language and tell the user exactly what to do.
- **FR-082**: The interface MUST meet WCAG 2.2 AA accessibility guidelines.
- **FR-083**: The interface MUST support light and dark themes and adapt to phone, tablet, and desktop screen sizes.

**Assurance**

- **FR-090**: The client and server source code MUST be published for public review.
- **FR-091**: An independent security audit (cryptography and application) MUST be completed and all critical / high findings fixed before public launch.
- **FR-092**: The project MUST publish a plain-language privacy policy and a security whitepaper describing exactly what the server can and cannot see.
- **FR-093**: The project MUST provide a responsible disclosure channel for security researchers.
- **FR-094**: Every functional requirement and every security requirement in this spec MUST be verifiable by at least one automated test, and the security-critical parts of the system MUST be small and simple enough for an independent auditor to read and understand.

### Key Entities

- **Account**: An identity made of a random Account ID and a long-term identity public key; the username lives in encrypted profile data. Contains no phone number or email.
- **Device**: A single installation of the app linked to an account; has its own key pair, name, platform, and last-active time.
- **Contact**: A relationship between two users, with verification state (verified / unverified) stored only on the users' devices.
- **Conversation**: A 1:1 or group thread; holds settings such as disappearing timer. Its contents are known only to participants.
- **Group**: A conversation with members, admins, and settings; membership is kept as private as feasible from the server.
- **Message**: Encrypted content plus minimal routing information (recipient device, timestamp); deleted from the server after delivery.
- **Attachment**: An encrypted file blob stored temporarily on the server; its decryption key travels only inside an encrypted message.
- **Invite Link**: A shareable token tied to a user or group, with optional expiry, use limit, and approval requirement; revocable.
- **Encrypted Backup**: Optional user-created backup, encrypted with a recovery key only the user holds.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A first-time user can install (or open on web), create an account, and send a first message to an invited contact in under 2 minutes.
- **SC-002**: 90% of test users successfully install the app on Android or iPhone on their first attempt without outside help.
- **SC-003**: 95% of messages between online users arrive in under 1 second; 99% in under 3 seconds.
- **SC-004**: An independent audit finds no way for the operator or an attacker with full server access to read message content, attachments, or contact lists.
- **SC-005**: A forensic copy of a locked device's app storage yields no readable messages, keys, or contacts.
- **SC-006**: 100% of identity-key changes produce a visible warning to affected contacts before the next message is sent.
- **SC-007**: After removal from a group, a removed member can decrypt 0% of subsequent group messages.
- **SC-008**: A lawful-request response contains no data beyond account creation date and last connection date.
- **SC-009**: Zero critical or high-severity findings remain open at public launch.
- **SC-010**: 85% of test users correctly explain what a safety-code warning means after seeing it once.
- **SC-011**: The system supports at least 10,000 concurrent users with SC-003 latency targets maintained.

---

## Assumptions

- Unlocking the app in v1 uses the passcode only. Biometric and hardware-key unlock is deferred to keep the key-handling code small; it can be added later without changing stored data.

- Key transparency (a public append-only log of key-directory changes) is deferred to a later feature and kept on the roadmap.

- Scope for v1 is text messaging, reactions, replies, attachments, and voice notes. **Voice and video calls are out of scope** for this spec and will be a separate feature.
- Group size limit for v1 is 256 members.
- Attachment size limit for v1 is 100 MB.
- Losing all devices without a recovery key means losing message history; this trade-off is accepted and explained to users at sign-up.
- Platform limits apply: iPhone does not allow blocking screenshots, so the iOS app hides content in the app switcher and warns instead.
- Push notifications on iPhone require the app to be installed to the home screen (iOS 16.4+) if distributed as a web app.
- The service will be operated in a way that complies with data-protection law in the operator's jurisdictions (e.g. POPIA, GDPR); minimal data collection makes this simpler.
- No advertising, analytics, or third-party trackers are included in any client.
