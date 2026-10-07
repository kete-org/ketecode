#!/bin/sh
# Prototype kubevm entrypoint (it remounts /proc/sys and /sys/fs/cgroup itself). The wrapper only
# reads the Secret, unmounts its volume and hands the config over on a pipe (P2: --config-file does both).
set -e
cfg=$(cat /run/kete-config/config.json)
umount /run/kete-config
echo "s0: secret volume unmounted; entries now visible: $(ls -A /run/kete-config | wc -l); mountinfo lines: $(grep -c kete-config /proc/self/mountinfo || true)" >&2
printf %s "$cfg" | /usr/local/libexec/kete/kete-job-entrypoint --config-fd 0
