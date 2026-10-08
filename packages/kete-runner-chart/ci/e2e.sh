#!/usr/bin/env bash
# Kind e2e for the kete-runner chart and controller (enterprise runtime P1). Runs in
# .github/workflows/kete-runner.yml after the cluster, the local registry and the images exist.
#
#   RUNNER_IMAGE  the test image (runner built with -tags kete_testdriver + fake platform), by digest
#   IMAGE_A       placeholder job image that runs until stopped, by digest
#   IMAGE_B       placeholder job image that exits after 20 s, by digest
#
# Proves: install with Pod Security restricted on the controller namespace; enrollment under
# job-host-v2 through the CONNECT proxy with a custom CA; the spent token Secret deleted; keys and
# state in Secrets; least-privilege RBAC; the admission policy refusing shared-kernel, foreign and
# privileged pods; placeholder machines starting (pod + boot-ID Secret) and stopping; exit;
# repository_unknown; orphan kill and re-adoption across a controller restart; the deadline kill;
# no token in the controller's logs.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
chart=$(cd "$here/.." && pwd)
: "${RUNNER_IMAGE:?}" "${IMAGE_A:?}" "${IMAGE_B:?}"
SYS=kete-system JOBS=kete-jobs SA=system:serviceaccount:kete-system:kete-runner
ADMIN=http://127.0.0.1:18080
start=$(date +%s)

log() { echo "[$(($(date +%s) - start))s] $*"; }
fail() {
  echo "FAIL: $*" >&2
  echo "--- controller logs" >&2; kubectl -n $SYS logs deploy/kete-runner --tail=200 >&2 || true
  echo "--- hosts" >&2; curl -s $ADMIN/hosts | jq . >&2 || true
  echo "--- pods" >&2; kubectl get pods -A -o wide >&2 || true
  echo "--- events ($JOBS)" >&2; kubectl -n $JOBS get events >&2 || true
  exit 1
}
# wait_for <seconds> <description> <command…>
wait_for() {
  local t=$1 what=$2; shift 2
  for _ in $(seq "$t"); do
    if "$@" >/dev/null 2>&1; then log "ok: $what"; return 0; fi
    sleep 1
  done
  fail "timed out: $what"
}
host() { curl -sf $ADMIN/hosts | jq -r '.[0].ID // empty'; }
mstate() { curl -sf $ADMIN/hosts | jq -r --arg m "$1" '.[0].Machines[$m] | "\(.State)/\(.Reason)"'; }
is_state() { [ "$(mstate "$1")" = "$2" ]; }
assign() {
  curl -sf -X POST $ADMIN/assign -d "{\"host_id\":\"$HOST\",\"machine_id\":\"$1\",\"job_id\":\"$2\",\"image\":\"$3\",\"deadline_seconds\":$4,\"repository\":\"$5\"}" >/dev/null
}
pod_phase() { kubectl -n $JOBS get pod "kete-job-$1" -o jsonpath='{.status.phase}' 2>/dev/null; }
no_pod() { ! kubectl -n $JOBS get pod "kete-job-$1" >/dev/null 2>&1; }
denied() { # denied <description> <kubectl args…>: the request must be refused by the admission policy
  local what=$1; shift
  if out=$("$@" 2>&1); then fail "admission allowed: $what"; fi
  grep -q "ValidatingAdmissionPolicy" <<<"$out" || fail "refused for another reason ($what): $out"
  log "ok: admission refused $what"
}

# --- fake platform
sed "s#@IMAGE@#$RUNNER_IMAGE#" "$here/e2e-fixtures.yaml" | kubectl apply -f -
kubectl -n kete-e2e rollout status deploy/platform --timeout=180s
kubectl -n kete-e2e port-forward svc/platform 18080:8080 >/tmp/pf.log 2>&1 &
wait_for 30 "admin API" curl -sf $ADMIN/hosts

# --- controller namespace (Pod Security restricted), CA bundle, enrollment token
kubectl create namespace $SYS
kubectl label namespace $SYS pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/enforce-version=latest
curl -sf $ADMIN/ca.pem >/tmp/ca.pem
kubectl -n $SYS create secret generic e2e-ca --from-file=ca.crt=/tmp/ca.pem
token="kete_jhe_$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 42)A"
curl -sf -X POST $ADMIN/token -d "{\"token\":\"$token\"}" >/dev/null
kubectl -n $SYS create secret generic kete-runner-enrollment --from-literal=token="$token"

# --- install
api_ip=$(kubectl get endpoints kubernetes -n default -o jsonpath='{.subsets[0].addresses[0].ip}')
api_port=$(kubectl get endpoints kubernetes -n default -o jsonpath='{.subsets[0].ports[0].port}')
pod_cidr=$(kubectl get nodes -o jsonpath='{.items[0].spec.podCIDR}' | sed 's#\.[0-9]*\.[0-9]*/[0-9]*#.0.0/16#')
cat >/tmp/values.yaml <<EOF
platform: {url: "https://platform.kete-e2e.svc.cluster.local"}
image: {repository: "${RUNNER_IMAGE%@*}", digest: "${RUNNER_IMAGE#*@}"}
enrollment: {tokenSecret: kete-runner-enrollment}
proxy: {url: "http://platform.kete-e2e.svc.cluster.local:3128"}
caBundle: {existingSecret: e2e-ca}
jobs:
  runtimeClassNames: [kete-test]
  images: ["$IMAGE_A", "$IMAGE_B"]
  slots: 8
  startTimeoutSeconds: 120
repositories: ["gitlab:payments/api"]
advertiseRepositories: true
podDriver: placeholder
placeholder: {exitAfter: [{image: "$IMAGE_B", seconds: 20}]}
networkPolicy:
  apiServer: {cidrs: ["$api_ip/32"], port: $api_port}
  platform: {cidrs: ["$pod_cidr"], ports: [3128]}
EOF
cat /tmp/values.yaml
helm install kete-runner "$chart" -n $SYS -f /tmp/values.yaml --wait --timeout 180s
log "installed"

# --- enrollment (v2, kubernetes facts) through the proxy, with the custom CA
has_host() { [ -n "$(host)" ]; }
wait_for 90 "host enrolled" has_host
HOST=$(host)
curl -sf $ADMIN/hosts | jq -e '.[0] | .Status == "pending" and .Facts.driver == "kubernetes" and .Facts.kvm == false and .Facts.slots == 8 and (.Facts.runtime_classes == ["kete-test"]) and (.Facts.versions.kubernetes | startswith("v1."))' >/dev/null || fail "enroll facts"
wait_for 30 "spent token Secret deleted" bash -c "! kubectl -n $SYS get secret kete-runner-enrollment"
[ "$(kubectl -n $SYS get secret kete-runner-keys -o jsonpath='{.metadata.annotations.kete\.dev/keys}')" = enrolled ] || fail "keys Secret not enrolled"
kubectl -n $SYS get secret kete-runner-state >/dev/null || fail "no state Secret"
kubectl -n $SYS get lease kete-runner -o jsonpath='{.spec.holderIdentity}' | grep -q kete-runner || fail "lease holder"
curl -sf -X POST $ADMIN/approve -d "{\"host_id\":\"$HOST\"}" >/dev/null
wait_for 90 "v2 reports" bash -c "curl -sf $ADMIN/hosts | jq -e '.[0].Reports > 0 and .[0].LastReport.version == 2 and (.[0].LastReport.repositories == [\"gitlab:payments/api\"])'"
[ "$(curl -sf $ADMIN/proxy | jq .connects)" -gt 0 ] || fail "the controller bypassed the proxy"
log "ok: platform traffic went through the CONNECT proxy"

# --- RBAC: least privilege
can() { kubectl auth can-i --as=$SA "$@" 2>/dev/null; }
[ "$(can get nodes)" = yes ] || fail "cannot get nodes"
for args in "list nodes" "create pods/exec -n $JOBS" "get secrets -n default" "list secrets -n $SYS" "create pods -n $SYS" \
            "delete deployments -n $SYS" "get secrets/other -n $SYS" "update pods -n $JOBS" "create pods -n default"; do
  # shellcheck disable=SC2086
  [ "$(can $args)" = no ] || fail "RBAC allows: $args"
done
log "ok: RBAC is least privilege"

# --- admission policy
pod() { # pod <name> <runtimeClass or ""> <image> [privileged]
  local rc=""; [ -n "$2" ] && rc="runtimeClassName: $2"
  local priv=false; [ "${4:-}" = privileged ] && priv=true
  cat <<EOF
apiVersion: v1
kind: Pod
metadata: {name: $1, namespace: $JOBS}
spec:
  $rc
  automountServiceAccountToken: false
  enableServiceLinks: false
  containers:
    - name: c
      image: $3
      command: [sleep, "30"]
      securityContext: {privileged: $priv, capabilities: {drop: [ALL]}}
EOF
}
denied "a runc pod by the controller SA" kubectl --as=$SA create -f <(pod runc-pod "" "$IMAGE_A")
denied "a runc pod by an admin" kubectl create -f <(pod runc-pod2 "" "$IMAGE_A")
denied "an allowed pod created by an admin" kubectl create -f <(pod admin-pod kete-test "$IMAGE_A")
denied "a privileged pod" kubectl --as=$SA create -f <(pod priv-pod kete-test "$IMAGE_A" privileged)
denied "a non-allowlisted image" kubectl --as=$SA create -f <(pod tag-pod kete-test "busybox:latest")

# --- machines
M1=2b3c4d5e-6f7a-4b8c-9d0e-000000000001 M2=2b3c4d5e-6f7a-4b8c-9d0e-000000000002
M3=2b3c4d5e-6f7a-4b8c-9d0e-000000000003 M4=2b3c4d5e-6f7a-4b8c-9d0e-000000000004
J=5e6f7a8b-9c0d-4e1f-8a2b-00000000000
assign $M3 ${J}3 "$IMAGE_A" 20 "gitlab:payments/api"   # deadline in 20 s: killed at deadline + 5 min
deadline_at=$(($(date +%s) + 20 + 300))
assign $M1 ${J}1 "$IMAGE_A" 3600 "gitlab:payments/api"
assign $M2 ${J}2 "$IMAGE_B" 3600 "gitlab:payments/api"
assign $M4 ${J}4 "$IMAGE_A" 3600 "gitlab:other/repo"

wait_for 120 "M1 running" is_state $M1 running/
[ "$(pod_phase $M1)" = Running ] || fail "M1 pod not running"
kubectl -n $JOBS get pod kete-job-$M1 -o json | jq -e --arg m $M1 '.metadata.labels["kete.dev/machine-id"] == $m and .spec.runtimeClassName == "kete-test" and .spec.automountServiceAccountToken == false' >/dev/null || fail "M1 pod spec"
wait_for 30 "M1 boot-ID Secret removed once running" bash -c "! kubectl -n $JOBS get secret kete-job-$M1"
kubectl -n $JOBS get events --field-selector involvedObject.name=kete-job-$M1 -o json | jq -e '[.items[] | select(.source.component == "kete-runner")] | length > 0' >/dev/null || fail "no controller event on the job pod"
wait_for 60 "M4 failed repository_unknown" is_state $M4 failed/repository_unknown
no_pod $M4 || fail "M4 got a pod"

curl -sf -X POST $ADMIN/withdraw -d "{\"host_id\":\"$HOST\",\"machine_id\":\"$M1\"}" >/dev/null
wait_for 90 "M1 destroyed desired" is_state $M1 destroyed/desired
wait_for 60 "M1 pod deleted" no_pod $M1
wait_for 120 "M2 exited by itself" is_state $M2 destroyed/exited
wait_for 60 "M2 pod deleted" no_pod $M2

# --- orphan kill and re-adoption across a restart
kubectl -n $SYS scale deploy/kete-runner --replicas=0
wait_for 120 "controller stopped" bash -c "[ -z \"\$(kubectl -n $SYS get pods -l app.kubernetes.io/name=kete-runner -o name)\" ]"
O=2b3c4d5e-6f7a-4b8c-9d0e-000000000009
kubectl --as=$SA create -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: kete-job-$O
  namespace: $JOBS
  labels: {app.kubernetes.io/managed-by: kete-runner, kete.dev/role: job, kete.dev/machine-id: "$O"}
spec:
  runtimeClassName: kete-test
  automountServiceAccountToken: false
  enableServiceLinks: false
  securityContext: {runAsNonRoot: true, runAsUser: 65534}
  containers:
    - name: job
      image: $IMAGE_A
      command: [sleep, "3600"]
      securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}
EOF
kubectl -n $SYS scale deploy/kete-runner --replicas=1
wait_for 120 "orphan pod deleted" no_pod $O
wait_for 60 "orphan reported unattributed" bash -c "curl -sf $ADMIN/hosts | jq -e --arg o $O '.[0].Unattributed[\$o].State == \"destroyed\"'"
[ "$(curl -sf $ADMIN/hosts | jq 'length')" = 1 ] || fail "the restarted controller enrolled again"
is_state $M3 running/ || fail "M3 was not re-adopted across the restart ($(mstate $M3))"
log "ok: M3 re-adopted after the restart"

# --- deadline kill (deadline + 5 min grace)
now=$(date +%s)
[ "$now" -lt "$deadline_at" ] && { log "waiting $((deadline_at - now)) s for M3's deadline + grace"; sleep $((deadline_at - now)); }
wait_for 120 "M3 destroyed deadline" is_state $M3 destroyed/deadline
wait_for 60 "M3 pod deleted" no_pod $M3

# --- nothing secret in the controller's logs
logs=$(kubectl -n $SYS logs deploy/kete-runner --tail=-1)
grep -q "$token" <<<"$logs" && fail "the enrollment token is in the controller's logs"
log "PASS ($(($(date +%s) - start)) s)"
