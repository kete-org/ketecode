#!/bin/bash
# Throwaway S0 driver, run on the k3s node: run-job.sh <name> <scenario> <runtimeclass|runc> <secctx-variant> <wrapper-variant>
# Starts the fake platform on 198.51.100.10 (dummy interface kete-fake), creates the job Secret and CA
# ConfigMap, applies the pod, waits for it to end, and prints the entrypoint's phase lines.
set -u
name=$1 scenario=$2 rc=$3 sec=$4 wrap=$5
here=$(cd "$(dirname "$0")" && pwd)
st=/mnt/lima-colima-kvmtest/s0/state/$name
K="sudo k3s kubectl -n kete-s0"
sudo rm -rf "$st"; mkdir -p "$st"
$K delete pod "$name" --ignore-not-found --wait=true >/dev/null
sudo pkill -f kete-job-fake-platform; sleep 1
sudo nohup /mnt/lima-colima-kvmtest/s0/bin/kete-job-fake-platform -addr 198.51.100.10 -state "$st" -scenario "$scenario" ${FAKE_ARGS:-} > "$st/fake.stdout" 2>&1 &
for _ in $(seq 60); do [ -f "$st/config.json" ] && break; sleep 0.5; done
[ -f "$st/config.json" ] || { echo "fake did not start"; cat "$st/fake.stdout"; exit 1; }
cat /etc/ssl/certs/ca-certificates.crt "$st/ca.pem" > "$st/ca-certificates.crt"
# PROFILE=kubevm (prototype image): rewrite the fake's dedicated config into a kubevm one carrying the
# node's boot ID (Node status.nodeInfo.bootID), or NODE_BOOT_ID to simulate a mismatch.
profile=${PROFILE:-dedicated}
if [ "$profile" = kubevm ]; then
  nb=${NODE_BOOT_ID:-$(sudo k3s kubectl get node -o jsonpath='{.items[0].status.nodeInfo.bootID}')}
  sudo python3 -c "import json,sys;c=json.load(open(sys.argv[1]));c['host_profile']='kubevm';c.pop('host_generation',None);c['node_boot_id']=sys.argv[2];open(sys.argv[1],'w').write(json.dumps(c))" "$st/config.json" "$nb"
fi
$K delete secret kete-job-s0 --ignore-not-found >/dev/null; $K delete configmap s0-wrappers --ignore-not-found >/dev/null; $K create configmap s0-wrappers --from-file="$here/wrappers" >/dev/null; $K delete configmap kete-job-s0-ca --ignore-not-found >/dev/null
sudo k3s kubectl -n kete-s0 create secret generic kete-job-s0 --from-file=config.json="$st/config.json" >/dev/null
$K create configmap kete-job-s0-ca --from-file=ca-certificates.crt="$st/ca-certificates.crt" >/dev/null
case $rc in runc) runtime="" ;; *) runtime="runtimeClassName: $rc" ;; esac
case $sec in
  caps) secctx='{privileged: false, allowPrivilegeEscalation: true, capabilities: {drop: [ALL], add: [NET_ADMIN, SYS_ADMIN, SYS_RESOURCE, SETUID, SETGID, KILL, CHOWN, DAC_OVERRIDE, FOWNER, FSETID]}}' ;;
  caps-nofsetid) secctx='{privileged: false, allowPrivilegeEscalation: true, capabilities: {drop: [ALL], add: [NET_ADMIN, SYS_ADMIN, SYS_RESOURCE, SETUID, SETGID, KILL, CHOWN, DAC_OVERRIDE, FOWNER]}}' ;;
  spec7) secctx='{privileged: false, capabilities: {drop: [ALL], add: [NET_ADMIN, SYS_ADMIN, SETUID, SETGID, KILL, CHOWN, DAC_OVERRIDE]}}' ;;
  default) secctx='{}' ;;
  privileged) secctx='{privileged: true}' ;;
  *) secctx="$sec" ;;
esac
cmd="/bin/sh /s0/$wrap.sh"
sed -e "s#@IMAGE@#${IMAGE:-ghcr.io/kete-org/kete-job@sha256:7c0c31d68d17cf8cd9d1ecbe9186b102ee6571c931bc072bd19b7739cf4a676a}#" -e "s#@PROFILE@#$profile#" -e "s#@NAME@#$name#" -e "s#@RUNTIME@#$runtime#" -e "s#@SECCTX@#$secctx#" -e "s#@CMD@#$cmd#" "$here/job-pod.yaml.tmpl" > "$st/pod.yaml"
t0=$(date +%s%N)
$K apply -f "$st/pod.yaml" >/dev/null || exit 1
ready=""
for _ in $(seq ${WAIT_S:-1800}); do
  p=$($K get pod "$name" -o jsonpath='{.status.phase}')
  [ -z "$ready" ] && [ "$p" != Pending ] && ready=$(( ($(date +%s%N) - t0)/1000000 )) && echo "started_ms=$ready (phase $p)"
  case $p in Succeeded|Failed) break ;; esac; sleep 1
done
echo "phase=$p total_ms=$(( ($(date +%s%N) - t0)/1000000 )) exit=$($K get pod "$name" -o jsonpath='{.status.containerStatuses[0].state.terminated.exitCode}')"
$K logs "$name" > "$st/job.log" 2>&1; cat "$st/job.log"
sleep 2; sudo pkill -TERM -f kete-job-fake-platform; sleep 2
echo "--- fake"; tail -5 "$st/fake.stdout"
