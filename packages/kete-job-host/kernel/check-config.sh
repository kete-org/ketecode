#!/usr/bin/env bash
# Kete-owned. Checks resolved guest kernel configurations against their fragments: every
# "CONFIG_X=y" line is set to y, every "# CONFIG_X is not set" line is unset, and nothing is built
# as a module (CONFIG_MODULES off, no "=m"). Runs in CI (no kernel build needed) and inside
# build.sh after `make olddefconfig`.
#
#   microvm  kernel/config-<arch>          against kete.fragment
#   cloudvm  kernel/config-cloudvm-<arch>  against kete.fragment, cloudvm.fragment and
#                                          cloudvm-<arch>.fragment
#
# Usage: kernel/check-config.sh [--variant microvm|cloudvm --arch amd64|arm64] [config ...]
#   Without configs: all four checked-in files. Variant and arch come from a config's file name
#   (config-<arch>, config-cloudvm-<arch>) unless given (build.sh checks its .config that way).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
variant="" arch=""
while [ $# -gt 0 ]; do
  case "$1" in
    --variant) variant="$2"; shift 2 ;;
    --arch) arch="$2"; shift 2 ;;
    --) shift; break ;;
    -*) echo "check-config: unknown argument $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
case "$variant" in ""|microvm|cloudvm) ;; *) echo "check-config: unknown variant $variant" >&2; exit 2 ;; esac
case "$arch" in ""|amd64|arm64) ;; *) echo "check-config: unknown arch $arch" >&2; exit 2 ;; esac
[ $# -gt 0 ] || set -- "$HERE/config-amd64" "$HERE/config-arm64" "$HERE/config-cloudvm-amd64" "$HERE/config-cloudvm-arm64"

# check_fragment <config> <fragment>: prints each mismatch, returns 1 if any.
check_fragment() {
  local cfg="$1" fragment="$2" bad=0 line key want got
  [ -f "$fragment" ] || { echo "check-config: $fragment: missing" >&2; return 1; }
  while IFS= read -r line; do
    case "$line" in
      CONFIG_*=*)
        key="${line%%=*}" want="${line#*=}"
        got="$(grep -E "^${key}=" "$cfg" | tail -n1 | cut -d= -f2- || true)"
        if [ "$got" != "$want" ]; then
          echo "check-config: $cfg: $key is '${got:-unset}', want '$want' ($(basename "$fragment"))" >&2
          bad=1
        fi
        ;;
      "# CONFIG_"*" is not set")
        key="${line#\# }" key="${key%% *}"
        if grep -qE "^${key}=" "$cfg"; then
          echo "check-config: $cfg: $key must not be set ($(grep -E "^${key}=" "$cfg"); $(basename "$fragment"))" >&2
          bad=1
        fi
        ;;
    esac
  done < "$fragment"
  return "$bad"
}

fail=0
for cfg in "$@"; do
  [ -f "$cfg" ] || { echo "check-config: $cfg: missing" >&2; fail=1; continue; }
  v="$variant" a="$arch"
  case "$(basename "$cfg")" in
    config-cloudvm-amd64) v="${v:-cloudvm}" a="${a:-amd64}" ;;
    config-cloudvm-arm64) v="${v:-cloudvm}" a="${a:-arm64}" ;;
    config-amd64) v="${v:-microvm}" a="${a:-amd64}" ;;
    config-arm64) v="${v:-microvm}" a="${a:-arm64}" ;;
  esac
  [ -n "$v" ] || { echo "check-config: $cfg: give --variant (file name doesn't say)" >&2; fail=1; continue; }
  fragments=("$HERE/kete.fragment")
  if [ "$v" = cloudvm ]; then
    [ -n "$a" ] || { echo "check-config: $cfg: give --arch for a cloudvm config" >&2; fail=1; continue; }
    fragments+=("$HERE/cloudvm.fragment" "$HERE/cloudvm-$a.fragment")
  fi
  bad=0
  for f in "${fragments[@]}"; do
    check_fragment "$cfg" "$f" || bad=1
  done
  if grep -qE '^CONFIG_[A-Za-z0-9_]+=m$' "$cfg"; then
    echo "check-config: $cfg: modules configured:" >&2
    grep -E '^CONFIG_[A-Za-z0-9_]+=m$' "$cfg" | head -n 20 >&2
    bad=1
  fi
  if [ "$bad" = 0 ]; then
    echo "check-config: $cfg ($v) ok"
  else
    fail=1
  fi
done
exit "$fail"
