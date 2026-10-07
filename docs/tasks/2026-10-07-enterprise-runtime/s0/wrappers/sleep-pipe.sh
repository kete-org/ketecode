#!/bin/sh
# pipe.sh after 15 s: tells a NetworkPolicy programming race apart from a policy that doesn't apply.
sleep 15
cat /run/kete-config/config.json | exec /usr/local/libexec/kete/kete-job-entrypoint --config-fd 0
