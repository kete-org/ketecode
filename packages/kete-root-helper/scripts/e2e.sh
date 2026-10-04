#!/usr/bin/env bash
# AC5 orchestration (module README, "How to test"): builds the helper, creates a tool user and
# cgroup via sudo, starts the real helper as root, then runs the server's real end-to-end test
# (packages/server/test/kete/job-helper-e2e.test.ts) as the *invoking* (unprivileged) user — the
# same split CI's `ubuntu-latest` runner has: the runner user is `kete`, the tool user is someone
# else entirely. Run from the repo root, e.g. `bash packages/kete-root-helper/scripts/e2e.sh`.
set -euo pipefail

if [ "$(id -u)" -eq 0 ]; then
  echo "scripts/e2e.sh must run as the unprivileged (kete-side) user, using sudo only for the helper itself" >&2
  exit 1
fi
if ! command -v sudo >/dev/null; then
  echo "sudo is required" >&2
  exit 1
fi
if ! command -v bun >/dev/null; then
  echo "bun is required (run ./.github/actions/setup-bun first in CI)" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$ROOT_DIR/../.." && pwd)"
WORK="/tmp/kete-e2e"
SOCK_DIR="/run/kete-e2e"
SOCKET="$SOCK_DIR/tool.sock"
CGROUP_ROOT="/sys/fs/cgroup/kete-e2e"
TOOL_CGROUP="$CGROUP_ROOT/tool"
KETE_UID="$(id -u)"

# $! after `sudo helper &` is sudo's own pid, not the helper's — killing it relies on sudo
# forwarding the signal, which isn't guaranteed across sudo versions/configs. Instead, the root
# shell that execs into the helper writes its own pid (stable across exec(2), and across the
# helper's own internal no_new_privs self-re-exec, which is also exec(2)) to a pidfile before
# exec'ing, so cleanup can kill the actual helper process deterministically.
# In the root-owned socket dir, so only sudo creates and removes it (a root-owned file in the
# sticky /tmp can't be removed by the unprivileged runner user).
PIDFILE="$SOCK_DIR/helper.pid"
sudo rm -f "$PIDFILE"
SUDO_JOB_PID=""
cleanup() {
  local helper_pid=""
  if sudo test -f "$PIDFILE" 2>/dev/null; then
    helper_pid="$(sudo cat "$PIDFILE" 2>/dev/null || true)"
  fi
  if [ -n "$helper_pid" ]; then
    sudo kill "$helper_pid" 2>/dev/null || true
    deadline=$((SECONDS + 5))
    while sudo kill -0 "$helper_pid" 2>/dev/null; do
      if [ $SECONDS -ge $deadline ]; then
        sudo kill -9 "$helper_pid" 2>/dev/null || true
        break
      fi
      sleep 0.2
    done
  fi
  if [ -n "$SUDO_JOB_PID" ]; then
    wait "$SUDO_JOB_PID" 2>/dev/null || true
  fi
  sudo rm -f "$PIDFILE" 2>/dev/null || true
  sudo rmdir "$TOOL_CGROUP"/p* 2>/dev/null || true
  sudo rmdir "$TOOL_CGROUP" "$CGROUP_ROOT" 2>/dev/null || true
  sudo rm -rf "$SOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

echo "building the helper..."
cd "$ROOT_DIR"
BUILD_DIR="$(mktemp -d)"
go build -trimpath -o "$BUILD_DIR/kete-root-helper" ./cmd/kete-root-helper
sudo mkdir -p "$WORK"
sudo cp "$BUILD_DIR/kete-root-helper" "$WORK/kete-root-helper"
sudo chmod 0755 "$WORK/kete-root-helper"
rm -rf "$BUILD_DIR"

echo "creating the tool user, cgroup, worktree root and socket dir..."
if ! id kete-e2e-tool >/dev/null 2>&1; then
  sudo useradd -M -r -s /usr/sbin/nologin kete-e2e-tool
fi
TOOL_UID="$(id -u kete-e2e-tool)"
TOOL_GID="$(id -g kete-e2e-tool)"

sudo mkdir -p "$TOOL_CGROUP"
sudo sh -c "echo '+pids +memory' > /sys/fs/cgroup/cgroup.subtree_control" 2>/dev/null || true
sudo sh -c "echo '+pids +memory' > '$CGROUP_ROOT/cgroup.subtree_control'"
sudo sh -c "echo 512 > '$TOOL_CGROUP/pids.max'"
sudo sh -c "echo 1G > '$TOOL_CGROUP/memory.max'"

sudo mkdir -p "$WORK" "$SOCK_DIR"
sudo chmod 1777 "$WORK"
sudo chmod 0755 "$SOCK_DIR"

echo "starting the helper..."
# `sh -c 'echo $$ > pidfile; exec …'`: the shell writes its own pid (as root, via sudo) before
# exec(2) replaces its image with the helper — exec never changes the pid, so PIDFILE ends up
# holding the helper's real, running pid, not sudo's.
sudo sh -c "echo \$\$ > '$PIDFILE'; exec '$WORK/kete-root-helper' \
  --socket '$SOCKET' \
  --kete-uid '$KETE_UID' \
  --tool-uid '$TOOL_UID' \
  --tool-gid '$TOOL_GID' \
  --worktree-root '$WORK' \
  --tool-cgroup '$TOOL_CGROUP' \
  --env-allow PATH,LANG,TERM \
  --env-set HOME='$WORK' \
  --env-set PATH=/usr/bin:/bin" \
  >/tmp/kete-e2e-helper.log 2>&1 &
SUDO_JOB_PID=$!

deadline=$((SECONDS + 10))
while ! sudo test -f "$PIDFILE" || ! sudo test -S "$SOCKET"; do
  if [ $SECONDS -ge $deadline ]; then
    echo "timed out waiting for the helper socket; helper log:" >&2
    cat /tmp/kete-e2e-helper.log >&2
    exit 1
  fi
  sleep 0.2
done

echo "running the server's AC5 test..."
cd "$REPO_ROOT/packages/server"
export HELPER_E2E_SOCKET="$SOCKET"
export HELPER_E2E_ROOT="$WORK"
export HELPER_E2E_TOOL_UID="$TOOL_UID"
export HELPER_E2E_TOOL_GID="$TOOL_GID"
# `|| status=$?`: under `set -e` a failing test would otherwise end the script here, before its
# output is printed.
status=0
output="$(bun run test ./test/kete/job-helper-e2e.test.ts 2>&1)" || status=$?
echo "$output"
if [ "$status" -ne 0 ]; then
  echo "AC5 test run exited with status $status; helper log:" >&2
  sudo cat /tmp/kete-e2e-helper.log >&2 || true
  exit 1
fi
# bun only prints a "N skip" line when N > 0 — the test's own gate (HELPER_E2E_SOCKET etc.) must
# have been satisfied, or this whole script's setup above was pointless.
if echo "$output" | grep -qE '[0-9]+ skip'; then
  echo "AC5 test was skipped (HELPER_E2E_* env not picked up) — treating as a failure" >&2
  exit 1
fi
echo "$output" | grep -qE '^ 0 fail$' || { echo "AC5 test failed" >&2; exit 1; }
