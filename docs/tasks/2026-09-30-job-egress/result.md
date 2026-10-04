# Result: Cloud job egress: nftables rules and the TLS-terminating proxy (ADR 0019 rule 4)

## What changed
- `packages/kete-egress/` (Go 1.26): the egress proxy — runs as its own unprivileged user (start-up identity checks: uids, gids, no groups, `no_new_privs`, no capabilities); receives its three loopback ports, log and a root-only control socket as fds from the entrypoint; per-phase (clone → agent → report, forward-only) exact-host allowlists per port; the tool user only reaches package registries, only in the agent phase; TLS terminated with a per-VM, name-constrained CA (key in memory only); CONNECT = SNI = `Host` on every request; HTTP/1.1 only (h2, Upgrade refused); upstreams dialled by its own resolution, blocked ranges checked on resolved addresses, verified against the system roots only; a kernel socket-table uid check (D5); registry rules built in, config can only narrow (D9); a JSONL log capped at 10,000,000 bytes that fails closed, with the last tenth reserved for root and rate-limited refusals (first per host always logged). `kete-egress nft` generates the nftables ruleset (per-uid output allowlists, fast reject for blocked traffic, IPv4 and IPv6, input/forward drop). README is the contract.
- `.github/workflows/kete-egress.yml`: path-filtered unit and privileged integration runs.
- No upstream files touched.

## Checks
| Check | Result |
|---|---|
| gofmt, `go vet` (+integration tag), `go test -race ./...` | 12 packages ok (coordinator re-run) |
| `go test -race -count=20/50` on proxy and reqlog | ok |
| `nft -c -f` on the golden rulesets | ok |
| Integration suite, local privileged container | 17/17 (coordinator re-run; builder ×3) |
| `kete-egress.yml` on `ubuntu-latest` | PASS, 17/17 (first run, PR #60) |
| lint, `upstream:check` | PASS |

Security review: round 1 changes needed (3 major: unconstrained tool allowlist, proxy could trust its own CA upstream, flaky test; 8 minor) → all fixed → round 2 approve with 5 minor follow-ups → all applied.

## Acceptance criteria
- [x] AC1 — `TestAllowed` (each phase and port, TLS via the job CA, upstream verified).
- [x] AC2 — `TestRefusedHostNotAllowed`, `TestRefusedSNI`, `TestRefusedHostMismatch`, `TestRegistry`, `TestRegistryCap`, `TestLogFull`, `TestResolvedBlocked`.
- [x] AC3 — `TestFirewall` (per user incl. an unlisted user, direct v4/v6, DNS incl. `fdaa::3`, fast refusal).
- [x] AC4 — `TestLogContent`, `TestLogFull`, reqlog unit tests.
- [x] AC5 — the checks table.

## User decisions
D4 name-constrained CA (fallback: drop the constraint if a client rejects it); D5 kernel uid check; D9 built-in registry rules that config can only narrow; blocked outbound fails fast (reject); D7/D8 plan defaults.

## Open (pieces C and D)
- Piece C: nftables on Fly Machines' kernel; Fly's resolver address; NAT64 (`64:ff9b::/96`, currently blocked).
- Piece D: CA acceptance by Bun, Node, pip, git and cargo; real package managers against the path shapes.

## Cards updated
New `egress` card (INDEX); repo-map, commands, contracts §6c, kete-tools-ci, root-helper, job-mode (the A–D split).

## Metrics
- Agents used: planner, implementer (no shell — stopped), general-purpose builder, reviewer ×2, librarian
- Scout lookups: shared with the image umbrella (Q3)
- Tokens / cost (from /usage): ~1.6M subagent tokens
- Time: ~6 h
