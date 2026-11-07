#!/usr/bin/env bash
# Runs every check CI runs, locally: format, lint, tests, dependency policy.
set -euo pipefail
cd "$(dirname "$0")/.."
export DATABASE_URL="$(scripts/dev-db.sh start)"
scripts/readme-status.sh --check
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo deny check
scripts/build-wasm.sh
(cd web && npm run typecheck && npm run lint && npm test)
echo "all checks passed"
