# Accepted risks

Each entry is a known issue we have chosen to accept for now. The security lead must review every entry by its date. An entry is removed as soon as it is fixed.

| ID | Where | Why accepted | Condition to keep accepting | Review by |
|----|-------|--------------|-----------------------------|-----------|
| RUSTSEC-2026-0387 (constant-time timing issues) | `crypto-bigint` 0.5.5, via `p256`/`p384` in `openmls_rust_crypto` 0.6.0 | The shipped ciphersuite is X25519, AES-128-GCM, Ed25519. NIST-curve code is linked but not called. A newer `crypto-bigint` needs a newer `openmls_rust_crypto`. | The built WASM must not contain `crypto-bigint` code reachable from our API (check in the T014 spike). Re-check whenever `openmls_rust_crypto` is updated. | 2026-12-07 |
| RUSTSEC-2026-0173 (unmaintained) | `proc-macro-error2`, via `hax-lib-macros` in `libcrux` | Compile-time procedural macro only. It is not part of the shipped binary. No upgrade exists. | It stays a build-time dependency. | 2026-12-07 |
| npm advisory on `minimatch` (moderate, denial of service) | `typescript-eslint`, `@eslint/config-array`, Stryker (web dev tooling) | Development and CI tooling only. Never runs in the shipped client. `npm audit --omit=dev` reports none. | Dev dependencies only. CI fails on high or above. | 2026-12-07 |
