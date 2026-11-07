#!/usr/bin/env bash
# Generate CycloneDX SBOMs for a release (Constitution IX). Output goes to build/out/.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
out="$root/build/out"
mkdir -p "$out"

(cd "$root/web" && npm sbom --sbom-format cyclonedx --omit dev > "$out/web.sbom.json")

if [ -f "$root/Cargo.toml" ] || [ -f "$root/server/Cargo.toml" ]; then
  command -v cargo-cyclonedx >/dev/null || { echo "cargo-cyclonedx is required for the Rust SBOM" >&2; exit 1; }
  (cd "$root" && cargo cyclonedx --format json)
fi

echo "SBOMs written to $out"
