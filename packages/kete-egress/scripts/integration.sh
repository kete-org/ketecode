#!/usr/bin/env bash
# Root-only Linux integration setup + run (module README "How to test"). Builds kete-egress and
# the integration test binary, creates the proxy/kete/tool users, then runs the tests inside a
# fresh network namespace: the nftables rules the tests apply (an output policy of drop) never
# touch Docker's or the CI runner's own network, and Docker's DNS NAT can't interfere. Inside the
# namespace a dummy interface carries the fake internet (documentation addresses) and bait
# addresses in blocked ranges (the metadata service, a private range, Fly's fdaa::/16).
#
# The proxy is started through `setpriv --no-new-privs`, as the entrypoint must (Go's exec can't set
# no_new_privs for a child).
#
# Usage: scripts/integration.sh [go test flags, e.g. -test.run TestFirewall]
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "scripts/integration.sh must run as root" >&2
  exit 1
fi

need=()
command -v nft >/dev/null || need+=(nftables)
command -v ip >/dev/null || need+=(iproute2)
command -v curl >/dev/null || need+=(curl)
{ command -v unshare >/dev/null && command -v setpriv >/dev/null; } || need+=(util-linux)
if [ "${#need[@]}" -gt 0 ]; then
  apt-get update -qq >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "${need[@]}" >/dev/null
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="/tmp/kete-egress-it"
rm -rf "$WORK"
mkdir -p "$WORK"
chmod 0755 "$WORK"

cd "$ROOT_DIR"
CGO_ENABLED=0 go build -trimpath -o "$WORK/kete-egress" ./cmd/kete-egress
go test -c -tags integration -o "$WORK/itest.test" ./internal/itest
chmod 0755 "$WORK/kete-egress" "$WORK/itest.test"

ensure_user() {
  local name="$1"
  id -u "$name" >/dev/null 2>&1 || useradd -M -r -s /usr/sbin/nologin "$name" >/dev/null
  echo "$(id -u "$name") $(id -g "$name")"
}
read -r PROXY_UID PROXY_GID <<< "$(ensure_user kete-it-proxy)"
read -r KETE_UID KETE_GID <<< "$(ensure_user kete-it-kete)"
read -r TOOL_UID TOOL_GID <<< "$(ensure_user kete-it-tool)"
read -r OTHER_UID OTHER_GID <<< "$(ensure_user kete-it-other)" # named nowhere in the config

export EGRESS_IT_PROXY_UID="$PROXY_UID" EGRESS_IT_PROXY_GID="$PROXY_GID"
export EGRESS_IT_KETE_UID="$KETE_UID" EGRESS_IT_KETE_GID="$KETE_GID"
export EGRESS_IT_TOOL_UID="$TOOL_UID" EGRESS_IT_TOOL_GID="$TOOL_GID"
export EGRESS_IT_OTHER_UID="$OTHER_UID" EGRESS_IT_OTHER_GID="$OTHER_GID"
export EGRESS_IT_BIN="$WORK/kete-egress" EGRESS_IT_WORK="$WORK"

exec unshare --net --fork -- bash -euo pipefail -c '
  for f in all default lo; do
    [ -e "/proc/sys/net/ipv6/conf/$f/disable_ipv6" ] && echo 0 > "/proc/sys/net/ipv6/conf/$f/disable_ipv6"
  done
  ip link set lo up
  if ip link add eg0 type dummy 2>/dev/null; then
    dev=eg0
    ip link set eg0 up
  else
    echo "integration.sh: no dummy interface support; using lo for the fake addresses" >&2
    dev=lo
  fi
  for a in 198.51.100.10/32 198.51.100.11/32 198.51.100.53/32 169.254.169.254/32 10.9.9.9/32; do
    ip addr add "$a" dev "$dev"
  done
  for a in 2001:db8::10/128 fdaa::3/128; do
    ip -6 addr add "$a" dev "$dev" nodad
  done
  exec "$EGRESS_IT_WORK/itest.test" -test.v -test.count=1 "$@"
' bash "$@"
