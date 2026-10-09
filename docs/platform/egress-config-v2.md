<!-- Copied from kete-code-platform docs/contracts/egress-config-v2.md at commit 214e543 (2026-10-09: kete-code's host-boundary and upstream-proxy DNS amendments carried into the platform copy). The platform copy is the source of truth for the v2 rules until packages/kete-egress/README.md takes them over; update both together, and re-copy the test vector into packages/kete-egress/internal/config/testdata/egress-config-v2/ with them. -->

# Egress proxy configuration — v2

The configuration `kete-egress` (kete-code `packages/kete-egress`) reads at start-up, version 2:
version 1 (kete-code `packages/kete-egress/README.md` "Configuration v1", contracts.md §6c) plus what
an enterprise network needs — an **upstream proxy** reached with `CONNECT`, a **CA bundle** for
upstream TLS, and **internal destinations** (private ranges, ports other than 443) allowed by CIDR,
which v1's firewall refuses (enterprise runtime spec §9.2, decision D-M3: outbound HTTPS only,
through enterprise proxies with custom CAs).

**Runtime-side only.** The platform never sends or reads this document: the job entrypoint builds
it from its own configuration (for the `kubevm` profile, the runner's Helm values: `proxy`,
`proxy.caBundleSecret`, the repository registry and model endpoints), never from the platform's
sealed configuration. It is specified here with job-host-v2 (Phase 8 piece P0b) and implemented in
kete-code (P0c), whose README then takes it over as the source of truth. The schema
`packages/shared/src/egress-config-v2.ts` (not exported) checks the v2 rules below and the v1 fields
by shape; the vector `docs/contracts/test-vectors/egress-config-v2/configs.json` lists configurations
an implementation must accept and refuse.

## Example

```json
{
  "version": 2,
  "uids": { "proxy": 990, "kete": 991, "tool": 992 },
  "ports": { "kete": 81, "tool": 82, "root": 83 },
  "resolvers": ["10.96.0.10:53"],
  "phases": {
    "clone": { "root": ["gitlab.corp.example:8443", "portal.kete.example"] },
    "agent": { "kete": ["llm.corp.example", "portal.kete.example"], "tool": ["npm.corp.example:8081"], "root": ["portal.kete.example"] },
    "report": { "root": ["portal.kete.example"] }
  },
  "registries": [{ "host": "npm.corp.example:8081", "kind": "npm" }],
  "upstream": {
    "proxy": "http://10.20.0.5:3128",
    "proxy_auth_file": "/run/kete-egress/proxy-auth",
    "ca_bundle_file": "/run/kete-egress/upstream-ca.pem",
    "direct": ["gitlab.corp.example:8443", "npm.corp.example:8081", "llm.corp.example"]
  },
  "internal": [
    { "cidr": "10.20.0.0/16", "ports": [443, 3128, 8081, 8443] },
    { "cidr": "fd12:3456:789a::/48", "ports": [443] }
  ]
}
```

## What v2 adds

| Field | Meaning | Refused when |
|---|---|---|
| `version` | `2` | anything else (a v1 document stays valid for a v1 proxy; a v2 proxy reads only v2) |
| allowlist entries (`phases.*.*`, `registries[].host`, `upstream.direct`) | a plain DNS host (port 443) or `host:port` | `host:443` (the bare host is the one spelling of 443), a port outside 1–65535 or with a leading zero, an IP address, a non-443 port that no `internal` range lists |
| `upstream.proxy` | `http://host:port` or `https://host:port` (TLS to the proxy, verified); host a DNS name or an IPv4 literal | no port, userinfo, a path or query, another scheme, an invalid address, a port no `internal` range lists (unless 443), an IPv4 literal in a forbidden range (below), or an IPv4 literal in a v1-blocked range (including multicast and reserved) outside every `internal` range |
| `upstream.proxy_auth_file` | path under `/run/` of a file holding `username:password`, sent as `Proxy-Authorization: Basic …` on each `CONNECT`; the entrypoint writes it `0400` for the proxy user | not under `/run/` (the entrypoint's tmpfs: never the image, the workspace or a volume), or with a segment that is empty, `.`, `..` or starts with another character than a letter, digit or `_`. Credentials are never inline (unknown fields are refused) and never logged |
| `upstream.ca_bundle_file` | path under `/run/` of PEM certificates trusted **in addition to** the image's roots to verify upstream servers (and an `https` proxy) — for TLS-intercepting enterprise proxies | as above (under `/run/`). It never becomes the trust store of `kete` or tools (they trust only the per-job CA, as in v1), and verification is never disabled |
| `upstream.direct` | allowlist entries reached without the proxy (exact entries, no suffix matching) | an entry that is in no allowlist, or listed twice |
| `internal[]` | `{ cidr, ports }`: destinations inside `cidr` are allowed — for the proxy user only, on exactly `ports` — although v1 blocks the range | a CIDR not in canonical form (the text must equal its normalization: lowercase, RFC 5952 for IPv6, no host bits), broader than /8 (IPv4) or /32 (IPv6), touching any forbidden range (below), overlapping another entry; no ports, more than 16, or a duplicate; more than 32 entries |

## Forbidden ranges

No internal range may touch these, and the upstream proxy's address may not be in one — whether
written as a literal (refused at start-up) or resolved from its name (refused per connection, like
every destination). A destination address in one of them is refused even when an `internal` range
or v1's public-443 rule would otherwise allow it. They reach the node or the cloud control plane, or
embed an arbitrary IPv4 address:

```text
0.0.0.0/8
127.0.0.0/8
169.254.0.0/16
168.63.129.16/32
100.100.100.200/32
224.0.0.0/4
240.0.0.0/4
::/96
::1/128
::ffff:0:0/96
64:ff9b::/96
64:ff9b:1::/48
2002::/16
fe80::/10
fd00:ec2::254/128
ff00::/8
```

(unspecified and "this network"; loopback; link-local and cloud metadata; Azure WireServer; Alibaba
metadata; multicast; reserved and broadcast; IPv4-compatible IPv6; IPv4-mapped; NAT64 RFC 6052 and
RFC 8215; 6to4; IPv6 link-local; AWS IPv6 metadata; IPv6 multicast). The schema's
`EGRESS_FORBIDDEN_RANGES` is this list, checked by test.

## Behaviour

- **With `upstream`:** every allowed connection (any phase, any port A, B or R) is opened as
  `CONNECT host:port` through the proxy, except `direct` entries, which are dialled as in v1. The
  allowlist, SNI and `Host` checks of v1 are unchanged: the proxy is a transport, never a reason to
  allow a host. A `407` or any non-2xx `CONNECT` answer refuses that connection (logged
  `upstream_proxy` in kete-egress's log, no retry with other credentials).
- **Firewall:** v1's rules stay — TCP 443 to non-blocked addresses only — plus, for the proxy user,
  each `internal` range on exactly its ports, and the upstream proxy's address and port. A `direct`
  or proxied entry whose resolved address is outside every `internal` range is reachable only on
  443; one inside a range only on that range's ports. Resolution happens per connection as in v1
  (no pinning across connections); an address in a forbidden range is refused even if a range
  would cover it — for the upstream proxy's resolved address too.
- **Host boundary** (amended 2026-10-09 from kete-code's implementation, enterprise runtime P2): the
  `kubevm` profile's host-boundary probe runs as **root before the in-guest firewall**, which reaches
  strictly more than any user after it, so a pass also holds after the firewall. It probes cloud
  metadata, the default gateway, private-range samples, IPv6, the Kubernetes API
  (`KUBERNETES_SERVICE_HOST:PORT`, required in a kubevm pod) and every node address, the API and the
  nodes on the gateway sample ports **and on every port an `internal` range lists**; anything
  answering exits before `claim` (`host_boundary`). It retries for up to 30 s (a NetworkPolicy may be
  enforced after the pod starts) and passes only after two consecutive clean rounds. The runner also
  refuses internal ranges containing the Kubernetes API's address, the node's addresses or the
  node's pod range. An internal range therefore can't open the cluster to a job.
- **DNS with an upstream proxy** (amended 2026-10-09 from kete-code's implementation): a proxied
  connection is opened as `CONNECT host:port` **by name**, so the enterprise proxy resolves the
  destination itself. kete-egress resolves and checks the name too (forbidden, internal, blocked
  rules) and refuses it if no address passes, but the address the proxy finally connects to is the
  proxy's choice: with an upstream proxy, forbidden-range enforcement on the final destination
  depends on the enterprise proxy's resolution and policy. (`CONNECT` to the validated address is a
  possible later option; it is not in v2.) A `407` stops every upstream connection for a minute (no
  credential lock-out by retries); a `CONNECT` answer's head is read through a 16 KiB limit and a 2xx
  answer's body is never read.
- **Logging:** proxy credentials and the CA bundle's contents are never logged. How the request log
  records proxied connections and refused `CONNECT`s is kete-egress's log format (P0c); a change
  there bumps the log's own `v`.
- **Clients** (`kete`, tools) are unchanged: they still see only `HTTPS_PROXY=http://127.0.0.1:<port>`
  and the per-job CA. The upstream proxy is invisible to them.

## Not in v2

Suffix or wildcard hosts, `NO_PROXY`-style patterns, SOCKS, proxy auto-configuration (PAC),
NTLM/Kerberos proxy authentication, plain-HTTP destinations, and air-gapped installs (spec D-M3).
