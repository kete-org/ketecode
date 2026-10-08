# kete-egress

A cloud job's only network boundary: the egress half of kete-code-platform ADR 0019 rule 4
(`docs/jobs.md` §8 item 2). Inside a job container nothing reaches the network except through one
TLS-terminating proxy that allows exactly the hosts each phase needs, for exactly the user that
needs them. One Go binary, two subcommands:

- `kete-egress nft --config <file|->` prints the job's nftables ruleset;
- `kete-egress serve --config <file|->` runs the proxy on file descriptors root hands it.

Linux-only; it ships in the job container image (piece D) and is installed and supervised by the
job entrypoint (piece C). It never ships with the `kete` CLI or the VS Code extension. Everything
below is a contract the entrypoint relies on: configuration v1, the fd layout, control protocol v1
and log format v1.

## Security model

- **Only the proxy user reaches the internet**, and only TCP 443 (never a blocked range) plus DNS
  to the configured resolvers. The `kete` user may reach only port A on loopback; the tool user
  only port B and its own loopback listeners on ports ≥ 1024; root only port R. Everything else is
  refused at once (a TCP reset, or ICMP port-unreachable), IPv4 and IPv6 alike, including Fly's
  private network (`fdaa::/16`, inside `fc00::/7`) and the metadata service (`169.254.0.0/16`).
- **Each port serves one user.** Besides the firewall, every accepted connection's owner is looked
  up in the kernel's socket table (`/proc/net/tcp{,6}`) and must be that port's user (defence in
  depth; fails closed).
- **Exact hosts, per phase and port.** A connection is allowed only when the CONNECT host, the TLS
  SNI and every request's `Host` are the same allowlisted name for that port in the current phase.
  Names are lowercased and must be plain DNS names (no IP literals, no trailing dot, no non-ASCII);
  there are no wildcards.
- **The proxy chooses the destination.** It resolves the CONNECT host with its own resolver (the
  configured resolvers only), drops every blocked address, connects itself, and verifies the
  upstream certificate against the system roots — loaded at start-up before the job CA exists, so
  the job CA can never verify an upstream. A client's `Host` never routes anything.
- **A per-VM CA, in memory only.** The CA key is generated at start-up and never written anywhere.
  The CA carries critical DNS name constraints limited to the allowlisted hosts and excludes every
  IP address, so even a leaked key could only sign for names the job may reach anyway. A permitted
  name also permits its subdomains (RFC 5280), so each host's subdomains are excluded too
  (`.host`) — except a host with an allowlisted host below it (`github.com` with
  `api.github.com`), whose other subdomains stay permitted, because excluding them would exclude the
  allowlisted one. Session tickets are off: every connection gets a full handshake and SNI check.
- **HTTP/1.1 only.** ALPN offers `http/1.1` only; an h2 preface, HTTP/1.0, `Upgrade` (WebSocket,
  h2c), absolute-form and asterisk-form requests are refused. The proxy never follows redirects:
  a redirect to another host needs its own allowed CONNECT.
- **Phases only move forward** (`none → clone → agent → report → closed`) and change only on an
  instruction over a socketpair only root holds. A phase change closes every open connection the
  new phase doesn't allow.
- **The tool user reaches package registries only**, and only in the agent phase.
- **A capped, root-owned request log** that fails closed: once full, every request is refused. The
  last tenth (at most 1 MB) is usable by root's port only, and refusal lines are rate-limited per
  port, so a job user can't exhaust the log to stop root reporting the job's result.
- **The proxy never runs as root.** Root binds the privileged ports, opens the log and creates the
  control socketpair; the proxy only inherits them.
- A guest-root escape defeats all of this (ADR 0019); short credential lifetimes remain the real
  bound.

## Building

```sh
CGO_ENABLED=0 go build -trimpath -ldflags=-s -o dist/kete-egress ./cmd/kete-egress
```

`CGO_ENABLED=0` matters: it makes Go's own resolver the only one. No Go toolchain is needed on a
macOS development machine; every command runs in the official `golang` Docker image (Colima works
as the Docker runtime).

## Configuration v1

One JSON document drives both subcommands. Unknown fields are refused; any invalid value exits 2
with a one-line reason on stderr.

```json
{
  "version": 1,
  "uids": { "proxy": 990, "kete": 991, "tool": 992 },
  "ports": { "kete": 81, "tool": 82, "root": 83 },
  "resolvers": ["[fdaa::3]:53"],
  "phases": {
    "clone":  { "root": ["github.com", "api.github.com", "platform.example"] },
    "agent":  { "kete": ["gateway.example", "platform.example"], "tool": ["registry.npmjs.org"], "root": ["platform.example"] },
    "report": { "root": ["platform.example", "storage.example"] }
  },
  "registries": [ { "host": "registry.npmjs.org", "kind": "npm", "shapes": ["package", "scoped_package", "tarball", "scoped_tarball"] } ],
  "limits": { "registry_requests": 20000, "log_max_bytes": 10000000 }
}
```

The values are examples. Every host comes from the entrypoint (`claim` gives the gateway, platform
and storage hosts); nothing but the registry rules is built in.

| Field | Meaning | Refused when |
|---|---|---|
| `version` | `1` | missing, or any other value (a new field means version 2) |
| `uids.proxy`, `uids.kete`, `uids.tool` | Numeric users; root is always 0 | missing, 0, ≥ 2³²−1, or not all different |
| `ports.kete`, `ports.tool`, `ports.root` | Ports A, B and R on 127.0.0.1 | missing, not 1-1023, or not distinct |
| `resolvers` | DNS servers, `"ip:53"` or `"[ipv6]:53"` | empty, not an IP literal with port 53, loopback, unspecified, multicast, zoned, IPv4-mapped, or listed twice. A private address (Fly's `fdaa::3`) is allowed: the firewall's exception is explicit, limited to port 53 and the proxy user |
| `phases.<clone\|agent\|report>.<kete\|tool\|root>` | Exact host allowlists; a missing phase or port allows nothing | a host that isn't a plain DNS name, a host listed twice in one list, or no host in any list at all; a `tool` list outside the agent phase; a `tool` host that is neither a built-in registry host nor in `registries` |
| `registries[]` | Registry hosts and the rules they get (below) | see "Registry rules" |
| `limits.registry_requests` | Registry requests per job; default and maximum 20,000 | outside 1-20,000 (it may only be lowered) |
| `limits.log_max_bytes` | Request-log cap; default and maximum 10,000,000 bytes (10 MB under both definitions) | outside 4,096-10,000,000 (it may only be lowered) |

## Registry rules

Package registries get GET/HEAD only, no query string and no body, a request target of at most
1 KiB, a per-kind path-shape allowlist, and a per-job request cap. **The rules are built in; the
configuration can only narrow them, never widen them.**

- Built-in kinds and their shape names (regexes over the raw path in `internal/registry`):
  - `npm`: `package`, `scoped_package`, `scoped_package_encoded` (`/@scope%2fname`), `tarball`,
    `scoped_tarball`. The audit endpoint (`POST /-/npm/v1/security/*`) is refused, so the image sets
    `NPM_CONFIG_AUDIT=false`.
  - `pypi`: `simple_index`, `simple_project`, `json_project`, `json_release`, `file`
    (`/packages/<2 hex>/<2 hex>/<60 hex>/<file>`, which covers the `.metadata` variant).
  - `crates`: `config`, `index_1`, `index_2`, `index_3`, `index_4` (the sparse index),
    `crate_file` and `crate_download` (the static host; cargo uses `/crates/<name>/<version>/download`),
    `api_download`.
  - `rubygems`: `versions`, `info`, `names`, `gem`, `gemspec`, `specs` (`specs`, `latest_specs`,
    `prerelease_specs`).
- Built-in hosts: `registry.npmjs.org`, `registry.yarnpkg.com` (npm); `pypi.org`,
  `files.pythonhosted.org` (pypi); `index.crates.io`, `static.crates.io`, `crates.io` (crates);
  `rubygems.org`, `index.rubygems.org` (rubygems). A built-in host allows nothing by itself, but
  whenever one is in an allowlist its kind's rules apply to it, whether or not `registries` lists it.
- A `registries[]` entry is `{host, kind, shapes?}`. It may:
  - put another host (a mirror, a test registry) under a built-in kind's rules;
  - restrict a host to a subset of its kind's shape names (`shapes` omitted means all of them).
- It may not — each is refused at start-up: an unknown kind; a shape name the kind doesn't have (a
  regex, a new shape); an empty `shapes` list; a duplicate host or shape; a built-in host declared
  as a different kind; and any other field (methods, path length, query, patterns: unknown fields
  are refused).
- To drop a registry, leave it out of every allowlist.
- Order of checks per request: method (405 `method`), query (403 `query`), body (403 `body`),
  target > 1,024 bytes (414 `path_length`), a `.`/`..`/empty segment or any `%` escape but the npm
  scope's `%2f` (403 `path`), shape (403 `path_shape`), then the cap (429 `registry_cap`).
- Whether real `npm`, `pip`, `cargo` and `bundler` runs fit these shapes is checked in the image's
  smoke test (piece D), not here (no internet in this module's tests).

## File descriptors

The entrypoint (root) prepares everything privileged, then starts `kete-egress serve --config -`
(the configuration on stdin) as the proxy uid and gid with `setgroups([])`, `no_new_privs`, a clean
environment (no `SSL_CERT_*` other than the image's, no `*_PROXY`, no `GODEBUG`) and
`oom_score_adj` −1000 (set by root; the proxy can't lower its own).

| fd | What | Checked at start (fail: exit 2) |
|---|---|---|
| 3 | TCP listener, `127.0.0.1:<ports.kete>` (port A) | stream socket, IPv4, listening, bound to 127.0.0.1 and exactly the configured port, port < 1024 |
| 4 | TCP listener, `127.0.0.1:<ports.tool>` (port B) | the same |
| 5 | TCP listener, `127.0.0.1:<ports.root>` (port R) | the same |
| 6 | Request log, opened by root `O_WRONLY\|O_APPEND\|O_CREAT\|O_CLOEXEC`, mode 0600, owner root | write-only with `O_APPEND`; a regular file owned by uid 0; its current size is the starting offset |
| 7 | Control: one end of an `AF_UNIX SOCK_STREAM` socketpair; root keeps the other | a unix stream socket |

Also refused at start (from `/proc/self/status`): any uid (real, effective, saved, filesystem)
other than `uids.proxy`, and so root; any gid 0; supplementary groups; `no_new_privs` not set;
non-empty permitted, effective or ambient capabilities. Fd 7's peer (`SO_PEERCRED`; for a
socketpair, its creator) must be uid 0. Any other inherited fd above 7 is refused (fds the Go
runtime itself opens, close-on-exec, don't count). Then the proxy refuses `SSL_CERT_FILE` or any
`SSL_CERT_DIR` entry naming anything under `/run/kete-egress`, loads the system roots (before
creating the job CA), refuses them if any root's subject common name is the job CA's (`Kete job
egress CA`), and sets `PR_SET_DUMPABLE 0`.

## Control protocol v1

Newline-delimited JSON on fd 7, at most 4 KiB per line, unknown fields refused.

| Direction | Message | Notes |
|---|---|---|
| proxy → root | `{"type":"ready","version":1,"ca_cert_pem":"…"}` | once, after every start-up check; the CA certificate for the trust stores |
| root → proxy | `{"type":"phase","phase":"clone"\|"agent"\|"report"\|"closed"}` | forward only; skipping is allowed |
| proxy → root | `{"type":"phase_ok","phase":"…","closed_connections":n}` | the connections the new phase no longer allows are already closed |
| proxy → root | `{"type":"error","reason":"…"}` | an unknown or backward phase; the proxy keeps running |
| root → proxy | `{"type":"stats"}` | |
| proxy → root | `{"type":"stats","requests":n,"refused":n,"registry_requests":n,"log_bytes":n,"log_full":bool,"job_log_full":bool}` | `requests` counts forwarded requests (the platform's summary metadata) |

In `none` (the start) and `closed` every request is refused. EOF on fd 7 (the entrypoint closed it
or died) makes the proxy close every connection and exit 0; a malformed line exits 2.

## Log format v1

JSON Lines on fd 6, one object per request or refusal. The platform stores it as
`job-audit/<org>/<job>.proxy.jsonl` (`application/x-ndjson`, ≤ 10 MB).

```json
{"v":1,"ts":"2026-09-30T12:34:56.789Z","phase":"agent","user":"tool","port":82,"method":"GET","host":"registry.npmjs.org","path":"/left-pad","status":200,"req_bytes":0,"resp_bytes":1234}
```

- Never logged: headers, bodies, query strings. `path` is the request target up to the `?`, cut
  to 256 bytes. `host` is the CONNECT host (invalid characters replaced by `_`).
- `suppressed` (refusal lines only, omitted when 0): how many earlier refusal lines for the same
  port were rate-limited away (see below).
- CONNECT- and TLS-stage refusals log `method:"CONNECT"`, `path:""` and `status:0` when no HTTP
  status could be sent.
- `reason` appears on refusals and failures only: `host_not_allowed`, `bad_connect`,
  `unsupported_method`, `port`, `bad_host`, `peer_uid`, `conn_limit`, `sni_mismatch`,
  `tls_handshake`, `host_mismatch`, `protocol`, `target`, `upgrade`, `body_too_large`, `log_full`,
  `resolved_blocked`, `resolve_failed`, `upstream_error`, `upstream_proxy` (v2: the enterprise
  proxy refused or failed the CONNECT), `idle_timeout` (rate-limited like a
  refusal), `suppressed_summary`, and the registry reasons
  `method`, `query`, `body`, `path_length`, `path`, `path_shape`, `registry_cap`.
- **The file never exceeds `log_max_bytes`**, even with requests in flight: a request is forwarded
  only after room for its line (2,560 bytes, the bound on any line) has been reserved while always
  keeping 128 bytes for the final marker.
- **Root's share:** the last tenth of the cap (at most 1,000,000 bytes) can be reserved only for
  port R. When the job users' part is exhausted, ports A and B get 503 while root keeps working;
  when root's reservation no longer fits either, the log is full: every CONNECT and request is
  refused with 503, nothing more is written, and once in-flight lines are written a last
  `{"v":1,"ts":"…","log_full":true}` marker ends the file. `stats.log_full` reports the latter.
- When the job users' part first fills, a one-time `{"v":1,"ts":"…","job_log_full":true}` marker
  is written from root's share, and `stats.job_log_full` turns true.
- **Refusal lines are rate-limited per port** (10 lines/s, burst 50). A refusal over the limit (or
  with no room left in its share) is still refused and counted in `stats.refused`, but not
  written; the next refusal line written for that port carries `"suppressed":n`, the number left
  out since the previous one. The first refusal of each (port, reason, host) bypasses the limit —
  up to 256 such combinations per job — so a probe of a new host can't hide behind a burst of
  noise.
- At shutdown, each port that still has an unreported suppressed count gets a summary line from
  root's share: `"method":"CONNECT"`, `"reason":"suppressed_summary"`, `"suppressed":n`.
- Every in-flight request's line is written before the proxy exits (on EOF it closes the
  connections and waits up to 5 s for their handlers).
- A write error on fd 6 (e.g. `ENOSPC`) exits 1; no request is forwarded without a reservation.

## Limits

| Limit | Value |
|---|---|
| Open client connections, total / per port A, B, R | 512 / 64, 256, 32 (over: accepted, logged `conn_limit`, closed) |
| CONNECT head read; client TLS handshake | 10 s each |
| Header bytes: CONNECT / inner request | 8 KiB / 32 KiB |
| Client keep-alive idle | 90 s |
| Upstream dial / TLS handshake / response header | 10 s / 10 s / 300 s |
| Stream idle (no bytes either way) | 300 s, then the connection is closed |
| Request body (non-registry) | 64 MiB → 413 |
| Registry requests per job | 20,000 (config may lower) → 429 |
| Request log | 10,000,000 bytes (config may lower) |
| Accept errors (EMFILE, …) | back off 50 ms doubling to 1 s |
| Refusal lines per port | 10/s, burst 50 (the rest counted as `suppressed`) |
| Root-only log share | the last tenth of the log, at most 1,000,000 bytes |
| DNS lookups | 5 s |

## Firewall

`kete-egress nft` prints one complete ruleset and changes nothing itself. The entrypoint applies
it as root **before** starting any job user's process and before `claim`, then checks it:

```sh
kete-egress nft --config /run/kete/egress.json | nft -f -
nft list table inet kete_egress >/dev/null
```

Any non-zero exit means abort. The output starts with `table inet kete_egress` and `delete table
inet kete_egress`, so one atomic `nft -f` both installs and re-installs it. `table inet
kete_egress` holds:

- sets `blocked_v4` (`0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 169.254.0.0/16 172.16.0.0/12
  192.0.0.0/24 192.168.0.0/16 198.18.0.0/15 224.0.0.0/3`) and `blocked_v6` (`::/96` — unspecified,
  loopback and IPv4-compatible — `::ffff:0:0/96 64:ff9b::/96 64:ff9b:1::/48 100::/64 2002::/16`
  (6to4) `fc00::/7 fe80::/10 ff00::/8`) — the same list (`internal/blocked`) the proxy's dialer
  uses;
- `chain output`, hook priority −155 (after conntrack, before any destination NAT, so a rule sees
  the destination the process asked for): established/related accepted, invalid dropped, ICMPv6
  neighbour discovery accepted (kernel-generated, no socket owner), then a jump per `meta skuid`
  to `proxy_out` (DNS to the resolvers, **before** the blocked ranges since Fly's resolver is in
  `fdaa::/16`; then the blocked ranges are refused; then TCP 443), `kete_out` (port A),
  `tool_out` (port B; loopback TCP/UDP ≥ 1024 on IPv4 and `::1`) and `root_out` (port R). Whatever
  a user chain doesn't accept — and all traffic from any other uid — ends in `jump refuse`; the
  chain's `policy drop` is only a backstop;
- `chain refuse`: `meta l4proto tcp reject with tcp reset`, then `reject with icmpx
  port-unreachable` for UDP and everything else. **Fail fast:** a blocked TCP `connect()` fails
  with `ECONNREFUSED` at once and a blocked UDP exchange gets `ECONNREFUSED` (or `EPERM`), instead
  of hanging until the client's own timeout. The reset or ICMP error is generated locally and
  reaches the socket as conntrack `related`, so the rules above let it through;
- `chain input`, policy drop: established/related, loopback, ICMPv6 ND/RA/packet-too-big;
- `chain forward`, policy drop.

Input and forward keep a silent drop: nothing inside the job waits on an unsolicited inbound
packet, so rejecting there would only confirm the machine to a remote scanner. A drop or reject in
any base chain is final in nftables, so no other table can weaken this.

**Open question for piece C (Fly verification): NAT64.** `64:ff9b::/96` (the well-known NAT64
prefix) is blocked today, because a NAT64 address can embed any IPv4 address, private ones
included. If Fly Machines reach IPv4-only hosts through NAT64, every such host is unreachable
until this is decided (e.g. allowing the prefix in the rules while the dialer checks the embedded
IPv4 address against `blocked_v4`). Nothing allows it silently.

Not done here, for the entrypoint (piece C): `user.max_user_namespaces=0`, `/proc` `hidepid=2`,
`oom_score_adj`.

## Clients: CA and proxy variables

The entrypoint writes the `ready` CA PEM to `/run/kete-egress/ca.pem` (0644, root) and points each
client at it through its own variables. **It never adds the job CA to the system trust store**
(`/usr/local/share/ca-certificates`, `update-ca-certificates`): the system store is what the proxy
verifies upstreams against, and the job CA must never be able to verify an upstream. (The proxy
also loads its roots before the job CA exists, so this holds either way.) Clients only ever reach
the proxy, so the replace-style variables can point at the job CA alone. The image (piece D) sets,
per user, with that user's port:

| Client | Variables |
|---|---|
| everything | `HTTPS_PROXY`/`https_proxy` = `http://127.0.0.1:<port>`; `HTTP_PROXY`/`http_proxy` the same (plain HTTP is refused anyway); `NO_PROXY` unset |
| OpenSSL defaults, Go, Ruby, gem, bundler, Python `ssl` | `SSL_CERT_FILE=/run/kete-egress/ca.pem` |
| Node, npm, yarn, pnpm, Bun (kete) | `NODE_EXTRA_CA_CERTS=/run/kete-egress/ca.pem`; `NPM_CONFIG_CAFILE=/run/kete-egress/ca.pem`, `NPM_CONFIG_AUDIT=false`, `NPM_CONFIG_FUND=false`, `NPM_CONFIG_UPDATE_NOTIFIER=false` |
| pip, requests, uv | `PIP_CERT`, `REQUESTS_CA_BUNDLE` (uv also `UV_NATIVE_TLS=1`) |
| cargo | `CARGO_HTTP_CAINFO` (cargo reads `HTTPS_PROXY`) |
| git | `GIT_SSL_CAINFO` |
| curl | `CURL_CA_BUNDLE` |

These variables are for the job users' processes only; the proxy is started with a clean
environment and never reads `HTTPS_PROXY`.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | the control channel closed (normal shutdown), or `nft` printed the ruleset |
| 1 | runtime failure: a request-log write, a listener, a control write |
| 2 | start-up or configuration refusal, or a malformed control line (one line on stderr) |

## Kernel requirements

`nf_tables` with the `inet` family, `meta skuid`, `ct state`, `th dport` and interval sets; IPv6
enabled; `/proc/net/tcp` and `/proc/net/tcp6`. Verified in Colima's kernel and GitHub's
`ubuntu-latest` by the integration suite. **Not yet verified: Fly Machines' guest kernel and its
resolver address** (`fdaa::3` is expected) — piece C/D's first real machine checks both.

## Configuration v2

Version 2 adds what an enterprise network needs: an upstream proxy reached with `CONNECT`
(`upstream.proxy`, `http://` or `https://host:port`), proxy credentials only from a file
(`upstream.proxy_auth_file`, never inline) and an extra CA bundle for upstream TLS
(`upstream.ca_bundle_file`), both under `/run/`; entries reached without the proxy
(`upstream.direct`); `host:port` allowlist entries for ports other than 443; and `internal` CIDR
ranges the proxy user may reach on exactly their ports although v1 blocks them. No internal range
may touch the forbidden ranges (`internal/blocked.Forbidden`), and an upstream proxy given as an
address may not be in one. The rules and the refusals are
[`docs/platform/egress-config-v2.md`](../../docs/platform/egress-config-v2.md) (the platform's copy;
its test vector is `internal/config/testdata/egress-config-v2/configs.json`, checked by
`config.ParseV2`'s tests). One deliberate difference: an upstream proxy given as an IPv4 literal in
any range of this module's v1 blocked list (`blocked_v4` above, which also blocks `192.0.0.0/24` and
`198.18.0.0/15`) must be inside an `internal` range; the platform's schema checks a shorter list.

`serve` and `nft` read both versions (`config.Load`: version 2 goes through `ParseV2`, then
`ConfigV2.Runtime`, the v1 `Config` with allowlists keyed by each entry's one spelling — the bare
host for 443, `host:port` otherwise). The job entrypoint writes v2 for the `kubevm` profile only.

- **Proxy:** a `CONNECT` may name any port; the entry `host:port` must be allowed in the current
  phase for the port's user, the TLS leaf and SNI are the host's, and each request's `Host` must be
  the entry (`host` or `host:443` for 443). Every allowed connection is opened as `CONNECT
  host:port` through the upstream proxy (TLS to an `https` proxy, verified), with
  `Proxy-Authorization: Basic` from the credentials file (read once at start, never logged), except
  `upstream.direct` entries, which are dialled as in v1. A refused or failed `CONNECT` (any non-2xx,
  `407` included) refuses the connection: status 502, log reason `upstream_proxy`, no retry.
- **Addresses** (every destination, the proxy's own too, resolved per connection as in v1): a
  forbidden address is refused whatever else says; one inside an internal range is allowed on
  exactly that range's ports; any other v1-blocked address is refused; the rest only on 443. A
  destination is resolved and checked even when it then goes through the proxy.
- **Trust:** the system roots plus `upstream.ca_bundle_file` (at most 256 KiB, at least one
  certificate, none named like a job CA), for upstream TLS only; clients still trust only the job
  CA.
- **Firewall** (`nft`): v1's ruleset, plus in `proxy_out`, before the blocked-range refusal: the
  forbidden sets refused, each internal range accepted on its ports, and a literal upstream proxy
  address on its port. The other users' chains are v1's. A proxy named by DNS on a port other than
  443 must sit in an internal range listing that port.

## How to test

```sh
# Unit tests: gofmt, vet (also with the integration tag), tests with the race detector.
docker run --rm -v "$PWD/packages/kete-egress:/src" -w /src golang:1.26-bookworm \
  sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go vet -tags integration ./... && go test -race ./...'

# Integration suite: root, real users, real nftables rules, fake upstreams and DNS, all inside a
# fresh network namespace. Needs a privileged container.
docker run --rm --privileged -v "$PWD/packages/kete-egress:/src" -w /src golang:1.26-bookworm \
  bash scripts/integration.sh
# Append a Go test flag for a subset, e.g.:
#   bash scripts/integration.sh -test.run TestFirewall
```

`scripts/integration.sh` installs `nftables`, `iproute2`, `curl` and `util-linux` if missing,
builds the binary and the test binary, creates the users `kete-it-proxy`, `kete-it-kete` and
`kete-it-tool` (plus `kete-it-other`, named nowhere in the configuration), then runs the tests
under `unshare --net` with the fake internet on documentation
addresses (`198.51.100.0/24`, `2001:db8::/32`, which the blocked list deliberately leaves out) and
bait listeners on blocked addresses, and fake DNS on `198.51.100.53:53` and Fly's `[fdaa::3]:53`.
The test process plays the entrypoint (it applies the rules with `kete-egress nft | nft -f -` and
launches the proxy per the fd table through `setpriv --no-new-privs`, with `SSL_CERT_FILE`
pointing at the fake upstreams' CA — the only way the tests make the proxy trust them); clients
run as the real users (curl/OpenSSL and Go). CI: `.github/workflows/kete-egress.yml`.
