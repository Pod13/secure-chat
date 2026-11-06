# Secure Real-Time Chat

A chat service where only the people in a Conversation can read it. Servers, operators and networks are untrusted.

## Language

**Account**:
An identity made of a username and an identity key. It carries no phone number or email.
_Avoid_: User, profile

**Device**:
One linked installation of the app, with its own keys, belonging to an Account.
_Avoid_: Client, session

**Contact**:
A connection between two Accounts, with verification state held only on the Accounts' Devices.
_Avoid_: Friend, buddy

**Conversation**:
A 1:1 or Group thread of messages that only its participants can read.
_Avoid_: Chat, thread

**Group**:
A Conversation with Members and admins.
_Avoid_: Channel, room

**Member**:
An Account that belongs to a Group.
_Avoid_: Participant (reserve for 1:1 Conversations)

**Safety Code**:
A code, also shown as a QR code, unique to a pair of Accounts, which Contacts compare out-of-band to confirm identity.
_Avoid_: Fingerprint, safety number

**Verified**:
The state of a Contact whose Safety Code the Account holder has confirmed. A key change resets it to unverified.
_Avoid_: Trusted

**Recovery Key**:
A secret only the Account holder keeps, which is the sole way to restore an Account or Backup after losing every Device.
_Avoid_: Master key, password reset

**Backup**:
An optional blob holding identity keys, Contacts, Groups and history, encrypted with the Recovery Key.
_Avoid_: Export, sync

**Invite**:
A revocable token that brings an Account into the service, connects two Accounts as Contacts, or joins an Account to a Group.
_Avoid_: Invitation, referral
