#!/usr/bin/env bash
# Kete-owned. Builds the Kete Code Harness step image (packages/kete-harness-plugin/README.md):
#   1. compiles the entrypoint (src/main.ts) with Bun into one Linux binary for the architecture;
#   2. stages a minimal build context .build/ctx-<arch>/ (Dockerfile, gitconfig, LICENSE, NOTICE,
#      bin/kete-harness-plugin, kete);
#   3. unless --no-image, `docker build`s it for linux/<arch> (another architecture than the
#      daemon's needs QEMU binfmt).
#
# The Linux `kete` must be built first (packages/cli: bun run build --target=kete-linux-<x64|arm64>
# --skip-web-ui), or passed with --kete (the release passes the released, checksum-verified binary).
# Needs `bun install` to have run at the repository root (the entrypoint imports @opencode/util).
#
# Usage: scripts/build.sh [--arch amd64|arm64] [--kete <path>] [--tag <image>] [--version <v>]
#                         [--revision <sha>] [--no-image]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"

arch=""
kete=""
tag="kete-harness-plugin:local"
version="dev"
revision="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
image=1
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) arch="$2"; shift 2 ;;
    --kete) kete="$2"; shift 2 ;;
    --tag) tag="$2"; shift 2 ;;
    --version) version="$2"; shift 2 ;;
    --revision) revision="$2"; shift 2 ;;
    --no-image) image=0; shift ;;
    *) echo "build.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ -z "$arch" ]; then
  case "$(uname -m)" in
    aarch64|arm64) arch=arm64 ;;
    x86_64|amd64) arch=amd64 ;;
    *) echo "build.sh: unknown architecture; pass --arch" >&2; exit 2 ;;
  esac
fi
case "$arch" in
  arm64) bunarch=arm64 ;;
  amd64) bunarch=x64 ;;
  *) echo "build.sh: --arch must be amd64 or arm64" >&2; exit 2 ;;
esac
[ -n "$kete" ] || kete="$REPO/packages/cli/dist/cli-linux-$bunarch/bin/kete"
if [ ! -f "$kete" ]; then
  echo "build.sh: no Linux kete at $kete; build it first: (cd packages/cli && bun run build --target=kete-linux-$bunarch --skip-web-ui)" >&2
  exit 1
fi

ctx="$HERE/.build/ctx-$arch"
rm -rf "$ctx"
mkdir -p "$ctx/bin"

echo "== entrypoint (bun-linux-$bunarch)"
(cd "$HERE" && bun build --compile --minify --sourcemap=none --target="bun-linux-$bunarch" src/main.ts --outfile "$ctx/bin/kete-harness-plugin")

echo "== staging $ctx"
cp "$HERE/Dockerfile" "$HERE/gitconfig" "$ctx/"
cp "$REPO/LICENSE" "$REPO/NOTICE" "$ctx/"
cp "$kete" "$ctx/kete"
chmod 0755 "$ctx/kete" "$ctx/bin/kete-harness-plugin"

if [ "$image" = 1 ]; then
  echo "== docker build $tag (linux/$arch)"
  docker build --platform "linux/$arch" --build-arg VERSION="$version" --build-arg REVISION="$revision" -t "$tag" "$ctx"
fi
