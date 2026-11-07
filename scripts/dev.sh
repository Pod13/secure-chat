#!/usr/bin/env bash
# Runs the whole app locally: database, throwaway TLS certificate, relay server (https://localhost:8080)
# and web app (http://localhost:5173). Ctrl-C stops the server and web app.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .local

export DATABASE_URL="$(scripts/dev-db.sh start)"
psql -q "$DATABASE_URL" -c "select 1 from accounts limit 0" >/dev/null 2>&1 \
  || psql -q -v ON_ERROR_STOP=1 "$DATABASE_URL" -f server/migrations/0001_init.sql >/dev/null

if [ ! -f .local/dev-cert.pem ]; then
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 30 -subj /CN=localhost \
    -addext "subjectAltName=DNS:localhost" -keyout .local/dev-key.pem -out .local/dev-cert.pem 2>/dev/null
fi
export TLS_CERT_FILE="$PWD/.local/dev-cert.pem" TLS_KEY_FILE="$PWD/.local/dev-key.pem"

[ -d web/node_modules ] || (cd web && npm ci)
cargo build -p server
trap 'kill 0' EXIT
target/debug/server &
(cd web && npm run dev) &
wait
