# Testing

Constitution X and XIII: tests are written first, every requirement maps to a test, and security-critical code is held to stricter gates.

## Gates enforced in CI

| Gate | Where | Applies to |
|------|-------|-----------|
| Complexity (cyclomatic at most 10, at most 50 lines per function, at most 400 per file) | ESLint (`web/eslint.config.js`), clippy (`server/clippy.toml`) | All code |
| 100% branch coverage | `web/vitest.config.ts`; Rust coverage added with `server/` | `web/src/crypto/`, `web/src/store/`, `web/src/sw/`, `crypto-wasm/`, `server/src/auth/`, `build/` |
| Mutation testing, break below 85% | Stryker (`web/stryker.config.json`), cargo-mutants | The same security-critical modules |
| Dependency audit (high or above fails) | `npm audit`, cargo-deny | All dependencies |
| Secret scanning, SAST | gitleaks, CodeQL | The whole repository |

## Conventions

- Security-critical logic is deterministic. Clock, randomness, storage and network are injected through the ports in `server/src/ports.rs` and `web/src/ports.ts`, with in-memory fakes in the test directories.
- Mutation testing shows whether assertions are meaningful. A surviving mutant in a security-critical module is fixed by adding a test, not by excluding the code.
- Browser end-to-end tests run the Playwright matrix in `web/playwright.config.ts` (Chrome, Safari/WebKit, Firefox, Edge, plus Android and iPhone emulation).
