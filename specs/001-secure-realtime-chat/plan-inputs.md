# Plan Inputs: Secure Real-Time Chat

Design decisions settled during the requirements interview, carried into `/speckit-plan`. They are kept out of `spec.md` because they describe how, not what.

- **Stack**: TypeScript PWA client with audited WASM crypto; Rust server.
- **Protocols**: MLS (RFC 9420) via OpenMLS for Groups. *Superseded by the plan (research R2): 1:1 also uses MLS, because libsignal has no supported browser build.*
- **Client integrity (FR-033)**: content-hashed static assets, a published signed manifest, and a service worker that refuses any asset not in the manifest.
- **Delivery (FR-031a)**: sealed-sender-style delivery; rate limits per recipient and per delivery token.
- **Push (FR-027)**: empty wake-up payload; Device fetches ciphertext and decrypts any preview locally.
- **Web key storage**: non-extractable WebCrypto key wrapped by an Argon2id passcode key; WebAuthn deferred for simplicity (see docs/adr/0001-pwa-only-v1.md).
- **Deferred**: key transparency log; post-quantum hybrid key agreement stays on the roadmap (constitution III).
- **To cover in the plan**: Account IDs and delivery tokens are server-visible metadata and must enter the Data Inventory.
