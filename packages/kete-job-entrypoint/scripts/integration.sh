#!/usr/bin/env bash
# Root-only Linux integration setup + run (module README "How to test"). Installs the tools the
# suite needs, builds the entrypoint, the real kete-root-helper and kete-egress (sibling modules)
# and the fake `kete`, installs them at the image's paths, creates the job users the way the image
# does, then runs the tests inside a fresh network namespace: the nftables rules the entrypoint
# applies (an output policy of drop) never touch Docker's or the CI runner's own network. Inside
# the namespace a dummy interface carries the fake platform (198.51.100.10) and its DNS
# (198.51.100.53), documentation addresses the egress blocklist deliberately leaves out. A default
# route via 198.51.100.1 (on-link, nothing answers there) gives off-Fly profiles the default gateway
# their host-boundary probe requires; every probe sent there goes unanswered.
#
# The entrypoint sets user.max_user_namespaces=0, a host-wide sysctl in a container; the script
# restores the previous value on exit.
#
# Usage: scripts/integration.sh [go test flags, e.g. -test.run TestLifecycle]
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "scripts/integration.sh must run as root" >&2
  exit 1
fi
if [ "$(stat -fc %T /sys/fs/cgroup)" != "cgroup2fs" ]; then
  echo "cgroup v2 (unified hierarchy) is required at /sys/fs/cgroup" >&2
  exit 1
fi

need=()
command -v git >/dev/null || need+=(git)
command -v nft >/dev/null || need+=(nftables)
command -v ip >/dev/null || need+=(iproute2)
{ command -v unshare >/dev/null && command -v setpriv >/dev/null; } || need+=(util-linux)
command -v ps >/dev/null || need+=(procps)
command -v update-ca-certificates >/dev/null || need+=(ca-certificates)
if [ "${#need[@]}" -gt 0 ]; then
  apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${need[@]}" >/dev/null
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PKGS="$(cd "$ROOT_DIR/.." && pwd)"
WORK="/tmp/kete-entry-it-bin"
rm -rf "$WORK"
mkdir -p "$WORK" /usr/local/libexec/kete

(cd "$PKGS/kete-root-helper" && CGO_ENABLED=0 go build -trimpath -o /usr/local/libexec/kete/kete-root-helper ./cmd/kete-root-helper)
(cd "$PKGS/kete-egress" && CGO_ENABLED=0 go build -trimpath -o /usr/local/libexec/kete/kete-egress ./cmd/kete-egress)
cd "$ROOT_DIR"
CGO_ENABLED=0 go build -trimpath -o /usr/local/libexec/kete/kete-job-entrypoint ./cmd/kete-job-entrypoint
CGO_ENABLED=0 go build -trimpath -o /usr/local/bin/kete ./internal/itest/fakekete
go test -c -tags integration -o "$WORK/itest.test" ./internal/itest
chmod 0755 /usr/local/libexec/kete/* /usr/local/bin/kete "$WORK/itest.test"

# The job users, created as the image creates them.
getent group kete-job >/dev/null || groupadd --system kete-job
for u in kete-proxy kete kete-tool; do
  if ! id -u "$u" >/dev/null 2>&1; then
    extra=()
    [ "$u" != kete-proxy ] && extra=(-G kete-job)
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin "${extra[@]}" "$u"
  fi
done

# The proxy's resolver: the fake DNS (Docker's embedded DNS is loopback, which the proxy refuses).
echo "nameserver 198.51.100.53" > /etc/resolv.conf

userns="$(cat /proc/sys/user/max_user_namespaces)"
restore() { echo "$userns" > /proc/sys/user/max_user_namespaces || true; }
trap restore EXIT

unshare --net --fork -- bash -euo pipefail -c '
  ip link set lo up
  if ip link add eg0 type dummy 2>/dev/null; then
    dev=eg0
    ip link set eg0 up
  else
    echo "integration.sh: no dummy interface support; using lo for the fake addresses" >&2
    dev=lo
  fi
  for a in 198.51.100.10/32 198.51.100.53/32; do
    ip addr add "$a" dev "$dev"
  done
  ip route add default via 198.51.100.1 dev "$dev" onlink
  exec "$0" -test.v -test.count=1 "$@"
' "$WORK/itest.test" "$@"
