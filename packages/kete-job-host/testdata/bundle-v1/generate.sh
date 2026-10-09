#!/usr/bin/env bash
# Regenerates bundles.json and SHA256SUMS from a kete-code-platform checkout, with the platform's
# own validator running on Node. Writes nothing into the platform checkout.
#   ./generate.sh /path/to/kete-code-platform
# Needs bun (to bundle generate.ts against the platform's sources) and node.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
platform=$(cd "${1:?usage: generate.sh <kete-code-platform checkout>}" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cp "$here/generate.ts" "$tmp/generate.ts"
printf '{"compilerOptions":{"baseUrl":".","paths":{"@portal/*":["%s/apps/portal/*"]}}}\n' "$platform" >"$tmp/tsconfig.json"
(cd "$tmp" && bun build ./generate.ts --target=node --format=esm --outfile "$tmp/generate.mjs" >/dev/null)
KETE_PLATFORM_COMMIT=$(git -C "$platform" rev-parse HEAD) node "$tmp/generate.mjs" >"$here/bundles.json"
(cd "$here" && shasum -a 256 bundles.json generate.sh generate.ts >SHA256SUMS)
