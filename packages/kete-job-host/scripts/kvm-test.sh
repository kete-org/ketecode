#!/usr/bin/env bash
# Kete-owned. Runs the firecracker driver's KVM acceptance tests and the dedicated driver's real
# job test (internal/kvmtest, build tag kvm) on a Linux host, as root (/dev/kvm and the guest
# kernel only for the firecracker tests: a TestDedicated* regexp runs without them). It changes the host while it runs and restores it:
# net.ipv4.ip_forward=1, the agent's nftables table, taps kjh*, a network namespace kjhtest with a
# veth pair ktv0/ktv1, cgroups under /sys/fs/cgroup/kete-job-host-vms (dedicated:
# kete-job-host-jobs, a veth kjh0, loop devices), and (when Docker's iptables
# chain DOCKER-USER exists) two ACCEPT rules for kjh+ so Docker's FORWARD policy doesn't drop guest
# traffic the agent's table already filtered.
#
# Usage: sudo scripts/kvm-test.sh <dir> [go test -run regexp]
#   <dir> holds: kvm.test and probe (go test -c -tags kvm ./internal/kvmtest; go build
#   ./internal/kvmtest/probe, CGO off, for the host's architecture), firecracker and jailer,
#   the guest kernel (kete-guest-kernel-*), kete-job.tar (docker save of the job image) and
#   kete-job-fake-platform (packages/kete-job-image/scripts/build.sh --no-image builds it).
#   Optional: kete-job-entrypoint (this checkout's, CGO off) replaces the image's in TestRealJob.
set -euo pipefail

dir="$(cd "${1:?usage: kvm-test.sh <dir> [regexp]}" && pwd)"
run="${2:-.}"
[ "$(id -u)" = 0 ] || { echo "kvm-test.sh: run as root" >&2; exit 2; }
kernel="$(ls "$dir"/kete-guest-kernel-* 2>/dev/null | grep -v '\.sha256$' | head -n1 || true)"
case "$run" in
  TestDedicated*) ;; # the dedicated driver needs neither KVM nor Firecracker nor a guest kernel
  *)
    [ -c /dev/kvm ] || { echo "kvm-test.sh: /dev/kvm is missing" >&2; exit 2; }
    [ -n "$kernel" ] || { echo "kvm-test.sh: no kete-guest-kernel-* in $dir" >&2; exit 2; }
    ;;
esac

fwd="$(cat /proc/sys/net/ipv4/ip_forward)"
docker_rules=0
cleanup() {
  echo "$fwd" > /proc/sys/net/ipv4/ip_forward
  if [ "$docker_rules" = 1 ]; then
    iptables -D DOCKER-USER -i kjh+ -j ACCEPT 2>/dev/null || true
    iptables -D DOCKER-USER -o kjh+ -j ACCEPT 2>/dev/null || true
  fi
  nft delete table inet kete-job-host 2>/dev/null || true
  ip netns del kjhtest 2>/dev/null || true
}
trap cleanup EXIT
echo 1 > /proc/sys/net/ipv4/ip_forward
if command -v iptables >/dev/null && iptables -S DOCKER-USER >/dev/null 2>&1; then
  iptables -I DOCKER-USER -i kjh+ -j ACCEPT
  iptables -I DOCKER-USER -o kjh+ -j ACCEPT
  docker_rules=1
fi

if [ -x "$dir/kete-job-entrypoint" ]; then export KVM_ENTRYPOINT="$dir/kete-job-entrypoint"; fi
export KVM_FIRECRACKER="$dir/firecracker" KVM_JAILER="$dir/jailer" KVM_KERNEL="$kernel" \
  KVM_IMAGE_TAR="$dir/kete-job.tar" KVM_FAKE_PLATFORM="$dir/kete-job-fake-platform" KVM_PROBE="$dir/probe"
cd "$dir"
./kvm.test -test.v -test.count=1 -test.timeout 60m -test.run "$run"
