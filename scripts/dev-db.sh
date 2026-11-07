#!/usr/bin/env bash
# Starts a throwaway local PostgreSQL (data in .local/, never committed) and prints its URL.
# Usage: scripts/dev-db.sh start|stop     Test data only; never point this at real data.
set -euo pipefail
cd "$(dirname "$0")/.."
DIR="$PWD/.local/pgdata"
PORT="${DEV_DB_PORT:-55432}"
URL="postgres://postgres@localhost:$PORT/postgres"

case "${1:-start}" in
  start)
    if ! pg_isready -q -h localhost -p "$PORT"; then
      [ -d "$DIR" ] || initdb -D "$DIR" -U postgres --auth=trust >/dev/null
      pg_ctl -D "$DIR" -o "-p $PORT -k /tmp" -l "$PWD/.local/pg.log" -w start >/dev/null
    fi
    echo "$URL"
    ;;
  stop) pg_ctl -D "$DIR" -m fast stop ;;
  *) echo "usage: $0 start|stop" >&2; exit 2 ;;
esac
