# Plan: Cloud job egress: nftables rules and the TLS-terminating proxy (ADR 0019 rule 4)

> **Large task: approval needed before building.** This is a **security change**: it builds the
> job's only network boundary. It also adds a **new in-repo contract** (a JSON config, an fd
> layout, a control protocol and the JSONL log format that piece C, the entrypoint, relies on,
> and that the platform stores as `job-audit/<org>/<job>.proxy.jsonl`). **No upstream file is
> edited**, the runtime config schema doesn't change, and no SDK or protocol regeneration is
> needed. Decisions D1-D9 at the end need the user's yes or no.

## Cards read
- docs/context/modules/root-helper.md (verified-at 7ade92f18e, stale: no)
- docs/context/modules/job-mode.md (verified-at 6c3649e3a6, stale: no)
- docs/context/modules/kete-tools-ci.md (stale: no; `stale-cards.mjs` reported "All cards current")
- Also read: docs/context/{INDEX,commands,pitfalls,decisions}.md, contracts.md headings;
  kete-code-platform `docs/adr/0019-container-host-fly-machines.md` rules 4-5 and
  `docs/jobs.md` §7-8 and the callbacks table (the proxy log is uploaded as `.proxy.jsonl`,
  `application/x-ndjson`, ≤ 10 MB).

## 1. Where the code lives (D1)

**A new Go module, `packages/kete-egress/`** (module path
`github.com/kete-org/ketecode/packages/kete-egress`, `go 1.26.0` / `toolchain go1.26.8`, the same
pin as the root helper), with one binary, `kete-egress`, and its own path-filtered workflow
`.github/workflows/kete-egress.yml`.

Why not a second binary in `packages/kete-root-helper/`:
- **Separate trust boundaries, separate reviews.** The helper is a root process that spawns
  tools; the proxy is an unprivileged network boundary. One module named "root-helper" holding
  the proxy would mislead every future reader and card.
- **CI minutes.** The helper's workflow runs its integration suite *and* the bun-based AC5 e2e
  (~4-6 min). Sharing a module means sharing the path filter, so every proxy edit would re-run
  the helper's e2e and vice versa. Two filters cost nothing.
- **Shared go.mod buys little.** The only shared piece is the toolchain pin (two lines) and
  `golang.org/x/sys`. No Go code is shared: the helper's packages are all `internal/`.
- **Binary count is the same either way.** One binary per job (proxy, helper, entrypoint) runs
  as a different user with different privileges, so a multi-call binary wouldn't save anything
  that matters. It would only mean the proxy user can execute code paths that are built to run as
  root.
- **The entrypoint (piece C) doesn't need to import it.** The contract is language-neutral: a
  binary with two subcommands, a JSON config, a fixed fd layout and a line protocol. Piece C
  calls `kete-egress nft` and `kete-egress serve`. If piece C wants typed Go structs later, a
  `replace` directive or a `go.work` works. That's piece C's decision.

Cost: two `go.mod` pins to bump together. The new card says so under "Changes".

## 2. Proxy design

### 2.1 Processes, privileges, fds (D2)
The proxy **never runs as root.** The entrypoint (root) prepares everything privileged, then
starts `kete-egress serve --config -` (the config on stdin) as the `proxy` uid/gid, with
`setgroups([])`, `no_new_privs`, a clean environment (no `SSL_CERT_*`, `*_PROXY` or `GODEBUG`)
and `oom_score_adj` −1000 (set by root; the proxy can't lower its own). The inherited fds are
fixed:

| fd | What | Proxy checks at start (fail → exit 2, one-line reason on stderr) |
|---|---|---|
| 3 | TCP listener, `127.0.0.1:<ports.kete>` (port A) | `SO_TYPE`=stream, `SO_ACCEPTCONN`=1, `getsockname` = 127.0.0.1 and the configured port, port < 1024 |
| 4 | TCP listener, `127.0.0.1:<ports.tool>` (port B) | same |
| 5 | TCP listener, `127.0.0.1:<ports.root>` (port R) | same |
| 6 | request log, opened by root `O_WRONLY\|O_APPEND\|O_CREAT\|O_CLOEXEC`, mode 0600, owner root | `F_GETFL` has `O_APPEND` and is write-only; `fstat` is a regular file with uid 0; the current size is the starting offset |
| 7 | control, one end of an `AF_UNIX SOCK_STREAM` socketpair; root keeps the other end | `SO_DOMAIN`=AF_UNIX |

Why fds rather than binding itself: ports below 1024 need root or `CAP_NET_BIND_SERVICE`, and
lowering `ip_unprivileged_port_start` would let job users bind them first. The log must be
root-owned (spec), and the proxy user can't create a root-owned file. Only a holder of the fd can
use the control socketpair, so "root-only" holds by construction: no path, no peer-credential
check, nothing a job user can connect to.

Start-up checks also refuse: `getuid()==0`, `getuid() != config.uids.proxy`, and any fd above
7. After the checks the proxy sets `PR_SET_DUMPABLE 0`.

### 2.2 Per-VM CA (memory only)
- At start: an ECDSA P-256 CA key, **held in memory only and never written to disk.** That's
  stricter than "readable only by the proxy user" (D3). Self-signed, `IsCA`, `MaxPathLenZero`,
  KeyUsage CertSign, a random 128-bit serial, NotBefore = now − 1 h, NotAfter = now + 24 h (the
  longest job is 130 min), subject CN "Kete job egress CA".
- **Name constraints** (D4, recommended): `PermittedDNSDomains` = the union of every allowlisted
  host in the config, marked critical. Then even a leaked key can only sign for allowed names.
- Leaf certificates: one ECDSA P-256 leaf key made at start; one certificate per host, issued the
  first time that host is allowed and then cached in a mutex-guarded map. The cache is bounded,
  because only allowlisted names are ever issued. SAN = the one DNS name, ExtKeyUsage
  serverAuth, same validity as the CA.
- The CA certificate PEM goes to root in the `ready` control message (§2.4). The entrypoint
  writes it where the trust stores read it (§6). No file permissions to get right.

### 2.3 One client connection (package `internal/proxy`)
1. **Accept** on port P (A/B/R, which means user kete/tool/root). Enforce the connection limits
   (§2.7). **Peer-uid check (D5, defence in depth under nftables):** look up the client socket in
   `/proc/net/tcp` (the entry whose local address is the peer's address and port and whose remote
   address is the listener). Its uid must equal the uid configured for P (root = 0). If it
   doesn't, or the lookup fails, close the connection and log `reason: peer_uid`.
2. **CONNECT head.** `http.ReadRequest` on a `bufio.Reader`, with a 10 s deadline and 8 KiB max
   header bytes. The request must be `CONNECT host:443 HTTP/1.1`. Any other method, including
   plain-HTTP absolute-form proxying, gets 405 and close. The host is normalised (§2.5), and a
   port other than 443 gets 403. If a `Host` header is present it must equal the CONNECT
   authority.
3. **Allowlist:** `allowed(phase, port, host)` for the current phase. Refused → 403, log, close.
   A full log → 503 (§2.6).
4. Reply `HTTP/1.1 200 Connection established`. The TLS server reads through a conn wrapper
   that first replays whatever `bufio` already buffered.
5. **Client-side TLS** (handshake timeout 10 s, TLS ≥ 1.2). `GetConfigForClient` requires that
   `hello.ServerName`, normalised, **equals** the CONNECT host. No SNI, a different SNI, or an IP
   SNI makes the handshake fail and logs `sni_mismatch`. `NextProtos: ["http/1.1"]` only (D6).
   The leaf comes from the §2.2 cache.
6. **Requests on the TLS conn.** A `net/http` `Server` serves exactly this one conn (a
   single-conn listener), with `ReadHeaderTimeout` 10 s, `IdleTimeout` 90 s and `MaxHeaderBytes`
   32 KiB. The handler checks, in order:
   - `r.ProtoMajor==1 && r.ProtoMinor==1`. HTTP/1.0 or a `PRI * HTTP/2.0` preface gets 505.
   - `r.RequestURI` starts with `/` (origin-form only; absolute-form and `*` get 400).
   - `normalize(r.Host)` (`:443` stripped, any other port refused) **equals** the CONNECT host,
     or 421 Misdirected Request (`host_mismatch`). This is the domain-fronting check, and it runs
     on every request on the connection.
   - The allowlist is checked again for the **current** phase (phases change mid-connection).
   - `Upgrade` or `Connection: upgrade` gets 403 (no WebSocket or h2c tunnels; D7).
   - Registry rules (§2.8) if the host is a registry host.
   - Request-body limit (§2.7), then log admission (§2.6).
7. **Forward** with `httputil.ReverseProxy`, one per port so upstream connections are never
   reused across users. `Rewrite` sets `Out.URL.Scheme="https"`,
   `Out.URL.Host=Out.Host=<CONNECT host>` from the connection state, **never from `r.Host`**.
   `Proxy-Authorization` and `Proxy-Connection` are dropped, and no `X-Forwarded-*` headers are
   added (`SetXForwarded` is not called). `FlushInterval: -1` passes SSE streams through.
   `ErrorHandler` answers 502 and logs. 3xx responses go back to the client unchanged; the
   proxy never follows redirects, so a redirect to another host needs its own allowed CONNECT.
8. **Upstream transport** (`http.Transport`, one per port):
   - `Proxy: nil`. It must never read `HTTPS_PROXY` from the environment; a unit test asserts
     this.
   - `ForceAttemptHTTP2: false`, `DisableCompression: true`, `TLSHandshakeTimeout` 10 s,
     `ResponseHeaderTimeout` 300 s (model streams can be slow to start), `IdleConnTimeout` 90 s,
     `MaxConnsPerHost` 64.
   - `TLSClientConfig{ServerName: host, MinVersion: TLS12}` with `RootCAs` nil, which means the
     system roots.
   - `DialContext` resolves the name **with the proxy's own resolver** (§2.9), drops every
     address in the blocked ranges (§3.2; the same list as nftables, one Go source), and dials
     the remaining addresses in order with a 10 s timeout. A `net.Dialer.Control` hook re-checks
     the exact address being connected. No address left → 502 `resolved_blocked`.
   - The dial address comes only from the proxy's own resolution of the CONNECT host.
9. **Phase change** (§2.4): after the new phase is applied, every open client connection whose
   (port, host) is no longer allowed is closed before `phase_ok` is sent.

### 2.4 Phases and the control protocol v1 (fd 7)
Newline-delimited JSON, at most 4 KiB per line, unknown fields refused.
- proxy → root, once, after every start-up check and the CA: `{"type":"ready","version":1,"ca_cert_pem":"…"}`.
- root → proxy: `{"type":"phase","phase":"clone"|"agent"|"report"|"closed"}` → proxy replies
  `{"type":"phase_ok","phase":"…","closed_connections":n}` or
  `{"type":"error","reason":"…"}`. Phases only move forward: `none → clone → agent → report →
  closed`. Skipping a phase is allowed (e.g. `none → agent`). Going back is refused. In `none`
  and `closed` every request is refused.
- root → proxy: `{"type":"stats"}` → `{"type":"stats","requests":n,"refused":n,"registry_requests":n,"log_bytes":n,"log_full":bool}`
  (the platform's summary metadata wants the request count).
- EOF on fd 7 (the entrypoint died or closed it) → the proxy stops accepting, closes every
  connection and exits 0. Any malformed control line → exit 2. Exits are how the entrypoint's
  supervision (`proxy_failed`) sees problems.

The phase state lives in `internal/phase`: pure, a mutex around one value, with transition rules
that can be unit-tested.

### 2.5 Hostname normalisation (`internal/hostname`)
One function is used for the config, CONNECT, SNI and `Host`. It lowercases ASCII and refuses: an
empty name, non-ASCII (IDNs must arrive as punycode), a trailing dot, IP literals (v4 and v6),
any label longer than 63 bytes, a total longer than 253 bytes, and characters outside
`[a-z0-9.-]`. Hosts then compare by exact string equality. There are no wildcards anywhere.

### 2.6 Request log (`internal/reqlog`), fails closed
- JSONL, **log format v1** (documented in the README as a contract), one object per line:
  `{"v":1,"ts":"<RFC3339 UTC ms>","phase":"agent","user":"tool","port":82,"method":"GET","host":"registry.npmjs.org","path":"<≤256 B>","status":200,"req_bytes":0,"resp_bytes":1234,"reason":"<enum, refusals only>"}`.
  Headers and bodies are never logged. `path` is the raw request target without the query (the
  query is never logged either), cut to 256 bytes. CONNECT and TLS-stage refusals log
  `method:"CONNECT"`, `path:""` and `status:0` when no HTTP status could be sent.
- **Cap:** `limits.log_max_bytes`, default and hard maximum **10,000,000 bytes** (D8: safe under
  both readings of "10 MB"). Every line has a computable upper bound, `maxLine` (fixed fields plus
  host ≤ 253 plus path ≤ 256 plus JSON escaping ≤ 6× the path, in all under 2 KiB). **Admission
  reserves `maxLine`** before a request is forwarded:
  `written + reserved + maxLine + markerLen ≤ cap`. Otherwise the request is refused with 503 and
  the log is marked full. The line is written when the response ends, and then the unused part of
  the reservation is released. When the log first becomes full, one final
  `{"v":1,"ts":…,"log_full":true}` marker is written into the reserved `markerLen`. From then on
  every CONNECT and every request is refused (503), and nothing more is written. So the file can
  never exceed the cap, even with requests in flight.
- **Write error** on fd 6 (for example ENOSPC) → exit 1 (the entrypoint treats this as
  `proxy_failed`). No request is ever forwarded without a successful reservation.
- One writer mutex; a single `write(2)` per line (`O_APPEND`).

### 2.7 Limits (defaults; the config may lower them, never raise)
| Limit | Value |
|---|---|
| Open client connections, total / per port A, B, R | 512 / 64, 256, 32 (over the limit: accept, then close at once, and log `conn_limit`) |
| CONNECT head read and TLS handshake (client and upstream) | 10 s each |
| Header bytes: CONNECT / inner request | 8 KiB / 32 KiB |
| Client keep-alive idle | 90 s |
| Upstream dial / response header | 10 s / 300 s |
| Stream idle (no bytes either way) | 300 s, then close |
| Request body (non-registry) | 64 MiB (gateway prompts; platform uploads ≤ 20 MB) → 413 |
| Registry requests per job | 20,000 → 429 after |
| Log | 10,000,000 bytes |
| Accept errors (EMFILE) | back off 50 ms, then up to 1 s; never a busy loop |

### 2.8 Registry rules (`internal/registry`)
- The config lists registry hosts, each with a `kind` (`npm`, `pypi`, `crates`, `rubygems`). The
  path shapes are **hard-coded per kind** (spec). D9 flags that ADR 0019 says "platform
  configuration" for the shapes.
- For a registry host, checked in order: method `GET`/`HEAD` (else 405); no `?` in `RequestURI`
  and an empty `RawQuery` (else 403 `query`); `ContentLength==0` and no `Transfer-Encoding`
  (else 403 `body`); `len(RequestURI) ≤ 1024` (else 414); no `..` or `//` segment, and no `%`
  except the npm scope `%2f`/`%2F` (else 403 `path`); the path matches one of the kind's shapes
  (else 403 `path_shape`); then the global registry counter is incremented, with the 20,001st
  request refused (429 `registry_cap`).
- The first shapes (regex over the raw path; name = `[A-Za-z0-9._~-]{1,214}`; the implementer
  writes table tests with real paths for each):
  - **npm:** `/<name>`, `/@<scope>/<name>`, `/@<scope>%2f<name>`, `/<name>/-/<file>.tgz`,
    `/@<scope>/<name>/-/<file>.tgz`.
  - **pypi:** `/simple/`, `/simple/<name>/`, `/pypi/<name>/json`, `/pypi/<name>/<ver>/json`,
    `/packages/<a>/<b>/<hash…>/<file>` and the `.metadata` variant (a files host).
  - **crates:** `/config.json`, `/1/<n>`, `/2/<n>`, `/3/<c>/<n>`, `/<ab>/<cd>/<n>` (sparse
    index), `/crates/<n>/<n>-<ver>.crate` (static host), `/api/v1/crates/<n>/<ver>/download`.
  - **rubygems:** `/versions`, `/info/<n>`, `/names`, `/gems/<file>.gem`,
    `/quick/Marshal.4.8/<file>.gemspec.rz`, `/specs.4.8.gz`, `/latest_specs.4.8.gz`,
    `/prerelease_specs.4.8.gz`.
  - Refused on purpose: npm's `POST /-/npm/v1/security/*` (audit), and anything else. The image
    sets `NPM_CONFIG_AUDIT=false` (§6).
- Real-client confirmation (does `npm install`, `pip install`, `cargo fetch`, `bundle install`
  work through these shapes?) is **empirical, in piece D**. It can't be proven here without
  internet access.

### 2.9 Resolver
`net.Resolver{PreferGo: true, Dial: …}` dials **only** the config's `resolvers` (IP literal plus
port; for Fly this is expected to be `[fdaa::3]:53`, **to be verified empirically**). It never
reads `/etc/resolv.conf`, so the nftables DNS exception and the proxy use the same list. It does
A and AAAA lookups with a 5 s timeout. The build uses `CGO_ENABLED=0`, so the pure-Go resolver is
the only one.

## 3. nftables ruleset (`internal/netrules`, `kete-egress nft --config <path|->`)

### 3.1 Contract
`kete-egress nft` prints one complete ruleset to stdout and changes nothing itself. The entrypoint
runs `kete-egress nft --config cfg.json | nft -f -` as root, **before** starting any job user's
process and before `claim`, then checks the result with `nft list table inet kete_egress`. Any
non-zero exit means abort. The output starts with `table inet kete_egress` and
`delete table inet kete_egress`, then the full table, so a single atomic `nft -f` both installs
and re-installs it. It uses the `nft` CLI rather than a netlink library: no new dependency, text
that can be golden-tested and read in review. The image needs the `nftables` package (piece D).

### 3.2 Rules
- Blocked destinations (for the proxy's port-443 traffic; also used by the Go dialer, one source
  of truth):
  - v4: `0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
    192.0.0.0/24, 192.168.0.0/16, 198.18.0.0/15, 224.0.0.0/3`.
  - v6: `::/128, ::1/128, ::ffff:0:0/96, 64:ff9b::/96, 64:ff9b:1::/48, 100::/64, fc00::/7`
    (covers Fly's `fdaa::/16`), `fe80::/10, ff00::/8`.
  - The documentation ranges `198.51.100.0/24` and `2001:db8::/32` are **not** blocked (they
    aren't routable), and the integration test uses them. So there is **no test-only switch** in
    production code.
- `table inet kete_egress`:
  - `chain output` — `type filter hook output priority -155; policy drop;` The priority is after
    conntrack (−200) and **before any dstnat (−100)**, so a rule sees the destination the process
    actually asked for, and no NAT rule can make a forbidden destination look allowed.
    1. `ct state established,related accept`
    2. `ct state invalid drop`
    3. `icmpv6 type { nd-neighbor-solicit, nd-neighbor-advert, nd-router-solicit, mld2-listener-report } accept`
       (kernel-generated with no socket, so no `skuid`; without this IPv6 breaks for the proxy)
    4. `meta skuid <proxy> jump proxy_out` · `meta skuid <kete> jump kete_out` ·
       `meta skuid <tool> jump tool_out` · `meta skuid 0 jump root_out` (then the policy drops
       it)
  - `chain proxy_out` — DNS to exactly the configured resolvers:
    `ip daddr { <v4 resolvers> } meta l4proto { udp, tcp } th dport 53 accept` (and `ip6` for
    v6 resolvers; each set is emitted only if it isn't empty). **This comes before** the blocked
    sets, because Fly's resolver sits inside `fdaa::/16`. Then `ip daddr @blocked_v4 drop`,
    `ip6 daddr @blocked_v6 drop`, `tcp dport 443 accept`.
  - `chain kete_out` — `ip daddr 127.0.0.1 tcp dport <A> accept`
  - `chain tool_out` — `ip daddr 127.0.0.1 tcp dport <B> accept`;
    `ip daddr 127.0.0.0/8 meta l4proto { tcp, udp } th dport >= 1024 accept`;
    `ip6 daddr ::1 meta l4proto { tcp, udp } th dport >= 1024 accept` (its own listeners, such
    as test servers; UDP included for local test tooling: D7)
  - `chain root_out` — `ip daddr 127.0.0.1 tcp dport <R> accept`
  - `chain input` — `type filter hook input priority filter; policy drop;`
    `ct state established,related accept`, `ct state invalid drop`, `iifname "lo" accept`,
    ICMPv6 ND/RA/packet-too-big accept. (Nothing binds a non-loopback address, but a tool could
    try, so inbound is closed as well.)
  - `chain forward` — `policy drop`.
- Other tables can't weaken this: in nftables a drop in any base chain is final.
- Config validation refuses: identical uids, uid 0 for a job user, ports that aren't distinct or
  aren't in 1-1023, and a resolver that isn't an IP literal plus port or that is loopback,
  unspecified or multicast. A private resolver address (Fly's `fdaa::3`) is allowed. The
  exception is explicit, limited to port 53 and the proxy uid, and each resolver is listed in the
  generated rule.
- Out of scope, noted for piece C: `user.max_user_namespaces=0` (a new netns has no route out
  anyway), `/proc` `hidepid=2`, and setting `oom_score_adj`.

## 4. Configuration contract (`kete-egress` config v1; README "Configuration")
One JSON file for both subcommands; unknown fields are refused (`DisallowUnknownFields`), and any
invalid value exits 2 with a one-line reason.
```json
{
  "version": 1,
  "uids": { "proxy": 990, "kete": 991, "tool": 992 },
  "ports": { "kete": 81, "tool": 82, "root": 83 },
  "resolvers": ["[fdaa::3]:53"],
  "phases": {
    "clone":  { "kete": [], "tool": [], "root": ["github.com", "api.github.com", "<platform host>"] },
    "agent":  { "kete": ["<gateway host>", "<platform host>"], "tool": ["registry.npmjs.org", "…"], "root": ["<platform host>"] },
    "report": { "kete": [], "tool": [], "root": ["<platform host>", "<storage host>"] }
  },
  "registries": [ { "host": "registry.npmjs.org", "kind": "npm" } ],
  "limits": { "registry_requests": 20000, "log_max_bytes": 10000000 }
}
```
The values above are examples only. Every host comes from the entrypoint (`claim` gives the
gateway, platform and storage hosts), and nothing is hard-coded. `limits` is optional and may only
lower the defaults in §2.7. A registry host is subject to registry rules on every port where it's
allowed. The README carries the full field table, the fd table (§2.1), control protocol v1
(§2.4), log format v1 (§2.6), exit codes (0 control closed; 1 runtime failure: log write,
listener; 2 start-up or config refusal) and the version rules (a new field means `version` 2).

## 5. Tests

### 5.1 Go unit tests (no root; macOS via Docker)
`internal/hostname` (the normalisation table), `internal/config` (every refusal),
`internal/phase` (transitions, backward refused), `internal/policy` (the allowlist per
phase × port), `internal/registry` (per-kind shape tables with real paths, method, query, body,
the 1 KiB boundary at 1024 and 1025, the cap at N and N+1), `internal/reqlog` (the cap is never
exceeded under concurrent reservations with `-race`, the marker, full → refuse, a write error is
fatal; a fake writer), `internal/ca` (the leaf verifies against the CA for its host only; name
constraints refuse an unlisted host; key usages), `internal/netrules` (golden files in
`testdata/`, IPv4-only, IPv6 and mixed resolvers), `internal/peeruid` (`/proc/net/tcp{,6}`
parsing from fixtures), and `internal/proxy` over loopback on unprivileged ports, with injected
test upstream roots and resolver (package-internal constructor options; `main` never sets them):
CONNECT refusals, SNI ≠ CONNECT, Host ≠ CONNECT on the second request of a keep-alive connection,
absolute-form, h2 preface, Upgrade, the forwarded Host always being the CONNECT host, phase change
closing connections, and `Transport.Proxy == nil` even with `HTTPS_PROXY` set.

### 5.2 Privileged integration suite (`internal/itest`, `//go:build integration && linux`)
`scripts/integration.sh` (root only; the pattern is the root helper's script):
1. Installs `nftables iproute2 curl util-linux` with apt **only if missing**.
2. Builds `CGO_ENABLED=0 go build -o $WORK/kete-egress ./cmd/kete-egress` and
   `go test -c -tags integration -o $WORK/itest.test ./internal/itest` (`$WORK=/tmp/kete-egress-it`,
   mode 0755 so the job users can execute the test binary's client re-exec).
3. Creates the users `kete-it-proxy`, `kete-it-kete` and `kete-it-tool` (`useradd -M -r`), and
   passes their numeric ids in `EGRESS_IT_*` env.
4. `exec unshare --net --fork -- bash -c '…'`, **a fresh network namespace**, so the rules never
   touch Docker's or the CI runner's network (on a runner, an output-drop policy in the host
   namespace would cut the runner off) and Docker's DNS NAT can't interfere. Inside it:
   `ip link set lo up`; `sysctl -w net.ipv6.conf.all.disable_ipv6=0`; a dummy interface `eg0`
   with `198.51.100.10/32`, `198.51.100.11/32`, `198.51.100.53/32`, `2001:db8::10/128 nodad`,
   and the blocked "bait" addresses `169.254.169.254/32`, `10.9.9.9/32`, `fdaa::3/128 nodad`;
   then it runs `$WORK/itest.test -test.v "$@"`.

The test process (root) plays the entrypoint and the internet:
- A **test CA** issues upstream certificates for `gateway.test`, `platform.test`, `storage.test`,
  `github.test`, `registry.npm.test` (kind npm), `front.test`, `evil.test` and `v6only.test`.
  The fake HTTPS upstreams (as root) listen on `198.51.100.10:443`, `198.51.100.11:443` and
  `[2001:db8::10]:443` and echo back as JSON the SNI, `Host`, method, path and body length they
  saw. `front.test` and `evil.test` share `198.51.100.11` (a CDN front). Bait listeners run on
  every blocked address on port 443.
- A **fake DNS server** on `198.51.100.53:53` (UDP and TCP) built with
  `golang.org/x/net/dns/dnsmessage` (a test-only dependency). It maps each name above, plus
  `internal.test → 10.9.9.9` and `v6only.test → 2001:db8::10` (AAAA only).
- It applies the rules exactly as the entrypoint will: `kete-egress nft --config … | nft -f -`.
- It launches the proxy exactly per the §2.1 contract: `exec.Cmd` with `ExtraFiles`,
  `SysProcAttr.Credential` for the proxy uid with `Groups: []`, and
  `SSL_CERT_FILE=<test CA>` (this is how the test makes the proxy trust its upstreams; the
  production code has no test hook). It reads `ready` and writes the proxy CA for the clients.
- **Clients as real users:** the test binary re-execs itself (`EGRESS_IT_CLIENT=<json>`) with
  `Credential` set to the kete, tool, root or proxy uid. Each run is one scenario (plain `curl`
  with `--proxy`, `--cacert <proxy CA>`; a Go `net/http` client; or a raw CONNECT plus
  `tls.Client` for adversarial cases) and prints a JSON result: status, error string, errno.

| Case (spec AC) | Expectation |
|---|---|
| AC1, per phase × port: clone/root → `github.test`; agent/kete → `gateway.test`, `platform.test`; agent/tool → `registry.npm.test` GET metadata and a tarball; agent/root → `platform.test`; report/root → `storage.test` PUT with a body; `v6only.test` (IPv6 upstream) | 200 via `curl` (OpenSSL) **and** the Go client; the upstream echo shows Host = SNI = the name; the curl trust is the proxy CA only |
| AC1 negative control: a proxy with no `SSL_CERT_FILE` (system roots only) | 502: upstream verification actually happens |
| AC2 host not allowed: agent/kete → `github.test`; clone/kete → anything; agent/tool → `gateway.test`; `none` phase | 403 |
| AC2 phase switch: a root keep-alive connection to `github.test` in clone, then phase → agent | the connection is closed; a new CONNECT gets 403; `phase_ok.closed_connections ≥ 1`; going back to clone is refused |
| AC2 SNI ≠ CONNECT; no SNI | TLS handshake fails |
| AC2 domain fronting: CONNECT `front.test`, SNI `front.test`, `Host: evil.test` (both allowed, same IP) | 421; the upstream never receives `evil.test` |
| AC2 Host differing on the 2nd request of a keep-alive connection | 421 |
| AC2 registry: POST, `?x=1`, bare `?`, GET with a body, path 1025 B (1024 passes), an unknown shape, `..` | 405 / 403 / 403 / 403 / 414 / 403 / 403 |
| AC2 cap: a proxy with `registry_requests: 5` | requests 1-5 pass, the 6th gets 429 |
| AC2/AC4 log full: `log_max_bytes: 4096` | requests pass until full, then 503 for CONNECT and in-connection requests; the file is ≤ 4096 B and ends with `log_full` |
| AC4 log content | a line per request (and per refusal); a request carrying a secret header, a body marker and a query marker → none of the three appears in the file; `path` ≤ 256 B; mode 0600 and root-owned; the kete and tool users get EACCES opening it |
| resolved to a blocked address: allowed `internal.test` → 10.9.9.9 | 502 `resolved_blocked`; the bait listener gets nothing |
| AC3 wrong port: kete → B and R; tool → A and R; root → A and B | `connect` fails (EPERM) |
| AC3 tool's own listener: tool → `127.0.0.1:18080` and `[::1]:18080` (a tool-uid listener); kete → the same | tool connects; kete gets EPERM |
| AC3 direct bypass: kete, tool, root → `198.51.100.10:443` and `[2001:db8::10]:443` | EPERM |
| AC3 DNS: kete, tool, root → `198.51.100.53:53` UDP and TCP | fail; proxy uid → answers |
| AC3 metadata and private ranges: proxy uid → `169.254.169.254:443`, `10.9.9.9:443`, `[fdaa::3]:443` | EPERM; the proxy uid → `198.51.100.10:443` connects (control) |
| D5 peer-uid check: rules **not** loaded, kete-uid client → port B | the proxy refuses (`peer_uid`) |
| start-up refusals: run as root; a wrong fd; a non-append log | exit 2 |

### 5.3 Commands
- Local (Colima; confirm `docker info` works; cgroup v2 isn't needed here):
  `docker run --rm --privileged -v "$PWD/packages/kete-egress:/src" -w /src golang:1.26-bookworm bash scripts/integration.sh`
  (append `-test.run <Name>` for a subset). AC5 needs **3 consecutive full passes.**
- CI: a new `.github/workflows/kete-egress.yml`, a copy of `kete-root-helper.yml`'s structure
  (the same pinned `actions/checkout` and `actions/setup-go` SHAs, concurrency, `permissions:
  contents: read`, `timeout-minutes: 10`). Paths: `packages/kete-egress/**` and the workflow
  itself; `workflow_dispatch`. Steps: `test -z "$(gofmt -l .)"`, `go vet ./...`,
  `go vet -tags integration ./...`, `go test -race ./...`, then
  `sudo env "PATH=$PATH" bash scripts/integration.sh` (safe on the runner thanks to
  `unshare --net`). No bun step. Expected ~2-4 min.

### 5.4 Must be verified empirically (record the results in handoff.md)
1. `nft` with `meta skuid`, `th dport`, `ct state`, and hook priority −155 works in Colima's kernel
   and on `ubuntu-latest` (this task's suites prove both).
2. **Fly Machines' guest kernel has `nf_tables` and IPv6 egress, and the resolver is
   `fdaa::3`.** This can't be checked here; it's for pieces C and D's first real machine (the ADR
   says so).
3. Name-constrained CA acceptance: curl/OpenSSL and Go are covered here. **Bun (kete's own
   fetch), Node/npm, Python/pip, git (Debian's libcurl-gnutls) and cargo** go to piece D's image
   smoke test. If any of them rejects the constraint, D4 falls back to no constraints (a
   one-line change).
4. Real package managers against the path shapes (piece D).
5. That Bun honours `HTTPS_PROXY` and `NODE_EXTRA_CA_CERTS` for kete's gateway calls (piece A
   or D).

## 6. CA and proxy environment for the image (README "Clients"; piece D sets them)
The entrypoint writes the `ready` CA PEM to `/run/kete-egress/ca.pem` (0644, root) and adds it
to the Debian store (`/usr/local/share/ca-certificates/kete-egress.crt` + `update-ca-certificates`)
so clients that use defaults trust it. Clients only ever reach the proxy, so the *replace*-style
variables can point at the per-VM CA alone:

| Client | Variable(s) |
|---|---|
| everything (proxy) | `HTTPS_PROXY`/`https_proxy` = `http://127.0.0.1:<port for that user>`; `HTTP_PROXY`/`http_proxy` the same (plain HTTP is refused anyway); `NO_PROXY` unset |
| Node, npm, yarn, pnpm, **Bun (kete)** | `NODE_EXTRA_CA_CERTS=/run/kete-egress/ca.pem`; npm `NPM_CONFIG_CAFILE=…ca.pem`, `NPM_CONFIG_AUDIT=false`, `NPM_CONFIG_FUND=false`, `NPM_CONFIG_UPDATE_NOTIFIER=false` |
| pip, requests, uv | `PIP_CERT`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE` (uv also `UV_NATIVE_TLS=1`) |
| cargo | `CARGO_HTTP_CAINFO`; `CARGO_HTTP_PROXY` optional (cargo reads `HTTPS_PROXY`) |
| go | `SSL_CERT_FILE` (the module proxy stays off: ADR, later opt-in) |
| git | `GIT_SSL_CAINFO` |
| curl | `CURL_CA_BUNDLE` |
| Ruby, gem, bundler | `SSL_CERT_FILE` |
| OpenSSL defaults | the Debian store update above |

## 7. Upstream edits
**None.** Every path is Kete-owned (`packages/kete-egress/**`, `.github/workflows/kete-egress.yml`,
this task folder). The new package has no `package.json`, so it isn't a bun workspace and nothing
in turbo, lint or typecheck changes. Note: `kete-build.yml` ignores only `**/*.md` and `docs/**`,
so a Go change also triggers the normal build workflow, the same as the root helper today
(accepted).

## Files
The implementer reads **only** these.

| File | Read / change | Why |
|---|---|---|
| docs/tasks/2026-09-30-job-egress/spec.md, plan.md, handoff.md | read (+ append to handoff) | scope, design, the log of deviations and empirical results |
| docs/context/commands.md (Go root-helper section) | read | the Docker command pattern |
| docs/context/pitfalls.md | read | the rules |
| packages/kete-root-helper/go.mod, .gitignore | read | the pin and dependency version to copy |
| packages/kete-root-helper/cmd/kete-root-helper/main.go | read | flag parsing and start-up refusal style (exit code plus one-line stderr) |
| packages/kete-root-helper/internal/config/config.go | read | validated-config pattern |
| packages/kete-root-helper/scripts/integration.sh | read | the root-only setup script pattern (users, build, run) |
| packages/kete-root-helper/internal/itest/helper_test.go | read | the pattern for integration clients re-exec'd as other uids |
| packages/kete-root-helper/README.md | read | the contract-README structure to mirror |
| .github/workflows/kete-root-helper.yml | read | the workflow to copy (pinned SHAs, concurrency, permissions) |
| packages/kete-egress/go.mod, go.sum, .gitignore | create | the module (`golang.org/x/sys v0.48.0`, `golang.org/x/net` for the test DNS only); `dist/` ignored |
| packages/kete-egress/README.md | create | **the contract**: security model, subcommands, config v1, fd table, control protocol v1, log format v1, exit codes, nftables ruleset and how to apply it, client CA and proxy variables (§6), kernel requirements, how to test |
| packages/kete-egress/cmd/kete-egress/main.go | create | the `serve` and `nft` subcommands |
| packages/kete-egress/internal/config/{config.go,config_test.go} | create | config v1 parse and validate, limits clamping |
| packages/kete-egress/internal/hostname/{hostname.go,hostname_test.go} | create | §2.5 |
| packages/kete-egress/internal/phase/{phase.go,phase_test.go} | create | the phase state and transitions |
| packages/kete-egress/internal/policy/{policy.go,policy_test.go} | create | the allowlist per phase × port; the refusal reason enum |
| packages/kete-egress/internal/registry/{registry.go,registry_test.go} | create | §2.8 shapes and rules, the cap counter |
| packages/kete-egress/internal/reqlog/{reqlog.go,reqlog_test.go} | create | §2.6 capped JSONL with reservations |
| packages/kete-egress/internal/ca/{ca.go,ca_test.go} | create | §2.2 |
| packages/kete-egress/internal/blocked/{blocked.go,blocked_test.go} | create | the blocked v4/v6 prefixes, a single source for nftables and the dialer |
| packages/kete-egress/internal/netrules/{netrules.go,netrules_test.go,testdata/*.nft} | create | §3 generator plus golden files |
| packages/kete-egress/internal/peeruid/{peeruid_linux.go,peeruid_test.go,testdata/*} | create | D5 `/proc/net/tcp{,6}` lookup |
| packages/kete-egress/internal/control/{control.go,control_test.go} | create | the §2.4 line protocol over fd 7 |
| packages/kete-egress/internal/proxy/{proxy.go,connect.go,forward.go,dial.go,limits.go,*_test.go} | create | §2.3 and §2.7; the fd and start-up checks live in `startup_linux.go` |
| packages/kete-egress/internal/itest/{main_test.go,fakes_test.go,client_test.go,scenarios_test.go} | create | §5.2 (build tags `integration && linux`) |
| packages/kete-egress/scripts/integration.sh | create | §5.2 setup plus the `unshare --net` run |
| .github/workflows/kete-egress.yml | create | §5.3 path-filtered CI |

## Steps
1. Scaffold the module: `go.mod` (copy the pin), `.gitignore`, a README skeleton with the
   contract sections from §4. Write the contract first; code follows it.
2. The pure packages with their unit tests: `hostname`, `config`, `phase`, `policy`, `blocked`,
   `registry`, `reqlog`, `ca`, `control`, `peeruid`. Run the unit command after each.
3. `netrules` plus golden files, and the `nft` subcommand.
4. `proxy` (connect → TLS → handler → forward → dial) with in-process unit tests on unprivileged
   ports and injected roots and resolver. Then `startup_linux.go` (the fd checks, uid checks,
   `PR_SET_DUMPABLE`) and the `serve` subcommand.
5. `scripts/integration.sh` and `internal/itest`: every row of the §5.2 table. Run the whole
   suite 3× in Colima.
6. `.github/workflows/kete-egress.yml`; run it by `workflow_dispatch` on the branch and watch it.
7. Finish the README (§6 table, exit codes, kernel requirements, test commands). Append to
   handoff.md the deviations, the empirical results (§5.4 items 1 and 3 partial) and anything not
   run.

## Verification
All from the repo root, narrowest first. "Unit" is
`docker run --rm -v "$PWD/packages/kete-egress:/src" -w /src golang:1.26-bookworm sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go vet -tags integration ./... && go test -race ./...'`.
"Itest" is
`docker run --rm --privileged -v "$PWD/packages/kete-egress:/src" -w /src golang:1.26-bookworm bash scripts/integration.sh`.

| Criterion | Command (narrowest first) |
|---|---|
| AC1 | Unit with `go test -race ./internal/proxy/... ./internal/ca/...`, then Itest `-test.run 'TestAllowed'` |
| AC2 | Unit with `go test ./internal/{policy,registry,hostname,phase,reqlog}/...`, then Itest `-test.run 'TestRefused\|TestPhase\|TestRegistry\|TestLogFull'` |
| AC3 | Unit with `go test ./internal/netrules/...` (golden files), then Itest `-test.run 'TestFirewall'` |
| AC4 | Unit with `go test -race ./internal/reqlog/...`, then Itest `-test.run 'TestLog'` |
| AC5 | Unit (full), then Itest (full) **3 times in a row** locally, then `gh workflow run kete-egress.yml --repo kete-org/ketecode --ref feature/job-egress` and `gh run watch --repo kete-org/ketecode`; then `bun run --cwd packages/kete-tools upstream:check` and `bun run lint` from the root |

## Cards to update after the build
- **New card `docs/context/modules/egress.md`** (paths `packages/kete-egress/**`,
  `.github/workflows/kete-egress.yml`): the contract pointers, D1-D9, the test commands, the
  empirical results, and the gotchas found (netns isolation, ND ICMPv6, the resolver before the
  blocked sets, hook priority).
- `docs/context/INDEX.md`: a card table row. `docs/context/repo-map.md`: the
  `packages/kete-egress/` row, and the workflow row mentioning `kete-egress.yml`.
- `docs/context/commands.md`: a "Go egress proxy" section (the Unit, Itest and CI commands).
- `docs/context/contracts.md`: a new §6c "Egress proxy config, fds, control protocol and log
  format v1 (in-repo contract)" pointing at the README; mention that the log is the platform's
  `.proxy.jsonl` upload.
- `kete-tools-ci` card: the new workflow, and the two go.mod pins to bump together.
- `root-helper` card, Quick answers "What isn't done yet": the egress proxy is now
  `packages/kete-egress/`.

## Decisions for the user
- **D1** A separate module `packages/kete-egress/` with its own workflow (recommended), rather
  than a second binary in `kete-root-helper`. §1 gives the reasons.
- **D2** The proxy never runs as root. The entrypoint binds the three privileged ports, opens the
  root-owned log and a control socketpair, and passes them as fds 3-7. The phase changes only
  through that socketpair, which only root holds. (Alternative: the proxy starts as root and
  drops privileges itself. Rejected: more root code in the proxy.)
- **D3** The CA key lives in memory only, never on disk. The CA PEM goes to root over the control
  channel.
- **D4** The CA carries critical DNS name constraints limited to the allowlisted hosts
  (recommended; this depends on client acceptance, verified in piece D, with a one-line
  fallback).
- **D5** Peer-uid check via `/proc/net/tcp` on each accepted connection, as defence in depth
  under nftables (recommended; fails closed).
- **D6** **HTTP/1.1 only, h2 refused** (ALPN offers only `http/1.1`; a `PRI` preface gets 505).
  Why: every client in scope (npm, pip, cargo, git, curl, Bun's fetch, SSE model streams) works
  over 1.1. Refusing h2 removes the multiplexing, HPACK and flow-control attack surface (rapid
  reset, CONTINUATION floods) from the job's only network boundary. It also leaves exactly one
  authority field per request (`Host`) to check, with no `:authority` versus `Host` ambiguity.
  The upstream side is 1.1 as well. The cost is some throughput on many small registry
  downloads, which is acceptable. Revisit only if a required client proves h2-only.
- **D7** WebSocket and `Upgrade` are refused; the tool user may use loopback UDP ≥ 1024 as well
  as TCP. Say if either should change.
- **D8** "10 MB" means 10,000,000 bytes (safe under both definitions of the platform's 10 MB
  upload limit). The cap and the 20,000 registry-request cap are config values that may only be
  **lowered** (the tests lower them).
- **D9** The spec hard-codes the registry path shapes per registry *kind*, and the config maps
  each host to a kind. ADR 0019 says the shapes are "platform configuration". This plan follows
  the approved spec. If the platform should own the shapes, that's a config v2 field later.
