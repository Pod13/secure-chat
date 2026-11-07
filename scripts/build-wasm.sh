#!/usr/bin/env bash
# Builds the MLS module from crypto-wasm/. The Node build (.wasm-node/) is used by the tests that
# run real cryptography; add `web` to also build the browser module for the app.
set -euo pipefail
cd "$(dirname "$0")/../crypto-wasm"
source "$HOME/.cargo/env" 2>/dev/null || true
wasm-pack build --target nodejs --release --out-dir ../.wasm-node --out-name crypto_wasm --quiet
if [ "${1:-}" = "web" ]; then
  wasm-pack build --target web --release --out-dir ../web/src/wasm --out-name crypto_wasm --quiet
fi
