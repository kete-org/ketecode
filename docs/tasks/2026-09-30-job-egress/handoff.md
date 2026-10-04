# Handoff: Cloud job egress: nftables rules and the TLS-terminating proxy (ADR 0019 rule 4)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-09-30 coordinator

- spec.md approved by the user (2026-09-30). Context: shared scout notes in docs/tasks/2026-09-30-job-image/handoff.md (Q3 egress). No Go on the Mac; use Docker/Colima (golang:1.26-bookworm, privileged, cgroupns private) as for the root helper. Subagents have sometimes lost their shell mid-task: if yours does, stop and report rather than writing unrun code as done.

## 2026-09-30 planner

- Done: plan.md written (D1-D9 need the user's approval; security change, new in-repo contract; no upstream edits). Cards root-helper, job-mode and kete-tools-ci were current (`stale-cards.mjs`: all current).
- Docs enough: no — missing: the egress requirements (ADR 0019 rule 4: ports A/B/R, phase table, registry limits, the 10 MB log) and the proxy-log upload shape (`job-audit/<org>/<job>.proxy.jsonl`, ndjson) aren't mirrored in kete-code (contracts.md §6 or docs/platform); I read kete-code-platform `docs/adr/0019-container-host-fly-machines.md` and `docs/jobs.md` §7-8 and the callbacks table.
- Docs enough: no — missing: whether a Go-only package under `packages/` is picked up as a bun workspace, and whether it triggers `kete-build.yml`; I checked root `package.json` (workspaces `packages/*`, but a folder without `package.json` isn't a workspace) and `kete-build.yml` (`paths-ignore` covers only `**/*.md` and `docs/**`, so Go changes trigger it, as for the root helper).
- Docs enough: no — missing: the integration-script details the plan's implementer must copy (apt-free `golang:1.26-bookworm` has no `nft`/`ip`; how the helper's script creates users and passes uids); I read `packages/kete-root-helper/scripts/integration.sh`, `go.mod`, `.gitignore`, `README.md` headings and `.github/workflows/kete-root-helper.yml`.
- Risks noted in the plan: CI would cut off the runner if rules were applied in the host netns (the plan runs the suite under `unshare --net`); Docker's DNS DNAT could fake a DNS pass (hook priority −155 before dstnat, plus the netns); IPv6 needs ICMPv6 ND accepted; Fly's resolver (`fdaa::3`, inside the blocked `fc00::/7`) needs the explicit DNS exception first. Fly kernel nf_tables and client acceptance of the name-constrained CA remain empirical (pieces C and D).

## 2026-09-30 coordinator

- plan.md approved by the user (2026-09-30): D4 CA name constraints on the allowed hosts, with a one-line fallback if a client rejects it; D5 yes, check each connection's uid in the kernel socket table as well as nftables; D9 CHANGED from the plan: registry path rules are built-in defaults that the platform configuration can only narrow (remove registries or tighten shapes), never widen; D7 and D8 at the plan defaults.

## 2026-09-30 implementer (blocked, no shell tool)

- Read plan.md, handoff.md, then exactly the files plan.md's "Files" table marks "read": docs/context/commands.md, docs/context/pitfalls.md, packages/kete-root-helper/{go.mod,.gitignore,cmd/kete-root-helper/main.go,internal/config/config.go,scripts/integration.sh,internal/itest/helper_test.go,README.md}, .github/workflows/kete-root-helper.yml. All read successfully; no discrepancies found in the plan from this reading — it accurately describes the root-helper patterns to mirror (Docker-only Go workflow, config.Parse style, integration.sh structure with unshare-based isolation being the egress-specific addition, itest re-exec-as-uid pattern, contract-README shape, pinned-SHA workflow).
- **Did not write any code.** My tool set for this invocation was `Read, Edit, Write, Grep, Glob, SubagentHandback` — **no Bash/shell tool was available at any point**, including at the very start of the task. The task's own instructions are explicit: "If your shell/Bash tool is unavailable or disappears at any point, STOP immediately and report exactly what is written but unrun — never describe unrun tests as passing." Every step in the plan (scaffolding `go.mod`, writing ~20 Go packages, generating nftables golden files, building and running the privileged integration suite 3×, the CI workflow, `bun run lint`, `bun run --cwd packages/kete-tools upstream:check`) requires running commands (`docker run …`, `gofmt`, `go vet`, `go test`, `bun run …`) after each step per CLAUDE.md §12 and the plan's "Verification" table. With no shell access I cannot run any of that, and CLAUDE.md's reliability rules (§10: "No hidden failures … Report status truthfully") plus the task's explicit stop condition rule out writing ~20 files of untested Go/TLS/nftables code and presenting it as done or even as a good-faith untested draft — there is no way to check it compiles, let alone passes `go vet`/`gofmt`/tests, and this is explicitly called out as a security-sensitive change (the job's only network boundary).
- **Nothing in `packages/kete-egress/` or `.github/workflows/kete-egress.yml` exists.** No files were created or modified by this session beyond this handoff.md entry.
- Open question for the coordinator: re-dispatch this task to an implementer invocation that actually has a Bash/shell tool (the task description promised Docker/Colima access via shell). If the harness is supposed to grant Bash to implementer subagents and didn't this time, that's the thing to fix before re-running — not a plan defect.

## 2026-09-30 implementer

Done (with a shell; Docker/Colima, `golang:1.26-bookworm`, Go 1.26.8 arm64). Nothing committed, staged or pushed. No upstream file edited.

**Files created**
- `packages/kete-egress/`: `go.mod` (x/sys v0.48.0, x/net v0.59.0 for the test DNS only), `go.sum`, `.gitignore`, `README.md` (the contract: security model, config v1, registry rules, fd table, control protocol v1, log format v1, limits, firewall, client variables, exit codes, kernel requirements, how to test), `cmd/kete-egress/main.go`, `internal/{blocked,ca,config,control,hostname,netrules(+testdata/{v4,v6,mixed}.nft),peeruid(+testdata/{tcp,tcp6}),phase,policy,registry,reqlog}/*`, `internal/proxy/{proxy,connect,forward,dial,limits,startup_linux}.go` + `proxy_test.go`, `internal/itest/{main,fakes,client,proxy,scenarios}_test.go`, `scripts/integration.sh`.
- `.github/workflows/kete-egress.yml` (pinned SHAs copied from `kete-root-helper.yml`).

**D9 (changed by the user): registry rules are built in, config can only narrow**
- Built in (`internal/registry`): the kinds `npm`/`pypi`/`crates`/`rubygems`, each with named path shapes, plus a table of well-known public registry hosts → kind (`registry.npmjs.org`, `registry.yarnpkg.com`, `pypi.org`, `files.pythonhosted.org`, `index.crates.io`, `static.crates.io`, `crates.io`, `rubygems.org`, `index.rubygems.org`). A built-in host allows nothing by itself; whenever one is in an allowlist its kind's rules apply even if `registries` omits it (so omitting it can't free it from registry rules).
- Config field: `registries: [{host, kind, shapes?}]`. It can put another host (mirror, test registry) under a kind's rules, or restrict a host to a subset of its kind's shape names. Removing a registry = leaving it out of every allowlist. `limits.registry_requests` may only be lowered.
- Validation refuses every widening: unknown kind; shape not in the kind (regex, new name, another kind's shape); empty `shapes`; duplicate host/shape; a built-in host declared as another kind; any extra field (methods, max path, query, pattern — `DisallowUnknownFields`). Tests: `registry.TestValidateRefusesWidening`, `config.TestRegistryWideningRefused` (+ narrowing accepted, `TestNarrowedShapes`, `config.TestValid` for the auto-applied built-in).

**Deviations from plan.md (each small; flag if any is unacceptable)**
1. **TCP drops time out, not EPERM.** The plan's §5.2 table expected `connect` → EPERM. With an nftables drop in the output hook the kernel ignores the first SYN's error and retransmits, so TCP `connect()` times out; UDP `sendto` does get EPERM. The ruleset is unchanged (policy drop, as planned); `TestFirewall` accepts "timeout or EPERM" for blocked TCP, requires EPERM for blocked UDP DNS, and every blocked destination has a live listener plus positive controls (own port, proxy → 443 v4/v6), so a failure can only be the firewall. The probes run in parallel (2 s dial timeout) — the test takes ~11 s. If fast failure is wanted, a `reject` rule at the end of each user chain is the option (a design change, not made).
2. **Extra-fd check skips close-on-exec fds.** Go 1.25+'s container-aware GOMAXPROCS keeps `/sys/fs/cgroup/cpu.max` open (as fd 8) before `main` runs, so "any fd above 7" refused every start. `CheckNoExtraFDs` now refuses only fds > 7 *without* `FD_CLOEXEC` (anything that survived execve lacked it; anything with it was opened by this process). The `extra fd 8` start-up refusal test still passes.
3. **Log line bound is 2,560 bytes, not "under 2 KiB".** Worst case (host 253 B never escaped — invalid bytes become `_`; path 256 B JSON-escaped up to 6×; fixed fields ~270 B) exceeds 2 KiB; `MaxLine` = 2560, `MarkerLen` = 128, min `log_max_bytes` 4096. Tested (`TestPathCutAndWorstCaseFits`).
4. **Resolver and `/etc/resolv.conf`:** Go's pure resolver with a custom `Dial` never uses resolv.conf's *nameservers* (every query goes to the configured resolvers), but it still reads resolv.conf *options* and `/etc/hosts` (both root-owned). Names are queried rooted (`host.`) so search lists never apply. Avoiding the read entirely would need our own DNS client (x/net/dnsmessage as a non-test dependency); not done.
5. Go's `http.Server` answers `OPTIONS *` itself; `DisableGeneralOptionsHandler: true` so it reaches the handler (400 `target`). Found by the unit test.
6. Added files not in the plan's list: `internal/itest/proxy_test.go` (the proxy launcher, split from `client_test.go`), `internal/peeruid/peeruid_other.go` (non-Linux stub that fails closed, so the package compiles off Linux).
7. CONNECT carrying a `Host` header that differs from the authority (or two `Host` headers) → 400 `host_mismatch` (the plan didn't give a status). A plain-HTTP (non-CONNECT) request → 405 `unsupported_method`.
8. The "tool's own listener" in `TestFirewall` is a root-owned listener on 127.0.0.1/::1:18080 (the rule doesn't depend on the listener's owner).

**Checks run (real output)**
- Unit, exactly the plan's command (`docker run --rm -v …/kete-egress:/src … sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go vet -tags integration ./... && go test -race ./...'`): exit 0; 12 packages `ok`, `cmd/kete-egress` has no tests; 60 unit test functions.
- Itest, exactly the plan's command (`docker run --rm --privileged … bash scripts/integration.sh`), 3 consecutive runs: run 1 exit 0, 15 PASS / 0 FAIL; run 2 exit 0, 15 PASS / 0 FAIL; run 3 exit 0, 15 PASS / 0 FAIL. The dummy interface worked in Colima (no fallback to `lo`).
- `bun run lint` (root): 0 warnings, 0 errors. `bun run --cwd packages/kete-tools upstream:check`: "upstream checks passed".
- `nft -c -f` on all three golden files and a double apply of `mixed.nft` (re-install idempotent): OK on nftables v1.0.6 (bookworm).

**Empirical results (plan §5.4)**
1. `meta skuid`, `th dport`, `ct state`, interval sets and hook priority −155 work in **Colima's kernel** (the suite applies the real rules). `ubuntu-latest`: **not run** (see below).
3. Name-constrained CA accepted by **curl (OpenSSL, bookworm) and Go** (`TestAllowed` runs both for every allowed case). Bun, Node/npm, Python/pip, git (libcurl-gnutls), cargo: piece D.
2, 4, 5: not checkable here (piece C/D).

**Not run / unverified**
- **CI (AC5 "and in CI")**: the workflow was written but not run — `gh workflow run` needs the branch (and the workflow file) on the remote, and I was told not to commit or push. Run `gh workflow run kete-egress.yml --repo kete-org/ketecode --ref feature/job-egress` after pushing.
- Kernel behaviour on `ubuntu-latest` and on Fly Machines.

**Open questions**
- D-deviation 1 (drop → timeout rather than EPERM for TCP): keep the drop, or add explicit `reject`s for fast failure?
- Cards (librarian): new `egress` card, INDEX/repo-map/commands/contracts rows, `kete-tools-ci` and `root-helper` updates per plan "Cards to update"; add the gotchas above (Go runtime cpu.max fd, `OPTIONS *`, SYN drop = timeout, netns isolation).

## 2026-09-30 implementer (fail-fast follow-up)

User decision (via coordinator): blocked outbound traffic is refused, not silently dropped. Shell available throughout; nothing committed.

- **Ruleset (`internal/netrules/netrules.go`)**: new `chain refuse { meta l4proto tcp reject with tcp reset; reject with icmpx port-unreachable }`. `proxy_out`'s blocked ranges now `jump refuse` (were `drop`); the output chain ends with `jump refuse` after the per-uid jumps, so everything a user chain doesn't accept (other loopback ports, direct outbound, private/metadata ranges, DNS from non-proxy users, any other uid) is refused. `policy drop` stays as a backstop; `ct state invalid drop` unchanged. ICMP port-unreachable (not admin-prohibited) was chosen so UDP callers get `ECONNREFUSED` on both families (admin-prohibited maps to EHOSTUNREACH/EACCES).
- **Input and forward keep policy drop** (not reject): nothing in the job waits on unsolicited inbound traffic, and a reject would only confirm the machine to a remote scanner. The locally generated reset/ICMP reaches the socket as conntrack `related`, so the existing accepts pass it (confirmed empirically — the refusals arrive).
- Goldens regenerated (`testdata/{v4,v6,mixed}.nft`); `netrules_test.go` now asserts the refuse chain, `jump refuse` for the blocked sets, and that the output chain ends in `jump refuse`. README "Security model" and "Firewall" updated (fail fast, why input/forward still drop). The earlier "drop → timeout" note is superseded.
- **TestFirewall**: every blocked TCP probe must fail with `ECONNREFUSED` in < 1 s (`failFast`; the client measures elapsed time), no timeouts accepted; non-proxy DNS must fail with `ECONNREFUSED` (UDP also allows `EPERM`) in < 1 s. The test now takes 0.02-0.03 s (was ~11 s).

**Checks (real output)**
- Unit (the plan's exact command): exit 0, 12 packages ok, 0 FAIL.
- `nft -c -f` on `mixed.nft`, `v4.nft`, `v6.nft` (nftables v1.0.6): all ok; applying `mixed.nft` twice: ok.
- Integration (the plan's exact privileged command), 3 consecutive runs: run 1 exit 0, 15 PASS / 0 FAIL (TestFirewall 0.03 s); run 2 exit 0, 15 PASS / 0 FAIL (0.02 s); run 3 exit 0, 15 PASS / 0 FAIL (0.02 s).
- Root `bun run lint`: 0 warnings, 0 errors. `upstream:check`: passed.
- Still not run: CI (needs a push), `ubuntu-latest` and Fly kernels.

## 2026-09-30 implementer (security-review fixes)

Shell available throughout; nothing committed. Each finding → fix:

1. **Tool user limited to registries in the agent phase** — `config.go`: refuses any `tool` list in clone/report, and any agent `tool` host that isn't a registry (built-in or in `registries[]`). Test: `config.TestToolReachesRegistriesOnly` (4 refusals + a declared mirror accepted). `policy_test` config now declares its registry.
2. **Upstream trust = system roots only** — `main.go` loads `x509.SystemCertPool()` after the fd/identity checks and **before** `ca.New` and `ready`, and passes it as the new required `Deps.UpstreamRoots` (`New` fails without it; `forward.go` uses it explicitly). README "Clients": the job CA goes only into per-client variables (`SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, …), **never** the system store; the Debian-store step is removed. Tests: `TestUpstreamSignedByJobCARefused` (an upstream presenting job-CA certificates, roots loaded as `serve` does → 502 `upstream_error`, nothing reaches it) and `TestNewRequiresUpstreamRoots`.
3. **Log-read race in tests** — `harness.waitLine`/`hasReason` poll the log (3 s deadline); `TestAllowedRequestForwardedToConnectHost` waits for its line; the integration `hasReason` polls too; log-content assertions run after `stop`, which now waits for handlers (4). Proof: `go test -race -count=50 ./internal/proxy/` → `ok` (100.2 s).
4. **Close waits for in-flight handlers** — `Proxy.handlers` WaitGroup; `Close` stops the accept loops, closes connections, then waits up to 5 s so every in-flight line (and the final marker) is written before exit 0.
5. **CA subdomains** — `ExcludedDNSDomains` gets `.host` for every host with no allowlisted descendant; a host with one (github.com + api.github.com) keeps its other subdomains permitted, since excluding them would exclude the descendant (documented in the code and README). Test: `ca.TestSubdomainsExcluded`. The integration suite shows curl/OpenSSL and Go accept the CA with the exclusions.
6. `SessionTicketsDisabled: true` on the client-facing TLS config.
7. **Identity check** — `CheckUID` → `CheckIdentity`: `/proc/self/status` must show all four uids = proxy uid, no gid 0, no supplementary groups, `NoNewPrivs: 1`, and zero `CapPrm`/`CapEff`/`CapAmb`. Unit test `TestCheckStatus` (13 cases). Integration: the proxy is now started through `setpriv --no-new-privs` (Go's SysProcAttr can't set it); new refusal cases "no no_new_privs", "supplementary group", "gid 0" all exit 2 with the intended reason (plus the existing ones).
8. **Control peer** — fd 7's `SO_PEERCRED` must be uid 0. Integration `TestControlPeerMustBeRoot`: fd 7 is a connection to a unix listener owned by the kete user → exit 2 "the peer is uid …, must be root".
9. **Log DoS** — `reqlog`: the last tenth of the cap (max 1,000,000 B) is reservable only by port R (`Reserve(root bool)`, `FullFor`); ports A/B get 503 once their part is exhausted while root keeps working; the marker is written when root's reservation no longer fits. Refusal lines (and idle-timeout lines) are rate-limited per port (token bucket 10/s, burst 50); refusals are still counted in `stats.refused`, and the next line for that port carries `"suppressed":n` (log format v1 gains this optional field; not yet released). Tests: `reqlog.TestRootShare`, `reqlog.TestRefusalRateLimit`, proxy `TestToolFloodCannotStopRoot` (300 tool refusals → ≤ burst lines, all counted; tool registry traffic until 503; then root 200), proxy `TestLogFullRefusesEverything` and integration `TestLogFull` (8,192 B: kete until 503, then root until 503, file ≤ cap and ends with the marker).
10. **Blocked ranges** — `::/96` (replaces `::/128` and `::1/128`: nft interval sets reject overlaps; it also covers IPv4-compatible `::a.b.c.d`) and `2002::/16` (6to4) added; goldens regenerated. `64:ff9b::/96` stays blocked; README states this as an open question for piece C/Fly (NAT64 would make IPv4-only hosts unreachable; a fix would allow the prefix while checking the embedded IPv4) — nothing allows it silently.
11. **Integration** — resolvers now `198.51.100.53:53` and `[fdaa::3]:53` (fake DNS on both); the proxy user's UDP/TCP DNS to `[fdaa::3]:53` succeeds (the exception precedes the blocked `fc00::/7`); kete/tool/root/other to it are refused fast. New fourth user `kete-it-other` (named nowhere in the config): TCP to ports A and R, v4/v6 upstreams and the tool listener, and DNS to both resolvers, all refused with ECONNREFUSED/EPERM in < 1 s.

**Checks (real output)**
- gofmt clean; `go vet ./...` and `go vet -tags integration ./...` ok; `go test -race ./...`: 12 packages ok (cmd has no tests); `go test -race -count=50 ./internal/proxy/`: ok (100.177 s).
- `nft -c -f` on `mixed.nft`, `v4.nft`, `v6.nft`: all ok; applying `mixed.nft` twice: ok.
- Integration (the plan's exact privileged command), 3 consecutive runs: run 1 exit 0, 16 PASS / 0 FAIL; run 2 exit 0, 16 PASS / 0 FAIL; run 3 exit 0, 16 PASS / 0 FAIL (16 = the previous 15 + `TestControlPeerMustBeRoot`).
- Root `bun run lint`: 0 warnings, 0 errors. `upstream:check`: passed.
- Still not run: CI (needs a push); `ubuntu-latest` and Fly kernels; `setpriv` must exist on the CI runner (util-linux; the script installs it if missing).

## 2026-09-30 implementer (reviewer's minor follow-ups)

Shell available; nothing committed.
1. **Shutdown summary** — `reqlog.FlushSuppressed` writes, from root's share, one `"reason":"suppressed_summary","suppressed":n` line per port with an unreported count; `Proxy.Close` calls it after the handlers finish. A refusal that can't be written because its share is full now adds to the count instead of losing it (found while testing). Tests: `TestFlushSuppressed`, `TestFlushSuppressedUsesRootShare`, proxy `TestToolFloodCannotStopRoot` (summary for the tool port after `Close`).
2. **First refusal per (port, reason, host) bypasses the bucket**, up to 256 combinations per job. Test: `TestFirstRefusalPerHostBypassesBucket` (a probe behind a 1,000-refusal burst is logged; a repeat isn't; the bypass stops at 256). `TestRefusalRateLimit` counts updated (burst + 1).
3. **`job_log_full`** — when the job users' share first fills, a one-time `{"v":1,"ts":…,"job_log_full":true}` line is written from root's share (keeping the final marker's room); `stats` gains `job_log_full`. Tests: `TestRootShare`, `control.TestWriters`, proxy `TestToolFloodCannotStopRoot`.
4. **Trust refusals in `serve`** — `proxy.CheckTrustEnv` refuses `SSL_CERT_FILE` or any `SSL_CERT_DIR` entry under `/run/kete-egress`; `proxy.CheckRoots` refuses a system pool containing a root whose subject CN is `ca.JobCAName` ("Kete job egress CA"). The test CAs now use `ca.NewNamed("Test upstream CA", …)` so they aren't mistaken for a job CA. Tests: `TestCheckTrustEnv`, `TestCheckRoots`, integration `TestTrustRefusals` (three cases, each exit 2 with the intended reason).
5. `TestFirewall`: unlisted user → port B, expected refused.
- Also fixed: `TestConnectRefusals` read `stats.refused` right after the response (the counter is bumped just after the status is written); it failed once at `-count=20`, now polls. README updated (log section, stats, start-up checks).

**Checks (real output)**: gofmt clean; vet (+integration) ok; `go test -race ./...`: 12 packages ok; `go test -race -count=20 ./internal/reqlog/ ./internal/proxy/`: ok / ok (after the poll fix; the first attempt failed once, as above). Integration, 3 consecutive runs: 17 PASS / 0 FAIL each, exit 0 (16 + `TestTrustRefusals`). The 3 runs came before the final unit-test-only poll fix, which isn't in the integration binary. Lint 0/0; `upstream:check` passed. CI still not run.
