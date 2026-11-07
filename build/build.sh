#!/usr/bin/env bash
# Reproducible web build: the same source and lockfile give byte-identical output.
# Usage: build/build.sh <version> <minClientVersion> <keyId> [outdir]
# Produces <outdir>/ (default build/out/web) with content-hashed assets and manifest.unsigned.txt.
# Signing is a separate step done in the HSM; see build/sign-manifest.ts.
set -euo pipefail

version="${1:?version}"; min="${2:?minClientVersion}"; key="${3:?keyId}"
root="$(cd "$(dirname "$0")/.." && pwd)"
out="${4:-$root/build/out/web}"

export TZ=UTC LC_ALL=C SOURCE_DATE_EPOCH=0
[ -d "$root/web/node_modules" ] || (cd "$root/web" && npm ci)
rm -rf "$out"
(cd "$root/web" && npx vite build --outDir "$out" --emptyOutDir >/dev/null \
  && npx vite build --config vite.sw.config.ts --outDir "$out" >/dev/null)
node "$root/build/sign-manifest.ts" unsigned "$out" "$version" "$min" "$key"
echo "built $out"
