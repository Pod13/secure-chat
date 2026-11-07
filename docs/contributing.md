# Contributing

The constitution at `.specify/memory/constitution.md` is the highest authority. Read it first.

## Commits and branches

- Every commit MUST be signed (`git config commit.gpgsign true`, with a GPG, SSH or Sigstore key registered on your account).
- `main` is protected. Configure the repository to require:
  - pull requests with at least one approving review;
  - signed commits and linear history;
  - all CI checks passing, with no bypass for administrators;
  - no force pushes and no branch deletion.
- Install the local secret guard: `pre-commit install` (config in `.pre-commit-config.yaml`).

## Reviews

Every pull request needs one approving review that includes the simplicity check (Constitution XIII): a reviewer other than the author can explain what the code does and why it is correct, and the complexity limits are met.

| Changed paths | Extra required approval |
|---------------|-------------------------|
| `crypto-wasm/`, `web/src/crypto/` | Designated cryptography reviewer and security reviewer |
| `server/src/auth/`, `web/src/store/`, `web/src/sw/`, `build/` | Designated security reviewer |

## Working rules

- Write the test first; security requirements need an automated test before the implementation.
- Never add a dependency without justification in `specs/001-secure-realtime-chat/research.md` (R8). Pin exact versions and commit lockfiles. Prefer releases that are at least two weeks old.
- Never commit secrets, keys or production data.
- Complexity limits (CI-enforced): cyclomatic complexity at most 10, at most 50 lines per function, at most 400 lines per file. A limit is exceeded only with an inline justification approved in review.
- When you change task status, architecture or how to run the app, update `README.md` in the same commit. The progress table is generated: run `scripts/readme-status.sh`. `scripts/check.sh` and the pre-commit hook fail if it is stale.
