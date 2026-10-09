#!/usr/bin/env bash
# Kind e2e for the GitLab provider and the publisher (enterprise runtime P3). Runs in
# .github/workflows/kete-runner.yml after ci/e2e-kubevm.sh, on the same two-node cluster, with a
# third runner release in its own namespaces.
#
#   RUNNER_IMAGE        the runner test image (-tags kete_testdriver; holds kete-fake-platform), by digest
#   JOB_IMAGE           the kete-job image (entrypoint -tags kete_testdriver), by digest
#   FAKE_IMAGE          a local image: the job image plus kete-job-fake-platform (the jobs-v1 fake)
#   GITLAB_FAKE_IMAGE   a local image: the job image (git, git http-backend) plus kete-fake-gitlab
#
# The world, outside the cluster on the `kete-e2e-world` Docker network (172.30.0.0/24):
#   FAKE_IP    the jobs-v1 fake (platform.kete.test: claim, result, finish; the scripted model)
#   JH_IP      the job-host fake (job-host-v2, admin API) and the enterprise's CONNECT proxy
#   GITLAB_IP  the fake GitLab self-managed (gitlab.corp.test): REST API v4 and git smart HTTP
#              through the real git http-backend; a Maintainer token that mints project access
#              tokens, a writer bot token, protected branches with can_push
#
# Proves: a real job, end to end — the controller mints a per-job clone token (read_repository),
# checks the base ref with it, the job clones with it, the token is revoked once the job reports
# clone_done; the job exits into `publishing`; nothing is published before the platform's
# go-ahead; then the publisher pod (runner image, VM-isolated class, non-root, read-only outbox)
# validates the bundle, pushes a new branch create-only onto the job's base commit, opens a draft
# merge request, and the outcome reaches the platform (refs per the boundary); the outbox and the
# publisher go. Refusals with outboxes rewritten as a compromised job could (impersonating the
# controller, as the P2 e2e does): two of the platform's bundle vectors (a protected CI path; a
# symlink entry), an unprotected base branch, an existing job branch, a missing manifest; and a
# machine the platform drops while it waits (destroyed, outbox gone, never published). The admission
# policy refuses a job pod mounting the writer Secret and a publisher pod with a writable outbox;
# the controller can't read the writer Secret. No token in the controller's or publishers' logs.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
chart=$(cd "$here/.." && pwd)
vectors=$(cd "$here/../../kete-job-host/testdata/bundle-v1" && pwd)
: "${RUNNER_IMAGE:?}" "${JOB_IMAGE:?}" "${FAKE_IMAGE:?}" "${GITLAB_FAKE_IMAGE:?}"
SYS=kete-system3 JOBS=kete-jobs3 REL=kete-runner3
SA=system:serviceaccount:$SYS:kete-runner
ADMIN=http://127.0.0.1:18081 GADMIN=http://127.0.0.1:18082
REPO=gitlab:payments/api PROJECT=payments/api
STATE=${E2E_STATE:-/tmp/kete-publish-state}
WORKER=kind-worker
start=$(date +%s)

log() { echo "[publish $(($(date +%s) - start))s] $*"; }
fail() {
  echo "FAIL: $*" >&2
  echo "--- controller logs" >&2; kubectl -n $SYS logs deploy/kete-runner --tail=200 >&2 || true
  echo "--- hosts" >&2; curl -s $ADMIN/hosts | jq '.[0] | {Status, StartsBlocked: .LastReport.starts_blocked, Machines: (.Machines | map_values({State, Reason, Publish}))}' >&2 || true
  echo "--- pods" >&2; kubectl get pods -A -o wide >&2 || true
  for p in $(kubectl -n $JOBS get pods -o name 2>/dev/null); do echo "--- $p" >&2; kubectl -n $JOBS logs "$p" --tail=60 >&2 || true; kubectl -n $JOBS get "$p" -o jsonpath='{.status.containerStatuses[0].state}' >&2 || true; echo >&2; done
  echo "--- events ($JOBS)" >&2; kubectl -n $JOBS get events --sort-by=.lastTimestamp >&2 || true
  echo "--- gitlab" >&2; curl -s $GADMIN/state | jq '{tokens: [.tokens[]? | {name, revoked, clones}], merge_requests, branches, requests: (.requests[-40:])}' >&2 || true
  echo "--- docker logs kete-gitlab" >&2; docker logs kete-gitlab 2>&1 | tail -40 >&2 || true
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
machine() { curl -sf $ADMIN/hosts | jq -c --arg m "$1" '.[0].Machines[$m]'; }
mstate() { curl -sf $ADMIN/hosts | jq -r --arg m "$1" '.[0].Machines[$m] | "\(.State)/\(.Reason)"'; }
is_state() { [ "$(mstate "$1")" = "$2" ]; }
gstate() { curl -sf $GADMIN/state; }

# --- the world
NET=kete-e2e-world SUBNET=172.30.0.0/24
FAKE_IP=172.30.0.200 JH_IP=172.30.0.201 GITLAB_IP=172.30.0.202
helm uninstall kete-runner2 -n kete-system2 --wait >/dev/null 2>&1 || true # P2's release: it would poll the new job-host fake
docker rm -f kete-jh-fake kete-fake kete-gitlab >/dev/null 2>&1 || true
docker network inspect $NET >/dev/null 2>&1 || docker network create --subnet $SUBNET $NET >/dev/null
for node in kind-control-plane $WORKER; do docker network connect $NET "$node" 2>/dev/null || true; done
hosts=(--add-host "platform.kete.test:$FAKE_IP" --add-host "gateway.kete.test:$FAKE_IP" --add-host "storage.kete.test:$FAKE_IP" --add-host "gitlab.corp.test:$GITLAB_IP")
sudo rm -rf "$STATE" 2>/dev/null || rm -rf "$STATE"
mkdir -p "$STATE"
docker run -d --name kete-jh-fake --network $NET --ip "$JH_IP" "${hosts[@]}" -p 127.0.0.1:18081:8080 \
  --entrypoint /usr/local/bin/kete-fake-platform "$RUNNER_IMAGE" -authority platform.kete.test >/dev/null
wait_for 30 "job-host fake" curl -sf $ADMIN/hosts
curl -sf $ADMIN/ca.pem >"$STATE/jh-ca.pem"
docker run -d --name kete-fake --network $NET --ip "$FAKE_IP" -v "$STATE/fake:/state" -v "$STATE/jh-ca.pem:/jh-ca.pem:ro" -v "$STATE/ca:/ca" \
  --entrypoint /usr/local/libexec/kete-e2e/kete-job-fake-platform "$FAKE_IMAGE" \
  -addr "$FAKE_IP" -state /state -scenario lifecycle -deadline 25m -policy-timeout 10 -runtime-repo "$REPO" \
  -job-hosts "https://$JH_IP:8443" -job-hosts-ca /jh-ca.pem -ca-dir /ca -linger >/dev/null
wait_for 60 "jobs-v1 fake ready" test -s "$STATE/fake/runtime-job.json"
fake_job() { jq -r ".$1" "$STATE/fake/runtime-job.json"; }
# The fake GitLab: payments/api mirrors the jobs-v1 fake's repository (the scripted model edits its
# README), main protected and the writer may not push to it.
docker run -d --name kete-gitlab --network $NET --ip "$GITLAB_IP" -p 127.0.0.1:18082:8080 -v "$STATE/fake/git:/seed:ro" \
  --entrypoint /usr/local/libexec/kete-e2e/kete-fake-gitlab "$GITLAB_FAKE_IMAGE" -host gitlab.corp.test -root /tmp/gitlab >/dev/null
wait_for 30 "fake GitLab" curl -sf $GADMIN/state
rnd() { head -c 30 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 26; }
MINTER="glpat-$(rnd)" WRITER="glpat-$(rnd)"
out=$(curl -s -w '\n%{http_code}' -X POST $GADMIN/projects -d "{\"path\":\"$PROJECT\",\"from\":\"/seed/org/repo.git\"}")
[ "$(tail -1 <<<"$out")" = 200 ] || fail "gitlab project: $out"
curl -sf -X POST $GADMIN/minter -d "{\"token\":\"$MINTER\"}" >/dev/null
curl -sf -X POST $GADMIN/writer -d "{\"user\":\"kete-bot\",\"token\":\"$WRITER\"}" >/dev/null
BASE=$(gstate | jq -r --arg p $PROJECT '.branches[$p][] | select(startswith("main ")) | split(" ")[1]')
[ ${#BASE} = 40 ] || fail "no base commit"
curl -sf $GADMIN/ca.pem >"$STATE/gitlab-ca.pem"
cat "$STATE/ca/ca.crt" "$STATE/gitlab-ca.pem" >"$STATE/bundle-ca.pem"

# --- cluster DNS: kete.test → the jobs-v1 fake, gitlab.corp.test → the fake GitLab; the worker
# fenced from its pods (idempotent: e2e-kubevm.sh may have done both).
corefile=$(kubectl -n kube-system get configmap coredns -o jsonpath='{.data.Corefile}')
add=""
grep -q "kete.test:53" <<<"$corefile" || add+="kete.test:53 {\n    errors\n    cache 5\n    forward . $FAKE_IP\n}\n"
grep -q "corp.test:53" <<<"$corefile" || add+="corp.test:53 {\n    errors\n    hosts {\n        $GITLAB_IP gitlab.corp.test\n    }\n}\n"
if [ -n "$add" ]; then
  kubectl -n kube-system get configmap coredns -o json | jq --arg a "$(printf "$add")" '.data.Corefile += "\n" + $a + "\n"' | kubectl apply -f - >/dev/null
  kubectl -n kube-system rollout restart deploy/coredns >/dev/null
  kubectl -n kube-system rollout status deploy/coredns --timeout=120s >/dev/null
fi
worker_cidr=$(kubectl get node $WORKER -o jsonpath='{.spec.podCIDR}')
if ! docker exec $WORKER iptables -C INPUT -s "$worker_cidr" -j REJECT 2>/dev/null; then
  docker exec $WORKER iptables -I INPUT 1 -s "$worker_cidr" -j REJECT
  docker exec $WORKER iptables -I INPUT 1 -s "$worker_cidr" -p tcp -j REJECT --reject-with tcp-reset
  docker exec $WORKER iptables -I INPUT 1 -s "$worker_cidr" -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
fi

# --- the third runner: minted clone tokens, a writer, publisher pods through the proxy
kubectl create namespace $SYS >/dev/null
kubectl label namespace $SYS pod-security.kubernetes.io/enforce=restricted pod-security.kubernetes.io/enforce-version=latest >/dev/null
kubectl create namespace $JOBS >/dev/null
kubectl -n $SYS create secret generic e2e-ca --from-file=ca.crt="$STATE/bundle-ca.pem" >/dev/null
kubectl -n $SYS create secret generic gitlab-minter --from-literal=token="$MINTER" >/dev/null
kubectl -n $JOBS create secret generic gitlab-writer --from-literal=token="$WRITER" >/dev/null
kubectl -n $JOBS create secret generic publisher-ca --from-file=ca.crt="$STATE/gitlab-ca.pem" >/dev/null
token="kete_jhe_$(head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 42)A"
curl -sf -X POST $ADMIN/token -d "{\"token\":\"$token\"}" >/dev/null
kubectl -n $SYS create secret generic kete-runner-enrollment --from-literal=token="$token" >/dev/null
api_ip=$(kubectl get endpoints kubernetes -n default -o jsonpath='{.subsets[0].addresses[0].ip}')
api_port=$(kubectl get endpoints kubernetes -n default -o jsonpath='{.subsets[0].ports[0].port}')
cat >"$STATE/values.yaml" <<EOF
platform: {url: "https://platform.kete.test"}
image: {repository: "${RUNNER_IMAGE%@*}", digest: "${RUNNER_IMAGE#*@}"}
enrollment: {tokenSecret: kete-runner-enrollment}
proxy: {url: "http://$JH_IP:3128"}
caBundle: {existingSecret: e2e-ca}
jobs:
  namespace: $JOBS
  createNamespace: false
  runtimeClassNames: [kete-test]
  images: ["$JOB_IMAGE"]
  slots: 6
  startTimeoutSeconds: 300
  egress: {cidrs: ["$FAKE_IP/32", "$JH_IP/32", "$GITLAB_IP/32"], ports: [443, 3128]}
  resources: {cpu: "1", memory: 2Gi, ephemeralStorage: 4Gi}
  outbox: {size: 1Gi, maxSize: 2Gi, storageClass: standard, accessMode: ReadWriteOnce, holdHours: 1}
repositories: ["$REPO"]
repositorySources:
  - {name: "$REPO", url: "https://gitlab.corp.test/$PROJECT.git", cloneMode: minted, minterSecret: gitlab-minter, writerSecret: gitlab-writer, writerUsername: kete-bot}
publisher:
  caBundleSecret: publisher-ca
  egress: {cidrs: ["$JH_IP/32"], ports: [3128]}
boundary: {summary: none, denials: actions, publishRefs: send}
podDriver: kubevm
networkPolicy:
  apiServer: {cidrs: ["$api_ip/32"], port: $api_port}
  platform: {cidrs: ["$JH_IP/32"], ports: [3128]}
EOF
# The jobs namespace is the chart's to label (privileged); created above so the writer Secret
# exists before the controller starts, as an enterprise's GitOps would order it.
kubectl label namespace $JOBS pod-security.kubernetes.io/enforce=privileged >/dev/null
helm install $REL "$chart" -n $SYS -f "$STATE/values.yaml" --wait --timeout 180s >/dev/null
log "installed $REL"
has_host() { [ -n "$(curl -sf $ADMIN/hosts | jq -r '.[0].ID // empty')" ]; }
wait_for 120 "host enrolled" has_host
HOST=$(curl -sf $ADMIN/hosts | jq -r '.[0].ID')
curl -sf -X POST $ADMIN/approve -d "{\"host_id\":\"$HOST\"}" >/dev/null
wait_for 90 "v2 reports, starts allowed" bash -c "curl -sf $ADMIN/hosts | jq -e '.[0].Reports > 0 and .[0].LastReport.starts_blocked == null'"

# RBAC and admission around the writer
[ "$(kubectl auth can-i --as=$SA get secrets/gitlab-writer -n $JOBS)" = no ] || fail "the controller can read the writer Secret"
[ "$(kubectl auth can-i --as=$SA get secrets/gitlab-minter -n $SYS)" = yes ] || fail "the controller can't read the minter Secret"
denied "the controller deleting the writer Secret" kubectl --as=$SA -n $JOBS delete secret gitlab-writer
denied "a job pod mounting the writer Secret" kubectl --as=$SA create -f <(jq -n --arg ns $JOBS --arg img "$JOB_IMAGE" '{apiVersion: "v1", kind: "Pod",
  metadata: {name: "kete-job-steal", namespace: $ns}, spec: {runtimeClassName: "kete-test", automountServiceAccountToken: false, enableServiceLinks: false,
  containers: [{name: "job", image: $img, securityContext: {capabilities: {drop: ["ALL"]}}, volumeMounts: [{name: "w", mountPath: "/w"}]}],
  volumes: [{name: "w", secret: {secretName: "gitlab-writer"}}]}}')
denied "a publisher pod running something else" kubectl --as=$SA create -f <(jq -n --arg ns $JOBS --arg img "$RUNNER_IMAGE" '{apiVersion: "v1", kind: "Pod",
  metadata: {name: "kete-publish-x", namespace: $ns, labels: {"kete.dev/role": "publish"}}, spec: {runtimeClassName: "kete-test", automountServiceAccountToken: false, enableServiceLinks: false,
  securityContext: {runAsNonRoot: true, runAsUser: 65532}, containers: [{name: "publish", image: $img, command: ["/usr/local/bin/kete-fake-platform"],
  securityContext: {readOnlyRootFilesystem: true, capabilities: {drop: ["ALL"]}}, volumeMounts: [{name: "w", mountPath: "/w", readOnly: true}]}],
  volumes: [{name: "w", secret: {secretName: "gitlab-writer"}}]}}')
denied "a job pod reading the writer Secret through its environment" kubectl --as=$SA create -f <(jq -n --arg ns $JOBS --arg img "$JOB_IMAGE" '{apiVersion: "v1", kind: "Pod",
  metadata: {name: "kete-job-steal2", namespace: $ns}, spec: {runtimeClassName: "kete-test", automountServiceAccountToken: false, enableServiceLinks: false,
  containers: [{name: "job", image: $img, securityContext: {capabilities: {drop: ["ALL"]}}, env: [{name: "T", valueFrom: {secretKeyRef: {name: "gitlab-writer", key: "token"}}}]}]}}')

assign() { # assign <machine> <job> <claim token> <branch>
  curl -sf -X POST $ADMIN/assign -d "{\"host_id\":\"$HOST\",\"machine_id\":\"$1\",\"job_id\":\"$2\",\"image\":\"$JOB_IMAGE\",\"deadline_seconds\":1500,\"repository\":\"$REPO\",\"claim_token\":\"$3\",\"publish\":{\"branch\":\"$4\",\"open_mr\":true}}" >/dev/null
}
authorize() { curl -sf -X POST $ADMIN/authorize -d "{\"host_id\":\"$HOST\",\"machine_id\":\"$1\"}" >/dev/null; }

# --- 1. a real job, published
M1=8b3c4d5e-6f7a-4b8c-9d0e-000000000001 B1=kete/job/e2e00001
assign $M1 "$(fake_job job_id)" "$(fake_job claim_token)" $B1
wait_for 240 "M1 pod created" kubectl -n $JOBS get pod kete-job-$M1
tokens() { gstate | jq -c '[.tokens[]? | {name, revoked, clones}]'; }
wait_for 120 "a clone token minted for M1" bash -c "curl -sf $GADMIN/state | jq -e --arg n kete-job-$REL-$M1 'any(.tokens[]?; .name == \$n and (.scopes == [\"read_repository\"]) and .access_level == 20)'"
wait_for 900 "fake: finish accepted" test -s "$STATE/fake/finished"
wait_for 120 "M1 publishing" is_state $M1 publishing/
gstate | jq -e --arg n kete-job-$REL-$M1 'any(.tokens[]; .name == $n and .revoked and .clones >= 1)' >/dev/null || fail "the clone token wasn't used then revoked: $(tokens)"
wait_for 60 "M1's job pod gone" bash -c "! kubectl -n $JOBS get pod kete-job-$M1"
sleep 5
kubectl -n $JOBS get pod kete-publish-$M1 >/dev/null 2>&1 && fail "a publisher started before the platform's go-ahead"
gstate | jq -e --arg b $B1 --arg p $PROJECT '[.branches[$p][] | startswith($b + " ")] | any | not' >/dev/null || fail "pushed before the go-ahead"
authorize $M1
wait_for 120 "the publisher pod" kubectl -n $JOBS get pod kete-publish-$M1
kubectl -n $JOBS get pod kete-publish-$M1 -o json | jq -e --arg img "$RUNNER_IMAGE" '.spec.runtimeClassName == "kete-test" and .spec.containers[0].image == $img and
  .spec.securityContext.runAsNonRoot and .spec.containers[0].securityContext.readOnlyRootFilesystem and
  ([.spec.volumes[] | select(.persistentVolumeClaim) | .persistentVolumeClaim.readOnly] == [true]) and
  ([.spec.containers[0].volumeMounts[] | .readOnly] | all) and (.spec.containers[0].args | index("--base-sha")) != null' >/dev/null || fail "publisher pod spec"
wait_for 300 "M1 published" bash -c "curl -sf $ADMIN/hosts | jq -e --arg m $M1 '.[0].Machines[\$m] | .State == \"destroyed\" and .Reason == \"exited\" and .Publish.status == \"created\"'"
pub=$(machine $M1 | jq -c .Publish)
log "outcome $pub"
jq -e --arg b $B1 --arg base "$BASE" '.branch == $b and .base_sha == $base and (.commit_sha | length) == 40 and .mr.iid >= 1 and (.mr.url | startswith("https://gitlab.corp.test/"))' <<<"$pub" >/dev/null || fail "outcome $pub"
commit=$(jq -r .commit_sha <<<"$pub")
gstate | jq -e --arg p $PROJECT --arg b "$B1 $commit" 'any(.branches[$p][]; . == $b)' >/dev/null || fail "the branch isn't at the reported commit"
gstate | jq -e --arg p $PROJECT --arg c "$commit $BASE " 'any(.commits[$p][]; startswith($c) and contains("[skip ci]"))' >/dev/null || fail "the commit's parent isn't the base"
readme=$(curl -sf "$GADMIN/file?project=$PROJECT&ref=$B1&path=README.md" | jq -r .content)
[ "$readme" = "# fake repository (edited by the e2e)" ] || fail "README on the branch: $readme"
gstate | jq -e --arg b $B1 '.merge_requests[0] | .source_branch == $b and .target_branch == "main" and (.title | startswith("Draft: Kete job"))' >/dev/null || fail "merge request"
wait_for 60 "M1's outbox and publisher removed" bash -c "! kubectl -n $JOBS get pvc kete-outbox-$M1 && ! kubectl -n $JOBS get pod kete-publish-$M1"
log "ok: published — new branch on the base, draft merge request, outcome reported"

# --- 2. refusals: outboxes rewritten as a compromised job could. Each machine's job fails its claim
# (a token the platform never issued) and exits into publishing; then its outbox is replaced.
docker exec kete-fake true
craft() { # craft <machine> <bundle file> <job id>: a helper pod (as the controller) rewrites the outbox
  local m=$1 b=$2 job=$3 dir="$STATE/craft-$1"
  mkdir -p "$dir"
  local files='{}'
  if [ -n "$b" ]; then
    cp "$b" "$dir/bundle.tar.gz"
    files=$(jq -n --arg s "$(sha256sum "$dir/bundle.tar.gz" | cut -c1-64)" --argjson n "$(stat -c %s "$dir/bundle.tar.gz")" '{bundle: {name: "bundle.tar.gz", size: $n, sha256: $s}}')
  fi
  jq -cn --arg j "$job" --arg r "$REPO" --arg base "$BASE" --argjson f "$files" \
    '{version: 1, job_id: $j, repository: $r, ref: "main", base_sha: $base, branch: "x", outcome: "completed", exit_code: 0, files: $f, notes: [], written_at: "2026-10-09T10:00:00Z"}' \
    >"$dir/manifest.json"
  kubectl -n $JOBS create configmap "craft-$m" --from-file="$dir" >/dev/null
  jq -n --arg ns $JOBS --arg img "$JOB_IMAGE" --arg m "$m" '{apiVersion: "v1", kind: "Pod",
    metadata: {name: ("kete-craft-" + ($m | .[-4:])), namespace: $ns, labels: {"kete.dev/machine-id": $m}},
    spec: {runtimeClassName: "kete-test", restartPolicy: "Never", automountServiceAccountToken: false, enableServiceLinks: false,
      containers: [{name: "job", image: $img, command: ["sh", "-c", "rm -rf /outbox/* && cp /seed/* /outbox/ && chown 0:65532 /outbox/* && chmod 0640 /outbox/* && chown 0:65532 /outbox && chmod 0750 /outbox && ls -ln /outbox"],
        securityContext: {capabilities: {drop: ["ALL"], add: ["CHOWN", "DAC_OVERRIDE", "FOWNER"]}},
        volumeMounts: [{name: "o", mountPath: "/outbox"}, {name: "s", mountPath: "/seed", readOnly: true}]}],
      volumes: [{name: "o", persistentVolumeClaim: {claimName: ("kete-outbox-" + $m)}}, {name: "s", projected: {sources: [{configMap: {name: ("craft-" + $m)}}]}}]}}' \
    | kubectl --as=$SA create -f - >/dev/null || fail "craft pod for $m"
  wait_for 120 "outbox of $m rewritten" bash -c "kubectl -n $JOBS get pod kete-craft-${m: -4} -o jsonpath='{.status.phase}' | grep -q Succeeded"
  kubectl -n $JOBS delete pod "kete-craft-${m: -4}" --wait=true >/dev/null
}
vector() { jq -r --arg n "$1" '.cases[] | select(.name == $n) | .bundle_b64' "$vectors/bundles.json" | base64 -d >"$STATE/$2"; [ -s "$STATE/$2" ] || fail "no vector $1"; }
python3 - "$STATE/good.tar.gz" <<'PY'
import io, json, sys, tarfile, gzip
data = b"# fake repository (crafted)\n"
manifest = json.dumps([{"path": "README.md", "mode": "100644"}]).encode()
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w", format=tarfile.USTAR_FORMAT) as t:
    for name, body in (("manifest.json", manifest), ("files/README.md", data)):
        ti = tarfile.TarInfo(name); ti.size = len(body); ti.mode = 0o644
        t.addfile(ti, io.BytesIO(body))
open(sys.argv[1], "wb").write(gzip.compress(buf.getvalue(), mtime=0))
PY
vector ci_path_gitlab ci.tar.gz           # the platform's vector: .gitlab-ci.yml (ci_path)
vector entry_type_symlink entry.tar.gz    # the platform's vector: a symlink tar entry (entry_type)
declare -A WANT BUNDLE BR
R=(8b3c4d5e-6f7a-4b8c-9d0e-0000000000a1 8b3c4d5e-6f7a-4b8c-9d0e-0000000000a2 8b3c4d5e-6f7a-4b8c-9d0e-0000000000a3 8b3c4d5e-6f7a-4b8c-9d0e-0000000000a4 8b3c4d5e-6f7a-4b8c-9d0e-0000000000a5 8b3c4d5e-6f7a-4b8c-9d0e-0000000000a6)
WANT[${R[0]}]=refused/bundle_invalid; BUNDLE[${R[0]}]=ci.tar.gz
WANT[${R[1]}]=refused/bundle_invalid; BUNDLE[${R[1]}]=entry.tar.gz
WANT[${R[2]}]=refused/base_unprotected; BUNDLE[${R[2]}]=good.tar.gz
WANT[${R[3]}]=refused/branch_exists; BUNDLE[${R[3]}]=good.tar.gz
WANT[${R[4]}]=failed/publisher_failed; BUNDLE[${R[4]}]=""
WANT[${R[5]}]=dropped; BUNDLE[${R[5]}]=good.tar.gz
i=0
for m in "${R[@]}"; do
  i=$((i + 1)); BR[$m]="kete/job/e2er000$i"
  assign "$m" "9e6f7a8b-9c0d-4e1f-8a2b-00000000000$i" "$(printf 'cd%.0s' $(seq 32))" "${BR[$m]}"
done
for m in "${R[@]}"; do wait_for 300 "$m publishing (its claim refused)" is_state "$m" publishing/; done
for m in "${R[@]}"; do
  if [ -n "${BUNDLE[$m]}" ]; then craft "$m" "$STATE/${BUNDLE[$m]}" "9e6f7a8b-9c0d-4e1f-8a2b-00000000000${m: -1}"; fi
done
curl -sf -X POST $GADMIN/branch -d "{\"project\":\"$PROJECT\",\"branch\":\"${BR[${R[3]}]}\",\"from\":\"main\"}" >/dev/null || fail "pre-existing branch"
curl -sf -X POST $ADMIN/withdraw -d "{\"host_id\":\"$HOST\",\"machine_id\":\"${R[5]}\"}" >/dev/null
wait_for 120 "dropped while waiting: destroyed/desired, outbox gone" bash -c "[ \"\$(curl -sf $ADMIN/hosts | jq -r --arg m ${R[5]} '.[0].Machines[\$m] | \"\(.State)/\(.Reason)/\(.Publish)\"')\" = destroyed/desired/null ] && ! kubectl -n $JOBS get pvc kete-outbox-${R[5]}"
for m in "${R[@]:0:2}" "${R[3]}" "${R[4]}"; do authorize "$m"; done
wait_for 300 "refusals reported" bash -c "for m in ${R[0]} ${R[1]} ${R[3]} ${R[4]}; do curl -sf $ADMIN/hosts | jq -e --arg m \$m '.[0].Machines[\$m].Publish != null' >/dev/null || exit 1; done"
curl -sf -X POST $GADMIN/protect -d "{\"project\":\"$PROJECT\",\"branch\":\"main\",\"protected\":false,\"can_push\":true}" >/dev/null
authorize "${R[2]}"
wait_for 300 "base_unprotected reported" bash -c "curl -sf $ADMIN/hosts | jq -e --arg m ${R[2]} '.[0].Machines[\$m].Publish != null'"
for m in "${R[@]:0:5}"; do
  got=$(machine "$m" | jq -r '"\(.State)/\(.Reason) \(.Publish.status)/\(.Publish.reason)"')
  [ "$got" = "destroyed/exited ${WANT[$m]}" ] || fail "$m: $got, want ${WANT[$m]}"
  log "ok: $m ${WANT[$m]}"
done
gstate | jq -e --arg p $PROJECT '[.branches[$p][] | select(startswith("kete/job/e2er"))] | length == 1' >/dev/null || fail "a refused publish pushed: $(gstate | jq -c --arg p $PROJECT '.branches[$p]')"
[ "$(gstate | jq '.merge_requests | length')" = 1 ] || fail "a refused publish opened a merge request"

# --- nothing secret in the controller's or the publishers' logs
logs=$(kubectl -n $SYS logs deploy/kete-runner --tail=-1)
for s in "$token" "$MINTER" "$WRITER" "$(fake_job claim_token)"; do
  grep -qF "$s" <<<"$logs" && fail "a credential is in the controller's logs"
done
grep -q '"msg":"clone_token_minted"' <<<"$logs" && grep -q '"msg":"clone_token_revoked"' <<<"$logs" || fail "no mint/revoke log lines"
grep -q 'glpat-' <<<"$logs" && fail "a GitLab token shape is in the controller's logs"
docker stop -t 20 kete-fake >/dev/null 2>&1 || true
f=$STATE/fake
[ "$(jq length "$f/contract.json")" = 0 ] || fail "contract errors: $(cat "$f/contract.json")"
jq -e 'all(.[]; .kind != "uploads" and (.kind | startswith("put:") | not))' "$f/calls.json" >/dev/null || fail "uploads"
helm uninstall $REL -n $SYS --wait >/dev/null 2>&1 || true
docker rm -f kete-jh-fake kete-fake kete-gitlab >/dev/null 2>&1 || true
log "PASS ($(($(date +%s) - start)) s)"
