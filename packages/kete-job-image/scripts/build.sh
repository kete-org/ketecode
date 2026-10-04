#!/usr/bin/env bash
# Kete-owned. Builds the cloud job image (packages/kete-job-image/README.md):
#   1. compiles kete-job-entrypoint, kete-job-init, kete-root-helper, kete-egress, and (for the e2e test layer)
#      kete-job-fake-platform and the e2e asserter, in golang:1.26-bookworm with the shared Go cache
#      volumes, CGO off, for one Linux architecture → .build/<arch>/bin/;
#   2. stages a minimal build context .build/ctx-<arch>/ (Dockerfile, Dockerfile.e2e, gitconfig,
#      LICENSE, NOTICE, bin/*, kete);
#   3. unless --no-image, `docker build`s it for linux/<arch> (plain docker build; another
#      architecture than the daemon's needs QEMU binfmt, as the release's arm64 build has).
#
# The Linux `kete` must be built first (packages/cli: bun run build --target=kete-linux-<x64|arm64>
# --skip-web-ui), or passed with --kete (the release job passes the released binary).
#
# Usage: scripts/build.sh [--arch amd64|arm64] [--kete <path>] [--tag <image>] [--version <v>]
#                         [--revision <sha>] [--no-image] [--load]
#   --load is accepted for symmetry with buildx and is the default (the image goes to the local daemon).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
PKGS="$REPO/packages"

arch=""
kete=""
tag="kete-job:local"
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
    --load) shift ;;
    *) echo "build.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [ -z "$arch" ]; then
  case "$(docker info --format '{{.Architecture}}')" in
    aarch64|arm64) arch=arm64 ;;
    x86_64|amd64) arch=amd64 ;;
    *) echo "build.sh: unknown Docker architecture; pass --arch" >&2; exit 2 ;;
  esac
fi
case "$arch" in
  arm64) bunarch=arm64 ;;
  amd64) bunarch=x64 ;;
  *) echo "build.sh: --arch must be amd64 or arm64" >&2; exit 2 ;;
esac
[ -n "$kete" ] || kete="$PKGS/cli/dist/cli-linux-$bunarch/bin/kete"
if [ ! -f "$kete" ]; then
  echo "build.sh: no Linux kete at $kete; build it first: (cd packages/cli && bun run build --target=kete-linux-$bunarch --skip-web-ui)" >&2
  exit 1
fi

out="$HERE/.build/$arch"
ctx="$HERE/.build/ctx-$arch"
mkdir -p "$out/bin"

echo "== Go binaries (linux/$arch)"
docker run --rm \
  -v "$PKGS:/src" -v "$out:/out" \
  -v kete-egress-gomod:/go/pkg/mod -v kete-egress-gocache:/root/.cache/go-build \
  -e CGO_ENABLED=0 -e GOOS=linux -e GOARCH="$arch" -e HOST_ID="$(id -u):$(id -g)" \
  golang:1.26-bookworm bash -euo pipefail -c '
    flags=(-trimpath -ldflags=-s)
    (cd /src/kete-job-entrypoint && go build "${flags[@]}" -o /out/bin/kete-job-entrypoint ./cmd/kete-job-entrypoint \
      && go build "${flags[@]}" -o /out/bin/kete-job-init ./cmd/kete-job-init \
      && go build "${flags[@]}" -o /out/bin/kete-job-fake-platform ./cmd/kete-job-fake-platform \
      && go test -c -tags e2e -o /out/bin/e2e.test ./internal/e2e)
    (cd /src/kete-root-helper && go build "${flags[@]}" -o /out/bin/kete-root-helper ./cmd/kete-root-helper)
    (cd /src/kete-egress && go build "${flags[@]}" -o /out/bin/kete-egress ./cmd/kete-egress)
    chmod 0755 /out/bin/*
    chown -R "$HOST_ID" /out
  '

echo "== staging $ctx"
rm -rf "$ctx"
mkdir -p "$ctx/bin"
cp "$HERE/Dockerfile" "$HERE/gitconfig" "$ctx/"
cp "$HERE/test/Dockerfile.e2e" "$ctx/Dockerfile.e2e"
cp "$REPO/LICENSE" "$REPO/NOTICE" "$ctx/"
chmod 0644 "$ctx/gitconfig" "$ctx/LICENSE" "$ctx/NOTICE"
for b in kete-job-entrypoint kete-job-init kete-root-helper kete-egress kete-job-fake-platform e2e.test; do
  ln "$out/bin/$b" "$ctx/bin/$b" 2>/dev/null || cp "$out/bin/$b" "$ctx/bin/$b"
done
# A hard link when kete is on the same file system (no 170 MB copy), else a copy.
ln "$kete" "$ctx/kete" 2>/dev/null || cp "$kete" "$ctx/kete"
chmod 0755 "$ctx/kete" "$ctx/bin/"*

if [ "$image" = 1 ]; then
  echo "== docker build $tag"
  docker build --platform "linux/$arch" --build-arg VERSION="$version" --build-arg REVISION="$revision" -t "$tag" "$ctx"
  docker image inspect "$tag" --format 'image {{.Id}} {{.Architecture}} {{.Size}} bytes'
fi
