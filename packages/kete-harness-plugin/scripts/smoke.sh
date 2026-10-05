#!/usr/bin/env bash
# Kete-owned. Tests a built Harness step image (packages/kete-harness-plugin/README.md).
#   always: linux/<arch>, runs as uid 1000, refuses an empty configuration (exit 2, "refused:")
#   --full: also, with the host's network (Linux), the image's real entrypoint and kete:
#     cloud mode against the fake platform (test/fixtures/fake-platform.ts): exit 0, outputs;
#     run mode against the fake model endpoint (test/fixtures/fake-model.ts) in a throwaway git
#     workspace with a bare remote: exit 0, the audit artifact, the change pushed to a NEW branch,
#     main untouched. Offline: nothing leaves 127.0.0.1.
# The fakes run with bun on the host and are stopped on exit.
#
# Usage: scripts/smoke.sh <image> [--arch amd64|arm64] [--full]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${1:?usage: smoke.sh <image> [--arch amd64|arm64] [--full]}"
shift
arch=""
full=0
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) arch="$2"; shift 2 ;;
    --full) full=1; shift ;;
    *) echo "smoke.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
[ -n "$arch" ] || arch="$(docker image inspect "$image" --format '{{.Architecture}}')"

fail() { echo "::error::$*" >&2; exit 1; }
pids=()
tmp="$(mktemp -d)"
cleanup() {
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
  rm -rf "$tmp" 2>/dev/null || true
}
trap cleanup EXIT

echo "== image metadata"
[ "$(docker image inspect "$image" --format '{{.Os}}/{{.Architecture}}')" = "linux/$arch" ] || fail "not linux/$arch"
[ "$(docker image inspect "$image" --format '{{.Config.User}}')" = "1000:1000" ] || fail "the image doesn't run as uid 1000"

echo "== empty configuration is refused (exit 2)"
set +e
out="$(docker run --rm --platform "linux/$arch" "$image" 2>&1)"
code=$?
set -e
echo "$out"
[ "$code" = 2 ] || fail "empty configuration exited $code, expected 2"
grep -q "refused: Set PLUGIN_TASK" <<<"$out" || fail "no refusal message"

[ "$full" = 1 ] || exit 0

echo "== kete in the image"
docker run --rm --platform "linux/$arch" --entrypoint /usr/local/bin/kete "$image" --version

serve() {
  local file="$tmp/$1.url"
  bun "$HERE/test/fixtures/serve.ts" "$1" > "$file" &
  pids+=("$!")
  for _ in $(seq 50); do [ -s "$file" ] && break; sleep 0.2; done
  [ -s "$file" ] || fail "the fake $1 didn't start"
  head -n1 "$file"
}

uid="$(id -u):$(id -g)"
outputs() { cat "$1"; }

echo "== cloud mode against the fake platform"
platform="$(serve platform)"
mkdir -p "$tmp/cloud"
docker run --rm --platform "linux/$arch" --network host --user "$uid" \
  -v "$tmp/cloud:/harness" -e DRONE_WORKSPACE=/harness -e DRONE_OUTPUT=/harness/out.env \
  -e PLUGIN_MODE=cloud -e PLUGIN_BASE_URL="$platform" -e PLUGIN_KETE_API_KEY=kete_test_key_0123456789abcdef \
  -e PLUGIN_PROJECT=11111111-1111-4111-8111-111111111111 -e PLUGIN_REPO=22222222-2222-4222-8222-222222222222 \
  -e PLUGIN_AGENT=build -e PLUGIN_TASK="Fix the flaky test" -e PLUGIN_BUDGET=1 -e PLUGIN_TIMEOUT=5 -e PLUGIN_PUSH_BRANCH=true \
  "$image" || fail "cloud mode failed"
outputs "$tmp/cloud/out.env"
grep -qx "KETE_OUTCOME=completed" "$tmp/cloud/out.env" || fail "cloud outcome"
grep -qx "KETE_BRANCH=kete/job/harness1" "$tmp/cloud/out.env" || fail "cloud branch"
grep -q "^KETE_JOB_URL=$platform/jobs/" "$tmp/cloud/out.env" || fail "cloud job URL"

echo "== run mode against the fake model"
model="$(serve model)"
w="$tmp/run"
mkdir -p "$w/home"
git init -q --bare -b main "$w/remote.git"
git init -q -b main "$w/seed"
echo "# shop" > "$w/seed/README.md"
echo "kete-output/" > "$w/seed/.gitignore"
git -C "$w/seed" add .
git -C "$w/seed" -c user.name=t -c user.email=t@example.com commit -q -m init
git -C "$w/seed" push -q "$w/remote.git" main
git clone -q "$w/remote.git" "$w/harness"
printf "error TS2304: Cannot find name 'FIXED'.\n" > "$w/harness/build.log"
# The same path inside the container, so the clone's origin (a local path) resolves.
docker run --rm --platform "linux/$arch" --network host --user "$uid" -v "$w:$w" \
  -e HOME="$w/home" -e DRONE_WORKSPACE="$w/harness" -e DRONE_OUTPUT="$w/out.env" -e DRONE_TARGET_BRANCH=main \
  -e KETE_DISABLE_MODELS_FETCH=1 \
  -e PLUGIN_PRESET=fix-build -e PLUGIN_LOG=build.log -e PLUGIN_BUDGET=1 -e PLUGIN_TIMEOUT=5 \
  -e PLUGIN_MODEL_URL="$model" -e PLUGIN_MODEL=fake-model -e PLUGIN_MODEL_API_KEY=plainendpointvalue0123 \
  -e PLUGIN_PUSH_BRANCH=kete/smoke-fix \
  "$image" || fail "run mode failed"
outputs "$w/out.env"
grep -qx "KETE_OUTCOME=completed" "$w/out.env" || fail "run outcome"
grep -qx "KETE_BRANCH=kete/smoke-fix" "$w/out.env" || fail "run branch"
grep -q '"event":"started"' "$w/harness/kete-output/audit.jsonl" || fail "no audit artifact"
[ "$(git -C "$w/remote.git" show kete/smoke-fix:FIXED.md)" = fixed ] || fail "the change isn't on the new branch"
[ "$(git -C "$w/remote.git" rev-list --count main)" = 1 ] || fail "main changed"
if grep -rqE "sk-fakeharnesssecret|plainendpointvalue0123" "$w/out.env" "$w/harness/kete-output"; then fail "a secret reached the outputs"; fi
echo "smoke: ok"
