#!/usr/bin/env bash
# Kete-owned. Builds the cloudvm base disk (kete-code-platform ADR 0023 rules 15, 17, 18, 21): one
# raw GPT disk per architecture from a release's job image and Kete's cloudvm kernel, which the
# Packer template (../cloudvm.pkr.hcl) converts and imports into each provider.
#
#   1. Only a release-signed image (rule 17): `cosign verify` of the job image's index digest
#      against the release workflow's identity, on this host, before anything is pulled.
#   2. The cloudvm kernel (packages/kete-job-host/kernel/build.sh --variant cloudvm): its file must
#      match its .sha256, and its .config must pass check-config.sh --variant cloudvm (drivers,
#      DHCP, nftables, ext4, overlayfs built in; no modules: the image has no module loader).
#   3. In a pinned Debian builder (container root, no privileges, no loop devices; see
#      assemble-disk.sh): the job image's linux/<arch> root file system by that same digest, with
#      no SSH server, cloud-init, provider guest agent or getty allowed in it; GRUB (BIOS + UEFI on
#      amd64, UEFI on arm64) with its configuration built in; the disk.
#
# Disk: 1 BIOS boot (GRUB core), 2 EFI system (GRUB, the kernel), 3 kete-root (the image, ext4,
# mounted read-only), 4 kete-scratch (empty ext4, kete-job-init's overlay upper layer). PID 1 is
# kete-job-init (`init=`), which configures the network with its own DHCP client (`kete.net=dhcp`)
# and the given public resolvers (`kete.dns=`), reads the provider's user data and drops the
# metadata service before starting the entrypoint. No user account has a password or key; nothing
# listens.
#
# Output in --out: kete-cloudvm-<arch>.raw (sparse) and kete-cloudvm-<arch>.json (the job image and
# its digest, the kernel's release and digest, the command line, the disk's SHA-256), which the
# Packer template checks before every import.
#
# Usage:
#   build-disk.sh --arch amd64|arm64 --job-image ghcr.io/kete-org/kete-job@sha256:<64 hex> \
#                 --kernel-dir DIR --out DIR [--resolvers 1.1.1.1,8.8.8.8] [--disk-gib 20] \
#                 [--identity-regexp RE]
#   build-disk.sh --arch arm64 --test-rootfs-tar FILE --kernel-dir DIR --out DIR
#       Test disks only (the boot test, test/boot-test.sh): the root file system from a tar instead
#       of a signed image, no signature check; the manifest says "test": true and the Packer template
#       refuses it.
# Needs Docker, and cosign (v3) for --job-image.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
KERNEL_TOOLS="$REPO/packages/kete-job-host/kernel"

# The builder and its packages, as the kernel build pins them (kernel/build.sh).
BUILDER=debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a
DEBIAN_SNAPSHOT=20261001T000000Z
SOURCE_DATE_EPOCH=1790985600
IDENTITY_DEFAULT='^https://github\.com/kete-org/ketecode/\.github/workflows/kete-release\.yml@refs/tags/kete-v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'
ISSUER=https://token.actions.githubusercontent.com

arch="" job_image="" rootfs_tar="" kernel_dir="" out="" resolvers="1.1.1.1,8.8.8.8" disk_gib=20
identity="$IDENTITY_DEFAULT"
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) arch="$2"; shift 2 ;;
    --job-image) job_image="$2"; shift 2 ;;
    --test-rootfs-tar) rootfs_tar="$2"; shift 2 ;;
    --kernel-dir) kernel_dir="$2"; shift 2 ;;
    --out) out="$2"; shift 2 ;;
    --resolvers) resolvers="$2"; shift 2 ;;
    --disk-gib) disk_gib="$2"; shift 2 ;;
    --identity-regexp) identity="$2"; shift 2 ;;
    *) echo "build-disk.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
die() { echo "build-disk.sh: $*" >&2; exit 1; }
case "$arch" in amd64|arm64) ;; *) die "--arch must be amd64 or arm64" ;; esac
[ -n "$kernel_dir" ] && [ -d "$kernel_dir" ] || die "--kernel-dir must be a directory"
[ -n "$out" ] || die "--out is required"
[[ "$disk_gib" =~ ^[0-9]+$ ]] && [ "$disk_gib" -ge 8 ] && [ "$disk_gib" -le 64 ] || die "--disk-gib must be 8-64"
# One or two public IPv4 resolvers: the rule kete-job-init applies to kete.dns at boot
# (guestinit.ParseCmdline / publicIPv4): not 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12,
# 192.168/16, 224/4 or 240/4.
public_ipv4() {
  local a b c d
  [[ "$1" =~ ^(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})\.(0|[1-9][0-9]{0,2})$ ]] || return 1
  a=${BASH_REMATCH[1]} b=${BASH_REMATCH[2]} c=${BASH_REMATCH[3]} d=${BASH_REMATCH[4]}
  [ "$a" -le 255 ] && [ "$b" -le 255 ] && [ "$c" -le 255 ] && [ "$d" -le 255 ] || return 1
  [ "$a" -ne 0 ] && [ "$a" -ne 10 ] && [ "$a" -ne 127 ] && [ "$a" -lt 224 ] || return 1
  if [ "$a" -eq 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ]; then return 1; fi
  if [ "$a" -eq 169 ] && [ "$b" -eq 254 ]; then return 1; fi
  if [ "$a" -eq 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ]; then return 1; fi
  if [ "$a" -eq 192 ] && [ "$b" -eq 168 ]; then return 1; fi
  return 0
}
IFS=, read -r -a resolver_list <<<"$resolvers"
[ "${#resolver_list[@]}" -ge 1 ] && [ "${#resolver_list[@]}" -le 2 ] && [[ "$resolvers" != *, ]] \
  || die "--resolvers must be one or two public IPv4 addresses"
for r in "${resolver_list[@]}"; do
  public_ipv4 "$r" || die "--resolvers: $r is not a public IPv4 address"
done
test_disk=false
if [ -n "$job_image" ]; then
  [ -z "$rootfs_tar" ] || die "--job-image and --test-rootfs-tar exclude each other"
  [[ "$job_image" =~ ^ghcr\.io/kete-org/kete-job@sha256:[0-9a-f]{64}$ ]] || die "--job-image must be ghcr.io/kete-org/kete-job pinned by sha256 digest"
elif [ -n "$rootfs_tar" ]; then
  [ -f "$rootfs_tar" ] || die "--test-rootfs-tar: no such file"
  test_disk=true
else
  die "give --job-image (or --test-rootfs-tar for a test disk)"
fi

# 2. The cloudvm kernel for this architecture, its digest and its configuration.
shopt -s nullglob
kernels=("$kernel_dir"/kete-cloudvm-kernel-*-"$arch")
shopt -u nullglob
[ "${#kernels[@]}" = 1 ] || die "want exactly one kete-cloudvm-kernel-*-$arch in $kernel_dir, found ${#kernels[@]}"
kernel="${kernels[0]}"
kname="$(basename "$kernel")"
krelease="${kname#kete-cloudvm-kernel-}"
krelease="${krelease%-"$arch"}"
ksum="sha256:$(sha256sum "$kernel" | cut -d' ' -f1)"
[ "$(cat "$kernel.sha256")" = "$ksum" ] || die "$kname doesn't match its .sha256"
"$KERNEL_TOOLS/check-config.sh" --variant cloudvm --arch "$arch" "$kernel.config" >/dev/null \
  || die "$kname.config fails check-config.sh --variant cloudvm"

# 1. The signature, before anything is pulled.
if [ "$test_disk" = false ]; then
  command -v cosign >/dev/null || die "cosign is required"
  cosign verify --certificate-identity-regexp "$identity" --certificate-oidc-issuer "$ISSUER" \
    "$job_image" >/dev/null || die "the job image's signature doesn't verify against the release identity"
  echo "== signature verified: $job_image"
fi

mkdir -p "$out"
out="$(cd "$out" && pwd)"
kdir="$(cd "$(dirname "$kernel")" && pwd)"
mounts=(-v "$HERE:/scripts:ro" -v "$kdir:/kernel:ro" -v "$out:/out")
envs=(-e ARCH="$arch" -e KERNEL="/kernel/$kname" -e KERNEL_RELEASE="$krelease" -e KERNEL_SHA256="$ksum"
  -e RESOLVERS="$resolvers" -e DISK_GIB="$disk_gib" -e DEBIAN_SNAPSHOT="$DEBIAN_SNAPSHOT"
  -e SOURCE_DATE_EPOCH="$SOURCE_DATE_EPOCH" -e HOST_ID="$(id -u):$(id -g)" -e TEST_DISK="$test_disk")
if [ "$test_disk" = true ]; then
  tdir="$(cd "$(dirname "$rootfs_tar")" && pwd)"
  mounts+=(-v "$tdir:/rootfs-in:ro")
  envs+=(-e ROOTFS_TAR="/rootfs-in/$(basename "$rootfs_tar")")
else
  envs+=(-e JOB_IMAGE="$job_image")
fi
echo "== assembling the $arch disk in $BUILDER"
docker run --rm "${mounts[@]}" "${envs[@]}" "$BUILDER" bash /scripts/assemble-disk.sh
echo "== $(cat "$out/kete-cloudvm-$arch.json")"
