# Kete-owned. The cloud job image (kete-code-platform docs/jobs.md §8 items 1-2, ADR 0019 rule 5):
# one container runs one job end to end; its root entrypoint sets up the machine, guards the
# network, claims the job, clones, runs `kete job run` with tools under the tool user, and reports.
#
# Built by scripts/build.sh from a staged context (.build/ctx-<arch>/), never from the repository
# root: the Go binaries and the Linux `kete` are compiled first, so this file has no build stage.
# No secret and no CA key is ever in the image: the proxy generates its CA per VM, in memory, and
# every credential arrives after boot (packages/kete-job-entrypoint/README.md).
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="Kete Code cloud job" \
      org.opencontainers.image.description="Runs one Kete Code cloud job: the root entrypoint, root helper, egress proxy and kete" \
      org.opencontainers.image.source="https://github.com/kete-org/ketecode" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.licenses="MIT"

# The distro's git, ripgrep, nftables and CA roots, plus Node/npm and Python/pip (D4) for the
# tool user's package installs through the proxy. Every setuid/setgid bit is stripped in the same
# layer (no privilege can be regained inside the job, ADR 0019 rule 5).
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      git ripgrep nftables ca-certificates nodejs npm python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb \
 && find / -xdev -perm /6000 -type f -exec chmod ug-s {} +

# The job users, created at build time and verified by the entrypoint at boot (D5): the proxy user
# has no supplementary group; kete and the tool user share kete-job, which has no other member.
RUN groupadd --system kete-job \
 && useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin kete-proxy \
 && useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin -G kete-job kete \
 && useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin -G kete-job kete-tool

# Root's git ignores system config (GIT_CONFIG_NOSYSTEM); this is for the job users' git.
COPY gitconfig /etc/gitconfig
# OpenCode's MIT licence and Kete's notice travel with the binary.
COPY LICENSE NOTICE /usr/share/doc/kete/
# Modes come from the staged context (build.sh: 0755); COPY makes them root-owned. kete-job-init is
# PID 1 of microvm and cloudvm guests (self-hosted hosts, kete-code-platform ADR 0023 rule 15);
# unused on Fly, where the entrypoint is the image's ENTRYPOINT under Fly's init.
COPY bin/kete-job-entrypoint bin/kete-job-init bin/kete-root-helper bin/kete-egress /usr/local/libexec/kete/
COPY kete /usr/local/bin/kete

# Build-time checks: no setuid/setgid file is left, the binaries are root-owned and not writable
# by anyone else, and rg and git are on the tool user's PATH (/usr/local/bin:/usr/bin:/bin).
RUN test -z "$(find / -xdev -perm /6000 -type f)" \
 && for f in /usr/local/bin/kete /usr/local/libexec/kete/kete-job-entrypoint /usr/local/libexec/kete/kete-job-init /usr/local/libexec/kete/kete-root-helper /usr/local/libexec/kete/kete-egress; do \
      [ "$(stat -c '%u:%g:%a' "$f")" = "0:0:755" ] || { echo "bad owner or mode: $f"; exit 1; }; \
    done \
 && command -v rg && command -v git && command -v nft \
 && [ "$(id -u kete)" != 0 ] && [ "$(id -u kete-tool)" != 0 ] && [ "$(id -u kete-proxy)" != 0 ]

ENTRYPOINT ["/usr/local/libexec/kete/kete-job-entrypoint"]
