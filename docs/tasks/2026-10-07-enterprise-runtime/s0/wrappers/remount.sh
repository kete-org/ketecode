#!/bin/sh
# What a kubevm profile would do first: make /proc/sys and the container's cgroup2 mount writable
# (CRI mounts both read-only for a non-privileged container; inside the Kata guest that is the
# pod's own kernel), then the unchanged entrypoint on a pipe.
set -e
mount -o remount,bind,rw /proc/sys
mount -o remount,rw /sys/fs/cgroup
cat /run/kete-config/config.json | exec /usr/local/libexec/kete/kete-job-entrypoint --config-fd 0
