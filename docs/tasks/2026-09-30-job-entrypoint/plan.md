# Plan: Cloud job entrypoint and image: piece C+D (ADRs 0018-0021, docs/jobs.md §8 items 1-2)

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

**Size: large, security-critical, needs the user's approval before building.** It adds new
shared contracts: the machine-config variables, a mirror of the platform's job callbacks, the
change-bundle format, and `kete job run`'s behaviour in job mode. **No upstream OpenCode file is
edited.** The edits outside the new module are to Kete-owned paths only: `packages/cli/src/kete/`,
`packages/kete-root-helper/`, `.github/workflows/kete-*`, `docs/`.

## Findings that shape the plan (read these first)

- **F1. `kete job run` can't start in job mode today.** `job-git.ts:36` refuses every `git` call in
  job mode. `job-run.ts:417` calls `repoRoot` first, and `:452` creates its own worktree under
  kete's data directory. ADR 0019 rule 5 says the entrypoint creates the worktree and passes it in,
  so the CLI needs a small Kete-owned change: in job mode, **cwd is the prepared worktree**. That
  means no git calls, `spec.branch` is required, `.git` must exist, and the result reports
  `isolated: true, worktree: cwd, branch: spec.branch`. This is in PR 1 (step 3).
- **F2. The real `kete` can't reach its own server inside the firewall.** `kete job run` forces a
  standalone child, `kete serve --stdio --port 0` (TCP loopback, basic-auth password;
  `cli/src/services/standalone.ts:19-57`). The egress ruleset lets the `kete` uid reach **only
  port A**, loopback included (`kete-egress/README.md:18-22`). So a real-`kete` job can't run until
  piece A's unix-socket server lands. **AC1 with the real `kete`, and AC5's Bun check, depend on
  piece A.** PR 1 uses a fake `kete` and isn't affected. See decision D1 for PR 2.
- **F3. Tools would inherit `oom_score_adj` −1000.** The helper must run at −1000, and every child
  inherits that value, so every tool would be immune to OOM kills, including its own cgroup's
  `memory.max` OOM. Fix: the helper's stage 2 writes `0` to `/proc/self/oom_score_adj` before it
  drops privilege. That's a small change in `packages/kete-root-helper` (PR 1, step 2). The
  entrypoint's own launcher does the same for `kete`.
- **F4. Proxy hosts arrive after the proxy has to be running.** Egress config v1 fixes the
  allowlists at `serve` start, and control v1 has no host update. But the gateway host arrives
  only in the `claim` response, and the storage host only in the `uploads` response, while the
  proxy must be up before `claim` (root reaches only port R). Plan: **restart the proxy between
  phases, only while no job-user process exists.** Instance 1 (before claim) allows root →
  platform. Instance 2 (after claim, before any job user runs) holds the full clone and agent
  allowlists. Instance 3 (report phase, after every job process is killed) adds the storage host.
  Root keeps the listening sockets and the log file; README "fd 6: its current size is the
  starting offset" means the 10 MB cap holds across instances. There's an alternative (D2).
- **F5. The root helper must start before `claim`** (ADR 0019 rule 5, last bullet: "exits before
  `claim`" if it can't start the helper). Its `--worktree-root` is opened at start-up, so it is the
  fixed **worktree parent**, which exists before the clone; the repository copy is created inside
  it later. This differs from the spec's step 5 wording ("Run: start the root helper") and follows
  the ADR.
- **F6. Test networking.** Docker's embedded DNS (`127.0.0.11`) is loopback, which the egress
  config refuses. Docker bridge addresses (`172.16/12`) are blocked ranges. So the e2e uses a
  Docker network on the documentation subnet `198.51.100.0/24` (the egress suite's own choice),
  and bind-mounts a `resolv.conf` naming the fake DNS server. Both the entrypoint and the proxy
  stay unmodified.

## Cards read
- docs/context/INDEX.md; modules/job-mode.md, root-helper.md, egress.md, cli.md, audit-log.md,
  gateway.md, kete-tools-ci.md (skimmed), contracts.md §6-§8, commands.md, pitfalls.md (job
  items). `stale-cards.mjs`: job-mode, root-helper, egress, cli, audit-log, kete-tools-ci, gateway,
  config-kete, brand-env and server-sdk are all current (2bb85f3003 / a90d57e2d8 / d5cd08f36b /
  bfd6c66).
- READMEs: `packages/kete-root-helper/README.md` (flags, spawn sequence, protocol v1),
  `packages/kete-egress/README.md` (config v1, fds 3-7, control v1, log v1, firewall, clients).
- Platform (read-only): `docs/jobs.md` §1, §2 "Container callbacks" (:178-206), §5, §6, §8;
  ADR 0018 rules 5-9, ADR 0019 rules 4-8, ADR 0020 rules 1-2 and 8-9, ADR 0021 rules 4-6.
- Code opened where the cards didn't say enough (logged in handoff.md):
  `cli/src/kete/job-run.ts:395-520`, `job-git.ts`, `cli/src/services/standalone.ts`,
  `cli/script/build.ts:26-60,258`, `.github/workflows/kete-release.yml`, `kete-egress.yml`.

---

## 1. PR split and module layout

**PR 1 (piece C): `feature/job-entrypoint`**
- A new Go module, `packages/kete-job-entrypoint/`: the entrypoint, its unit tests, and a privileged
  integration suite against a minimal in-process fake platform (Go) and a **fake `kete`** (a Go
  test program). The real helper and proxy binaries are built from their sibling modules.
- F3 fix in `packages/kete-root-helper` (stage 2 resets `oom_score_adj`), with an itest case.
- F1 fix in `packages/cli/src/kete/job-run.ts` and `job.ts` (job mode: prepared worktree), with
  tests.
- A new path-filtered workflow, `kete-job-entrypoint.yml`; the README contract; docs and contracts.
- Covers: AC2, AC3, AC4 (fully); AC1 up to the fake `kete` (lifecycle, shell spawn through the real
  helper as the tool user, edit, heartbeats, result, uploads, finish, bundle = the edited file);
  AC6 (go vet/test, integration, CI, lint, `upstream:check`).

**PR 2 (piece D): `feature/job-image`, after PR 1** (and, per D1, after piece A's unix-socket
server)
- `packages/kete-job-image/`: the Dockerfile, build and e2e scripts, and the e2e test layer.
- The fake platform grows: a scripted fake gateway, a GHES-style revoke endpoint, a DNS forwarder
  for the real registries, and a container `main` (`cmd/kete-job-fake-platform`).
- The e2e asserter (`internal/e2e`, build tag `e2e`).
- `kete-job-image.yml` (path-filtered e2e) and the `image` job in `kete-release.yml` (GHCR push on
  `kete-v*` only, digest recorded in the release notes); `docs/release.md`.
- Covers: AC1 with the real `kete`, AC5, AC6 (image builds, publish dry run, e2e locally and in CI).

**Module layout: a new, separate module** (`packages/kete-job-entrypoint/`, its own `go.mod`). It
does not live inside the helper's or the egress module, for the same reasons as egress D1
(`egress` card): a different trust boundary and review, its own CI path filter, and no shared Go
code (it talks to the helper and proxy only through their documented CLI, fds and wire protocols;
their `internal/` packages can't be imported anyway). Cost: a **third** pin to bump together,
`go 1.26.0` / `toolchain go1.26.8` / `golang.org/x/sys v0.48.0` (+ `golang.org/x/net v0.59.0` for
the fake DNS, the same pin as egress). Record "three pins" in the cards. It is not a bun workspace
(no `package.json`). CI reuses the helper/egress pattern: setup-go from `go.mod`, gofmt, vet (+ the
integration tag), `go test -race`, then the privileged suite in Docker.

Package layout (all `//go:build linux` where they touch syscalls, each with a non-Linux stub that
fails closed, like `peeruid_other.go`):

| Package | Role |
|---|---|
| `cmd/kete-job-entrypoint` | `main`: dispatch `__launch` (stage 2, before flag parsing) → `__run` (after the env scrub) → default (boot: read env, re-exec) |
| `internal/bootenv` | Read and validate `KETE_JOB_ID`, `KETE_JOB_PLATFORM_URL`, `KETE_JOB_CLAIM_TOKEN`; hand them over a pipe to the re-exec'd `__run` |
| `internal/layout` | Every fixed path, port, limit and timing as one `Config` with defaults (tests override timings in-process; the binary has **no** flag or env knob for them) |
| `internal/sysusers` | Parse `/etc/passwd` and `/etc/group` (root-owned, no NSS) → validated ids |
| `internal/setup` | Directories, sysctls, `/proc` `hidepid=2` remount, `/.fly` lockdown, own `oom_score_adj` |
| `internal/cgroup` | Top-level layout, controllers, limits, `cgroup.kill`, `cgroup.events` populated, member listing |
| `internal/launch` | Stage 1 (parent) / stage 2 (`__launch`): cgroup fd, oom, setgroups/setgid/setuid, NNP, umask, `close_range`, `execve` |
| `internal/egress` | Build config v1, apply `nft`, bind ports, open log, socketpair, start/stop/restart the proxy, control client, supervision |
| `internal/helper` | Start/stop the root helper with its flags; wait for the socket |
| `internal/platform` | Callback client: claim, events, result, uploads, finish, signed-URL PUT; retry policy |
| `internal/gitops` | Hardened git runner; pristine clone, verify, agent copy, branch |
| `internal/bundle` | The safe reader, blob hashing, limits, tar writer |
| `internal/job` | The orchestrator (`Run(ctx, cfg, deps)`), phases, heartbeats, deadline, outcome mapping |
| `internal/phaselog` | Structured stdout lines (fixed codes only) |
| `internal/fakeplatform` | Test support (non-`_test` so PR 2's container `main` can reuse it): TLS with its own CA, DNS, callbacks, git smart HTTP |
| `internal/itest` (+ `internal/itest/fakekete`) | Integration suite (`integration && linux`) and the fake `kete` program |

---

## 2. The entrypoint, step by step

### 2.1 Machine configuration and the claim token

- **Source: environment variables the platform sets in the Fly machine config** (`config.env`; ADR
  0018 rule 8: "machine configuration carries only the job id, the platform URL and a single-use
  claim token … removes the claim token from its environment"). Names, a new contract (D3):
  `KETE_JOB_ID` (UUID), `KETE_JOB_PLATFORM_URL` (`https://`, plain DNS host, port 443 or none, no
  userinfo, query or fragment, path empty or `/`), `KETE_JOB_CLAIM_TOKEN` (printable ASCII, 32-512
  bytes). Any other `KETE_*` variable is ignored. Fly also offers `config.files`; not used in v1.
- **Scrub by re-exec:** `os.Unsetenv` doesn't clear the kernel's view of the initial environment
  (`/proc/self/environ`). So the boot stage validates the three values, writes them as JSON to a
  pipe, and `execve`s `/proc/self/exe __run` with an **empty environment** (only `PATH=/usr/sbin:/usr/bin:/sbin:/bin`)
  and the pipe as fd 3. After that, the token lives only in the Go heap until claim returns, and
  the variable is set to `""` in the struct. Every child the entrypoint starts gets an explicit
  environment, never an inherited one. `/proc/<pid>/environ` of root processes is unreadable to
  other users (ptrace access check + `hidepid=2`). Fly's own init also held the value; that's
  outside our control (listed in §7).

### 2.2 Fixed layout (constants in `internal/layout`; the image creates none of these at build time)

| Path | Owner / mode | Holds |
|---|---|---|
| `/run/kete-job/` | root 0700 | `egress.json` (0600), root's temp, launch-spec pipes |
| `/run/kete-egress/ca.pem` | root 0644 (dir 0755) | the proxy's `ready` CA PEM (README "Clients") |
| `/run/kete-helper/helper.sock` | dir root 0755; socket kete 0600 (the helper chowns it) | the helper socket |
| `/var/lib/kete-root/` | root 0700 | `pristine.git` (bare, leaf 0700), `home/` (root's git HOME), `tmp/` (mkdtemp for the bundle and index) |
| `/var/log/kete-job/` | root 0700 | `proxy.jsonl` (fd 6, 0600), `proxy.stderr`, `helper.stderr`, `kete.stdout`, `kete.stderr` |
| `/var/lib/kete-job/kete/` | kete 0700 | kete's HOME, XDG_{CONFIG,DATA,CACHE,STATE}_HOME, `tmp/`, `spec.json` (kete 0600) |
| `/var/lib/kete-job/tool/` | tool 0700 | the tool user's HOME and `tmp/` |
| `/srv/kete-job/work/` | root:kete-job **2750** | the fixed **worktree parent** = the helper's `--worktree-root` |
| `/srv/kete-job/work/repo/` | tool:kete-job, dirs 2775, files g+w | the agent's working copy (the worktree `kete job run` runs in) |

All directories are created with `mkdirat`/`fchownat`/`fchmodat` through fds opened `O_NOFOLLOW`.
Any pre-existing path that isn't the expected type and owner aborts. The parent is not
group-writable, so neither job user can rename or replace `repo` (they need write on the parent).
Owning `repo` as the tool user means the tool user's git needs no `safe.directory`; the image
still sets `safe.directory = /srv/kete-job/work/repo` in `/etc/gitconfig`, as the spec asks (root's
git ignores system config). This is D5.

### 2.3 Steps, syscalls, order and failures

Phase lines on stdout are JSON: `{"ts","step","event":"start|ok|failed","code":<fixed enum>,
"exit_code"?}`. They never carry a message from git, `kete`, the platform or a token (ADR 0019
rule 8).

| # | Step | Exact mechanism | On failure |
|---|---|---|---|
| 0 | Boot | Read env (2.1), re-exec `__run`; `prctl(PR_SET_DUMPABLE,0)`; write `-1000` to `/proc/self/oom_score_adj`; `umask(022)`; `signal.Notify(SIGTERM)` → graceful abort (never pass SIGTERM through) | exit 2 (`boot`), no callbacks |
| 1a | Users | `sysusers`: `kete`, `kete-tool`, `kete-proxy`, group `kete-job`; all ids ≠ 0 and distinct; `kete` and `kete-tool` are in `kete-job`; `kete-proxy` has **no** supplementary group (the proxy refuses them); no other member of `kete-job` | exit 1 (`setup_users`), no claim |
| 1b | Sysctls | write+read back `/proc/sys/fs/protected_hardlinks`=1, `protected_symlinks`=1, `/proc/sys/user/max_user_namespaces`=0 (egress README "Not done here", D6) | exit 1 (`setup_sysctl`) |
| 1c | `/proc` | `mount("proc","/proc","proc",MS_REMOUNT\|MS_NOSUID\|MS_NODEV\|MS_NOEXEC,"hidepid=2")`; verify `hidepid=invisible` or `=2` in `/proc/self/mountinfo` | exit 1 (`setup_proc`) |
| 1d | Fly API | if `/.fly` exists: `fchownat root:root`, `fchmodat 0700` on `/.fly` (the `api` socket's directory); verify with `lstat` (only on Fly; a no-op locally) | exit 1 (`setup_fly`) |
| 1e | Directories | 2.2 table | exit 1 (`setup_dirs`) |
| 1f | Cgroups | R = own cgroup (`/proc/self/cgroup` `0::` + the cgroup2 mount point from `/proc/self/mountinfo`; reuse the helper's approach). If R isn't the root cgroup: `mkdir R/kete-job-init`, move every pid in `R/cgroup.procs` there (the "no internal processes" rule). Write `+pids +memory` to `R/cgroup.subtree_control`. `mkdir R/kete-job` (+ its `subtree_control`), then `R/kete-job/{system,kete,tool}`; move self to `system`. `kete`: `memory.max` = 25% and `pids.max` = 512; `tool`: `memory.max` = 60% of `MemTotal` and `pids.max` = 4096, `subtree_control +pids +memory` (the helper's leaves). The helper checks these | exit 1 (`setup_cgroup`) |
| 2a | Egress config | build config v1 (egress README): uids; ports 81/82/83; `resolvers` = the `nameserver` lines of `/etc/resolv.conf` (loopback is refused by the proxy → abort); instance 1 phases: `clone.root = [platform host]`; `registries` = none; limits default | exit 1 (`egress_config`) |
| 2b | Firewall | `kete-egress nft --config -` (config on stdin) piped to `nft -f -`; then `nft list table inet kete_egress`; both with timeouts; non-zero → abort | exit 1 (`egress_nft`) — **no claim** |
| 2c | Proxy | `net.ListenTCP("tcp4",127.0.0.1:{81,82,83})` → `.File()`; open `/var/log/kete-job/proxy.jsonl` `O_WRONLY\|O_APPEND\|O_CREAT\|O_CLOEXEC` 0600; `socketpair(AF_UNIX,SOCK_STREAM\|SOCK_CLOEXEC)`; start `kete-egress serve --config -` via `launch` (uid/gid proxy, `setgroups([])`, NNP, oom −1000, env **empty** but `PATH`, cgroup `system`, fds 3-7 = A,B,R,log,ctl, stdin = config, stdout/stderr → `proxy.stderr`); read `ready` (≤ 10 s) → write `ca.pem` atomically (temp + rename, 0644); send `phase clone`, expect `phase_ok` | exit 1 (`egress_proxy`) — **no claim** |
| 2d | Helper | start `kete-root-helper` via `launch` (uid 0 kept, oom −1000, umask **002**, cgroup `system`, env empty but `PATH`) with `--socket /run/kete-helper/helper.sock --kete-uid K --tool-uid T --tool-gid Tg --worktree-root /srv/kete-job/work --tool-cgroup R/kete-job/tool --env-allow <list> --env-set …` (§6 lists the tool env); wait ≤ 10 s for the socket (`lstat`: a socket, owner kete, 0600); supervise | exit 1 (`helper`) — **no claim** |
| 3 | Claim | root's HTTP client: proxy `http://127.0.0.1:83`, `RootCAs` = **only** `ca.pem`, TLS 1.2+, 30 s timeout. `POST {platform}/api/v1/jobs/{id}/claim` `{claim_token}`. **Retried only if the request was never written** (`httptrace.WroteRequest` not reached: dial/TLS/proxy errors), ≤ 5 tries in 2 min: a second claim fails the job (`claim_replayed`). 200 → strict-validate the response (below); zero the token field | 4xx/5xx/invalid → exit 1 (`claim`), no callbacks (sweeper: `claim_timeout`/`claim_replayed`) |
| 3b | Claim response | `callback_token` non-empty; `deadline` RFC 3339 in the future; `platform_url` must equal the machine config's (else `error`); `gateway_url`, `clone.url` `https://` + plain DNS host + port 443; `clone.ref` a valid branch name; `base_sha` 40 hex; `spec` a JSON object with `version: 1`, `policy.timeout` a positive integer, `branch` a valid branch name (`git check-ref-format --branch` via gitops). The **hard deadline** context starts here: `ctx = WithDeadline(deadline)` | invalid with a usable callback token → `result {outcome:"error", exit_code:1, message:"invalid claim response: <field>"}` → report without bundle; unusable → exit 1 |
| 3c | Proxy instance 2 | the full config: `clone.root = [platform, clone host, api host]`, `agent.kete = [gateway, platform]`, `agent.tool = <built-in registry hosts>` (D7), `agent.root = [platform]`, `report.root = [platform]`. Stop instance 1 (close fd 7; wait for exit 0, ≤ 10 s), start instance 2 with the **same** listener and log fds, new `ca.pem`, phase `clone` | can't report (no proxy) → exit 1 (`egress_restart`); the platform's sweeper fails it `lost` |
| 4a | Clone | event `{phase:"clone"}`. `git clone --bare --depth=1 --single-branch --no-tags --branch <ref> -- <url> /var/lib/kete-root/pristine.git` (§2.4 env; the header via `GIT_CONFIG_COUNT`: `http.extraHeader = Authorization: Basic base64(x-access-token:<token>)`); timeout 10 min | `result {error, 1, "clone failed"}` → report without bundle |
| 4b | Verify | `git --git-dir=pristine.git rev-parse --verify refs/heads/<ref>^{commit}` must equal `base_sha`; `rev-parse --show-object-format` = `sha1`; no `objects/info/alternates`; no `shallow` other than `base_sha` | `result {outcome:"refused", exit_code:2, message:"clone HEAD does not match base_sha"}` (ADR 0021 rule 4) → report without bundle |
| 4c | Revoke | `DELETE https://api.github.com/installation/token` (for `github.com`; for any other host `https://<host>/api/v3/installation/token`, the GHES convention the fake uses) with `Authorization: token <t>` through port R; expect 204; ≤ 3 tries; then drop the token | D8: an `events` message `"clone token revoke failed"` and continue (the token can't leave the VM: no later phase allows a GitHub host) |
| 4d | Agent copy | `git clone --no-hardlinks --no-checkout -- /var/lib/kete-root/pristine.git /srv/kete-job/work/repo`; check there's no `objects/info/alternates`; `git -C repo checkout -q -b <spec.branch> <base_sha>`; `git -C repo remote remove origin`. Then a walk with `WalkDir` + `Lchown(tool, kete-job)`, dirs `chmod 2775`, regular files `g+w` (exec bits kept), symlinks untouched (no job process exists yet, so no race) | `result {error,1,"agent copy failed"}` → report |
| 4e | Proxy phase | `phase agent` → `phase_ok` (closes root's GitHub connections) | proxy error → `proxy_failed` path |
| 5a | Timeout | `eff = floor(min(policy.timeout, (deadline − now − FinalizeReserve[5 min]) / 1 min))`; `eff < 1` → don't start `kete` | `result {outcome:"deadline", exit_code:1}` (ADR 0018 rule 9) → report |
| 5b | Spec | copy of the claim's `spec` with `policy.timeout = eff`, all other fields verbatim, written to `/var/lib/kete-job/kete/spec.json` (create as root with `O_EXCL\|O_NOFOLLOW`, then `fchown` kete, 0600) | `error` |
| 5c | Launch `kete` | `launch`: cgroup `kete` (`CLONE_INTO_CGROUP` via `SysProcAttr.UseCgroupFD`), stage 2 writes oom `0`, `setgroups([kete-job])`, setgid, setuid kete, NNP, umask 002, `close_range(3,…,CLOEXEC)`, `chdir /srv/kete-job/work/repo`, `execve /usr/local/bin/kete job run --json /var/lib/kete-job/kete/spec.json`. stdout → `kete.stdout`, stderr → `kete.stderr` (root-owned 0600, opened by root, passed as fds 1/2), stdin `/dev/null`. Env: the §6 kete list | `error` |
| 5d | Heartbeats | first `events {phase:"agent", effective_timeout_minutes: eff}`, then every 30 s `{phase:"agent", kete_cgroup_extra: n}`, where n = pids in `kete/cgroup.procs` whose `readlink /proc/<pid>/exe` ≠ `/usr/local/bin/kete` (so `job run` and its `serve` child don't count). An events failure: retry at the next tick; **404 on any callback** = cancelled or terminal → kill everything, exit 0 (`cancelled`) with no more callbacks | — |
| 5e | Supervise | wait on: `kete` exit; proxy exit (unplanned → `proxy_failed`); helper exit (→ an events message; `kete`'s tools then fail on their own); backstop timer `eff + 3 min` → SIGTERM `kete`, then `cgroup.kill` `kete` after 10 s → `result {outcome:"time_limit", exit_code:3, message:"stopped by the entrypoint"}` if `kete` wrote none; hard deadline → abort | per row |
| 6a | Stop agents | `phase report`; SIGTERM the helper (it closes its listener and kills every leaf), wait ≤ 10 s, else SIGKILL; unlink the socket. Write `1` to `kete/cgroup.kill` and `tool/cgroup.kill`, then loop ≤ 30 s (100 ms steps, re-killing each round) until both `cgroup.events` say `populated 0` **and** a `/proc` scan finds no process with any of real/effective/saved/fs uid = kete or tool (the `pgrep -u` of ADR 0021 rule 5) | anything left → no bundle, `push_error:"processes_alive"` |
| 6b | Result | the `kete.stdout` bytes (≤ 1 MiB): the whole trimmed file, or else the last line, that parses as a JSON object with `version: 1`, a string `outcome` and an integer `exit_code`; sent **verbatim** (those bytes). Missing or invalid → `{version:1, outcome:"error", exit_code:<kete's code or 1>, denied:[], message:"kete exited without a valid result"}`. `POST …/result` (Bearer), retry ≤ 3 on network/5xx | result not accepted → still try uploads and finish, then exit 1 |
| 6c | Bundle | §3, unless `processes_alive` or `proxy_failed` | refused → `push_error: symlink` or `unreadable` |
| 6d | Uploads | `POST …/uploads {bundle: <built>}` → 3 URLs. **Proxy instance 3:** stop instance 2, start with `report.root = [platform, storage host]` (host from the URLs; all must share one `https` host, port 443), phase `report`. `PUT` each URL (`Content-Type` per jobs.md, `Content-Length`, streamed): the audit log (below), the bundle, and last the proxy log (a snapshot of its current size, so lines after the snapshot aren't included, stated in the README) | a failed upload → an events message and continue to finish (uploads are single-use) |
| 6e | Finish | `events {phase:"done"}`; `POST …/finish {push_error?}`; `stats`, then `phase closed`, close fd 7, wait for the proxy (≤ 10 s); exit 0 | exit 1 |
| 7 | Hard deadline | every step runs under `ctx` (deadline = claim `deadline`); on expiry: `cgroup.kill` both job cgroups, SIGKILL the helper, close the proxy, exit 1 (`deadline`), with no further callbacks (they'd answer 404 past the deadline) | — |

**Proxy failure (ADR 0019 rule 4, ADR 0018 rule 5):** an unplanned proxy exit at any point after
claim → 6a (kill), then restart the proxy straight into `report` (skipping phases is allowed) →
`result {outcome:"proxy_failed", exit_code:1}` (unless `kete`'s result was already sent) → uploads
`{bundle:false}` → audit and proxy log → `finish {push_error:"proxy_failed"}`. If the restart fails
there's no way out: exit 1 (the platform marks it `lost`).

**Audit log to upload:** `<kete XDG_DATA_HOME>/kete/audit/<session_id>.jsonl`. `session_id` comes
from the result and must match `^ses_[A-Za-z0-9]{1,64}$` (confirm the exact shape and the data
directory's brand name in `audit.ts:137-141` / `util/src/global.ts`). It is opened with the §3
`O_NOFOLLOW` walk from the kete home, only after 6a, and must be a regular file ≤ 20 MB (the
audit's own cap, `audit.ts:43`). If it's missing or refused, it isn't uploaded, and an events
message says why. Piece A replaces this with the entrypoint-owned sink.

**Outcomes the entrypoint itself reports** (result v1; the platform stores unknown outcomes as
`failed`): `error` (1), `refused` (2, clone at the wrong commit), `deadline` (1), `proxy_failed`
(1), `time_limit` (3, backstop). `push_error` (finish): `processes_alive`, `symlink`,
`unreadable`, `proxy_failed`.

### 2.4 Hardened git (every root git call, `internal/gitops`)

- Always `/usr/bin/git` with an **explicit environment only**:
  - `PATH=/usr/bin:/bin`, `HOME=/var/lib/kete-root/home`, `GIT_CONFIG_NOSYSTEM=1`,
    `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=` and `SSH_ASKPASS=`
    unset.
  - `GIT_NO_REPLACE_OBJECTS=1`, `GIT_LFS_SKIP_SMUDGE=1`, `GIT_PROTOCOL_FROM_USER=0`, `LC_ALL=C`,
    and `GIT_INDEX_FILE` = a fresh file in a `mkdtemp` under `/var/lib/kete-root/tmp`.
  - `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` = `core.hooksPath=/dev/null`, `core.fsmonitor=false`,
    `core.untrackedCache=false`, `protocol.allow=never`, `protocol.https.allow=always` (plus
    `protocol.file.allow=always` for the local agent copy only), `submodule.recurse=false`,
    `http.proxy=http://127.0.0.1:83`, `http.sslCAInfo=/run/kete-egress/ca.pem`,
    `core.quotePath=false`, and, for the clone only, `http.extraHeader`.
- No `GIT_TRACE*` or other inherited variable can leak in: the environment is constructed, never
  inherited.
- Timeouts per call (the clone gets 10 min, the others 60 s). stdout and stderr are capped (64 MiB /
  64 KiB).
- stderr goes into a result message only after the clone token and any `Authorization` line are
  scrubbed, cut to 300 bytes.

### 2.5 Credentials: where each one lives

| Credential | Arrives | Lives | Never |
|---|---|---|---|
| Claim token | env of the boot stage | the pipe → the `__run` heap until claim returns | any child's env, any file, argv, log |
| Callback token | claim response | the entrypoint heap (Bearer header built per request) | `kete`, the tool user, files, logs, argv |
| Clone token | claim response | the heap → the git child's env (`GIT_CONFIG_VALUE_n`, root-only by `hidepid` + ptrace) → dropped after revoke | disk, remote URL, argv, logs, `kete` |
| Gateway key | claim response | the heap → **`kete`'s env `KETE_GATEWAY_KEY`** (the approved interim gap until piece A's descriptor) | the tool user (the helper's env allowlist + the client's filtering + `hidepid`), the helper, files |
| Signed URLs | uploads response | the heap | logs (the query string is never logged) |

---

## 3. The bundle safe reader (`internal/bundle`, ADR 0021 rules 5-6)

Runs only after 6a has confirmed that no job process is left, so nothing can race it; it is still
written as if something could.

1. **Workspace:** `mkdtemp(/var/lib/kete-root/tmp/bundle-*)` (root 0700). `PATH`/`HOME` are
   root-only (§2.4). Nothing from the worktree is ever executed.
2. **Anchor:** open `/srv/kete-job/work` with per-component `openat(…, O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)`
   from `/`, check it's root-owned (not writable by the job users), then `openat(parentFD, "repo",
   O_PATH|O_DIRECTORY|O_NOFOLLOW)`. A symlink → refuse `symlink`; anything else → `unreadable`.
   Keep `repoFD` for every read.
3. **List (git against the pristine git-dir only):** every call has `--git-dir=/var/lib/kete-root/pristine.git
   --work-tree=/srv/kete-job/work/repo` + the §2.4 env, so git never discovers or reads the
   agent's `.git`:
   - `git read-tree <base_sha>` into the fresh `GIT_INDEX_FILE` (writes the temp index only).
   - `git ls-tree -r -z --full-tree <base_sha>` gives `mode type sha\tpath` for the base.
   - `git ls-files -z --others --exclude-standard` gives untracked, not-ignored paths. Git lstats
     and never follows symlinked directories. A nested repository shows up as `dir/`; it is
     **skipped** and named in an events message (D9).
   - Limits: 60 s each; ≤ 64 MiB of output; ≤ 100,000 untracked entries (over → `unreadable`).
4. **Path hygiene** (defence in depth before any open): valid UTF-8 (non-UTF-8 can't be
   represented in the JSON manifest → `unreadable`); no NUL, no leading `/`, no empty, `.` or `..`
   component; ≤ 4,096 bytes, components ≤ 255. The platform's full `verify_path`, protected-path
   and case-fold rules stay with the platform; the entrypoint doesn't hide changes to `.github/`
   etc.
5. **Open, never follow:** every directory component uses `openat(dirFD, name,
   O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC)`. The leaf uses `openat(dirFD, name,
   O_RDONLY|O_NOFOLLOW|O_NONBLOCK|O_CLOEXEC)`, then `fstat`.
   - `ELOOP`/`EMLINK` on any component, or `S_ISLNK` from `fstatat(AT_SYMLINK_NOFOLLOW)` on the
     leaf → refuse **`symlink`**.
   - The leaf isn't `S_ISREG` (directory, FIFO, socket, device) → refuse **`unreadable`**
     (`O_NONBLOCK` means a FIFO can't block the open).
   - `ENOENT`, or `ENOTDIR` on an ancestor, for a **tracked** path → **deletion**. For an untracked
     path it's `unreadable` (it was just listed).
   - Any other errno → `unreadable`.
6. **Per base entry type:**
   - blob `100644`/`100755`: read ≤ limit + 1 bytes, compute the git blob SHA-1 (`"blob <n>\0" +
     bytes`) and the mode (`st_mode & S_IXUSR` → `100755`, else `100644`). If both equal the
     base's, it's unchanged and skipped; otherwise it goes in.
   - `120000` (a base symlink): `fstatat(AT_SYMLINK_NOFOLLOW)`; if it's still a symlink and
     `readlinkat` equals the base blob's target (`git cat-file blob <sha>` against pristine, ≤ 4 KiB),
     it's unchanged and skipped. **Anything else → refuse `symlink`**, since the platform refuses
     any manifest entry naming a base symlink.
   - `160000` (gitlink): skipped always (no submodules are cloned).
   - untracked: must be a regular file; always included, with its mode.
7. **Limits (mirroring ADR 0021 rule 6, so a bundle the platform must refuse is never built):**
   - a file > 1 MiB, or a binary file > 256 KiB (binary = a NUL in the first 8,000 bytes, git's
     heuristic);
   - more than 50 binary files;
   - more than 1,000 manifest entries;
   - more than 20 MB of uncompressed tar (every header, PAX record, padding and the end blocks
     counted exactly);
   - more than 10 MB of gzip output (a counting writer).

   Any of these → no bundle, `push_error: "unreadable"`, plus an events message naming the limit
   (D10: ask the platform for a `too_large` value).
8. **Format:** gzip (one member, `gzip.BestCompression`) of a tar written with Go's
   `archive/tar`:
   - The first entry is `manifest.json`: a JSON **array** (ADR 0021: "a list"; D11), each item
     `{"path":"a/b","mode":"100644"}` or `{"path":"a/b","deleted":true}`, sorted by path bytes.
   - Then one `files/<path>` entry per non-deleted item, in manifest order.
   - Every header: `Typeflag TypeReg`, `Mode 0644`, `Uid/Gid 0`, empty `Uname/Gname`,
     `ModTime = time.Unix(0,0)`, zero access and change times. Format USTAR when the name fits,
     else PAX with **only** a `path` record (no GNU, no global headers).
   - A unit test decodes every header and asserts this.
   - No changes → an empty-array manifest, still uploaded (D12).
9. The bundle file lives in the mkdtemp directory and is uploaded from there. The directory is
   removed at exit.

---

## 4. The fake platform and the end-to-end test

**Language: Go**, in the entrypoint module (`internal/fakeplatform`). It reuses the egress suite's
fake TLS and DNS patterns (`kete-egress/internal/itest/fakes_test.go`), `net/http/cgi` for git, and
one toolchain in CI. Bun was considered and rejected: a second toolchain in the e2e container, and
no git smart-HTTP helper. **Contract drift guard:** the fake has its **own** structs for every
callback body, decoded with `DisallowUnknownFields` and checked against the documented limits
(message ≤ 500, the phase enum, `effective_timeout_minutes` accepted once, only with the first
`agent` event, 1 ≤ it ≤ `policy.timeout`). It never imports `internal/platform`, so the client and
the fake can't both drift together. New mirror: `contracts.md` §6d.

- **TLS:** the fake generates its own CA at start-up (CN `Kete e2e test CA`, never the job CA's
  CN), with leaf certs for `platform.kete.test`, `gateway.kete.test`, `storage.kete.test` and
  `github.kete.test`, and writes `ca.pem` to a shared directory.
  - PR 1 integration: `TestMain` installs it into `/usr/local/share/ca-certificates` +
    `update-ca-certificates` **before** any proxy starts.
  - PR 2: a test image layer does the same.
  - Either way the proxy and entrypoint run unmodified (the proxy verifies upstreams against the
    system roots).
- **DNS:** `x/net/dns/dnsmessage` UDP+TCP on `:53`. `*.kete.test` A → the fake's address. Every
  other name is forwarded to the fake container's own resolver (so AC5 can reach the real
  registries). It records the queries.
- **Callbacks:** `/api/v1/jobs/{id}/{claim,events,result,uploads,finish}` with the exact jobs.md §2
  semantics:
  - claim once, 409 on a second;
  - Bearer must equal the callback token, else 404;
  - state checks (`running` → `finalizing`);
  - 404 past the deadline.

  Scenario knobs (set by the test in-process, or via a control port in PR 2): `base_sha` override
  (wrong commit), deadline, hang `result`/`uploads`, 404 on `events` (cancel).
- **Git:** a bare repo created at start-up, containing `README.md`, `src/app.txt`, an executable
  `run.sh`, a tracked symlink `link -> README.md` (covers §3 step 6), `.gitignore` (`*.log`), and
  branch `main`. Served by `net/http/cgi` → `git http-backend` (`GIT_PROJECT_ROOT`,
  `GIT_HTTP_EXPORT_ALL=1`) behind a check that the `Authorization` header is exactly `Basic
  base64(x-access-token:<clone token>)`. It records whether the token was ever seen elsewhere
  (URL, query).
- **Revoke (GHES shape):** `DELETE /api/v3/installation/token` on `github.kete.test` → 204;
  recorded.
- **Signed uploads:** `https://storage.kete.test/upload/<random>?token=<random>`, PUT once each;
  size limits per jobs.md (audit 20 MB, proxy log 10 MB, bundle 10 MB); stored to
  `state/uploads/<kind>`.
- **Fake gateway (PR 2):** `GET /anthropic/v1/models` (the shape `gateway.ts:217-254` parses; other
  routes return an empty list), platform `GET /api/v1/models` and `/api/v1/me` minimal (what
  `gateway.ts:256-303` accepts), `GET /api/v1/sync` → 404 or minimal, and `POST
  /anthropic/v1/messages` as a **scripted SSE stream** chosen by how many `tool_result` blocks the
  request carries:
  - turn 1 is a `tool_use` of the shell tool running `id -un`;
  - turn 2 checks that the tool result contains the tool user's name (records pass/fail), then a
    `tool_use` of the edit tool changing one line of `README.md`;
  - turn 3 is final text.

  Message shapes: `packages/ai/test/provider/anthropic-messages.test.ts`. Tool ids and argument
  names: `packages/core/src/tool/{shell,edit}.ts`. The model id must exist in the bundled catalog
  (checked in the e2e; gap logged). The spec names that model and **omits `agent`** (sync from a
  gateway key is piece A / §8 item 6).
- **AC5 scenario (PR 2, a second job):** the scripted model issues shell calls as the tool user,
  each ending in `&& echo AC5_<X>_OK`:
  - `npm install --no-audit --no-fund --prefix "$TMPDIR/n" is-number@7.0.0`;
  - `python3 -m venv "$TMPDIR/v" && "$TMPDIR/v/bin/pip" install six==1.16.0`;
  - `cargo` in a `$TMPDIR` crate: `cargo fetch` with one dependency (`itoa = "=1.0.11"`), using
    the sparse index.

  The fake records the markers. Everything goes to `$TMPDIR`, outside the worktree, so the bundle
  stays empty.
- **Harness (PR 2, `packages/kete-job-image/scripts/e2e.sh`):**
  1. `docker network create --subnet 198.51.100.0/24 kete-e2e`.
  2. Run the fake container at `198.51.100.10` (DNS on the same address).
  3. Build the test layer, `FROM kete-job:local` + the fake CA + `cargo` (and, if D4 leaves them
     out, `nodejs npm python3-venv`).
  4. `docker run --privileged --cgroupns=private --network kete-e2e --ip 198.51.100.20 -v
     $STATE/resolv.conf:/etc/resolv.conf:ro -e KETE_JOB_ID=… -e
     KETE_JOB_PLATFORM_URL=https://platform.kete.test -e KETE_JOB_CLAIM_TOKEN=…` and wait
     (timeout 15 min).
  5. `docker export` the stopped container → a token scan.
  6. Copy the fake's `state/`.
  7. Run `go test -tags e2e ./internal/e2e -state <dir>` in `golang:1.26-trixie`.
  8. Save and restore `user.max_user_namespaces` around the run (it's a host-wide sysctl in
     Colima's VM, D6).
  9. Remove the network and containers on exit (trap).
- **End-to-end assertions (`internal/e2e`):**
  - The call order is `claim` → `events(clone)` → `events(agent, effective_timeout_minutes)` →
    `events(agent, …)*` → `result` → `events(report)` → `uploads` → 3 PUTs → `events(done)` →
    `finish` with no `push_error`.
  - Every gap between events is ≤ 60 s. `kete_cgroup_extra` is 0.
  - The result is valid v1, with outcome `completed`, `branch = spec.branch` and `isolated: true`.
  - The tool-user check passed.
  - The bundle parses (the §3 header rules), its manifest is exactly `[{"path":"README.md","mode":"100644"}]`,
    and `files/README.md` equals the scripted edit.
  - The audit upload is JSONL with a `run ended` line.
  - The proxy log is JSONL v1 and includes `agent`/`kete` → `gateway.kete.test` lines.
  - The revoke was called before the first agent-phase request.
  - The claim token, callback token and clone token appear nowhere in the exported filesystem, the
    uploads (other than the audit's redacted content), the fake's request URLs, or the container's
    stdout.
  - Container stdout contains only phase lines.
  - The AC5 job: all four markers seen, and no `path_shape`/`registry_cap` refusals in its proxy
    log.

---

## 5. Dockerfile and publishing (PR 2)

- **Base: `debian:trixie-slim` pinned by digest** (Debian 13, the current stable). bookworm's cargo
  1.63 predates the sparse index (it needs a `github.com` git index, which the proxy never allows),
  and trixie's git 2.47 is the git the integration suite uses. The Go stage is
  `golang:1.26-trixie@sha256:…` with `--platform=$BUILDPLATFORM`, cross-compiled per `TARGETARCH`,
  `CGO_ENABLED=0 go build -trimpath -ldflags=-s` for each of the three modules. **BuildKit named
  contexts** keep the build context small, with no root `.dockerignore` to fight upstream over:
  `docker buildx build -f packages/kete-job-image/Dockerfile --build-context helper=packages/kete-root-helper
  --build-context egress=packages/kete-egress --build-context entrypoint=packages/kete-job-entrypoint
  --build-context kete=<dir with linux-amd64/kete, linux-arm64/kete> packages/kete-job-image`.
- **`kete` binary:**
  - Release: the `kete-<v>-linux-{x64,arm64}.tar.gz` from the release build artifact (already
    checksummed).
  - Local and PR CI: `bun run build --target=kete-linux-x64 --skip-web-ui` (or `kete-linux-arm64`
    on Apple-silicon Colima) in `packages/cli/` → `dist/cli-linux-<arch>/bin/kete`
    (`build.ts:258`). Not `--skip-install`: the cross-target native packages must be installed.
- **Final stage:**
  - `apt-get install --no-install-recommends git ripgrep nftables ca-certificates` (+ D4:
    `nodejs npm python3 python3-venv python3-pip`), then remove the apt lists.
  - `groupadd --system kete-job`. `useradd --system --user-group --no-create-home --home-dir
    /nonexistent --shell /usr/sbin/nologin` for `kete-proxy`, `kete` (`-G kete-job`) and
    `kete-tool` (`-G kete-job`). **Users are created at build time and verified at run time**
    (step 1a, D5): deterministic, with no `useradd` at boot.
  - `COPY` the binaries: `/usr/local/bin/kete` (0755), and
    `/usr/local/libexec/kete/{kete-job-entrypoint,kete-root-helper,kete-egress}` (0755 root).
  - `/etc/gitconfig`: `[safe] directory = /srv/kete-job/work/repo`.
  - The OpenCode `LICENSE` and Kete `NOTICE` in `/usr/share/doc/kete/` (licensing rule).
  - Strip setuid/setgid bits: `find / -xdev -perm /6000 -type f -exec chmod ug-s {} +`, then a
    build-time check that none are left (ADR 0019 rule 5).
  - OCI labels: source, revision, version, `licenses=MIT`.
  - `ENTRYPOINT ["/usr/local/libexec/kete/kete-job-entrypoint"]`, no `USER`, no `CMD`.
  - No secrets and no CA key: the CA is generated per VM, in memory.
- **Publish:** a new `image` job in `.github/workflows/kete-release.yml`:
  - `needs: [build, smoke]`, `ubuntu-latest`, `permissions: {contents: read, packages: write}`;
    runs on tags and on `workflow_dispatch`.
  - Downloads the `release` artifact, verifies `SHA256SUMS`, and unpacks the Linux tarballs into
    the `kete` context.
  - `docker/setup-buildx-action`; builds `linux/amd64` (D13); **runs `scripts/e2e.sh` against the
    built image** before any push.
  - Then `docker/login-action` (GHCR, `GITHUB_TOKEN`) and `docker/build-push-action` with `push:
    ${{ github.event_name == 'push' && startsWith(github.ref, 'refs/tags/kete-v') }}`, tags
    `ghcr.io/kete-org/kete-job:<TAG>`, and `outputs.digest`.
  - The `publish` job gets `needs: [smoke, extension, image]` and, after "Create or update the
    draft release", appends `Job image: ghcr.io/kete-org/kete-job@<digest>` to the notes
    (`gh release edit --notes-file`) and uploads `kete-job-image.digest` as an asset. The platform
    pins that digest (ADR 0019 rule 7).
  - Actions are pinned by SHA, as in the existing workflows.
- **Testing without a release:** `gh workflow run kete-release.yml --repo kete-org/ketecode --ref
  feature/job-image -f version=kete-v0.0.0-test.1`. On `workflow_dispatch` the push expression is
  false, so it builds, runs the e2e, prints the local digest and pushes nothing (confirm how
  `kete-tools release` handles a non-existent tag in manual runs; `release.ts`). Locally, the same
  build script with `--load`.
- One-time manual steps for the user: make the GHCR package `kete-job` **public** after its first
  push, and link it to the repo.

---

## 6. CA and proxy settings per user (egress README "Clients"), and the AC5 checks

- **`kete` (port A = 81)**, the full environment:
  - `HOME`, `XDG_*`, `TMPDIR` under `/var/lib/kete-job/kete`;
    `PATH=/usr/local/bin:/usr/bin:/bin`; `LANG=C.UTF-8`.
  - `HTTPS_PROXY`/`https_proxy=http://127.0.0.1:81`; **no** `HTTP_PROXY` or `NO_PROXY` (until
    piece A, kete's own loopback server would otherwise be sent to the proxy; after A it's a unix
    socket).
  - `NODE_EXTRA_CA_CERTS=/run/kete-egress/ca.pem`, `SSL_CERT_FILE=/run/kete-egress/ca.pem`.
  - `KETE_JOB_MODE=1`, `KETE_JOB_TOOL_SOCKET=/run/kete-helper/helper.sock`,
    `KETE_JOB_MAX_OUTPUT_TOKENS=32000` (the platform default, ADR 0020 rule 8; a constant until the
    claim carries it, D14), `KETE_RUNTIME_TYPE=kete_cloud`.
  - `KETE_GATEWAY_URL=<gateway_url>`, `KETE_PLATFORM_URL=<platform_url>`, `KETE_GATEWAY_KEY=<key>`
    (the interim gap).
- **Tool user (port B = 82), via the helper's `--env-set`:**
  - `HOME`, `TMPDIR` under `/var/lib/kete-job/tool`; `PATH=/usr/local/bin:/usr/bin:/bin`;
    `LANG=C.UTF-8`.
  - `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy` = `http://127.0.0.1:82`.
  - `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `NPM_CONFIG_CAFILE`, `PIP_CERT`,
    `REQUESTS_CA_BUNDLE`, `CARGO_HTTP_CAINFO`, `GIT_SSL_CAINFO` and `CURL_CA_BUNDLE`, all
    `=/run/kete-egress/ca.pem`.
  - `NPM_CONFIG_AUDIT=false`, `NPM_CONFIG_FUND=false`, `NPM_CONFIG_UPDATE_NOTIFIER=false`,
    `PIP_DISABLE_PIP_VERSION_CHECK=1`, `UV_NATIVE_TLS=1`.

  `--env-allow` = the names `kete`'s shell tool may legitimately pass (check which names the
  client forwards and whether `--env-set` names must also be allowed; `kete-root-helper/internal/config/config.go`).
  Never `KETE_*`.
- **Root (port R = 83):** git through `http.proxy` + `http.sslCAInfo` (§2.4); Go's client through
  an explicit `Proxy` + `RootCAs`. No variables.
- **The job CA never goes into the system store** (the proxy refuses it anyway). Only the fake's
  *test* CA is added to the system store, and only in test containers.
- **AC5, per ecosystem:**
  - **Bun/Node:** `kete`'s gateway calls through port A with `NODE_EXTRA_CA_CERTS` (AC1 run;
    needs piece A) and `npm install is-number@7.0.0` as the tool user.
  - **pip:** venv + `pip install six==1.16.0`.
  - **git:** root's clone through port R with `http.sslCAInfo` (every run; git 2.47 over libcurl).
  - **cargo:** `cargo fetch` of `itoa` over the sparse index (`index.crates.io`,
    `static.crates.io`).
  - All four exercise the **name-constrained** CA. If one refuses it, the egress card's fallback
    (no constraints) is a separate egress change the user decides on; don't silently weaken.

---

## 7. Tests and exact commands

**PR 1 (no Go on the Mac; Colima, `docker info --format '{{.CgroupVersion}}'` = `2`):**
- Unit (no root):

  ```sh
  docker run --rm -v "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-trixie \
    sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go vet -tags integration ./... && go test -race ./...'
  ```

  This covers bootenv, sysusers (fixture files), egress config and control (a fake socketpair),
  the platform client (httptest: retries, the claim no-retry-after-write rule, 404 → cancel),
  gitops env construction (a fake `git` on `PATH` recording argv and env), bundle (§3, temp git
  repos: modified/new/deleted/mode, a symlink added/in a component/replacing a base symlink,
  FIFO, a directory where a file was, oversized text/binary, 51 binaries, non-UTF-8, ignored,
  nested repo, a malicious `.git/config` fsmonitor/hooks in the worktree whose marker must never
  appear, the fake `git` asserting `--git-dir=<pristine>` on every call, tar header rules), and
  the job orchestrator with fake deps (the outcome table, timeout math, the deadline, proxy exit).
- Integration (root; real users, cgroups, nftables, helper, proxy; in-process fake platform; fake
  `kete`):

  ```sh
  docker run --rm --privileged --cgroupns=private -v "$PWD/packages:/src" \
    -w /src/kete-job-entrypoint golang:1.26-trixie bash scripts/integration.sh
  ```

  (append `-test.run <Name>`).
  - `scripts/integration.sh` installs `git nftables iproute2 util-linux procps ca-certificates`.
  - It builds `kete-root-helper`, `kete-egress`, `kete-job-entrypoint` and `fakekete`.
  - It creates `kete`, `kete-tool` and `kete-proxy` (+ `kete-job`) the same way the Dockerfile
    does.
  - It adds `dummy0` with `198.51.100.10/24`, `198.51.100.53/24`, points `/etc/resolv.conf` at
    `198.51.100.53`, then runs the test binary.
  - The container's own netns and mount namespace keep nftables and `/proc` away from the host;
    `user.max_user_namespaces` is saved and restored by the script.
  - Tests (each gets a fresh fake platform; `t.Cleanup` removes the nft table, the cgroups and
    `/srv/kete-job`, `/var/lib/kete-*`, `/run/kete-*`):
    - `TestLifecycle` (AC1 minus the real `kete`): fake `kete` asserts its uid, NNP, oom 0,
      environment (no callback or claim token), spawns `id -un` through the **real** helper
      (a minimal protocol-v1 client in `fakekete`: HELLO → SPAWN → STDOUT/EXIT), edits
      `README.md`, writes an audit file and prints result v1. Assertions as §4, with the bundle =
      `README.md` only.
    - `TestRefuseClaimWithoutFirewall` (`NftPath` → a failing program) and
      `TestRefuseClaimWithoutProxy` (`EgressPath` → exits 2) and `TestRefuseClaimWithoutHelper`:
      zero claim requests.
    - `TestCloneWrongCommit`: `refused` / 2, no `kete` started.
    - `TestProcessesAlive`: a stray process with the tool uid outside the job cgroups →
      `push_error: processes_alive`, no bundle.
    - `TestProxyFailed`: the test SIGKILLs `kete-egress serve` mid-agent → `proxy_failed`, a
      restarted proxy reports, no bundle.
    - `TestHardDeadline`: fake `kete` hangs and the fake's `uploads` hangs → `Run` returns by
      deadline + 2 s with both cgroups empty.
    - `TestCancelled`: `events` 404 → kill, no more callbacks.
    - `TestDeadlineTooShort`: `deadline`, no `kete`.
    - `TestBundleRefusals`: fake `kete` plants a symlink / FIFO / oversize file → `symlink` /
      `unreadable`.
    - `TestCredentials` (AC4): a 10 ms `/proc` poller throughout the run (no cmdline anywhere
      holds any token; no non-root environ holds the claim, callback or clone token), plus a
      post-run `grep -rF` over `/` (excluding `/proc`, `/sys`, `/dev`) for all three, plus the
      logs and the captured stdout.
    - `TestBinaryBoot`: runs the built binary with the env, and checks `/proc/<pid>/environ` of
      the running entrypoint has no `KETE_JOB_CLAIM_TOKEN` after the re-exec.
- Helper change: `docker run --rm --privileged --cgroupns=private -v
  "$PWD/packages/kete-root-helper:/src" -w /src golang:1.26-bookworm bash scripts/integration.sh
  -test.run TestOomScoreReset` (new, alongside the existing 14), plus the existing unit command.
- CLI change: `bun run test ./test/kete/job-run.test.ts` in `packages/server/` (the new job-mode
  case: a fake git that fails if called, cwd = a prepared repo, `spec.branch` required); `bun test
  ./test/kete/job-connection.test.ts` in `packages/cli/`; `bun run typecheck` in `packages/cli`
  and `packages/server`.
- CI: `gh workflow run kete-job-entrypoint.yml --repo kete-org/ketecode --ref feature/job-entrypoint`
  then `gh run watch --repo kete-org/ketecode`.

**PR 2:**
- Local image (Apple silicon → arm64):

  ```sh
  (cd packages/cli && bun run build --target=kete-linux-arm64 --skip-web-ui)
  bash packages/kete-job-image/scripts/build.sh --load
  ```

  (the script stages `dist/cli-linux-arm64/bin/kete` into the `kete` context; needs
  `docker buildx`: `brew install docker-buildx` with Colima).
- e2e: `bash packages/kete-job-image/scripts/e2e.sh kete-job:local` (network access needed for
  AC5).
- CI: `kete-job-image.yml` (path filter: `packages/kete-job-{entrypoint,image}/**`,
  `packages/kete-root-helper/**`, `packages/kete-egress/**`, `packages/cli/src/kete/job*.ts`,
  `packages/util/src/kete/{job-mode,tool-runner,tool-helper,tool-helper-protocol}.ts`,
  `packages/server/src/kete/job-server.ts`, `packages/core/src/kete/job-*`, the workflow). It runs
  `bun install` → the linux-x64 build → buildx `--load` amd64 → `e2e.sh`; ~12-15 min, timeout 30.
  Then `gh workflow run kete-job-image.yml …`; the release dry run as in §5.

**Unverifiable without a real Fly machine** (record in the README and card):
- whether Fly's guest kernel has `nf_tables` inet with the needed features, and IPv6 egress;
- the resolver address (`fdaa::3`) and NAT64;
- whether `/proc` can be remounted with `hidepid`;
- cgroup v2 mount and delegation in the guest, and whether Fly's init owns the root cgroup;
- `/.fly/api`'s real path and permissions;
- the machine-config env names reaching the entrypoint;
- the entrypoint's exit stopping the machine;
- Fly init retaining the claim token in its own memory;
- the GHCR pull by digest;
- the real GitHub `DELETE /installation/token` and shallow `--branch` clone against github.com;
- Supabase's signed-upload method (PUT assumed, D15);
- real platform callback behaviour.

---

## 8. Upstream edits, docs and cards, verification, decisions

**Upstream edits: none.** Every changed path is Kete-owned (`packages/kete-*`,
`packages/cli/src/kete/*`, `.github/workflows/kete-*`, `docs/`). `upstream:check` must still pass.

### Files

| File | Read / change | Why |
|---|---|---|
| `packages/kete-root-helper/README.md` | read | flags, socket rules, spawn sequence, protocol v1 (the fake `kete`'s mini client) |
| `packages/kete-root-helper/internal/config/config.go` | read | `--env-allow`/`--env-set` semantics, the checks the entrypoint must satisfy |
| `packages/kete-root-helper/internal/cgroup/cgroup_linux.go` | read | `cgroupMountPoint()`/own-cgroup approach to mirror |
| `packages/kete-root-helper/internal/launch/stage2_linux.go` | **change** | F3: write `0` to `/proc/self/oom_score_adj` before `setgroups` (as root); a failure → `identity` error |
| `packages/kete-root-helper/internal/itest/scenarios_test.go` | **change** | `TestOomScoreReset`: helper at −1000, a tool reads `/proc/self/oom_score_adj` = 0 |
| `packages/kete-root-helper/scripts/integration.sh`, `internal/itest/helper_test.go` | read | harness pattern (users, cgroup layout) |
| `packages/kete-egress/README.md` | read | config v1, fds, control v1, log v1, firewall, clients |
| `packages/kete-egress/cmd/kete-egress/main.go`, `internal/control/*.go` | read | exact control JSON and start-up checks |
| `packages/kete-egress/scripts/integration.sh`, `internal/itest/{main_test,fakes_test}.go` | read | fake internet, DNS and TLS patterns, how the test "plays the entrypoint" |
| `packages/kete-egress/go.mod`, `.github/workflows/kete-egress.yml`, `kete-root-helper.yml` | read | pins and the workflow shape to copy |
| `packages/kete-job-entrypoint/**` (§1 layout, incl. `go.mod`, `go.sum`, `README.md`, `scripts/integration.sh`) | **create** | piece C |
| `.github/workflows/kete-job-entrypoint.yml` | **create** | path filter: the entrypoint, helper and egress modules + itself; gofmt/vet/`test -race`; then the Docker integration command in §7 |
| `packages/cli/src/kete/job-run.ts` | **change** | F1: `Input.jobMode?: boolean`. When true: skip `repoRoot`/`headSha`/`worktreeAdd`/cleanup/`hasUncommittedChanges`; refuse without `spec.branch`; refuse if `<cwd>/.git` doesn't exist (`deps.exists`); `isolated: true, worktree: cwd, branch: spec.branch, directory: cwd`. Keep the `location.get` + realpath check. Header comment: why |
| `packages/cli/src/kete/job.ts` | **change** | pass `jobMode: KeteJobMode.enabled(process.env)` |
| `packages/cli/src/kete/job-git.ts`, `packages/util/src/kete/job-mode.ts` | read | the guard stays; `enabled()` semantics |
| `packages/server/test/kete/job-run.test.ts` | **change** | the job-mode prepared-worktree case (+ refusals without a branch or without `.git`) |
| `packages/core/src/kete/audit.ts` (:43-46, :137-141), `packages/util/src/global.ts` | read | audit file path and the data-directory name under XDG |
| `packages/cli/src/services/standalone.ts` | read | F2 context (TCP loopback + password) |
| `docs/jobs.md` | **change** | "Job mode": `kete job run` in job mode uses cwd as the prepared worktree (no git); update the "stops at worktree creation" text |
| `docs/context/contracts.md` | **change** | new §6d "Cloud-job entrypoint (in-repo + platform)": machine-config env names, a callbacks v1 mirror (jobs.md §2 container callbacks), the bundle format (§3.8), the image paths `kete` relies on, the `kete job run` job-mode cwd rule; §6 and §8 rows |
| `docs/context/commands.md` | **change** | a "Go job entrypoint" section (unit, integration); PR 2 adds "Job image" |
| **PR 2:** `packages/kete-job-entrypoint/internal/fakeplatform/*` (+ gateway, DNS forwarder, control port), `cmd/kete-job-fake-platform/main.go`, `internal/e2e/*_test.go` | **change / create** | §4 |
| **PR 2:** `packages/kete-job-image/{Dockerfile, gitconfig, test/Dockerfile.e2e, scripts/build.sh, scripts/e2e.sh, README.md}` | **create** | §5, §4 harness |
| **PR 2:** `packages/ai/test/provider/anthropic-messages.test.ts`, `packages/core/src/tool/{shell,edit}.ts`, `packages/core/src/kete/gateway.ts:97-303` | read | SSE shapes, tool ids and args, discovery/pricing/me shapes for the fake gateway |
| **PR 2:** `packages/cli/script/build.ts`, `packages/kete-tools/src/release.ts` | read | the target name and output path; archive names; how a manual run handles the version |
| **PR 2:** `.github/workflows/kete-release.yml` | **change** | the `image` job; `publish` needs it and records the digest |
| **PR 2:** `.github/workflows/kete-job-image.yml` | **create** | path-filtered e2e |
| **PR 2:** `docs/release.md` | **change** | the image, the digest in the notes, the one-time GHCR visibility step, the dry run |

### Steps

1. PR 1 branch `feature/job-entrypoint`. Scaffold the module (`go.mod` pins = egress's), `layout`,
   `phaselog`, `bootenv`, `sysusers` with unit tests.
2. Helper F3 change + `TestOomScoreReset`; README "Spawn sequence" stage 2 gains the oom step.
3. CLI F1 change + tests; `docs/jobs.md`.
4. `cgroup`, `setup`, `launch` (stage 1/2, including `__launch` dispatch before anything else in
   `main`).
5. `egress` (config builder with host validation, nft apply/verify, listeners, log, socketpair,
   start/ready/phase/stats/stop, restart with the same fds, supervision) + unit tests.
6. `helper` start/stop.
7. `platform` client (+ the claim retry rule) + httptest units.
8. `gitops` (the env of §2.4, clone/verify/revoke/agent copy/chown walk) + fake-git units.
9. `bundle` (§3) + units.
10. `job.Run` orchestrator (§2.3 table, outcome mapping, heartbeats, backstop, hard deadline) +
    fake-deps units; `main` wiring (boot → re-exec → `__run`).
11. `fakeplatform` (callbacks, TLS, DNS, git http-backend, GHES revoke, uploads, knobs),
    `fakekete`, `scripts/integration.sh`, the `internal/itest` tests of §7.
12. README (the contract: env, layout, steps, outcome and `push_error` mapping, bundle format,
    credentials table, test commands, unverifiable items), contracts.md §6d, commands.md, the
    workflow. Run every §7 PR 1 command + `bun run lint` + `upstream:check`. Open PR 1.
13. PR 2 branch `feature/job-image` (from `main` after PR 1; per D1 after piece A's socket server).
    Extend the fake platform (gateway, DNS forward, control port, container `main`), `internal/e2e`.
14. Dockerfile, `gitconfig`, `build.sh`, the e2e test layer, `e2e.sh`; run locally (arm64).
15. `kete-job-image.yml`; the `image` job in `kete-release.yml` + digest recording;
    `docs/release.md`; the dry-run dispatch. Run the §7 PR 2 commands. Open PR 2.

### Verification

| Criterion | Command (narrowest first) |
|---|---|
| AC1 | PR 1: `…integration.sh -test.run TestLifecycle` (fake `kete`). PR 2: `bash packages/kete-job-image/scripts/e2e.sh kete-job:local`, then CI `kete-job-image.yml` |
| AC2 | `…integration.sh -test.run 'TestRefuseClaim\|TestCloneWrongCommit\|TestProcessesAlive\|TestProxyFailed\|TestHardDeadline'` + `go test ./internal/job/...` |
| AC3 | `go test -race ./internal/bundle/...` (unit, in the Docker command) + `…integration.sh -test.run 'TestBundleRefusals\|TestLifecycle'` |
| AC4 | `…integration.sh -test.run 'TestCredentials\|TestBinaryBoot'`; PR 2: the e2e token scan |
| AC5 | PR 2: `e2e.sh` (the AC5 job: four markers, no registry refusals); Bun needs piece A |
| AC6 | the unit Docker command; the helper integration; `bun run test ./test/kete/job-run.test.ts` (server) + `bun run typecheck` (cli, server); `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; the CI runs of `kete-job-entrypoint.yml`, `kete-job-image.yml`; the release dry run (§5) |

### Cards to update after the build
- **New card `job-entrypoint`** (paths `packages/kete-job-entrypoint/**`,
  `.github/workflows/kete-job-entrypoint.yml`), and in PR 2 **`job-image`** (paths
  `packages/kete-job-image/**`, `.github/workflows/kete-job-image.yml`); add both to the INDEX
  table.
- `job-mode` (F1: the job run in job mode; the "stops at worktree creation" gotcha resolved; the
  image split status).
- `cli` (the `job-run.ts` job-mode path).
- `root-helper` (F3; the "three Go pins" note; the entrypoint now exists).
- `egress` (the entrypoint's restarts across instances; which open items PR 2 closed).
- `kete-tools-ci` (the two workflows; the release `image` job; the digest).
- `contracts.md` §6d, `commands.md`, `docs/release.md`.

### Decisions for the user

- **D1. PR 2 timing vs piece A (F2).**
  - Recommended: land PR 1 now, then piece A's unix-socket server, then PR 2 with the real-`kete`
    e2e (AC1, AC5 Bun).
  - Alternative: ship PR 2 now with the e2e running the fake `kete` baked into the test layer
    (image, publish and AC5 npm/pip/cargo/git all testable), and switch to the real `kete` when A
    lands.
- **D2. Proxy hosts (F4).**
  - Recommended: restart the proxy between phases (no contract change).
  - Alternative: the platform adds `upload_host` to the claim response and the egress gains a
    `hosts` control message (egress config/control v2).
- **D3. Machine-config env names:** `KETE_JOB_ID`, `KETE_JOB_PLATFORM_URL`,
  `KETE_JOB_CLAIM_TOKEN` (the platform's Fly adapter must set these).
- **D4. Toolchains in the image:** recommended `nodejs npm python3 python3-venv python3-pip` in the
  image; cargo only in the e2e test layer (size). Or git + rg only (then AC5 is checked in the
  test layer alone).
- **D5. Users and ownership:**
  - users created at build time and verified at boot;
  - `repo` owned by the tool user, group `kete-job`, parent root 2750;
  - `/etc/gitconfig` `safe.directory` kept as belt and braces.
- **D6.** Set `user.max_user_namespaces=0` in the VM (egress README asks for it; e2e restores
  Colima's value).
- **D7.** The agent-phase tool allowlist = every built-in registry host until the platform sends a
  list.
- **D8.** A failed clone-token revoke → warn in `events` and continue, rather than failing the job.
- **D9.** Nested repositories in the worktree are skipped (not refused) and reported in `events`.
- **D10.** Over-limit bundles map to `push_error: "unreadable"` for now; ask the platform to add
  `too_large`.
- **D11.** `manifest.json` is a bare JSON array (ADR says "a list"); confirm with the platform
  validator.
- **D12.** No changes → an empty-manifest bundle is still uploaded (vs `bundle: false`); confirm.
- **D13.** Publish `linux/amd64` only (Fly is x86-64); arm64 is built locally for Colima. Or
  publish both (needs QEMU in CI).
- **D14.** `KETE_JOB_MAX_OUTPUT_TOKENS` = the constant 32000 until the claim response carries it.
- **D15.** Signed uploads use `PUT` (Supabase signed upload URL); confirm with the platform.

### Known gaps carried (not fixed here)
- The gateway key in `kete`'s env (approved interim).
- `kete`'s server is TCP loopback with a password until piece A (the tool user may reach it; F2
  blocks the real run anyway).
- Sync from a gateway key (the spec's `agent` slug) is untested.
- There's no entrypoint-owned audit/result sink.
- `openat2` for `kete`'s own files and `PR_SET_DUMPABLE` in `kete` are missing.
- All of these are piece A.

---

## PR 2 refresh (2026-10-01)

Written by the planner after piece A1 (#63) and A2 (#64). Sections §4-§7 above stay the base for
PR 2; this section overrides them only where it says so. **Still size large, needs the user's
approval** (shared contract: the image, the release workflow, and, if N1 is accepted, one new
variable in `kete`'s job environment, contracts.md §6d). **No upstream OpenCode file is edited.**
Every path is Kete-owned: `packages/kete-job-entrypoint/`, `packages/kete-job-image/` (new),
`.github/workflows/kete-*`, `docs/`.

Cards read for this refresh (all current per `stale-cards.mjs`: job-mode, job-entrypoint, sync,
gateway, cli, server-sdk, root-helper, egress, kete-tools-ci), contracts.md §2, §4-§6d, §8,
pitfalls (job items), `docs/tasks/2026-10-01-job-sync-key/{spec,result,handoff}.md`.

### R0. What A1 and A2 already settled (no entrypoint work left for them)

- **Gateway key by descriptor: already done in A1, not open.** The entrypoint passes the key on a
  pipe that becomes `kete`'s fd 3 and sets `KETE_JOB_GATEWAY_KEY_FD=3`. `KETE_GATEWAY_KEY` is
  gone from `kete`'s environment (`internal/entry/entry_linux.go:195-221` `KeteEnvList`,
  `:281-310` `StartKete`). fakekete and TestCredentials assert it. §2.5's "Gateway key" row and
  §6's `KETE_GATEWAY_KEY=<key>` are **superseded**: the key lives in the heap, then on the fd-3
  pipe, and it is in no environment. The spec's "known gap until piece A" is closed for the key.
- **`KETE_PLATFORM_URL`: already set** to the claim's `platform_url` (`entry_linux.go:219`). A2
  requires it in job mode. Port A's agent allowlist already has `[gateway, platform]` (§2.3 row
  3c), so the first sync (`GET /api/v1/sync`) and the skill-file fetches
  (`GET /api/v1/sync/skills/{id}/files`, same platform host, `util/src/kete/sync/skills.ts:175-191`)
  pass the proxy with no egress change.
- **`spec.agent`:** the entrypoint copies the claim's spec verbatim, replacing only
  `policy.timeout`, so `agent` reaches `kete`. `kete job run` is the single validator: no agent or
  an unknown agent → `refused` (2), a failed sync → `error` (1), both before any prompt
  (`cli/src/kete/job-sync.ts`). The entrypoint already sends that result verbatim. **Planner
  default: no entrypoint check of `spec.agent`** (N2).
- **F2 is gone:** `kete`'s server is a unix socket (A1), so a real `kete` runs inside the firewall.

So the entrypoint's code changes in PR 2 are only N1 (one environment line) and the fake
platform. Everything else is the image and the harness.

### R1. Changes to the entrypoint

1. **(Only if N1 is accepted.)** Add `KETE_DISABLE_MODELS_FETCH=1` to `KeteEnvList`
   (`entry_linux.go:197`), with a comment. Why: `kete serve` fetches models.dev periodically
   (`core/src/models-dev.ts:329-434`; `cli/src/server-process.ts:120`). Port A refuses that host,
   so every job would log a refused request and an error, and the e2e's "no refusals for `kete`"
   check (R4) would fail. The bundled snapshot (`core/src/models-dev/snapshot.txt`) stays the
   catalog. In fakekete's expected-env map (`internal/itest/fakekete/main.go:98-100`), add the
   variable. Update README "Environments" and contracts.md §6d's env list (librarian).
2. Update README "Credentials" and "Known gaps" wording: the gateway key is no longer an interim
   gap (it may already say so after A1; check it, don't duplicate).
3. No change to claim validation, steps, outcomes or the bundle.

### R2. Changes to the fake platform (`internal/fakeplatform`, still test support, never imports `internal/platform`)

Mirror the known-good TS fake in `cli/test/kete/job-socket.subprocess.test.ts:70-125`, with the
contract shapes from `util/src/kete/sync/contract.ts`.

- **Job fixtures** (`NewJob`): every job gets a synced agent and one skill:
  - The agent: `id` = a random v4 UUID, `slug: "e2e-developer"`, `version: 1`,
    `mode: "primary"`, `model: {provider: "anthropic", model_id: <M>}`.
    `tools: {edit: true, shell: true, web: false, skills: ["e2e-notes"], subagents: [], mcp: {}}`.
    `permissions: [{action: "*", resource: "*", effect: "allow"}]`.
    `budget: {monthly_micros: null, spent_micros: 0, period: <current YYYY-MM>}`.
  - `<M>` is an Anthropic model id that is in the bundled snapshot with `tool_call: true`. Pick it
    with `grep` in `core/src/models-dev/snapshot.txt` and keep it as one constant. The synced agent
    maps it to `kete/<M>` (`core/src/kete/sync/plugin.ts:464`).
  - The skill: `slug: "e2e-notes"`, version `1.0.0`, short instructions, `requires_mcp: []`,
    and one file `notes.md` (`size_bytes`, `sha256`, `executable: false`).
  - The spec gains `"agent": "e2e-developer"` and `"model": "kete/<M>"`.
  - `organization` = a fixed UUID and name. `policies: []`: a loaded empty set, so the fail-closed
    guard doesn't apply (`plugin.ts:327-335`).
  - New knobs: `OmitAgent` (spec without `agent`), `UnknownAgent` (spec names a slug that isn't
    synced), `SyncStatus` (e.g. 401).
- **Platform host, new GET routes** (today `platform()` accepts only `POST /api/v1/jobs/…`, so
  route GETs before that check):
  - `GET /api/v1/sync`. The Bearer must equal the job's **gateway key** (not the callback token).
    The job must be `running`. Answer 200 with the response above and an `etag`, or 304 when
    `If-None-Match` matches. Record `sync`. A wrong or missing key → 401 with the
    `ErrorResponse` shape. If the callback, claim or clone token is presented, record a leak.
  - `GET /api/v1/sync/skills/{id}/files`: the same auth. Answer
    `{skill: {id, slug}, files: [{path, size_bytes, sha256, executable, content}]}`. Record
    `skill_files`.
  - `GET /api/v1/models`: `{models: [{provider: "anthropic", model_id: <M>,
    pricing_micros_per_mtok: {input, output, cache_read, cache_write}}]}`.
    `GET /api/v1/me`: the `PlatformMe` shape (`core/src/kete/gateway.ts:57-80`). Both use the
    same auth. They're served so `kete`'s proxy log has no 404 noise; record them.
- **Gateway host (new `gateway()` handler)**:
  - Every request: `x-api-key` must equal the gateway key (the Anthropic route's auth,
    `gateway.ts:111`). Other routes' `authorization: Bearer` gets the same check.
  - `GET /anthropic/v1/models` → `{data: [{id: <M>}]}`. `GET /openai/v1/models`,
    `/gemini/v1beta/models` and `/compat/{deepseek,openrouter}/v1/models` → 200 with an empty
    list in each route's shape (the parsers are in `gateway.ts:105-136`), so discovery logs no
    failures.
  - `POST /anthropic/v1/messages`: **check `x-kete-agent-id` = the synced agent's id and
    `x-kete-agent-version` = `"1"`** (the gateway's ADR 0020 rule 9 behaviour). A missing or wrong
    header → 403 with `x-kete-error-code: kete_agent_not_found`, recorded as a contract error
    (fails the e2e).
  - Then the scripted SSE of §4: turn 1 is `tool_use` shell `id -un`; turn 2 checks the
    tool_result contains `kete-tool`, then `tool_use` edit `README.md`; turn 3 is final text.
    Every response is recorded with its headers' pass/fail.
  - Scenario `ac5`: the shell calls of §4 "AC5 scenario", one per turn, each turn checking the
    previous marker, then final text.
- **Container main, `cmd/kete-job-fake-platform/main.go`**: flags `-addr 198.51.100.10`,
  `-state <dir>`, `-scenario lifecycle|ac5|no-agent`, `-git-http-backend`. It calls
  `fakeplatform.Start` and `NewJob`, then writes `state/job.env`: `KETE_JOB_ID`,
  `KETE_JOB_PLATFORM_URL`, `KETE_JOB_CLAIM_TOKEN`, `KETE_JOB_STORAGE_HOST` (for
  `docker run --env-file`, so no token is in host argv) and `state/ca.pem`. It serves until the
  job's `finish` (or the deadline), then writes `state/calls.json`, `state/contract.json`,
  `state/leaks.json`, `state/dns.json`, the stored uploads and the tokens (`state/tokens.json`,
  for the scan only), and exits 0. **One job per fake run.** The two scenarios are two runs: this
  replaces §4's control port, which was simpler to drop.
- **DNS forwarder** (§4): names outside `*.kete.test` go to the fake container's own resolver
  (from its `/etc/resolv.conf`, Docker's `127.0.0.11` on a user network). This is for AC5's real
  registries.
- The existing integration suite (`TestLifecycle` etc.) must still pass with the richer fixtures.
  fakekete ignores sync.

### R3. The image and the test layer (§5, lean for ~4 GB free in the Colima VM)

Planner changes to §5 that keep disk low (no user decision; §5's content otherwise stands):

- **No Go stage in the Dockerfile.** `scripts/build.sh` builds the binaries with the Docker
  command PR 1 already uses: `golang:1.26-bookworm` (already pulled) with the existing
  `kete-egress-gomod`/`kete-egress-gocache` volumes, `CGO_ENABLED=0 GOOS=linux GOARCH=<arch>
  go build -trimpath -ldflags=-s` for `kete-job-entrypoint`, `kete-root-helper`, `kete-egress`
  and (test layer only) `kete-job-fake-platform`, plus `go test -c -tags e2e -o e2e.test
  ./internal/e2e`.
  - Output goes to `packages/kete-job-image/.build/<arch>/` (gitignored).
  - build.sh then stages a minimal context `.build/ctx/`: Dockerfile, `gitconfig`, `LICENSE`,
    `NOTICE`, `bin/*`, and `kete` (hard link, else copy, from `packages/cli/dist/cli-linux-<arch>/bin/kete`).
  - It runs plain `docker build -t kete-job:local .build/ctx`, so `docker-buildx` isn't needed
    locally. The release job uses `docker/build-push-action` on the same staged context.
  - This replaces §5's BuildKit named contexts and the `golang:1.26-trixie` stage.
- **Final stage** as §5: `debian:trixie-slim@sha256:…` (cargo in the test layer needs trixie's
  sparse-index cargo). `--no-install-recommends git ripgrep nftables ca-certificates nodejs npm
  python3 python3-venv python3-pip` (D4). Remove the apt lists. Users at build time; strip
  setuid/setgid bits and check none are left; `ENTRYPOINT` the entrypoint; labels.
- **Test layer `test/Dockerfile.e2e`**: `FROM kete-job:local`; `apt-get install
  --no-install-recommends cargo`; `COPY bin/kete-job-fake-platform bin/e2e.test` →
  `/usr/local/libexec/kete-e2e/`. **The fake's CA is not baked in.** e2e.sh appends the per-run
  `state/ca.pem` to a copy of the image's `/etc/ssl/certs/ca-certificates.crt` and bind-mounts
  it read-only over that path in the **job** container. Only the proxy (empty env, Go system
  roots) verifies upstreams, so the test layer is built once and reused across runs. The **fake**
  container runs from the same test image (`--entrypoint`), so no extra image is pulled.
- **Disk hygiene** (record it in the image README):
  - Before building, `docker image prune -f && docker builder prune -f`. If free space is under
    3 GB, also `colima ssh -- sudo fstrim -a`.
  - e2e.sh removes its containers and network on exit (trap). It never keeps a tagged image per
    run.
  - Build only the host arch locally (arm64); CI builds amd64.
  - **The token scan streams `docker export <job container>` into `e2e.test -test.run
    TestExportScan -export -`** (run in a throwaway container from the test image with `-i`).
    The exported filesystem is never written to disk.

### R4. End-to-end run and assertions (overrides §4 "Harness" and "End-to-end assertions" where different)

`packages/kete-job-image/scripts/e2e.sh <image> [--scenario lifecycle|ac5|no-agent|all]`
(default `all`):
1. `docker build -t kete-job-e2e -f test/Dockerfile.e2e` (context: the staged dir).
2. `docker network create --subnet 198.51.100.0/24 kete-e2e`.
3. Per scenario:
   - Start the fake: `docker run -d --network kete-e2e --ip 198.51.100.10 -v $STATE:/state
     --entrypoint /usr/local/libexec/kete-e2e/kete-job-fake-platform kete-job-e2e -scenario …`.
     Wait for `state/job.env`.
   - Build `state/ca-bundle.crt` as in R3.
   - Run the job: `docker run --privileged --cgroupns=private --network kete-e2e --ip
     198.51.100.20 --env-file $STATE/job.env -v $STATE/resolv.conf:/etc/resolv.conf:ro -v
     $STATE/ca-bundle.crt:/etc/ssl/certs/ca-certificates.crt:ro kete-job-e2e` (the image's own
     ENTRYPOINT), timeout 15 min. Capture stdout and the exit code.
   - Stream the export scan, then
     `docker run --rm -v $STATE:/state --entrypoint /usr/local/libexec/kete-e2e/e2e.test
     kete-job-e2e -test.run 'Test<Scenario>' -state /state`.
4. Save `user.max_user_namespaces` before the runs and restore it in the trap (D6). Locally use
   `colima ssh -- sudo sysctl`; in CI the runner.
5. Clean up in the trap.

Assertions (`internal/e2e`, tag `e2e`), in addition to §4's list:
- **Order:** `claim` → `events(clone)` → **`sync` (Bearer = gateway key) → `skill_files`** →
  `events(agent, effective_timeout_minutes)` → … → `result` → … → `finish` with no
  `push_error`. `sync` comes after the revoke and before the first `/anthropic/v1/messages`.
- Every `/anthropic/v1/messages` request carried `x-api-key` = the gateway key,
  `x-kete-agent-id` = the agent's id and `x-kete-agent-version` = `1`. `contract.json` is empty.
- The gateway key appeared on no platform callback (`/api/v1/jobs/…`). The callback token
  appeared on no sync or gateway request.
- The result is v1 `completed`, exit 0, `isolated: true`, `branch = spec.branch`. The tool-user
  check passed. The bundle manifest is exactly `[{"path":"README.md","mode":"100644"}]`: the
  synced skill landed under `kete`'s config dir, never the worktree.
- The proxy log has `agent`/`kete` lines to `platform.kete.test` (sync) and `gateway.kete.test`.
  **No refused line for the `kete` port** (relies on N1). No `path_shape`/`registry_cap`
  refusals.
- **Token scan:** the claim, callback and clone tokens **and the gateway key** are nowhere in the
  exported filesystem. The gateway key is allowed only in the fake's own records. Also checked:
  container stdout (phase lines only), the uploads (the audit log is redacted; the key must not
  be in it) and request URLs.
- `TestAC5`: the four markers (`AC5_NPM_OK`, `AC5_PIP_OK`, `AC5_CARGO_OK`, and git via the clone)
  are seen, plus Bun via `kete`'s own TLS through port A (sync + gateway). Each run checks
  manifest = `[]` (D12).
- `TestNoAgent` (scenario `no-agent`, cheap and fail-closed): the spec has no `agent` → the result
  is `refused` exit 2; no `/anthropic/v1/messages` call; `finish` arrives normally.

### R5. Files (PR 2 reading and change list; replaces the "PR 2" rows of §8 Files)

| File | Read / change | Why |
|---|---|---|
| `packages/kete-job-entrypoint/README.md` | read + **change** | the contract; Environments (N1), credentials/gaps wording, "How to test" points to the image e2e |
| `packages/kete-job-entrypoint/internal/entry/entry_linux.go` | read; **change** only for N1 | `KeteEnvList` (:197) |
| `packages/kete-job-entrypoint/internal/itest/fakekete/main.go` | read; **change** only for N1 | expected env map (:98-100) |
| `packages/kete-job-entrypoint/internal/layout/layout.go` | read | paths, ports, `CAPath`, kete homes |
| `packages/kete-job-entrypoint/internal/fakeplatform/{fakeplatform,ca,dns}.go` | **change** | R2: fixtures, GET routes, gateway handler, DNS forwarder, state dump |
| `packages/kete-job-entrypoint/internal/fakeplatform/{sync,gateway,scenario}.go` | **create** | R2, split to keep files small |
| `packages/kete-job-entrypoint/cmd/kete-job-fake-platform/main.go` | **create** | R2 container main |
| `packages/kete-job-entrypoint/internal/e2e/{e2e_test,scan_test}.go` | **create** | R4 asserter (tag `e2e`) and the streamed export scan |
| `packages/kete-job-entrypoint/internal/itest/scenarios_test.go`, `scripts/integration.sh` | read | the fixtures still pass; users/harness pattern for the Dockerfile |
| `packages/util/src/kete/sync/contract.ts` | read | `SyncResponse`, `SyncedAgent`, `SyncedSkill`, `SkillFilesResponse`, `ErrorResponse` |
| `packages/util/src/kete/sync/skills.ts:100-200` | read | skill files request and checks (sha256, size) |
| `packages/core/src/kete/sync/plugin.ts:1-71,320-335,455-470` | read | agent headers, empty-policies semantics, model mapping |
| `packages/core/src/kete/gateway.ts:55-140,217-303` | read | route auth and list shapes, `/api/v1/models`, `/api/v1/me` |
| `packages/cli/src/kete/job-sync.ts`, `job-spec.ts` | read | first-sync behaviour and messages; spec fields |
| `packages/cli/test/kete/job-socket.subprocess.test.ts:50-125` | read | a working TS fake for sync + gateway to mirror |
| `packages/ai/test/provider/anthropic-messages.test.ts` | read | SSE event shapes |
| `packages/core/src/tool/{shell,edit}.ts` | read | tool ids and argument names |
| `packages/core/src/models-dev/snapshot.txt` | grep only | choose `<M>` (Anthropic, `tool_call: true`) |
| `packages/core/src/models-dev.ts:320-440`, `packages/cli/src/server-process.ts:117-121` | read | N1: what the models fetch does and the variable that disables it |
| `packages/kete-egress/README.md` (Registry rules, Clients) | read | built-in registry hosts, CA variables |
| `packages/cli/script/build.ts:26-70,120-140` | read | `--target=kete-linux-<arch>`, output path |
| `packages/kete-tools/src/release.ts` | read | archive names; a manual run's version handling |
| `packages/kete-job-image/{Dockerfile,gitconfig,.gitignore,README.md}` | **create** | R3 / §5 |
| `packages/kete-job-image/test/Dockerfile.e2e` | **create** | R3 test layer |
| `packages/kete-job-image/scripts/{build.sh,e2e.sh}` | **create** | R3 build, R4 harness |
| `.github/workflows/kete-job-entrypoint.yml` | read | workflow shape, pinned action SHAs |
| `.github/workflows/kete-job-image.yml` | **create** | path-filtered e2e (below) |
| `.github/workflows/kete-release.yml` | **change** | the `image` job (§5): staged context, e2e before push, push only on `kete-v*` tags, digest into the notes |
| `docs/release.md` | **change** | image, digest, one-time GHCR visibility, dry run, disk notes |
| `LICENSE`, `NOTICE` | read (copied into the image) | licensing rule |

`kete-job-image.yml` path filter (wider than §7's, since A1/A2 put more of the job path in TS):
- `packages/kete-job-{entrypoint,image}/**`, `packages/kete-root-helper/**`,
  `packages/kete-egress/**`
- `packages/cli/src/kete/job*.ts`, `packages/cli/src/kete/dumpable.ts`
- `packages/util/src/kete/{job-*,tool-*,http-url}.ts`, `packages/util/src/kete/sync/**`
- `packages/core/src/kete/{job-*,gateway.ts,unattended*.ts,audit.ts}`,
  `packages/core/src/kete/job-request/**`, `packages/core/src/kete/sync/**`
- `packages/server/src/kete/job-*`
- the workflow itself
- plus `workflow_dispatch`

Steps: `bun install` → `bun run build --target=kete-linux-x64 --skip-web-ui` (cli) →
`build.sh --arch amd64` → `e2e.sh kete-job:local`. Timeout 30 min. Upload `state/` (minus
`tokens.json`) as an artifact on failure.

### R6. Steps (replace §8 steps 13-15)

13. Branch `feature/job-image` from `main` after #64 merges.
14. N1 (if accepted): `KeteEnvList` + fakekete + README. Run the entrypoint unit and integration
    commands.
15. R2 fake platform (fixtures, sync/skill/models/me routes, gateway with the agent-header check,
    scripted SSE for `lifecycle`/`ac5`, DNS forwarder, state dump) + the container main. Add unit
    tests in `fakeplatform` for the auth and header checks (wrong key → 401, missing agent header
    → 403 + contract error). Re-run the integration suite.
16. `internal/e2e` (R4) incl. the streamed export scan.
17. `packages/kete-job-image`: Dockerfile, gitconfig, build.sh, Dockerfile.e2e, e2e.sh, README.
    Build `kete` for linux-arm64, then `build.sh`, then `e2e.sh --scenario no-agent` (fast), then
    `--scenario lifecycle`, then `ac5`.
18. `kete-job-image.yml`; the `image` job in `kete-release.yml` + digest; `docs/release.md`.
    Run lint and `upstream:check`. Push the branch (the coordinator or the user; agents don't
    push), dispatch both workflows, open PR 2.

### R7. Verification (narrowest first; replaces the PR 2 parts of §7 and the §8 table rows)

| Criterion | Commands |
|---|---|
| AC1 (real `kete`) | Fake units: `docker run --rm -v "$PWD/packages:/src" -w /src/kete-job-entrypoint -v kete-egress-gomod:/go/pkg/mod -v kete-egress-gocache:/root/.cache/go-build golang:1.26-bookworm go test -race ./internal/fakeplatform/...` → integration still green: `docker run --rm --privileged --cgroupns=private -v "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-bookworm bash scripts/integration.sh -test.run TestLifecycle` → `(cd packages/cli && bun run build --target=kete-linux-arm64 --skip-web-ui) && bash packages/kete-job-image/scripts/build.sh --load` → `bash packages/kete-job-image/scripts/e2e.sh kete-job:local --scenario no-agent` → `… --scenario lifecycle` → CI: `gh workflow run kete-job-image.yml --repo kete-org/ketecode --ref feature/job-image` and `gh run watch --repo kete-org/ketecode` |
| AC5 | `bash packages/kete-job-image/scripts/e2e.sh kete-job:local --scenario ac5` (needs network: npm, PyPI, crates.io); then the same CI run (the workflow runs `all`) |
| AC6 | `docker run … golang:1.26-bookworm sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go vet -tags integration ./... && go vet -tags e2e ./... && go test -race ./...'` (entrypoint module); the full `scripts/integration.sh`; image builds (`build.sh`); `e2e.sh kete-job:local` (all); `actionlint .github/workflows/kete-job-image.yml .github/workflows/kete-release.yml` (via `docker run --rm -v "$PWD:/repo" -w /repo rhysd/actionlint:latest`, if not installed); `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; CI `kete-job-image.yml` and `kete-job-entrypoint.yml` green; release dry run `gh workflow run kete-release.yml --repo kete-org/ketecode --ref feature/job-image -f version=kete-v0.0.0-test.1` (the push expression is false on dispatch: it builds, runs the e2e and prints the digest, and pushes nothing) |

AC2-AC4 stay as PR 1 verified them. AC4's e2e token scan now also covers the gateway key.

### R8. Risks

- **The model must be in the binary's bundled catalog.** The gateway plugin only publishes models
  that exist in the source provider's catalog (gateway card). models.dev is unreachable through
  port A, with or without N1, so a job can only use models in the snapshot of the `kete` it ships.
  A platform agent pinned to a newer model fails the job. Write this into the image README and
  the platform hand-off; N1 only makes it explicit.
- **Disk:** the test image with cargo is roughly 1 GB on top of the ~500 MB image. With ~4 GB free,
  follow R3's prune steps. If a build fails with ENOSPC, prune and run `fstrim`; never delete
  the Go cache volumes (they save minutes).
- **Unattended denials:** if the scripted shell or edit is denied despite the agent's allow-all
  rules, add `policy.allow` rules for exactly `shell`/`id -un` and `edit`/`README.md` to the
  fake's spec (`schema/src/kete/unattended.ts` `AllowRule`). Never loosen a policy in `kete` or
  the entrypoint.
- **Platform job keys and job-scoped sync aren't built** (A2). The fake defines what the e2e
  expects: Bearer job key; org-scoped `agents` including the spec's slug. Hand those shapes to
  the platform task.
- AC5 depends on live npm, PyPI and crates.io; a registry outage fails CI. Retry once; don't
  pin the run to mirrors.

### R9. Cards to update after PR 2 (adds to §8)

- New card `job-image` (+ INDEX row).
- `job-entrypoint`: the fake platform's sync/gateway, the container main, the e2e, N1. Quick
  answer: "PR 2 done".
- `job-mode`: real-`kete` e2e exists; N1 variable.
- `egress`: piece B's open CA checks closed by AC5.
- `kete-tools-ci`: `kete-job-image.yml`, the release `image` job, the digest.
- `contracts.md` §6d (N1, the image paths), `commands.md` "Job image", `docs/release.md`.

### R10. New decisions for the user (not covered by D1-D15)

- **N1. Turn off the models.dev fetch in jobs.** Recommended: the entrypoint adds
  `KETE_DISABLE_MODELS_FETCH=1` to `kete`'s environment. This is an additive §6d change. Jobs then
  use only the binary's bundled catalog, which is already the case in practice since port A
  blocks models.dev. Alternatives: (a) leave it, accepting a refused request and an error log per
  job, and drop the e2e's "no `kete` refusals" check; (b) allow the models host on port A for
  `kete` (an egress allowlist widening, not recommended).
- **N2. `spec.agent` validated only by `kete`.** Recommended: no entrypoint pre-check. `kete job
  run` refuses (2) before any prompt, at the cost of a clone. Alternative: the entrypoint refuses
  a claim whose `spec.agent` is missing or not a slug before cloning (a second validator that
  can drift).

Everything else in this refresh is a planner choice inside the approved D1-D15: the leaner build
(no Go stage, plain `docker build`), the fake's CA bind-mounted instead of baked, one job per fake
run instead of a control port, and the streamed export scan.
