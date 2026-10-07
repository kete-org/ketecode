#!/bin/sh
# remount.sh plus: read the job Secret, then unmount its volume before the entrypoint starts.
set -e
mount -o remount,bind,rw /proc/sys
mount -o remount,rw /sys/fs/cgroup
cfg=$(cat /run/kete-config/config.json)
umount /run/kete-config
echo "s0: secret volume unmounted; entries now visible: $(ls -A /run/kete-config | wc -l); mountinfo lines: $(grep -c kete-config /proc/self/mountinfo || true)" >&2
printf %s "$cfg" | /usr/local/libexec/kete/kete-job-entrypoint --config-fd 0
