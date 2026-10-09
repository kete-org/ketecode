#!/usr/bin/env bash
# Kete-owned. Runs the job image end to end against the containerised fake platform
# (packages/kete-job-image/README.md "End-to-end test"). Per scenario:
#   1. the fake (cmd/kete-job-fake-platform) at 198.51.100.10 on a documentation-range Docker
#      network (Docker's bridge ranges are blocked by the egress proxy, its embedded DNS is loopback);
#   2. the job container: the image's entrypoint as the dedicated host profile runs it
#      (KETE_JOB_HOST_PROFILE=dedicated, the fake's config.json on a pipe: stdin, --config-fd 0),
#      started by a stand-in for kete-job-host's dedicated reaper (`e2e.test __dedicated-init`,
#      internal/e2e/reaper_test.go: PID 1, Docker's /etc mounts and /.dockerenv removed), since the
#      entrypoint's shared-kernel guard refuses a plain Docker container; privileged with a private
#      cgroup namespace, its resolv.conf naming the fake's DNS and its CA bundle plus the fake's test
#      CA (bind mounts the stand-in copies into the container's own files). The Docker host stands in for the host agent's
#      table (kete-code-platform ADR 0023 rule 7): host_table below drops every packet from the job to
#      the Docker host itself and to private and special ranges, and lets only TCP 443 and the fake
#      out, so the entrypoint's host-boundary probe passes for the right reason;
#   3. the stopped container's `docker export`, streamed into the asserter's token scan (never written
#      to disk), then the asserter (internal/e2e) over the fake's recorded state.
# The image's entrypoint sets user.max_user_namespaces=0, a host-wide value in Colima's VM or on the
# CI runner: it is saved first and restored on exit. The host table is removed on exit too.
#
# Usage: scripts/e2e.sh <image> [--scenario lifecycle|ac5|orchestrate|no-agent|all] (default all)
# Environment: E2E_STATE (state directory, default .build/e2e-state), E2E_JOB_TIMEOUT (seconds,
# default 900), E2E_KEEP_LOGS=1 (also copy the job's /var/log/kete-job into the state, for debugging).
# The test layer's binaries come from scripts/build.sh's staged context for the image's architecture.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image="${1:?usage: e2e.sh <image> [--scenario lifecycle|ac5|orchestrate|no-agent|all]}"
shift
scenario=all
while [ $# -gt 0 ]; do
  case "$1" in
    --scenario) scenario="$2"; shift 2 ;;
    *) echo "e2e.sh: unknown argument $1" >&2; exit 2 ;;
  esac
done
case "$scenario" in
  all) scenarios=(no-agent lifecycle ac5 orchestrate) ;;
  lifecycle|ac5|orchestrate|no-agent) scenarios=("$scenario") ;;
  *) echo "e2e.sh: unknown scenario $scenario" >&2; exit 2 ;;
esac

arch="$(docker image inspect "$image" --format '{{.Architecture}}')"
ctx="$HERE/.build/ctx-$arch"
[ -x "$ctx/bin/e2e.test" ] || { echo "e2e.sh: no staged test binaries in $ctx; run scripts/build.sh first" >&2; exit 1; }
test_image="kete-job-e2e:local"
net="kete-e2e"
fake="kete-e2e-fake"
job="kete-e2e-job"
state_root="${E2E_STATE:-$HERE/.build/e2e-state}"
job_timeout="${E2E_JOB_TIMEOUT:-900}"
mkdir -p "$state_root"
state_root="$(cd "$state_root" && pwd)"

echo "== test layer ($test_image from $image)"
docker build -q --build-arg BASE="$image" -f "$ctx/Dockerfile.e2e" -t "$test_image" "$ctx" >/dev/null

docker rm -f "$fake" "$job" >/dev/null 2>&1 || true
docker network rm "$net" >/dev/null 2>&1 || true
userns="$(docker run --rm --privileged --entrypoint cat "$test_image" /proc/sys/user/max_user_namespaces)"
job_ip=198.51.100.20
fake_ip=198.51.100.10
# The Docker host's stand-in for the host agent's table (nftables in the Docker VM or on the runner,
# applied from a host-network container; table inet kete_e2e_host, removed on exit).
host_nft() { docker run --rm -i --privileged --network host --entrypoint nft "$test_image" "$@"; }
host_table() {
  host_nft -f - <<EOF
table inet kete_e2e_host
delete table inet kete_e2e_host
table inet kete_e2e_host {
  chain input {
    type filter hook input priority -10; policy accept;
    ip saddr $job_ip drop
  }
  chain forward {
    type filter hook forward priority -10; policy accept;
    ip saddr $job_ip ip daddr $fake_ip accept
    ip saddr $job_ip ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 0.0.0.0/8, 192.0.0.0/24, 198.18.0.0/15, 198.51.100.0/24, 224.0.0.0/4, 240.0.0.0/4 } drop
    ip saddr $job_ip tcp dport 443 accept
    ip saddr $job_ip drop
  }
}
EOF
}
cleanup() {
  docker rm -f "$fake" "$job" >/dev/null 2>&1 || true
  docker network rm "$net" >/dev/null 2>&1 || true
  host_nft delete table inet kete_e2e_host >/dev/null 2>&1 || true
  docker run --rm --privileged --entrypoint sh "$test_image" -c "echo $userns > /proc/sys/user/max_user_namespaces" >/dev/null 2>&1 \
    || echo "e2e.sh: could not restore user.max_user_namespaces=$userns" >&2
}
trap cleanup EXIT
docker network create --subnet 198.51.100.0/24 "$net" >/dev/null
host_table

# Root-owned state files (the containers write them) are removed through a container.
reset_dir() {
  docker run --rm -v "$state_root:/s" --entrypoint rm "$test_image" -rf "/s/$1"
  mkdir -p "$state_root/$1"
}

failed=()
for sc in "${scenarios[@]}"; do
  echo "== scenario $sc"
  st="$state_root/$sc"
  reset_dir "$sc"
  docker run -d --name "$fake" --network "$net" --ip "$fake_ip" -v "$st:/state" \
    --entrypoint /usr/local/libexec/kete-e2e/kete-job-fake-platform "$test_image" -scenario "$sc" >/dev/null
  for _ in $(seq 1 120); do
    [ -f "$st/job.env" ] && break
    [ "$(docker inspect -f '{{.State.Running}}' "$fake")" = true ] || break
    sleep 0.5
  done
  if [ ! -f "$st/job.env" ]; then
    docker logs "$fake" >&2 || true
    echo "e2e.sh: the fake platform did not start" >&2
    exit 1
  fi
  printf 'nameserver 198.51.100.10\n' > "$st/resolv.conf"
  docker run --rm --entrypoint cat "$test_image" /etc/ssl/certs/ca-certificates.crt > "$st/ca-bundle.crt"
  cat "$st/ca.pem" >> "$st/ca-bundle.crt"

  start=$(date +%s)
  # Attached with stdin (docker run -i), so the config reaches the entrypoint on a pipe and stdin
  # closes at its end; the CLI runs in the background and the container is polled as before.
  docker run -i --name "$job" --privileged --cgroupns=private --network "$net" --ip "$job_ip" \
    -v "$st/resolv.conf:/etc/resolv.conf:ro" -v "$st/ca-bundle.crt:/etc/ssl/certs/ca-certificates.crt:ro" \
    --entrypoint /usr/local/libexec/kete-e2e/e2e.test \
    "$test_image" __dedicated-init < "$st/config.json" >/dev/null 2>&1 &
  runner=$!
  for _ in $(seq 1 120); do
    docker inspect "$job" >/dev/null 2>&1 && break
    sleep 0.5
  done
  while [ "$(docker inspect -f '{{.State.Running}}' "$job")" = true ]; do
    if [ $(( $(date +%s) - start )) -gt "$job_timeout" ]; then
      echo "e2e.sh: the job ran longer than ${job_timeout}s; stopping it" >&2
      docker kill "$job" >/dev/null || true
      break
    fi
    sleep 2
  done
  wait "$runner" 2>/dev/null || true
  docker logs "$job" > "$st/job.stdout" 2> "$st/job.stderr"
  docker inspect -f '{{.State.ExitCode}}' "$job" > "$st/job.exit"
  echo "job exited $(cat "$st/job.exit") after $(( $(date +%s) - start ))s"

  # The fake writes its state after the finish; without one, stop it (SIGTERM also writes it).
  for _ in $(seq 1 30); do
    [ -f "$st/done" ] && break
    sleep 1
  done
  [ -f "$st/done" ] || docker stop -t 20 "$fake" >/dev/null || true
  docker logs "$fake" > "$st/fake.log" 2>&1 || true
  docker rm -f "$fake" >/dev/null 2>&1 || true
  if [ ! -f "$st/done" ]; then
    echo "e2e.sh: the fake platform wrote no state" >&2
    failed+=("$sc")
    docker rm -f "$job" >/dev/null 2>&1 || true
    continue
  fi

  ok=1
  echo "-- token scan of the exported job container"
  docker export "$job" | docker run --rm -i -v "$st:/state" --entrypoint /usr/local/libexec/kete-e2e/e2e.test "$test_image" \
    -test.run '^TestExportScan$' -test.v -test.count=1 -state /state -export - || ok=0
  if [ -n "${E2E_KEEP_LOGS:-}" ]; then
    # Debugging: copy the job's root-only logs (proxy, helper, kete stdout/stderr) out of the stopped container.
    docker cp "$job:/var/log/kete-job" "$st/logs" >/dev/null 2>&1 || true
  fi
  docker rm -f "$job" >/dev/null 2>&1 || true
  case "$sc" in
    lifecycle) name=TestLifecycle ;;
    ac5) name=TestAC5 ;;
    no-agent) name=TestNoAgent ;;
    orchestrate) name=TestOrchestrate ;;
  esac
  echo "-- $name"
  docker run --rm -v "$st:/state" --entrypoint /usr/local/libexec/kete-e2e/e2e.test "$test_image" \
    -test.run "^$name\$" -test.v -test.count=1 -state /state || ok=0
  [ "$ok" = 1 ] || failed+=("$sc")
done

if [ "${#failed[@]}" -gt 0 ]; then
  echo "e2e.sh: FAILED: ${failed[*]} (state in $state_root)" >&2
  exit 1
fi
echo "e2e.sh: all scenarios passed (${scenarios[*]})"
