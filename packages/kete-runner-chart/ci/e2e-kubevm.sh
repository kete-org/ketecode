#!/usr/bin/env bash
# Kind e2e for the kubevm pod driver (enterprise runtime P2). Runs in .github/workflows/kete-runner.yml
# after ci/e2e.sh, on the same two-node cluster, with a second runner release in its own namespaces.
#
#   RUNNER_IMAGE   the runner test image (-tags kete_testdriver; also holds kete-fake-platform), by digest
#   JOB_IMAGE      the kete-job image whose entrypoint is built with -tags kete_testdriver, by digest
#   MISSING_IMAGE  an allowlisted job image digest the registry doesn't have (image_pull_failed)
#   FAKE_IMAGE     a local Docker image: the job image plus kete-job-fake-platform (the jobs-v1 fake)
#
# The world, outside the cluster like an enterprise's own services, on a Docker network
# (172.30.0.0/24) the kind nodes join:
#   FAKE_IP  the jobs-v1 fake (cmd/kete-job-fake-platform): platform.kete.test (claim, events,
#            result, finish, sync), gateway.kete.test (the scripted model), github.kete.test (git),
#            *.kete.test DNS; it forwards /api/v1/job-hosts/ to the job-host fake, so one platform
#            origin serves the runner and its jobs, as the real platform does.
#   JH_IP    the job-host fake (kete-fake-platform: job-host-v2, admin API) and the enterprise's
#            CONNECT proxy, which the controller and every job's kete-egress (upstream) go through.
# The job pods run under the CI-only `kete-test` RuntimeClass (runc) on the worker, whose own
# addresses the e2e fences off from its pods (a production CNI's job), so the entrypoint's
# host-boundary probe passes for the right reason; the NetworkPolicy fences the rest.
#
# Proves: a real job pod lifecycle with the test-only shared-kernel build — boot-ID check, Secret
# unmount, remounts, host boundary, egress v2 through the upstream proxy with the custom CA and
# internal ranges, isolation, the runtime claim, the clone from the runner's source with its read
# credential, the scripted model through `kete job run`, the bounded result, the bundle, audit and
# proxy log in the outbox (kept after the pod), finish {"outbox":true}, never uploads; phase lines in
# the controller's reports; the machine Secret gone once running. Refusals: a claim naming another
# repository (nothing cloned, no result, no finish); a wrong node boot ID and the release rule on a
# shared kernel (shared_kernel, before anything else); a non-allowlisted RuntimeClass (admission);
# a configured RuntimeClass that doesn't exist (runtime_class_missing); an image that can't be
# pulled (image_pull_failed). No credential in the controller's logs.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
chart=$(cd "$here/.." && pwd)
: "${RUNNER_IMAGE:?}" "${JOB_IMAGE:?}" "${MISSING_IMAGE:?}" "${FAKE_IMAGE:?}"
SYS=kete-system2 JOBS=kete-jobs2 REL=kete-runner2
SA=system:serviceaccount:$SYS:kete-runner
ADMIN=http://127.0.0.1:18081
REPO=gitlab:payments/api
STATE=${E2E_STATE:-/tmp/kete-kubevm-state}
WORKER=kind-worker
start=$(date +%s)

log() { echo "[kubevm $(($(date +%s) - start))s] $*"; }
fail() {
  echo "FAIL: $*" >&2
  echo "--- controller logs" >&2; kubectl -n $SYS logs deploy/kete-runner --tail=200 >&2 || true
  echo "--- hosts" >&2; curl -s $ADMIN/hosts | jq '.[0] | {Status, StartsBlocked: .LastReport.starts_blocked, Machines}' >&2 || true
  echo "--- pods" >&2; kubectl get pods -A -o wide >&2 || true
  for p in $(kubectl -n $JOBS get pods -o name 2>/dev/null); do echo "--- $p" >&2; kubectl -n $JOBS logs "$p" --tail=80 >&2 || true; done
  echo "--- events ($JOBS)" >&2; kubectl -n $JOBS get events --sort-by=.lastTimestamp >&2 || true
  echo "--- docker logs kete-jh-fake (not polls)" >&2; docker logs kete-jh-fake 2>&1 | grep -v 'job-hosts/poll' | tail -40 >&2 || true
  if docker stop -t 20 kete-fake >/dev/null 2>&1; then # writes its records
    for d in "$STATE"/*/; do
      [ -f "$d/calls.json" ] || continue
      echo "--- fake $(basename "$d"): calls" >&2; jq -c '[.[] | {kind, status}]' "$d/calls.json" >&2 || true
      echo "--- fake $(basename "$d"): contract errors" >&2; cat "$d/contract.json" >&2 || true
    done
  fi
  exit 1
}
wait_for() {
  local t=$1 what=$2; shift 2
  for _ in $(seq "$t"); do
    if "$@" >/dev/null 2>&1; then log "ok: $what"; return 0; fi
    sleep 1
  done
  fail "timed out: $what"
}
denied() {
  local what=$1; shift
  if out=$("$@" 2>&1); then fail "admission allowed: $what"; fi
  grep -q "ValidatingAdmissionPolicy" <<<"$out" || fail "refused for another reason ($what): $out"
  log "ok: admission refused $what"
}
mstate() { curl -sf $ADMIN/hosts | jq -r --arg m "$1" '.[0].Machines[$m] | "\(.State)/\(.Reason)"'; }
is_state() { [ "$(mstate "$1")" = "$2" ]; }
phase_lines() { curl -sf $ADMIN/hosts | jq -c --arg m "$1" '.[0].Machines[$m].PhaseLines // []'; }

# --- the world: its own Docker network (fixed addresses need a user-configured subnet; kind's has
# none), a private range like an enterprise's, which the kind nodes join as a second interface.
NET=kete-e2e-world SUBNET=172.30.0.0/24
FAKE_IP=172.30.0.200 JH_IP=172.30.0.201
docker rm -f kete-jh-fake kete-fake >/dev/null 2>&1 || true
docker network rm $NET >/dev/null 2>&1 || true
docker network create --subnet $SUBNET $NET >/dev/null
for node in kind-control-plane $WORKER; do docker network connect $NET "$node"; done
hosts=(--add-host "platform.kete.test:$FAKE_IP" --add-host "gateway.kete.test:$FAKE_IP" --add-host "github.kete.test:$FAKE_IP" --add-host "storage.kete.test:$FAKE_IP")
rm -rf "$STATE" && mkdir -p "$STATE"
docker run -d --name kete-jh-fake --network $NET --ip "$JH_IP" "${hosts[@]}" -p 127.0.0.1:18081:8080 \
  --entrypoint /usr/local/bin/kete-fake-platform "$RUNNER_IMAGE" -authority platform.kete.test >/dev/null
wait_for 30 "job-host fake" curl -sf $ADMIN/hosts
curl -sf $ADMIN/ca.pem >"$STATE/jh-ca.pem"

# start_fake <name> <args…>: one jobs-v1 job; waits for its runtime-job.json.
start_fake() {
  local name=$1; shift
  docker rm -f kete-fake >/dev/null 2>&1 || true
  mkdir -p "$STATE/$name"
  docker run -d --name kete-fake --network $NET --ip "$FAKE_IP" -v "$STATE/$name:/state" -v "$STATE/jh-ca.pem:/jh-ca.pem:ro" -v "$STATE/ca:/ca" \
    --entrypoint /usr/local/libexec/kete-e2e/kete-job-fake-platform "$FAKE_IMAGE" \
    -addr "$FAKE_IP" -state /state -scenario lifecycle -deadline 25m -policy-timeout 10 -runtime-repo "$REPO" \
    -job-hosts "https://$JH_IP:8443" -job-hosts-ca /jh-ca.pem -ca-dir /ca "$@" >/dev/null
  wait_for 60 "fake $name ready" test -s "$STATE/$name/runtime-job.json"
}
stop_fake() { docker stop -t 20 kete-fake >/dev/null; docker rm kete-fake >/dev/null; }
start_fake lifecycle -linger
cp "$STATE/ca/ca.crt" "$STATE/fake-ca.pem" # the same CA for every fake run (-ca-dir)

# --- cluster: kete.test resolves to the fake (an enterprise's DNS), the worker's own addresses are
# fenced off from its pods (a production CNI's node isolation; kind's isn't).
kubectl -n kube-system get configmap coredns -o json | jq --arg ip "$FAKE_IP" \
  '.data.Corefile += "kete.test:53 {\n    errors\n    cache 5\n    forward . \($ip)\n}\n"' | kubectl apply -f - >/dev/null
kubectl -n kube-system rollout restart deploy/coredns >/dev/null
kubectl -n kube-system rollout status deploy/coredns --timeout=120s >/dev/null
worker_cidr=$(kubectl get node $WORKER -o jsonpath='{.spec.podCIDR}')
# Inserted at the top of INPUT in reverse: answers to the node's own connections pass, anything else
# from a pod to an address of the node itself is refused at once.
docker exec $WORKER iptables -I INPUT 1 -s "$worker_cidr" -j REJECT
docker exec $WORKER iptables -I INPUT 1 -s "$worker_cidr" -p tcp -j REJECT --reject-with tcp-reset
docker exec $WORKER iptables -I INPUT 1 -s "$worker_cidr" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
log "ok: worker $WORKER fenced from its pods ($worker_cidr)"

# --- the second runner: kubevm pod driver, the job image, the proxy and CA, the repository source
kubectl create namespace $SYS >/dev/null
kubectl label namespace $SYS pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/enforce-version=latest >/dev/null
kubectl -n $SYS create secret generic e2e-ca --from-file=ca.crt="$STATE/fake-ca.pem" >/dev/null
token="kete_jhe_$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 42)A"
curl -sf -X POST $ADMIN/token -d "{\"token\":\"$token\"}" >/dev/null
kubectl -n $SYS create secret generic kete-runner-enrollment --from-literal=token="$token" >/dev/null
read_secret() { # read_secret <fake state>: the fake job's clone credential as the repository's read Secret
  local tok; tok=$(jq -r .clone_token "$STATE/$1/runtime-job.json")
  kubectl -n $SYS create secret generic fake-repo-read --from-literal=username=x-access-token --from-literal=token="$tok" \
    --dry-run=client -o yaml | kubectl apply -f - >/dev/null
}
read_secret lifecycle
api_ip=$(kubectl get endpoints kubernetes -n default -o jsonpath='{.subsets[0].addresses[0].ip}')
api_port=$(kubectl get endpoints kubernetes -n default -o jsonpath='{.subsets[0].ports[0].port}')
values() { # values <runtimeClassNames JSON>
  cat <<EOF
platform: {url: "https://platform.kete.test"}
image: {repository: "${RUNNER_IMAGE%@*}", digest: "${RUNNER_IMAGE#*@}"}
enrollment: {tokenSecret: kete-runner-enrollment}
proxy: {url: "http://$JH_IP:3128"}
caBundle: {existingSecret: e2e-ca}
jobs:
  namespace: $JOBS
  runtimeClassNames: $1
  images: ["$JOB_IMAGE", "$MISSING_IMAGE"]
  slots: 4
  startTimeoutSeconds: 300
  egress: {cidrs: ["$FAKE_IP/32", "$JH_IP/32"], ports: [443, 3128]}
  resources: {cpu: "1", memory: 2Gi, ephemeralStorage: 4Gi}
  outbox: {size: 1Gi, holdHours: 1}
repositories: ["$REPO"]
repositorySources: [{name: "$REPO", url: "https://github.kete.test/org/repo.git", cloneSecret: fake-repo-read}]
podDriver: kubevm
networkPolicy:
  apiServer: {cidrs: ["$api_ip/32"], port: $api_port}
  platform: {cidrs: ["$JH_IP/32"], ports: [3128]}
EOF
}
values '[kete-test]' >"$STATE/values.yaml"
helm install $REL "$chart" -n $SYS -f "$STATE/values.yaml" --wait --timeout 180s >/dev/null
log "installed $REL"
has_host() { [ -n "$(curl -sf $ADMIN/hosts | jq -r '.[0].ID // empty')" ]; }
wait_for 120 "host enrolled through the proxy" has_host
HOST=$(curl -sf $ADMIN/hosts | jq -r '.[0].ID')
curl -sf -X POST $ADMIN/approve -d "{\"host_id\":\"$HOST\"}" >/dev/null
wait_for 90 "v2 reports" bash -c "curl -sf $ADMIN/hosts | jq -e '.[0].Reports > 0 and .[0].LastReport.starts_blocked == null'"
[ "$(kubectl auth can-i --as=$SA get pods --subresource=log -n $JOBS)" = yes ] || fail "no pods/log"
[ "$(kubectl auth can-i --as=$SA get runtimeclasses.node.k8s.io/kete-test)" = yes ] || fail "no get runtimeclasses"
[ "$(kubectl auth can-i --as=$SA get secrets/other -n $SYS)" = no ] || fail "RBAC allows reading other Secrets"

# Diagnostics (never fail the run): what a pod in the jobs namespace reaches under its
# NetworkPolicy, before any job — DNS through the cluster resolver, the proxy, a CONNECT through it.
cat >"$STATE/netprobe.py" <<PY
import socket
try:
    print("dns", socket.getaddrinfo("platform.kete.test", 443)[0][4])
except Exception as e:
    print("dns error", e)
try:
    s = socket.create_connection(("$JH_IP", 3128), 5)
    s.sendall(b"CONNECT platform.kete.test:443 HTTP/1.1\r\nHost: platform.kete.test:443\r\n\r\n")
    s.settimeout(10)
    print("connect", s.recv(64))
except Exception as e:
    print("connect error", e)
PY
jq -n --arg ns $JOBS --arg img "$JOB_IMAGE" --rawfile py "$STATE/netprobe.py" '{apiVersion: "v1", kind: "Pod", metadata: {name: "kete-job-netprobe", namespace: $ns},
  spec: {runtimeClassName: "kete-test", restartPolicy: "Never", automountServiceAccountToken: false, enableServiceLinks: false,
    containers: [{name: "job", image: $img, command: ["python3", "-c", $py], securityContext: {capabilities: {drop: ["ALL"]}}}]}}' \
  | kubectl --as=$SA create -f - >/dev/null || true
for _ in $(seq 60); do kubectl -n $JOBS get pod kete-job-netprobe -o jsonpath='{.status.phase}' 2>/dev/null | grep -Eq 'Succeeded|Failed' && break; sleep 1; done
log "netprobe: $(kubectl -n $JOBS logs kete-job-netprobe 2>&1 | tr '\n' ' ')"
kubectl -n $JOBS delete pod kete-job-netprobe --wait=false >/dev/null 2>&1 || true

assign() { # assign <machine> <job> <image> [extra JSON]
  curl -sf -X POST $ADMIN/assign -d "{\"host_id\":\"$HOST\",\"machine_id\":\"$1\",\"job_id\":\"$2\",\"image\":\"$3\",\"deadline_seconds\":1500,\"repository\":\"$REPO\"${4:-}}" >/dev/null
}
fake_job() { jq -r ".$2" "$STATE/$1/runtime-job.json"; }

# --- 1. a real job, end to end
M1=7b3c4d5e-6f7a-4b8c-9d0e-000000000001 M3=7b3c4d5e-6f7a-4b8c-9d0e-000000000003
assign $M1 "$(fake_job lifecycle job_id)" "$JOB_IMAGE" ",\"claim_token\":\"$(fake_job lifecycle claim_token)\""
assign $M3 7e6f7a8b-9c0d-4e1f-8a2b-000000000003 "$MISSING_IMAGE"
wait_for 240 "M1 running" is_state $M1 running/
wait_for 60 "M1's Secret deleted once running" bash -c "! kubectl -n $JOBS get secret kete-job-$M1"
kubectl -n $JOBS get pod kete-job-$M1 -o json | jq -e '.spec.runtimeClassName == "kete-test" and .spec.automountServiceAccountToken == false and
  (.spec.containers[0].securityContext.capabilities.add | length) == 11 and .spec.containers[0].securityContext.privileged == false and
  ([.spec.volumes[].persistentVolumeClaim.claimName // empty] == ["kete-outbox-'$M1'"])' >/dev/null || fail "M1 pod spec"
wait_for 900 "fake: finish accepted" test -s "$STATE/lifecycle/finished"
wait_for 180 "M1 exited" is_state $M1 destroyed/exited
docker exec kete-fake true # still serving: the controller polls through it
lines=$(phase_lines $M1)
for want in setup_host setup_kubevm host_boundary egress_nft isolation claim clone clone_done agent result bundle outbox finish; do
  jq -e --arg s "$want" 'any(.[]; .step == $s and .event == "ok")' <<<"$lines" >/dev/null || fail "no '$want ok' phase line: $lines"
done
jq -e 'any(.[]; .step == "setup_sysctl" and .event == "note" and .code == "shared_kernel")' <<<"$lines" >/dev/null || fail "the test build wrote host-wide sysctls"
log "ok: phase lines reached the platform through the controller"
# --- 2. image_pull_failed (an allowlisted digest the registry doesn't have), reported while this
# fake still fronts the platform
wait_for 180 "M3 failed image_pull_failed" is_state $M3 failed/image_pull_failed
wait_for 60 "M3 pod removed" bash -c "! kubectl -n $JOBS get pod kete-job-$M3"
stop_fake
f=$STATE/lifecycle
jq -e 'any(.[]; .kind == "claim") and any(.[]; .kind == "finish") and all(.[]; .kind != "uploads" and (.kind | startswith("put:") | not))' "$f/calls.json" >/dev/null || fail "calls $(jq -c '[.[].kind]' "$f/calls.json")"
jq -e '.[] | select(.kind == "finish") | .body == "{\"outbox\":true}"' "$f/calls.json" >/dev/null || fail "finish body"
jq -e '.[] | select(.kind == "result") | .body | fromjson | (.text == null and .worktree == null and has("denied_count"))' "$f/calls.json" >/dev/null || fail "the result wasn't bounded: $(jq -c '.[] | select(.kind == "result")' "$f/calls.json")"
[ "$(jq length "$f/contract.json")" = 0 ] || fail "contract errors: $(cat "$f/contract.json")"
[ "$(jq length "$f/leaks.json")" = 0 ] || fail "leaks: $(cat "$f/leaks.json")"
jq -e '.tool_user != "" and .edited_readme != ""' "$f/job.json" >/dev/null || fail "the scripted model's checks didn't run: $(cat "$f/job.json")"
log "ok: the job claimed, cloned, ran kete, bounded its result, never uploaded and finished with the outbox"
# The outbox outlives the pod: read it on the worker (local-path keeps the volume in a node directory).
kubectl -n $JOBS get pvc kete-outbox-$M1 >/dev/null || fail "the outbox went with the pod"
pv=$(kubectl -n $JOBS get pvc kete-outbox-$M1 -o jsonpath='{.spec.volumeName}')
dir=$(kubectl get pv "$pv" -o jsonpath='{.spec.hostPath.path}{.spec.local.path}')
docker exec $WORKER cat "$dir/manifest.json" >"$STATE/manifest.json" || fail "no manifest in the outbox ($dir)"
jq -e --arg r "$REPO" '.version == 1 and .repository == $r and (.base_sha | length) == 40 and .outcome == "completed" and
  (.files | has("result") and has("audit") and has("proxy_log") and has("bundle"))' "$STATE/manifest.json" >/dev/null || fail "manifest $(cat "$STATE/manifest.json")"
[ "$(docker exec $WORKER stat -c %a "$dir")" = 750 ] || fail "the outbox directory isn't 0750"
log "ok: outbox manifest $(jq -c '{outcome, base_sha, files: (.files | keys)}' "$STATE/manifest.json")"

# --- 3. a claim naming another repository: refused before anything is cloned
start_fake mismatch -claim-repo gitlab:other/repo
read_secret mismatch
M2=7b3c4d5e-6f7a-4b8c-9d0e-000000000002
assign $M2 "$(fake_job mismatch job_id)" "$JOB_IMAGE" ",\"claim_token\":\"$(fake_job mismatch claim_token)\""
wait_for 300 "M2 exited" is_state $M2 destroyed/exited
jq -e 'any(.[]; .step == "claim" and .event == "failed" and .code == "repository")' <<<"$(phase_lines $M2)" >/dev/null || fail "M2 phase lines $(phase_lines $M2)"
stop_fake
jq -e '[.[].kind] == ["claim"]' "$STATE/mismatch/calls.json" >/dev/null || fail "after a refused claim: $(jq -c '[.[].kind]' "$STATE/mismatch/calls.json")"
log "ok: the wrong repository was refused; nothing but the claim reached the platform"
start_fake idle -linger # fronts the platform for the rest

# --- 4. shared-kernel refusals, before anything is written: a pod and Secret as the controller
# would create them (impersonated), with a wrong node boot ID in the test mode, and with the real
# node boot ID but the release rule (no test mode).
boot=$(kubectl get node $WORKER -o jsonpath='{.status.nodeInfo.bootID}')
refusal_pod() { # refusal_pod <machine> <node_boot_id> <shared_kernel_test>
  local m=$1 cfg
  cfg=$(jq -cn --arg b "$2" --argjson t "$3" --arg r "$REPO" '{job_id: "7e6f7a8b-9c0d-4e1f-8a2b-000000000009", platform_url: "https://platform.kete.test",
    claim_token: ("ab" * 32), storage_host: "storage.kete.test", host_profile: "kubevm", node_boot_id: $b,
    local: {repository: {name: $r, clone_url: "https://github.kete.test/org/repo.git", ref: "main", username: "u", token: "t"},
      boundary: {summary: "none", denials: "actions", publish_refs: "send"}, shared_kernel_test: $t}}')
  jq -n --arg n "kete-job-$m" --arg ns $JOBS --arg c "$cfg" '{apiVersion: "v1", kind: "Secret", metadata: {name: $n, namespace: $ns}, type: "Opaque", stringData: {"config.json": $c}}' \
    | kubectl --as=$SA create -f - >/dev/null
  jq -n --arg n "kete-job-$m" --arg ns $JOBS --arg img "$JOB_IMAGE" '{apiVersion: "v1", kind: "Pod", metadata: {name: $n, namespace: $ns},
    spec: {runtimeClassName: "kete-test", restartPolicy: "Never", automountServiceAccountToken: false, enableServiceLinks: false,
      containers: [{name: "job", image: $img, command: ["/usr/local/libexec/kete/kete-job-entrypoint", "--config-file", "/run/kete-config/config.json"],
        env: [{name: "KETE_JOB_HOST_PROFILE", value: "kubevm"}],
        securityContext: {privileged: false, allowPrivilegeEscalation: false, capabilities: {drop: ["ALL"], add: ["NET_ADMIN", "SYS_ADMIN", "SYS_RESOURCE", "SETUID", "SETGID", "KILL", "CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "NET_BIND_SERVICE"]}},
        volumeMounts: [{name: "kete-config", mountPath: "/run/kete-config", readOnly: true}]}],
      volumes: [{name: "kete-config", secret: {secretName: $n, defaultMode: 256}}]}}' | kubectl --as=$SA create -f - >/dev/null
}
R1=7b3c4d5e-6f7a-4b8c-9d0e-0000000000a1 R2=7b3c4d5e-6f7a-4b8c-9d0e-0000000000a2
refusal_pod $R1 "$(cat /proc/sys/kernel/random/uuid)" true
refusal_pod $R2 "$boot" false
for m in $R1 $R2; do
  wait_for 120 "refusal pod $m ended" bash -c "kubectl -n $JOBS get pod kete-job-$m -o jsonpath='{.status.phase}' | grep -Eq 'Succeeded|Failed'"
  out=$(kubectl -n $JOBS logs kete-job-$m)
  [ "$(head -1 <<<"$out" | jq -r '.step + " " + .event')" = "setup_host start" ] || fail "$m: the first line isn't setup_host: $out"
  [ "$(sed -n 2p <<<"$out" | jq -r '.step + " " + .event + " " + .code')" = "setup_host failed shared_kernel" ] || fail "$m: $out"
  [ "$(wc -l <<<"$out" | tr -d ' ')" = 3 ] || fail "$m: more than the refusal and the exit: $out"
  kubectl -n $JOBS delete pod kete-job-$m --wait=false >/dev/null
done
log "ok: shared_kernel refused before any write (a wrong node boot ID; a shared kernel under the release rule)"

# --- 5. RuntimeClasses: a non-allowlisted one is refused by admission; a missing one blocks starts
kubectl apply -f - >/dev/null <<EOF
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata: {name: kete-other}
handler: runc
EOF
denied "a job pod with a non-allowlisted RuntimeClass" kubectl --as=$SA create -f <(jq -n --arg ns $JOBS --arg img "$JOB_IMAGE" '{apiVersion: "v1", kind: "Pod",
  metadata: {name: "kete-job-other", namespace: $ns}, spec: {runtimeClassName: "kete-other", automountServiceAccountToken: false, enableServiceLinks: false,
  containers: [{name: "job", image: $img, securityContext: {capabilities: {drop: ["ALL"]}}}]}}')
values '[kete-test, kete-missing]' >"$STATE/values-missing.yaml"
helm upgrade $REL "$chart" -n $SYS -f "$STATE/values-missing.yaml" --wait --timeout 180s >/dev/null
wait_for 120 "starts blocked (runtime_class_missing)" bash -c "curl -sf $ADMIN/hosts | jq -e '.[0].LastReport.starts_blocked == \"runtime_class_missing\"'"
helm upgrade $REL "$chart" -n $SYS -f "$STATE/values.yaml" --wait --timeout 180s >/dev/null
wait_for 120 "starts unblocked" bash -c "curl -sf $ADMIN/hosts | jq -e '.[0].LastReport.starts_blocked == null'"

# --- nothing secret in the controller's logs
logs=$(kubectl -n $SYS logs deploy/kete-runner --tail=-1)
for s in "$token" "$(jq -r .clone_token "$STATE/lifecycle/runtime-job.json")" "$(jq -r .claim_token "$STATE/lifecycle/runtime-job.json")"; do
  grep -qF "$s" <<<"$logs" && fail "a credential is in the controller's logs"
done
stop_fake
docker rm -f kete-jh-fake >/dev/null 2>&1 || true
log "PASS ($(($(date +%s) - start)) s)"
