---
status: accepted
---

# Use MLS for every Conversation, including 1:1

Both 1:1 Conversations and Groups use MLS (RFC 9420), with a 1:1 being a two-member group. libsignal has no supported browser build, and porting it would be custom cryptography; one protocol also means one code path to audit and efficient re-keying at 256 Members.

## Considered Options

- Signal protocol for 1:1 plus MLS for Groups: two protocols, and the 1:1 half has no audited browser library.
- Sender Keys for Groups: weaker post-compromise security and costly removals.

## Consequences

- OpenMLS compiled to WASM is on the critical path; spike T-spike-1 must confirm it works in all supported browsers, with mls-rs as the fallback.
- A post-quantum hybrid ciphersuite waits for library support.
