---
module: egress
paths: [packages/kete-egress/**, .github/workflows/kete-egress.yml]
verified-at: 6d8972321a
---

## Quick answers
- What is this module? `kete-egress`, the cloud job's only network boundary: the egress half of
  platform ADR 0019 rule 4 (kete-code-platform `docs/jobs.md` §8 item 2). One Go binary with two
  subcommands, `nft` (prints the job's nftables ruleset) and `serve` (the TLS-terminating proxy on
  fds root hands it) (`cmd/kete-egress/main.go:41-44`). Linux-only. It ships in the job image
  (piece D), is installed and supervised by the entrypoint (piece C), and never ships with the CLI
  or VS Code. This is piece B of the image work; umbrella notes are in `docs/tasks/2026-09-30-job-image/`.
- Where's the contract? `packages/kete-egress/README.md`: Security model (`README.md:16-54`),
  Configuration v1 (`:66-99`), Registry rules (`:101-133`), fd table (`:135-157`), Control protocol
  v1 (`:159-173`), Log format v1 (`:175-216`), Limits (`:218-234`), Firewall (`:236-282`), Clients
  (`:284-305`), exit codes, kernel requirements and how to test. `contracts.md` §6c points here.
- Where did the egress requirements (ports A/B/R, phase table, registry limits, 10 MB log) and the
  proxy-log upload shape come from? The platform's ADR 0019 rule 4 and `docs/jobs.md` §7-8. They are
  now mirrored in kete-code by the README and `contracts.md` §6c. The log is the platform's
  `job-audit/<org>/<job>.proxy.jsonl` upload (ndjson, ≤ 10 MB) (`README.md:177-178`).
- Why a separate module and not a second binary in `kete-root-helper`? D1
  (`docs/tasks/2026-09-30-job-egress/plan.md` §1). The two have different trust boundaries and
  reviews, separate CI path filters (a proxy edit doesn't re-run the helper's e2e), and no shared
  Go code. The cost is two `go.mod` pins to bump together (see Changes).
- Is a Go-only folder under `packages/` a bun workspace, and does it trigger `kete-build.yml`? It's
  not a workspace: root `package.json` lists `packages/*`, but a folder without `package.json` isn't
  one. It does trigger `kete-build.yml`: that workflow's `paths-ignore` covers only `**/*.md` and
  `docs/**`, so Go changes run it, as for the root helper. The module's own suite runs in
  `kete-egress.yml`.
- How does the integration script work without apt tools in `golang:1.26-bookworm`?
  `scripts/integration.sh` installs `nftables`, `iproute2`, `curl` and `util-linux` if missing. It
  creates `kete-it-{proxy,kete,tool,other}` and passes their uids to the test binary. Then it runs
  everything under `unshare --net --fork` (`scripts/integration.sh:57`), so the rules never touch
  the host or CI runner network (`README.md:337-346`). This mirrors the root helper's script, plus
  the netns.
- Who may reach what? Only the proxy user reaches the internet (TCP 443 plus DNS to the configured
  resolvers). `kete` reaches only port A, the tool user only port B and its own loopback ≥ 1024, and
  root only port R. Everything else, including any other uid, is **refused fast**: a TCP reset or
  ICMP port-unreachable (`README.md:18-22,255-267`).
- What does the tool user get? Package registries only, in the agent phase only. `config.Parse`
  refuses a `tool` list in clone/report, and any agent `tool` host that is neither a built-in
  registry host nor in `registries[]` (`internal/config/config.go:335-344`).
- Registry rules: who owns them? D9 as changed by the user: the rules are **built in**
  (`internal/registry/registry.go:70,110`, kinds npm/pypi/crates/rubygems plus their well-known
  hosts). Configuration can only narrow them: map another host to a kind, restrict to a subset of
  shape names, or lower `limits.registry_requests`. Every widening is refused at start-up
  (`registry.Validate`, `registry.go:144`; `README.md:101-133`).
- CA name constraints? D4: the per-VM CA (memory only, D3) carries critical DNS name constraints
  for the allowlisted hosts and excludes all IPs. Each host's subdomains are excluded unless an
  allowlisted host sits below it (`internal/ca/ca.go:95`). curl/OpenSSL and Go accept it (the
  integration suite). The job image's e2e (`packages/kete-job-image`, scenario `ac5`) runs real
  Bun (kete's gateway calls), npm, pip and cargo through the proxy with this CA (git clones too);
  the index fetch and downloads pass. The fallback (no constraints) is a one-line change.
- How do clients trust the CA? Only through per-client variables pointing at
  `/run/kete-egress/ca.pem` (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `NPM_CONFIG_CAFILE`, `PIP_CERT`,
  `REQUESTS_CA_BUNDLE`, `CARGO_HTTP_CAINFO`, `GIT_SSL_CAINFO`, `CURL_CA_BUNDLE`, plus `HTTPS_PROXY`
  per user's port), listed in `README.md:284-305`. **Never the system store**: the proxy verifies
  upstreams against it, and `serve` refuses a job CA among the system roots or trust variables
  under `/run/kete-egress` (`internal/proxy/trust.go:19,43`). The job entrypoint sets these
  variables (`packages/kete-job-entrypoint/internal/entry/entry_linux.go`, `ToolEnv` and `KeteEnvList`).
- Peer-uid check? D5: every accepted connection's owner is looked up in `/proc/net/tcp{,6}` and
  must be that port's user, as defence in depth under nftables. It fails closed; the non-Linux stub
  always refuses (`internal/peeruid/peeruid_linux.go:13`, `peeruid_other.go:11`).
- Has CI run? Yes. `kete-egress.yml` passed its first run on `ubuntu-latest` (PR #60, 2026-09-30):
  unit tests plus the privileged integration suite, 17/17. So `meta skuid`, `th dport`, `ct state`,
  interval sets and hook priority −155 work in Colima's and GitHub's kernels.
- Can the allowlisted hosts change after `serve` starts? **No**: config v1 fixes them at start and
  control v1 has no host update. The entrypoint therefore **restarts the proxy between phases**
  (user decision D2 of `docs/tasks/2026-09-30-job-entrypoint/plan.md`), only while no job-user
  process exists, reusing the same listener fds (3-5) and log fd (6, so the 10 MB cap holds across
  instances): instance 1 before claim (clone root → platform), instance 2 after claim (clone root →
  platform, clone host and, for GitHub only, its API host — a Harness Code claim gets exactly
  platform and clone host, 2026-10-05; agent kete → gateway, platform; agent tool → built-in
  registry hosts; agent/report root → platform), instance 3 in the report phase (report root →
  platform and the storage host). If the proxy died or the claim was invalid, a **report-only
  instance** (root → platform) is started before `result`; with a job process still alive
  (`processes_alive`) it is never restarted. Code: `packages/kete-job-entrypoint/internal/job/job.go`
  (`afterClaim`, `ensureReport`, `finalize`), `internal/egress/proxy_linux.go` (`Manager`). The
  alternative (an `upload_host` in the claim plus a `hosts` control message, config/control v2) was
  not chosen.
- Who installs it now? `packages/kete-job-entrypoint/` (`job-entrypoint` card): ports 81 (A, kete),
  82 (B, tool), 83 (R, root); config on stdin; the proxy as `kete-proxy` with no groups, NNP, oom
  −1000, an empty environment; resolvers = `/etc/resolv.conf` nameservers; CA written to
  `/run/kete-egress/ca.pem` per instance; per-user client variables set (`README.md:284-305`).
  This module's changes also trigger `kete-job-entrypoint.yml`.
- What's still open for piece C (the first real Fly Machine)? (1) whether Fly's guest kernel has
  `nf_tables`/`inet` with these features and IPv6 egress; (2) whether the resolver is `fdaa::3` (the
  firewall's DNS exception precedes the blocked `fc00::/7`); (3) NAT64: `64:ff9b::/96` is blocked
  today, so IPv4-only hosts are unreachable if Fly uses NAT64. A fix would allow the prefix while
  the dialer checks the embedded IPv4 (`README.md:275-279`). Nothing allows it silently.
- Which path does real cargo use to download a crate? `GET static.crates.io/crates/<name>/<ver>/download`
  (the sparse index's `dl` has no markers, so cargo appends `/{crate}/{version}/download`). That is
  the built-in `crate_download` shape (`internal/registry/registry.go:96`), added at PR 2 beside
  `crate_file` (`:93`) and `api_download` (`:94`); before it the proxy refused cargo with 403
  `path_shape`. Crate versions must start alphanumeric, so `.` and `..` never match
  (`registry.go:59`).
- What's left for piece D? Done in the image e2e (`job-image` card): npm, pip, cargo, git and Bun
  accept the CA. Still open: real `bundler` (RubyGems shapes) and Fly's NAT64 question below.
- Does `kete`'s own server need a firewall exception? No. Since piece A1
  (`docs/tasks/2026-10-01-job-socket-server/`) `kete job run` talks to its `kete serve` child over a
  unix socket in a 0700 dir (`packages/cli/src/kete/job-standalone.ts:43-84`), never a TCP port, so
  "`kete` reaches only port A" stays exact; the ruleset is unchanged. `kete`'s env therefore has only
  `HTTPS_PROXY` (no `HTTP_PROXY`/`NO_PROXY`), which also keeps unix-socket `fetch`es in origin form.

## Purpose
Inside a cloud-job container, nothing reaches the network except through one proxy. It allows
exactly the hosts each phase (clone → agent → report) needs, for exactly the user that needs them.
The firewall makes the proxy the only path out. The proxy makes CONNECT host = TLS SNI = every
`Host` an allowlisted name, and it chooses and verifies the upstream itself. Spec and plan (D1-D9):
`docs/tasks/2026-09-30-job-egress/`. A guest-root escape defeats all of it (ADR 0019); short
credential lifetimes remain the real bound.

## Entry points
- `packages/kete-egress/cmd/kete-egress/main.go`: `nft` (`:81`) prints
  `netrules.Generate(cfg)`. `serve` (`:96`) runs the start-up checks in this order: extra fds, then
  identity, then `PR_SET_DUMPABLE 0`, then trust env, then `x509.SystemCertPool` (`:124`), then
  `CheckRoots`. Only after that does it create the CA (`ca.New`), build the proxy with those roots
  as `Deps.UpstreamRoots`, write `ready` with the CA PEM, and loop on control lines.
- `packages/kete-egress/README.md`: the contract the entrypoint (piece C) and image (piece D) read.

## Key files
| File | Role |
| --- | --- |
| `internal/config/config.go` | Config v1 → validated `Config` (`Parse`, `:163`); strict JSON, limits may only be lowered, tool-user rules (`:335-344`) |
| `internal/netrules/netrules.go` | `Generate` (`:30`): the `table inet kete_egress` ruleset; goldens in `testdata/{v4,v6,mixed}.nft` |
| `internal/blocked/blocked.go` | The blocked v4/v6 ranges shared by the ruleset and the dialer (`Contains`, `:55`) |
| `internal/proxy/{proxy,connect,forward,dial,limits}.go` | Accept loops per port, CONNECT parsing, TLS termination (`SessionTicketsDisabled`, `connect.go:154`), HTTP/1.1-only inner server (`forward.go:35`), own resolver plus blocked-address filter (`dial.go:29,50`), connection limits |
| `internal/proxy/startup_linux.go`, `identity.go`, `trust.go` | `CheckNoExtraFDs` (`:32`), `CheckIdentity` (`:71`, parses `/proc/self/status`), `CheckTrustEnv`/`CheckRoots` |
| `internal/ca/ca.go` | Per-VM CA in memory, name constraints, `JobCAName` (`:33`) |
| `internal/registry/registry.go` | Built-in kinds/shapes/hosts, `Validate` (narrow-only), `NewRules`, per-request checks and cap |
| `internal/reqlog/reqlog.go` | Capped JSONL log: `MaxLine` 2560 / `MarkerLen` 128 (`:31-33`), root's share (`RootShare`, `:58`), `Reserve(root)` (`:158`), rate-limited `Refusal` (`:227`), `FlushSuppressed` (`:268`) |
| `internal/{phase,policy,hostname,control,peeruid}` | Forward-only phase state; (phase, port, host) → allowed; name normalisation; control protocol v1 (4 KiB lines); `/proc/net/tcp` owner lookup |
| `internal/itest/*_test.go` | `//go:build integration && linux`: 17 tests (`TestAllowed` … `TestFirewall`, `TestLogFull`, `TestTrustRefusals`, `TestControlPeerMustBeRoot`); the test process plays the entrypoint |
| `scripts/integration.sh` | Installs tools, creates users, builds, runs the suite under `unshare --net` |
| `.github/workflows/kete-egress.yml` | Path-filtered `ubuntu-latest` job: gofmt, vet (+integration tag), `go test -race`, then `sudo … scripts/integration.sh` |

## Data flow
1. **Entrypoint (root, piece C), before `claim`:** writes the config, runs `kete-egress nft
   --config … | nft -f -`, then `nft list table inet kete_egress`. Any failure aborts
   (`README.md:238-246`).
2. It binds ports A/B/R on 127.0.0.1, opens the root-owned log, and creates the control socketpair
   (fds 3-7). Then it starts `kete-egress serve --config -` as the proxy uid via `setgroups([])`
   and `no_new_privs`, with a clean environment (`README.md:137-157`). The proxy writes `ready`
   with the CA PEM; root saves it as `/run/kete-egress/ca.pem`.
3. Root sends `phase` lines forward (`clone`, then `agent`, then `report`, then `closed`). Each
   change closes connections the new phase doesn't allow, and the proxy answers `phase_ok`.
   `stats` returns counters for the platform's summary.
4. **A client request:** `CONNECT host:443` on the user's port. The proxy checks the peer uid, the
   allowlist for (phase, port, host), TLS with SNI = host, and then each inner request's `Host` =
   host, plus the registry rules. For each request it reserves a log line, resolves via the
   configured resolvers, drops blocked addresses, dials, verifies against the system roots,
   forwards over HTTP/1.1, and logs.
5. **Shutdown:** EOF on fd 7 closes every connection. The proxy waits up to 5 s for the handlers,
   writes the suppressed summaries, and exits 0.

## Data and APIs used
- `golang.org/x/sys` v0.48.0 (same pin as the root helper); `golang.org/x/net` v0.59.0 for the test
  DNS server only (`go.mod`). Standard-library TLS/x509/HTTP; `CGO_ENABLED=0` makes Go's own
  resolver the only one (`README.md:59-62`).
- Kernel: `nf_tables` inet with `meta skuid`, `ct state`, `th dport`, interval sets; IPv6;
  `/proc/net/tcp{,6}` (`README.md:315-320`).
- Platform: the allowlists come from `claim` (gateway, platform API and storage hosts) plus the
  clone host (GitHub's revoke API host for GitHub only; none for Harness Code) and the registry
  list, all via the entrypoint. Nothing is hard-coded but the
  registry rules.

## Rules that must not break
- The proxy never runs as root and never binds its own ports. It refuses to start on any uid/gid
  mismatch, gid 0, supplementary groups, missing `no_new_privs`, capabilities, an extra non-CLOEXEC
  fd > 7, or a control peer that isn't uid 0.
- Upstream trust is the system roots only, loaded **before** the job CA exists. The job CA never
  goes into the system store. `serve` refuses trust env or roots that would include it.
- CONNECT host = SNI = every `Host`, exact names, no wildcards, no IP literals. The proxy resolves
  and dials itself; a client `Host` never routes.
- Phases move only forward, and only on root's control socket.
- Limits and registry rules may only be narrowed by configuration, never widened (D8, D9).
- The log never exceeds `log_max_bytes`: no request is forwarded without a line reservation. Root's
  tenth (≤ 1 MB) is reserved for port R, so a job user can't stop root's reporting.
- Firewall: the resolver DNS exception comes **before** the blocked ranges (Fly's `fdaa::3` is in
  `fc00::/7`). ICMPv6 ND must be accepted, or IPv6 breaks. Hook priority −155 runs before dstnat,
  so Docker's DNS DNAT can't fake a pass. Blocked output is `jump refuse` (fail fast); input and
  forward stay silent `policy drop`.
- HTTP/1.1 only (D6). h2, `Upgrade`/WebSocket (D7), absolute-form and `OPTIONS *` are refused.

## Testing
- Unit (no root; Docker/Colima): `docker run --rm -v "$PWD/packages/kete-egress:/src" -w /src
  golang:1.26-bookworm sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go vet -tags integration
  ./... && go test -race ./...'` covers 12 packages.
- Integration (privileged; cgroup v2 not needed): `docker run --rm --privileged -v
  "$PWD/packages/kete-egress:/src" -w /src golang:1.26-bookworm bash scripts/integration.sh`.
  Append `-test.run <Name>` for a subset. The build ran it 3× consecutively: 17/17 each.
- CI: `gh workflow run kete-egress.yml --repo kete-org/ketecode --ref <branch>`, then
  `gh run watch --repo kete-org/ketecode`. It passed on `ubuntu-latest` (PR #60), 17/17.
- Ruleset goldens: `internal/netrules/testdata/*.nft`. After changing `Generate`, regenerate them
  and check each with `nft -c -f`.

## Changes
- `docs/tasks/2026-09-30-job-egress/`: spec, plan (D1-D9, the ruleset, config and test design) and
  handoff. The handoff holds the deviations, the user's fail-fast decision, the security-review
  fixes and the reviewer's minor follow-ups.
- **Three Go pins to bump together:** `packages/kete-egress/go.mod`,
  `packages/kete-root-helper/go.mod` and `packages/kete-job-entrypoint/go.mod` (`go 1.26.0` /
  `toolchain go1.26.8`, `x/sys v0.48.0`; `x/net v0.59.0` in egress and the entrypoint).
- Changing config, fds, control or log format: update the README section and bump its version.
  Log format v1 gained the optional `suppressed` field, the `suppressed_summary` reason and the
  `job_log_full` marker before release.
- Adding a registry kind or shape: `internal/registry` (built in; config can't add one), the README
  "Registry rules", and tests.

## Gotchas
- **An nftables drop makes TCP `connect()` hang, not EPERM:** the kernel retransmits the SYN. The
  user chose fail-fast, so blocked output now ends in `chain refuse` (TCP reset, then ICMPx
  port-unreachable, which gives `ECONNREFUSED`). `TestFirewall` requires `ECONNREFUSED` in under
  1 s (UDP may also give `EPERM`); earlier handoff notes about timeouts are superseded.
- **Go ≥ 1.25 keeps `/sys/fs/cgroup/cpu.max` open** (container-aware GOMAXPROCS) before `main`.
  `CheckNoExtraFDs` therefore refuses only fds > 7 **without** `FD_CLOEXEC`
  (`startup_linux.go:56-59`).
- **Go's `http.Server` answers `OPTIONS *` itself.** `DisableGeneralOptionsHandler: true` sends it
  to the handler, which refuses it (`forward.go:35`).
- **The log-line bound is 2,560 B, not 2 KiB:** the worst case includes a 253 B host and a 256 B
  path JSON-escaped up to 6×. Minimum `log_max_bytes` is 4096.
- **The resolver still reads `/etc/resolv.conf` options and `/etc/hosts`** (both root-owned), but
  never its nameservers. Names are queried rooted (`host.`), so search lists never apply.
- Registry refusal lines are rate-limited per port (10/s, burst 50). The first refusal per (port,
  reason, host) bypasses the limit, for up to 256 combinations. A refusal that isn't written still
  counts in `stats.refused` and in `suppressed`.
- nft interval sets reject overlapping prefixes, so `::/96` replaces `::/128` and `::1/128`.
- Tests that read the log or `stats.refused` right after a response must poll: the counter and line
  land just after the status is written. Races found at `-count=20/50`.
- Without `unshare --net`, the suite would apply the rules to the CI runner's own network and cut
  it off.
- Deviations from the plan's letter (all accepted): CONNECT with a mismatched or duplicate `Host`
  gets 400 `host_mismatch`; plain-HTTP requests get 405 `unsupported_method`; the "tool's own
  listener" in `TestFirewall` is root-owned (the rule doesn't depend on the listener's owner).
  Added files: `internal/itest/proxy_test.go` and `internal/peeruid/peeruid_other.go`.
