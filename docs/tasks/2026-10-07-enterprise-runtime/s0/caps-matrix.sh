#!/bin/bash
# S0: drop one capability at a time from the working set (prototype kubevm image, Kata, no-agent).
D=$(cd "$(dirname "$0")" && pwd)
export IMAGE=docker.io/library/kete-job:s0-kubevm PROFILE=kubevm
ALL="NET_ADMIN SYS_ADMIN SYS_RESOURCE SETUID SETGID KILL CHOWN DAC_OVERRIDE FOWNER FSETID"
for drop in ${@:-KILL CHOWN DAC_OVERRIDE FOWNER SYS_RESOURCE}; do
  set=$(echo $ALL | tr ' ' '\n' | grep -vx "$drop" | paste -sd, - | sed 's/,/, /g')
  name=c-$(echo $drop | tr 'A-Z_' 'a-z-')
  echo "=== without $drop"
  bash "$D/run-job.sh" "$name" no-agent kata-qemu "{privileged: false, allowPrivilegeEscalation: false, capabilities: {drop: [ALL], add: [$set]}}" kubevm 2>&1 \
    | grep -E 'phase=|"failed"|"exit"|finish accepted|stopped before' 
  sudo k3s kubectl -n kete-s0 delete pod "$name" --wait=false >/dev/null
done
