#!/usr/bin/env bash
# Kete-owned. The container half of build-disk.sh (read that first): runs as root in the pinned
# Debian builder, without privileges or loop devices. Builds each partition as a file (mkfs.ext4 -d,
# mkfs.fat + mtools, grub-mkimage with the configuration built in) and writes them into a sparse
# GPT disk at the offsets sgdisk chose.
#
# Environment (from build-disk.sh): ARCH, KERNEL, KERNEL_RELEASE, KERNEL_SHA256, RESOLVERS,
# DISK_GIB, DEBIAN_SNAPSHOT, SOURCE_DATE_EPOCH, HOST_ID, TEST_DISK, and JOB_IMAGE (by digest; its
# signature was verified on the host) or ROOTFS_TAR (test disks).
set -euo pipefail
: "${ARCH:?}" "${KERNEL:?}" "${KERNEL_RELEASE:?}" "${KERNEL_SHA256:?}" "${RESOLVERS:?}" "${DISK_GIB:?}"
: "${DEBIAN_SNAPSHOT:?}" "${SOURCE_DATE_EPOCH:?}" "${HOST_ID:?}" "${TEST_DISK:?}"
export SOURCE_DATE_EPOCH E2FSPROGS_FAKE_TIME="$SOURCE_DATE_EPOCH"

INIT=/usr/local/libexec/kete/kete-job-init
W=/work
mkdir -p "$W/rootfs" /opt/grub

# Tools from the same Debian snapshot as the kernel build; GRUB's platform modules for the target
# come from that architecture's packages (data only: grub-mkimage is the builder's own).
cat > /etc/apt/sources.list.d/debian.sources <<EOF
Types: deb
URIs: http://snapshot.debian.org/archive/debian/$DEBIAN_SNAPSHOT
Suites: trixie trixie-updates
Components: main
Signed-By: /usr/share/keyrings/debian-archive-keyring.gpg
Check-Valid-Until: no
EOF
native="$(dpkg --print-architecture)"
[ "$native" = "$ARCH" ] || dpkg --add-architecture "$ARCH"
apt-get -o Acquire::Retries=5 update -qq
pkgs="e2fsprogs gdisk dosfstools mtools grub-common jq ca-certificates"
[ -n "${JOB_IMAGE:-}" ] && pkgs="$pkgs skopeo umoci"
DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 install -y -qq --no-install-recommends $pkgs >/dev/null
case "$ARCH" in
  amd64) grubpkgs="grub-pc-bin:amd64 grub-efi-amd64-bin:amd64" ;;
  arm64) grubpkgs="grub-efi-arm64-bin:arm64" ;;
esac
mkdir -p /tmp/grub-debs && chown _apt /tmp/grub-debs
(cd /tmp/grub-debs && apt-get -o Acquire::Retries=5 download -qq $grubpkgs)
for deb in /tmp/grub-debs/grub-*.deb; do dpkg-deb -x "$deb" /opt/grub; done
G=/opt/grub/usr/lib/grub

# The job image's root file system for this architecture, by the digest the host verified.
if [ -n "${JOB_IMAGE:-}" ]; then
  skopeo copy --quiet --override-os linux --override-arch "$ARCH" "docker://$JOB_IMAGE" "oci:$W/oci:job"
  umoci unpack --image "$W/oci:job" "$W/bundle" >/dev/null
  rmdir "$W/rootfs" && mv "$W/bundle/rootfs" "$W/rootfs"
  rm -rf "$W/oci" "$W/bundle"
else
  tar --numeric-owner -xpf "$ROOTFS_TAR" -C "$W/rootfs"
fi
R="$W/rootfs"

# What must and must not be in it (ADR 0023 rule 15): kete-job-init and nft present; nothing that
# takes commands from outside or logs anyone in.
[ -x "$R$INIT" ] || { echo "assemble-disk: $INIT missing" >&2; exit 1; }
[ -x "$R/usr/sbin/nft" ] || { echo "assemble-disk: /usr/sbin/nft missing (the metadata drop needs it)" >&2; exit 1; }
for f in usr/sbin/sshd usr/bin/sshd usr/sbin/dropbear usr/bin/cloud-init usr/bin/google_guest_agent \
  usr/bin/google_metadata_script_runner usr/sbin/waagent usr/bin/oracle-cloud-agent \
  opt/digitalocean/bin/droplet-agent usr/sbin/qemu-ga usr/bin/qemu-ga usr/bin/hcloud-init \
  lib/systemd/systemd usr/lib/systemd/systemd; do
  if [ -e "$R/$f" ] || [ -L "$R/$f" ]; then echo "assemble-disk: refusing: /$f is in the image" >&2; exit 1; fi
done
# Anywhere in the image, not only at the usual paths.
found="$(find "$R" -xdev \( -name sshd -o -name 'sshd-*' -o -name dropbear -o -name cloud-init \
  -o -name '*guest-agent*' -o -name '*guest_agent*' -o -name 'google_*' -o -name waagent \
  -o -name authorized_keys -o -name 'authorized_keys2' \) -print -quit)"
if [ -n "$found" ]; then
  echo "assemble-disk: refusing: ${found#"$R"} is in the image" >&2; exit 1
fi
for d in etc/ssh etc/cloud; do
  if [ -e "$R/$d" ] || [ -L "$R/$d" ]; then echo "assemble-disk: refusing: /$d is in the image" >&2; exit 1; fi
done
# Every account locked: the password field must start with * or ! (empty means no password at all).
if [ -f "$R/etc/shadow" ] && awk -F: 'NF > 1 && $2 !~ /^[*!]/ { bad = 1 } END { exit !bad }' "$R/etc/shadow"; then
  echo "assemble-disk: refusing: an account in /etc/shadow isn't locked (empty password or a hash)" >&2; exit 1
fi
if [ -f "$R/etc/passwd" ] && awk -F: 'NF > 1 && $2 != "x" && $2 !~ /^[*!]/ { bad = 1 } END { exit !bad }' "$R/etc/passwd"; then
  echo "assemble-disk: refusing: /etc/passwd holds a password field" >&2; exit 1
fi

# GRUB with its configuration built in: no menu, no timeout, no file it reads besides the kernel.
dns="${RESOLVERS}"
case "$ARCH" in
  amd64) console="console=ttyS0,115200" ;;
  # Both UARTs: the last one that exists is /dev/console (kete-job-init's phase lines).
  arm64) console="console=ttyS0,115200 console=ttyAMA0,115200" ;;
esac
# quiet: only kernel warnings and worse reach the console, so the phase lines the adapters read from
# it (ADR 0023 rule 19) don't interleave with a backlog of boot messages.
CMDLINE="root=PARTLABEL=kete-root rootfstype=ext4 ro rootwait init=$INIT $console quiet panic=1 kete.net=dhcp kete.dns=$dns"
{
  echo "set timeout=0"
  if [ "$ARCH" = amd64 ]; then
    echo "serial --unit=0 --speed=115200"
    echo "terminal_input serial console"
    echo "terminal_output serial console"
  fi
  echo "search --no-floppy --label --set=root KETE-EFI"
  echo "linux /vmlinuz $CMDLINE"
  echo "boot"
  echo "echo kete-cloudvm: boot failed"
  echo "halt"
} > "$W/grub.cfg"
mods="part_gpt fat search search_label linux echo halt test"
case "$ARCH" in
  amd64)
    grub-mkimage -d "$G/x86_64-efi" -O x86_64-efi -o "$W/BOOTX64.EFI" -c "$W/grub.cfg" -p /EFI/BOOT $mods serial terminal
    grub-mkimage -d "$G/i386-pc" -O i386-pc -o "$W/core.img" -c "$W/grub.cfg" -p '(hd0,gpt2)/' biosdisk $mods serial terminal
    efi="$W/BOOTX64.EFI"
    ;;
  arm64)
    grub-mkimage -d "$G/arm64-efi" -O arm64-efi -o "$W/BOOTAA64.EFI" -c "$W/grub.cfg" -p /EFI/BOOT $mods
    efi="$W/BOOTAA64.EFI"
    ;;
esac

# Layout (512-byte sectors): 1 BIOS boot 2048-4095, 2 EFI 64 MiB, 3 kete-root (the image plus a
# quarter, at least 1 GiB, whole 64 MiB), 4 kete-scratch to the end. Fixed GUIDs: the same inputs
# give the same layout.
used_mib=$(du -sm --apparent-size "$R" | cut -f1)
root_mib=$(( (used_mib * 5 / 4 + 256 + 63) / 64 * 64 ))
[ "$root_mib" -ge 1024 ] || root_mib=1024
disk="$W/disk.raw"
truncate -s "${DISK_GIB}G" "$disk"
sgdisk -o \
  -U 4b455445-0000-4000-8000-000000000000 \
  -n 1:2048:4095 -t 1:ef02 -c 1:bios-boot -u 1:4b455445-0000-4000-8000-000000000001 \
  -n 2:4096:+64M -t 2:ef00 -c 2:kete-efi -u 2:4b455445-0000-4000-8000-000000000002 \
  -n 3:0:+"${root_mib}"M -t 3:8300 -c 3:kete-root -u 3:4b455445-0000-4000-8000-000000000003 \
  -n 4:0:0 -t 4:8300 -c 4:kete-scratch -u 4:4b455445-0000-4000-8000-000000000004 \
  "$disk" >/dev/null
part() { sgdisk -i "$1" "$disk" | awk -v k="$2" '$0 ~ k { print $3; exit }'; }
write() { # write <image> <first sector>
  dd if="$1" of="$disk" bs=4M seek="$(( $2 * 512 ))" oflag=seek_bytes conv=notrunc,sparse status=none
}
size_kib() { echo $(( ($(part "$1" "Last sector") - $(part "$1" "First sector") + 1) / 2 )); }

# 2: the EFI system partition with GRUB and the kernel.
mkfs.fat -C -n KETE-EFI -i 4b455445 --invariant "$W/esp.img" "$(size_kib 2)" >/dev/null
cp "$KERNEL" "$W/vmlinuz"
touch -d "@$SOURCE_DATE_EPOCH" "$W/vmlinuz" "$efi"
export MTOOLS_SKIP_CHECK=1
mmd -i "$W/esp.img" ::/EFI ::/EFI/BOOT
mcopy -m -i "$W/esp.img" "$efi" ::/EFI/BOOT/
mcopy -m -i "$W/esp.img" "$W/vmlinuz" ::/vmlinuz
write "$W/esp.img" "$(part 2 "First sector")"

# 3: the image, read-only at boot (no journal needed); 4: the empty scratch.
mkfs.ext4 -q -L kete-root -U 4b455445-0000-4000-8000-0000000000e3 -O ^has_journal \
  -E hash_seed=4b455445-0000-4000-8000-0000000000f3,root_owner=0:0 -d "$R" "$W/root.img" "$(size_kib 3)k"
write "$W/root.img" "$(part 3 "First sector")"
rm -f "$W/root.img"
mkfs.ext4 -q -L kete-scratch -U 4b455445-0000-4000-8000-0000000000e4 \
  -E hash_seed=4b455445-0000-4000-8000-0000000000f4,lazy_itable_init=1,lazy_journal_init=1,root_owner=0:0 \
  "$W/scratch.img" "$(size_kib 4)k"
write "$W/scratch.img" "$(part 4 "First sector")"
rm -f "$W/scratch.img"

# 1 + MBR (amd64): what grub-bios-setup does for a core image embedded in a BIOS boot partition.
# grub-mkimage's i386-pc image starts with diskboot.img and has set its sector count; diskboot's
# blocklist (the last 12 bytes of its sector) gets the LBA of the rest of the core image, boot.img
# the LBA of the core image (offset 0x5c) and two NOPs over its floppy drive check (0x66). Only
# boot.img's first 440 bytes are written: the protective MBR's partition table stays.
if [ "$ARCH" = amd64 ]; then
  core_lba=2048
  core_sectors=$(( ($(stat -c %s "$W/core.img") + 511) / 512 ))
  [ "$core_sectors" -le 2048 ] || { echo "assemble-disk: GRUB core image larger than the BIOS boot partition" >&2; exit 1; }
  le64() { printf "$(printf '%016x' "$1" | sed -E 's/(..)(..)(..)(..)(..)(..)(..)(..)/\\x\8\\x\7\\x\6\\x\5\\x\4\\x\3\\x\2\\x\1/')"; }
  le64 $((core_lba + 1)) | dd of="$W/core.img" bs=1 seek=500 conv=notrunc status=none
  write "$W/core.img" "$core_lba"
  cp "$G/i386-pc/boot.img" "$W/boot.img"
  le64 "$core_lba" | dd of="$W/boot.img" bs=1 seek=$((0x5c)) conv=notrunc status=none
  printf '\x90\x90' | dd of="$W/boot.img" bs=1 seek=$((0x66)) conv=notrunc status=none
  dd if="$W/boot.img" of="$disk" bs=440 count=1 conv=notrunc status=none
fi

sgdisk -v "$disk" | grep -q "No problems found" || { echo "assemble-disk: GPT check failed" >&2; sgdisk -v "$disk" >&2; exit 1; }
name="kete-cloudvm-$ARCH"
cp --sparse=always "$disk" "/out/$name.raw"
disk_sha="sha256:$(sha256sum "/out/$name.raw" | cut -d' ' -f1)"
jq -n --arg arch "$ARCH" --arg image "${JOB_IMAGE:-}" --arg kr "$KERNEL_RELEASE" --arg ks "$KERNEL_SHA256" \
  --arg cmd "$CMDLINE" --arg disk "$disk_sha" --argjson gib "$DISK_GIB" --argjson test "$TEST_DISK" '{
    format: "kete-cloudvm-disk v1", arch: $arch, test: $test,
    job_image: (if $image == "" then null else $image end),
    job_image_digest: (if $image == "" then null else ($image | capture("@(?<d>sha256:[0-9a-f]{64})$").d) end),
    kernel_release: $kr, kernel_sha256: $ks, cmdline: $cmd, disk_gib: $gib, disk_sha256: $disk }' > "/out/$name.json"
chown "$HOST_ID" "/out/$name.raw" "/out/$name.json"
echo "built /out/$name.raw ($disk_sha)"
