#!/usr/bin/env bash
# Kete-owned. Installs the kete-job-host agent for the firecracker driver on a systemd Linux host
# (kete-code-platform ADR 0023 rules 6-7, 21). It installs files and host settings only: it never
# enrolls, never starts the service and never downloads anything. Every artifact is a local file
# the operator fetched from a kete-v* release and checked; the Firecracker release's own
# SHA256SUMS line is passed in and verified here.
#
# Usage: sudo packaging/install.sh --agent PATH --firecracker PATH --jailer PATH \
#          --firecracker-sha256 HEX --jailer-sha256 HEX --kernel PATH --kernel-sha256 sha256:HEX
#        sudo packaging/install.sh --driver dedicated --agent PATH
#
# The dedicated driver (ADR 0023 rule 8, self-hosted P5) needs no Firecracker or kernel; it also
# installs kete-job-host-enroll.service, the first-boot enrollment of a server the platform rebuilt
# (R1 provider_rebuild: its user data writes config.json and enroll.token; the module README
# "Dedicated hosts"). Build the provider's host image with this, never on a used server.
#
# Result:
#   /usr/local/bin/kete-job-host, /usr/local/bin/firecracker, /usr/local/bin/jailer   root 0755
#   /var/lib/kete-job-host/kernels/<kernel file name>                                   root 0444
#   /var/lib/kete-job-host (0700), /etc/kete-job-host (0755)
#   /etc/sysctl.d/90-kete-job-host.conf  net.ipv4.ip_forward = 1 (guests are routed, ADR 0023 rule 7)
#   /etc/systemd/system/kete-job-host.service (packaging/kete-job-host.service)
# Then: write /etc/kete-job-host/config.json (the module README), enroll, `kete-job-host doctor`,
# `systemctl enable --now kete-job-host`.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
agent="" fc="" jailer="" kernel="" fcsum="" jsum="" ksum="" drv="firecracker"
while [ $# -gt 0 ]; do
  case "$1" in
    --driver) drv="$2"; shift 2 ;;
    --agent) agent="$2"; shift 2 ;;
    --firecracker) fc="$2"; shift 2 ;;
    --jailer) jailer="$2"; shift 2 ;;
    --firecracker-sha256) fcsum="$2"; shift 2 ;;
    --jailer-sha256) jsum="$2"; shift 2 ;;
    --kernel) kernel="$2"; shift 2 ;;
    --kernel-sha256) ksum="$2"; shift 2 ;;
    *) echo "install.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
die() { echo "install.sh: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"
case "$drv" in
  firecracker) need="agent fc jailer kernel fcsum jsum ksum" ;;
  dedicated) need="agent" ;;
  *) die "--driver must be firecracker or dedicated" ;;
esac
for v in $need; do
  [ -n "${!v}" ] || die "missing an argument (see the usage at the top of this file)"
done
[ "$(uname -s)" = Linux ] || die "Linux only"
command -v systemctl >/dev/null || die "systemd is required"
for tool in nft ip mkfs.ext4 sha256sum install; do
  command -v "$tool" >/dev/null || die "$tool is required (packages: nftables iproute2 e2fsprogs coreutils)"
done
[ -f /sys/fs/cgroup/cgroup.controllers ] || die "cgroup v2 (unified hierarchy) is required"

if [ "$drv" = dedicated ]; then
  [ -c /dev/loop-control ] || die "/dev/loop-control is missing (the dedicated driver loop-mounts the job's root)"
  "$agent" version >/dev/null || die "$agent doesn't run on this host"
  install -o root -g root -m 0755 "$agent" /usr/local/bin/kete-job-host
  install -d -o root -g root -m 0700 /var/lib/kete-job-host
  install -d -o root -g root -m 0755 /etc/kete-job-host
  printf '# kete-job-host: the job is routed through the host (ADR 0023 rules 7-8).\nnet.ipv4.ip_forward = 1\n' \
    > /etc/sysctl.d/90-kete-job-host.conf
  chmod 0644 /etc/sysctl.d/90-kete-job-host.conf
  sysctl -q -p /etc/sysctl.d/90-kete-job-host.conf
  install -o root -g root -m 0644 "$HERE/kete-job-host.service" /etc/systemd/system/kete-job-host.service
  install -o root -g root -m 0644 "$HERE/kete-job-host-enroll.service" /etc/systemd/system/kete-job-host-enroll.service
  systemctl daemon-reload
  systemctl enable kete-job-host-enroll.service kete-job-host.service
  echo "Installed for the dedicated driver (enabled, not started). On each rebuild the platform's user data"
  echo "writes /etc/kete-job-host/config.json and /etc/kete-job-host/enroll.token (root 0600); the first boot"
  echo "then enrolls (kete-job-host-enroll.service) and starts the agent."
  exit 0
fi
[ -c /dev/kvm ] || echo "install.sh: warning: /dev/kvm is missing; the firecracker driver can't run here" >&2

check() { # file expected-hex
  local got
  got="$(sha256sum "$1" | cut -d' ' -f1)"
  [ "$got" = "${2#sha256:}" ] || die "$1: sha256 $got, expected ${2#sha256:}"
}
check "$fc" "$fcsum"
check "$jailer" "$jsum"
check "$kernel" "$ksum"
"$agent" version >/dev/null || die "$agent doesn't run on this host"

install -o root -g root -m 0755 "$agent" /usr/local/bin/kete-job-host
install -o root -g root -m 0755 "$fc" /usr/local/bin/firecracker
install -o root -g root -m 0755 "$jailer" /usr/local/bin/jailer
install -d -o root -g root -m 0700 /var/lib/kete-job-host
install -d -o root -g root -m 0700 /var/lib/kete-job-host/kernels
install -o root -g root -m 0444 "$kernel" "/var/lib/kete-job-host/kernels/$(basename "$kernel")"
install -d -o root -g root -m 0755 /etc/kete-job-host
printf '# kete-job-host: guests are routed through the host (ADR 0023 rule 7).\nnet.ipv4.ip_forward = 1\n' \
  > /etc/sysctl.d/90-kete-job-host.conf
chmod 0644 /etc/sysctl.d/90-kete-job-host.conf
sysctl -q -p /etc/sysctl.d/90-kete-job-host.conf
install -o root -g root -m 0644 "$HERE/kete-job-host.service" /etc/systemd/system/kete-job-host.service
systemctl daemon-reload

echo "Installed. Next:"
echo "  1. write /etc/kete-job-host/config.json (root, 0644): firecracker.kernel = /var/lib/kete-job-host/kernels/$(basename "$kernel"),"
echo "     kernel_allowlist = [\"$ksum\"], versions.firecracker = $("/usr/local/bin/firecracker" --version | head -n1 | sed 's/^Firecracker v//')"
echo "  2. printf '%s\\n' \"\$TOKEN\" | kete-job-host enroll"
echo "  3. kete-job-host doctor"
echo "  4. systemctl enable --now kete-job-host"
if iptables -S FORWARD 2>/dev/null | grep -q '^-P FORWARD DROP'; then
  echo "install.sh: note: iptables' FORWARD policy is DROP (Docker?). Guest traffic the agent's table allows" >&2
  echo "  is then dropped there; this host should not run Docker, or allow kjh+ in DOCKER-USER." >&2
fi
