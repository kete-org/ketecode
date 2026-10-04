#!/usr/bin/env bash
# Kete-owned. Packer's first step for every provider (../cloudvm.pkr.hcl): checks the base disk
# build-disk.sh made against what this build was asked for, then writes the provider's upload
# format. Refuses a test disk, another architecture or job image, or a disk whose bytes changed
# since it was built.
#
# Environment: DISK_DIR, ARCH, JOB_IMAGE, OUT, FORMAT (gcp | raw.gz | raw.xz | qcow2). Needs jq,
# sha256sum, tar, gzip, xz, and qemu-img for qcow2.
set -euo pipefail
: "${DISK_DIR:?}" "${ARCH:?}" "${JOB_IMAGE:?}" "${OUT:?}" "${FORMAT:?}"
die() { echo "convert-disk: $*" >&2; exit 1; }
disk="$DISK_DIR/kete-cloudvm-$ARCH.raw"
manifest="$DISK_DIR/kete-cloudvm-$ARCH.json"
[ -f "$disk" ] && [ -f "$manifest" ] || die "no kete-cloudvm-$ARCH.raw/.json in $DISK_DIR"
jq -e --arg arch "$ARCH" --arg image "$JOB_IMAGE" \
  '.format == "kete-cloudvm-disk v1" and .test == false and .arch == $arch and .job_image == $image' \
  "$manifest" >/dev/null || die "the disk's manifest isn't a release disk of $JOB_IMAGE for $ARCH"
want="$(jq -r .disk_sha256 "$manifest")"
[ "sha256:$(sha256sum "$disk" | cut -d' ' -f1)" = "$want" ] || die "the disk doesn't match its manifest's disk_sha256"
[ "$FORMAT" != raw.gz ] || [ "$ARCH" = amd64 ] || die "DigitalOcean has no arm64 Droplets"
mkdir -p "$OUT"
case "$FORMAT" in
  # GCP imports a tar.gz holding exactly disk.raw (sparse; size a whole number of GiB).
  gcp) ln -sf "$(cd "$DISK_DIR" && pwd)/kete-cloudvm-$ARCH.raw" "$OUT/disk.raw"
       tar -C "$OUT" --dereference -Sczf "$OUT/disk.raw.tar.gz" disk.raw
       rm -f "$OUT/disk.raw" ;;
  raw.gz) gzip -c "$disk" > "$OUT/disk.raw.gz" ;;
  raw.xz) xz -T0 -c "$disk" > "$OUT/disk.raw.xz" ;;
  qcow2) qemu-img convert -f raw -O qcow2 "$disk" "$OUT/disk.qcow2" ;;
  *) die "unknown FORMAT $FORMAT" ;;
esac
echo "converted kete-cloudvm-$ARCH ($JOB_IMAGE) to $FORMAT"
