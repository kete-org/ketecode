#!/usr/bin/env bash
# Kete-owned. Builds Kete's guest kernels (kete-code-platform ADR 0023 rule 21) reproducibly: a
# pinned Linux LTS tarball (SHA-256 checked), a checked-in configuration, a pinned builder image
# with its packages from a fixed Debian snapshot, and fixed build metadata
# (KBUILD_BUILD_TIMESTAMP/USER/HOST, no git, no host paths). Two variants of the same source:
#
#   microvm (default)  kernel/config-<arch>, the Firecracker guest of the host agent. Output:
#     kete-guest-kernel-<release>-<arch>          vmlinux (amd64, ELF) or Image (arm64), as
#                                                  Firecracker loads them
#     kete-guest-kernel-<release>-<arch>.sha256   "sha256:<hex>", the agent's kernel_allowlist entry
#   cloudvm  kernel/config-cloudvm-<arch>, the kernel of the provider images (one VM per job;
#            packages/kete-job-image/packer). Output:
#     kete-cloudvm-kernel-<release>-<arch>          bzImage (amd64) or Image (arm64, EFI stub), as
#                                                    GRUB loads them
#     kete-cloudvm-kernel-<release>-<arch>.sha256   "sha256:<hex>"
#     kete-cloudvm-kernel-<release>-<arch>.config   the resolved configuration (the disk build
#                                                    checks it again)
# The release workflow signs the microvm kernel with cosign keyless signing (sign-blob), like the
# job image; the cloudvm kernel goes only into provider images built by CI (kete-cloudvm-images.yml).
#
# Usage: kernel/build.sh <amd64|arm64> [--variant microvm|cloudvm] [--out DIR] [--jobs N] [--regen-config|--check-only]
#   --regen-config  rebuild the variant's configuration from Firecracker's validated guest
#                   configuration (pinned commit and SHA-256) plus kernel/kete.fragment (and, for
#                   cloudvm, cloudvm.fragment and cloudvm-<arch>.fragment), instead of building.
#   --check-only    check the variant's configuration (stable under olddefconfig, check-config.sh)
#                   without compiling: what CI runs on every kernel change (kete-job-host.yml).
# Needs Docker. Builds natively when the Docker daemon's architecture matches, else cross-compiles
# (the release builds both on linux/amd64).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Pins. Bump LINUX_VERSION + LINUX_SHA256 (kernel.org sha256sums.asc) for a fix, reset KETE_REV to
# 1, run --regen-config for both arches, check the diff, and update the agent allowlist.
LINUX_VERSION=6.18.55
LINUX_SHA256=f410638061a165c12f42ab871d2f3fcd525515359b5faeee80969cff84524df9
KETE_REV=1
SOURCE_DATE_EPOCH=1790985600 # 2026-10-03T00:00:00Z
BUILDER=debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a
DEBIAN_SNAPSHOT=20261001T000000Z
FC_COMMIT=95f868c8e345b1cc8faccd1a3c910b4989dc3f58 # firecracker v1.17.0
FC_CONFIG_SHA256_amd64=ba22401a0c7292a4c024ebcd10a562d4a1f1bfd2faed671406d3b159c0cf5215
FC_CONFIG_SHA256_arm64=35cce8e8b754a84523ca20dc068fc3f8f03a15523be36a8623bad54e11972e2a

arch="${1:-}"
shift || true
out="$HERE/dist"
jobs=""
regen=0
check_only=0
variant=microvm
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --jobs) jobs="$2"; shift 2 ;;
    --regen-config) regen=1; shift ;;
    --check-only) check_only=1; shift ;;
    --variant) variant="$2"; shift 2 ;;
    *) echo "build.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ "$regen$check_only" != 11 ] || { echo "build.sh: --regen-config and --check-only are exclusive" >&2; exit 2; }
case "$arch" in
  amd64) karch=x86_64; fcarch=x86_64; cross=x86_64-linux-gnu; target=vmlinux; artifact=vmlinux; fcsum="$FC_CONFIG_SHA256_amd64" ;;
  arm64) karch=arm64; fcarch=aarch64; cross=aarch64-linux-gnu; target=Image; artifact=arch/arm64/boot/Image; fcsum="$FC_CONFIG_SHA256_arm64" ;;
  *) echo "usage: build.sh <amd64|arm64> [--variant microvm|cloudvm] [--out DIR] [--jobs N] [--regen-config|--check-only]" >&2; exit 2 ;;
esac
case "$variant" in
  microvm) cfgname="config-$arch"; prefix=kete-guest-kernel ;;
  cloudvm)
    cfgname="config-cloudvm-$arch"; prefix=kete-cloudvm-kernel
    # GRUB loads a bzImage on amd64; arm64's Image carries the EFI stub either way.
    if [ "$arch" = amd64 ]; then target=bzImage; artifact=arch/x86/boot/bzImage; fi
    ;;
  *) echo "build.sh: unknown variant $variant" >&2; exit 2 ;;
esac
release="$LINUX_VERSION-kete.$KETE_REV"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
cache="$HERE/.cache"
mkdir -p "$cache"

tarball="$cache/linux-$LINUX_VERSION.tar.xz"
if [ ! -f "$tarball" ] || ! echo "$LINUX_SHA256  $tarball" | sha256sum -c - >/dev/null 2>&1; then
  echo "== downloading linux-$LINUX_VERSION"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$tarball.part" "https://cdn.kernel.org/pub/linux/kernel/v6.x/linux-$LINUX_VERSION.tar.xz"
  mv "$tarball.part" "$tarball"
fi
echo "$LINUX_SHA256  $tarball" | sha256sum -c - >/dev/null || { echo "build.sh: linux-$LINUX_VERSION.tar.xz checksum mismatch" >&2; exit 1; }

if [ "$regen" = 1 ]; then
  base="$cache/fc-$fcarch.config"
  curl -fsSL --proto '=https' --tlsv1.2 -o "$base" \
    "https://raw.githubusercontent.com/firecracker-microvm/firecracker/$FC_COMMIT/resources/guest_configs/microvm-kernel-ci-$fcarch-6.18.config"
  echo "$fcsum  $base" | sha256sum -c - >/dev/null || { echo "build.sh: Firecracker base config checksum mismatch" >&2; exit 1; }
fi

echo "== building $release ($variant) for $arch in $BUILDER (linux/amd64)"
# Always a linux/amd64 builder, as on the release runner: Kconfig records what the compiler can do
# (CC_CAN_LINK, CC_HAS_MARCH_NATIVE, ...), which differs between a native and a cross toolchain, so
# configs regenerated on an arm64 machine would fail the stability check in CI. amd64 builds natively
# and arm64 with the cross compiler everywhere (emulated on an arm64 host: slower, same bytes).
docker run --rm --platform linux/amd64 \
  -v "$HERE:/kernel:ro" -v "$cache:/cache" -v "$out:/out" \
  -e ARCH="$karch" -e CROSS="$cross" -e TARGET="$target" -e ARTIFACT="$artifact" -e KARCH_NAME="$arch" \
  -e LINUX_VERSION="$LINUX_VERSION" -e RELEASE="$release" -e KETE_REV="$KETE_REV" \
  -e SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" -e DEBIAN_SNAPSHOT="$DEBIAN_SNAPSHOT" -e REGEN="$regen" \
  -e FCARCH="$fcarch" -e JOBS="$jobs" -e HOST_ID="$(id -u):$(id -g)" \
  -e VARIANT="$variant" -e CFGNAME="$cfgname" -e PREFIX="$prefix" -e CHECK_ONLY="$check_only" \
  "$BUILDER" bash -euo pipefail -c '
    cat > /etc/apt/sources.list.d/debian.sources <<EOF
Types: deb
URIs: http://snapshot.debian.org/archive/debian/$DEBIAN_SNAPSHOT
Suites: trixie trixie-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
Check-Valid-Until: no
EOF
    apt-get -o Acquire::Retries=5 update -qq
    native=$(dpkg --print-architecture)
    want=$([ "$KARCH_NAME" = amd64 ] && echo amd64 || echo arm64)
    pkgs="make bc bison flex libelf-dev libssl-dev xz-utils cpio python3 kmod"
    pkgs="$pkgs gcc libc6-dev" # host tools
    if [ "$native" = "$want" ]; then cc=""; else pkgs="$pkgs gcc-${CROSS//_/-}"; cc="$CROSS-"; fi
    DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y -qq --no-install-recommends $pkgs >/dev/null
    mkdir -p /build && cd /build
    tar -xf /cache/linux-$LINUX_VERSION.tar.xz
    cd linux-$LINUX_VERSION
    export KBUILD_BUILD_TIMESTAMP="@$SOURCE_DATE_EPOCH" KBUILD_BUILD_USER=kete KBUILD_BUILD_HOST=kete KBUILD_BUILD_VERSION=$KETE_REV
    mk() { make ARCH="$ARCH" CROSS_COMPILE="$cc" LOCALVERSION="-kete.$KETE_REV" "$@"; }
    if [ "$REGEN" = 1 ]; then
      cp /cache/fc-$FCARCH.config .config
      fragments="/kernel/kete.fragment"
      if [ "$VARIANT" = cloudvm ]; then fragments="$fragments /kernel/cloudvm.fragment /kernel/cloudvm-$KARCH_NAME.fragment"; fi
      ./scripts/kconfig/merge_config.sh -m .config $fragments >/dev/null
      mk olddefconfig >/dev/null
      /kernel/check-config.sh --variant "$VARIANT" --arch "$KARCH_NAME" .config
      sed -i -e "/^# Linux\/.* Kernel Configuration$/d" -e "/^# Compiler: /d" -e "/^CONFIG_CC_VERSION_TEXT=/d" .config
      cp .config /out/$CFGNAME
      chown "$HOST_ID" /out/$CFGNAME
      echo "regenerated $CFGNAME (copy it to kernel/)"
      exit 0
    fi
    cp /kernel/$CFGNAME .config
    mk olddefconfig >/dev/null
    norm() { sed -e "/^# Linux\/.* Kernel Configuration$/d" -e "/^# Compiler: /d" -e "/^CONFIG_CC_VERSION_TEXT=/d" "$1"; }
    if ! diff -u <(norm /kernel/$CFGNAME) <(norm .config) >/tmp/config.diff; then
      echo "build.sh: kernel/$CFGNAME is not stable under olddefconfig; run --regen-config:" >&2
      head -n 40 /tmp/config.diff >&2
      exit 1
    fi
    /kernel/check-config.sh --variant "$VARIANT" --arch "$KARCH_NAME" .config
    if [ "$CHECK_ONLY" = 1 ]; then echo "$CFGNAME is stable and passes check-config.sh"; exit 0; fi
    mk -j"${JOBS:-$(nproc)}" "$TARGET" >/dev/null
    [ "$(mk -s kernelrelease)" = "$RELEASE" ] || { echo "build.sh: kernelrelease $(mk -s kernelrelease) != $RELEASE" >&2; exit 1; }
    name=$PREFIX-$RELEASE-$KARCH_NAME
    install -m 0444 "$ARTIFACT" /out/$name
    echo "sha256:$(sha256sum /out/$name | cut -d" " -f1)" > /out/$name.sha256
    files="/out/$name /out/$name.sha256"
    if [ "$VARIANT" = cloudvm ]; then
      norm .config > /out/$name.config
      chmod 0444 /out/$name.config
      files="$files /out/$name.config"
    fi
    chown "$HOST_ID" $files
    echo "built $name $(cat /out/$name.sha256)"
  '
