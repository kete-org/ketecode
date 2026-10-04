#!/usr/bin/env bash
# Kete-owned. Boots a cloudvm disk (scripts/build-disk.sh) under QEMU the way a provider would, and
# checks kete-job-init gets as far as starting the entrypoint:
#   firmware (UEFI, or BIOS for amd64) → GRUB → Kete's cloudvm kernel → kete-job-init as PID 1 →
#   overlay root on kete-scratch → its DHCP client → the provider found by DMI → the user data
#   from a fake metadata service at 169.254.169.254 → the metadata drop → the entrypoint.
#
# Everything runs in one container (pinned Debian builder; QEMU, dnsmasq, a Python metadata
# server, a bridge and a tap inside the container's own network namespace), so the Docker host is
# not changed. It needs /dev/kvm for a disk of the host's architecture (TCG otherwise: slow) and
# /dev/net/tun. The provider decides the DMI fields, the disk bus, the user-data endpoint and the
# shape of the DHCP lease, like the real ones:
#   gcp           /32 address, gateway through classless static routes (option 121), virtio-scsi
#   hetzner       /32 address, off-link router 172.31.1.1 (no option 121), virtio-scsi
#   oci           /24 subnet with the router in it, virtio-scsi, base64 user data
#   digitalocean  /24 subnet with the router in it, virtio-blk
# The guest has no route to the internet: the entrypoint starts, runs its first steps and fails at
# the platform, which is past what this test checks.
#
# Usage: test/boot-test.sh --disk FILE --arch amd64|arm64 [--provider P] [--firmware uefi|bios]
#                          [--timeout SECONDS] [--log FILE]
# Exit 0 when every expected phase line appeared in order (and the metadata service served the
# user data exactly once); the serial log is kept in --log (default: next to the disk).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILDER=debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a
DEBIAN_SNAPSHOT=20261001T000000Z

disk="" arch="" provider=hetzner firmware=uefi timeout=240 log=""
while [ $# -gt 0 ]; do
  case "$1" in
    --disk) disk="$2"; shift 2 ;;
    --arch) arch="$2"; shift 2 ;;
    --provider) provider="$2"; shift 2 ;;
    --firmware) firmware="$2"; shift 2 ;;
    --timeout) timeout="$2"; shift 2 ;;
    --log) log="$2"; shift 2 ;;
    *) echo "boot-test.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -f "$disk" ] || { echo "boot-test.sh: --disk FILE is required" >&2; exit 2; }
case "$arch" in amd64|arm64) ;; *) echo "boot-test.sh: --arch amd64|arm64" >&2; exit 2 ;; esac
case "$provider" in gcp|hetzner|oci|digitalocean) ;; *) echo "boot-test.sh: unknown provider" >&2; exit 2 ;; esac
case "$firmware" in uefi) ;; bios) [ "$arch" = amd64 ] || { echo "boot-test.sh: BIOS is amd64 only" >&2; exit 2; } ;; *) exit 2 ;; esac
ddir="$(cd "$(dirname "$disk")" && pwd)"
log="${log:-$ddir/boot-$arch-$provider-$firmware.log}"
ldir="$(cd "$(dirname "$log")" && pwd)"

# BOOT_TEST_KVM=0: no /dev/kvm on the Docker host (TCG; a disk of another architecture always
# runs under TCG).
kvmdev=()
if [ "${BOOT_TEST_KVM:-1}" = 1 ]; then kvmdev=(--device /dev/kvm); fi
docker run --rm --cap-add NET_ADMIN --device /dev/net/tun "${kvmdev[@]}" \
  -v "$HERE:/test:ro" -v "$ddir:/disk:ro" -v "$ldir:/log" \
  -e DISK="/disk/$(basename "$disk")" -e ARCH="$arch" -e PROVIDER="$provider" -e FIRMWARE="$firmware" \
  -e TIMEOUT="$timeout" -e LOG="/log/$(basename "$log")" -e DEBIAN_SNAPSHOT="$DEBIAN_SNAPSHOT" \
  -e HOST_ID="$(id -u):$(id -g)" "$BUILDER" bash /test/boot-test-inner.sh
