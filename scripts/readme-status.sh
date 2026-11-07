#!/usr/bin/env bash
# Keeps the progress table in README.md in step with specs/*/tasks.md (the Spec Kit task list).
# Usage: scripts/readme-status.sh          rewrite the table
#        scripts/readme-status.sh --check  fail if the README is out of date (used by check.sh)
set -euo pipefail
cd "$(dirname "$0")/.."
TASKS=specs/001-secure-realtime-chat/tasks.md

table=$(awk '
  /^## Phase/ { if (name) print name "|" done "|" total; name=$0; sub(/^## /,"",name); sub(/ \(Priority.*/,"",name); sub(/ 🎯.*/,"",name); done=0; total=0; next }
  /^- \[[ xX]\] T[0-9]+/ { total++; if ($0 ~ /^- \[[xX]\]/) done++ }
  END { if (name) print name "|" done "|" total }
' "$TASKS" | awk -F'|' '
  { d+=$2; t+=$3; pct=int(100*$2/$3); mark=($2==$3)?"done":(($2>0)?"in progress":"not started");
    rows = rows "| " $1 " | " $2 " / " $3 " | " mark " |\n" }
  END { printf "| Phase | Tasks done | Status |\n|-------|-----------:|--------|\n%s| **Total** | **%d / %d (%d%%)** | |\n", rows, d, t, int(100*d/t) }')

block="<!-- progress:start -->
$table
<!-- progress:end -->"

export BLOCK="$block"
new=$(awk '
  /<!-- progress:start -->/ { print ENVIRON["BLOCK"]; skip=1; next }
  /<!-- progress:end -->/ { skip=0; next }
  !skip { print }
' README.md)

if [ "${1:-}" = "--check" ]; then
  [ "$new" = "$(cat README.md)" ] || { echo "README.md progress table is out of date: run scripts/readme-status.sh" >&2; exit 1; }
else
  printf '%s\n' "$new" > README.md
fi
