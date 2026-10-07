#!/bin/sh
# Unchanged entrypoint; only hands the Secret's config.json to it on a pipe (--config-fd 0).
cat /run/kete-config/config.json | exec /usr/local/libexec/kete/kete-job-entrypoint --config-fd 0
