# Kete-owned. The Kete Code step for Harness CI/CD pipelines (packages/kete-harness-plugin/README.md):
# a Harness CI "Plugin" step image (Drone-compatible: settings arrive as PLUGIN_* environment
# variables). Its entrypoint either runs `kete job run` in the pipeline's workspace or starts a Kete
# cloud job and waits for it.
#
# Built by scripts/build.sh from a staged context (.build/ctx-<arch>/), never from the repository
# root: the entrypoint (TypeScript compiled with Bun into one binary) and the Linux `kete` are built
# first, so this file has no build stage. No secret is ever in the image: keys arrive as step
# settings from Harness secrets at run time.
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Kete Code Harness step" \
      org.opencontainers.image.description="Runs Kete Code in a Harness CI/CD pipeline step: kete job run in the workspace, or a Kete cloud job" \
      org.opencontainers.image.source="https://github.com/kete-org/ketecode" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT"

# The distro's git (worktree, commit, push), ripgrep (kete's search) and CA roots. Every
# setuid/setgid bit is stripped in the same layer.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git ripgrep ca-certificates \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb \
 && find / -xdev -perm /6000 -type f -exec chmod ug-s {} +

# A non-root user. Harness steps run as the image's user unless the step sets runAsUser; the
# workspace's .git must be writable by whichever user runs the step (kete job run adds a worktree).
RUN useradd --uid 1000 --user-group --create-home --home-dir /home/kete --shell /usr/sbin/nologin kete

# safe.directory: the workspace is usually cloned by another user (the pipeline's clone step).
COPY gitconfig /etc/gitconfig
# OpenCode's MIT licence and Kete's notice travel with the binaries.
COPY LICENSE NOTICE /usr/share/doc/kete/
COPY bin/kete-harness-plugin /usr/local/bin/kete-harness-plugin
COPY kete /usr/local/bin/kete

# Build-time checks: no setuid/setgid file, both binaries root-owned and not writable by others,
# git and rg on PATH, the step user isn't root.
RUN test -z "$(find / -xdev -perm /6000 -type f)" \
 && for f in /usr/local/bin/kete /usr/local/bin/kete-harness-plugin; do \
      [ "$(stat -c '%u:%g:%a' "$f")" = "0:0:755" ] || { echo "bad owner or mode: $f"; exit 1; }; \
    done \
 && command -v git && command -v rg \
 && [ "$(id -u kete)" = 1000 ]

USER 1000:1000
ENV HOME=/home/kete
ENTRYPOINT ["/usr/local/bin/kete-harness-plugin"]
