#!/usr/bin/env bash
# Runs the browser end-to-end tests against a real relay and a real database, both throwaway.
# Usage: scripts/e2e.sh [playwright arguments, e.g. --project=chrome]
set -euo pipefail
cd "$(dirname "$0")/.."
source "$HOME/.cargo/env" 2>/dev/null || true
mkdir -p .local

export DATABASE_URL="$(scripts/dev-db.sh start)"
# Start from an empty database every run, so tests never depend on earlier runs.
psql -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -c "drop schema public cascade; create schema public" >/dev/null
psql -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -f server/migrations/0001_init.sql >/dev/null

if [ ! -f .local/dev-cert.pem ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj /CN=localhost \
    -addext "subjectAltName=DNS:localhost" -keyout .local/dev-key.pem -out .local/dev-cert.pem 2>/dev/null
fi
export TLS_CERT_FILE="$PWD/.local/dev-cert.pem" TLS_KEY_FILE="$PWD/.local/dev-key.pem"

cargo build -q -p server
scripts/build-wasm.sh web
export E2E_SEED_INVITE="$(target/debug/server seed-invite 1 50)"
target/debug/server &
RELAY_PID=$!
trap 'kill $RELAY_PID 2>/dev/null || true' EXIT
for _ in $(seq 1 50); do
  curl -sk -o /dev/null https://localhost:8080/ && break || sleep 0.2
done

cd web
[ -d node_modules ] || npm ci
npx playwright test "$@"
