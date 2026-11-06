---
status: accepted
---

# Ship v1 as an installable web app only

Version 1 is distributed as a PWA on web, Android and iPhone; native Play Store and App Store apps are deferred until after the first independent audit. One codebase and one client-integrity story (reproducible, signed web builds with strict CSP and SRI) is far cheaper to keep verifiable than HSM-signed, reproducible native builds plus store review.

## Consequences

- Device keys are non-extractable WebCrypto keys wrapped by an Argon2id passcode (WebAuthn deferred), not Secure Enclave / StrongBox.
- iPhone push requires iOS 16.4+ and a home-screen install, and goes through a third-party push service, so notifications carry no content or sender identity.
- iOS cannot block screenshots; the app hides content in the app switcher and warns instead.
