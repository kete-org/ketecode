#!/usr/bin/env bash
# Root-only Linux integration setup + run (module README "How to test"). Builds the helper and the
# integration test binary, creates a cgroup v2 layout, a tool/kete/third user, and a worktree
# root, then runs the tests. Used both by the local Docker/Colima command below and by CI.
#
# Usage: scripts/integration.sh [go test flags, e.g. -test.run TestSpawnIdentity]
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "scripts/integration.sh must run as root" >&2
  exit 1
fi

if [ "$(stat -fc %T /sys/fs/cgroup)" != "cgroup2fs" ]; then
  echo "cgroup v2 (unified hierarchy) is required at /sys/fs/cgroup" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="/tmp/kete-it"
CGROUP_ROOT="/sys/fs/cgroup/kete-it"
TOOL_CGROUP="$CGROUP_ROOT/tool"

cleanup() {
  rmdir "$TOOL_CGROUP"/p* 2>/dev/null || true
  rmdir "$TOOL_CGROUP/unbounded-test" 2>/dev/null || true
  rmdir "$TOOL_CGROUP" 2>/dev/null || true
  rmdir "$CGROUP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

# A private cgroup namespace (e.g. `docker run --cgroupns=private`) starts with processes already
# in the root cgroup (`[ -s cgroup.procs ]` can't detect this: cgroupfs pseudo-files report
# st_size 0 regardless of content), which blocks enabling controllers there ("no internal process"
# constraint) — move them aside first.
existing_root_procs="$(cat /sys/fs/cgroup/cgroup.procs 2>/dev/null || true)"
if [ -n "$existing_root_procs" ]; then
  mkdir -p /sys/fs/cgroup/init
  for pid in $existing_root_procs; do
    echo "$pid" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true
  done
fi

mkdir -p "$TOOL_CGROUP"
echo "+pids +memory" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true
echo "+pids +memory" > "$CGROUP_ROOT/cgroup.subtree_control"
echo 512 > "$TOOL_CGROUP/pids.max"
echo 1G > "$TOOL_CGROUP/memory.max"

# Users: numeric ids from env if given (CI sets KETE_IT_KETE_UID to the runner's own uid, since
# the kete-side client re-exec needs an id that's real on the box), else create fresh ones.
ensure_user() {
  local var_uid="$1" var_gid="$2" name="$3"
  local uid="${!var_uid:-}"
  if [ -z "$uid" ]; then
    useradd -M -r -s /usr/sbin/nologin "$name" >/dev/null
    uid="$(id -u "$name")"
  fi
  local gid
  gid="$(id -g "$uid" 2>/dev/null || echo "$uid")"
  echo "$uid $gid"
}

read -r KETE_UID KETE_GID <<< "$(ensure_user KETE_IT_KETE_UID KETE_IT_KETE_GID kete-it-kete)"
read -r TOOL_UID TOOL_GID <<< "$(ensure_user KETE_IT_TOOL_UID KETE_IT_TOOL_GID kete-it-tool)"
read -r THIRD_UID THIRD_GID <<< "$(ensure_user KETE_IT_THIRD_UID KETE_IT_THIRD_GID kete-it-third)"

mkdir -p "$WORK/wt" "$WORK/sock"
chown root:root "$WORK/wt"
chmod 2775 "$WORK/wt"
chgrp "$TOOL_GID" "$WORK/wt" 2>/dev/null || true
chmod 0755 "$WORK/sock"

cd "$ROOT_DIR"
go build -trimpath -o "$WORK/kete-root-helper" ./cmd/kete-root-helper
go test -c -tags integration -o "$WORK/it.test" ./internal/itest
chmod 0755 "$WORK/kete-root-helper" "$WORK/it.test"

export KETE_IT_KETE_UID="$KETE_UID"
export KETE_IT_KETE_GID="$KETE_GID"
export KETE_IT_TOOL_UID="$TOOL_UID"
export KETE_IT_TOOL_GID="$TOOL_GID"
export KETE_IT_THIRD_UID="$THIRD_UID"
export KETE_IT_THIRD_GID="$THIRD_GID"
export KETE_IT_WORKTREE_ROOT="$WORK/wt"
export KETE_IT_TOOL_CGROUP="$TOOL_CGROUP"
export KETE_IT_HELPER_BIN="$WORK/kete-root-helper"
export KETE_IT_SOCKET_DIR="$WORK/sock"

"$WORK/it.test" -test.v -test.count=1 "$@"
