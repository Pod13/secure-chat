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

## Database tests (server)

`server/tests/migrations.rs` needs a disposable PostgreSQL server and reads `DATABASE_URL`. It fails with a clear message when the variable is unset; it is never silently skipped. Each test works in its own schema.

Run a throwaway server without installing a service (Homebrew PostgreSQL 16 shown):

```sh
PGBIN=/opt/homebrew/opt/postgresql@16/bin
$PGBIN/initdb -D /tmp/sc-pgdata -U postgres --auth=trust -E UTF8
$PGBIN/pg_ctl -D /tmp/sc-pgdata -o "-p 55432 -k /tmp" -l /tmp/sc-pg.log -w start
export DATABASE_URL=postgres://postgres@localhost:55432/postgres
cargo test --all-features
$PGBIN/pg_ctl -D /tmp/sc-pgdata stop      # when finished
```

CI uses a `postgres:16` service container (see `.github/workflows/ci.yml`).

## Mutation testing one module (server)

```sh
export DATABASE_URL=postgres://postgres@localhost:55432/postgres
cargo mutants -p server -f server/src/auth/mod.rs --no-shuffle -- --test auth
```

Pass the test files that cover the module after `--`. A `MISSED` mutant means the tests do not notice that behaviour changing: add a test, do not exclude the code. A `TIMEOUT` (for example a loop that never ends) counts as caught.

