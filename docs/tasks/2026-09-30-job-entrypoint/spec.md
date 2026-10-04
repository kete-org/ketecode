# Spec: Cloud job entrypoint and image (pieces C+D)

- Task: `docs/tasks/2026-09-30-job-entrypoint` · Size: large · Created: 2026-09-30
- Status: approved (user, 2026-09-30)

## Goal
A container image that runs one cloud job end to end: its root entrypoint sets up the machine,
guards the network, claims the job from the platform, clones the repository, runs `kete job run`
with tools under the tool user, and reports the result, audit log and a safe change bundle back —
proven against a fake platform, locally and in CI. Pieces C and D of the container work (umbrella:
`docs/tasks/2026-09-30-job-image/`; piece B, the egress proxy, is merged as #60). Requirements:
kete-code-platform `docs/jobs.md` §8 items 1–2 (and the setup parts of 3–10), ADRs 0018 (lifecycle,
timeouts), 0019 (rules 4–8), 0020 (credentials), 0021 (rules 4–5).

## Scope
### C — the entrypoint (Go, next to the helper and the proxy; the plan picks the module layout)
In order, as root, failing the job with a clear reason at each step:
1. **Machine setup:** the `kete`, tool and proxy users and a shared group; the worktree parent
   (setgid, shared group) outside `kete`'s `0700` data dir; the `kete` and tool cgroups with
   `pids.max`/`memory.max`; `oom_score_adj -1000` for itself, the helper and the proxy;
   `fs.protected_hardlinks`/`protected_symlinks` = 1; `/proc` with `hidepid=2`.
2. **Network guard:** apply the ruleset from `kete-egress nft`; bind ports A/B/R; start the proxy with
   its fds and control socket; install its CA into per-client settings only. Abort before `claim`
   if any of this fails.
3. **Claim:** `POST …/claim` with the claim token (from the machine's configuration); unset the token;
   keep the callback token and gateway key in the entrypoint's memory only.
4. **Clone** (proxy phase `clone`): shallow clone of `base_sha` into a root-owned pristine copy (token
   via `http.extraHeader`, never on disk, in a URL or argv; no submodules or LFS); check `HEAD` =
   `base_sha`; revoke the token; make the agent's separate copy (`--no-hardlinks`, own objects);
   git `safe.directory` for the worktree parent; every root git call with the hardened environment
   (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`, hooks and fsmonitor off).
5. **Run** (proxy phase `agent`): start the root helper; write the job spec; run `kete job run` as the
   `kete` user with `no_new_privs`, `KETE_JOB_MODE=1`, `KETE_JOB_TOOL_SOCKET`,
   `KETE_JOB_MAX_OUTPUT_TOKENS`, `runtime.type = kete_cloud`, and the timeout
   `min(policy.timeout, deadline − now − 5 min)`; `kete`'s stdout/stderr to a file in the VM;
   heartbeats (`events`) at least every 60 s, including `effective_timeout_minutes` and
   `kete_cgroup_extra`; supervise the proxy (its exit ends the job as `proxy_failed`).
6. **Report** (proxy phase `report`): close the helper's socket; `cgroup.kill` both cgroups and
   confirm no process is left within 30 s (else `processes_alive`); send `result` (the
   `kete job run --json` object, verbatim); build the bundle with the safe reader (ADR 0021 rule 5:
   git lists paths against the pristine git-dir, root reads each with `O_NOFOLLOW`, regular files
   only, size limits, gzip tar with `manifest.json`); `uploads` then upload audit log, proxy log and
   bundle to the signed URLs; `finish` (with `push_error` when the bundle was refused).
7. A hard deadline across all steps.

**Runtime gaps (piece A) are not in this task.** Until they land, the entrypoint passes the gateway
key the way the runtime reads it today (an environment variable to `kete` only) and records that as
a known gap to close in piece A; nothing else is weakened.

### D — the image and the harness
- **Dockerfile:** a minimal Debian base; Linux `kete` (from `packages/cli` build), the root helper,
  the proxy, the entrypoint; the distro's `git`, `ripgrep`, `nftables`, `ca-certificates`; `rg` and
  `git` on the tool user's `PATH`; the entrypoint as `ENTRYPOINT`. No secrets, no CA key.
- **Publishing:** a workflow step that builds the image on `kete-v*` release tags and pushes it to
  GHCR, recording the digest in the release notes (the platform pins by digest). Not run for
  ordinary PRs.
- **Fake platform:** a small test server implementing claim, events, result, uploads and finish
  with the exact shapes, serving a local bare git repository to clone over HTTPS, a fake gateway
  (a scripted model that makes a shell tool call and edits a file), fake registries, and signed
  upload URLs; with its own test CA and DNS names, so the real proxy and firewall run unmodified.
- **End-to-end test:** runs the built image against the fake platform (Colima locally; a
  path-filtered CI workflow), asserting the whole lifecycle and the edited file arriving in the
  bundle. Also covers piece B's open checks: Bun/Node, pip, git and cargo accepting the proxy's CA,
  and a real package install through the proxy.

## Out of scope
- Piece A (unix-socket server, gateway key by descriptor, `openat2` for `kete`'s own files,
  non-dumpable, entrypoint-owned audit/result sink).
- The platform's job API, Fly adapter and real deployment; verification on Fly's kernel (NAT64,
  resolver address) — needs a real Fly machine.

## Acceptance criteria
- [ ] AC1: Against the fake platform, a job runs start to finish: claim, clone, a shell tool call as
  the tool user, a file edit, heartbeats, result, uploads (audit log, proxy log, bundle), finish —
  and the bundle contains exactly the edited file.
- [ ] AC2: The entrypoint refuses to claim if the firewall or proxy can't be set up; fails the job
  on a clone at the wrong commit; reports `processes_alive` when a process survives; reports
  `proxy_failed` when the proxy dies; ends at the hard deadline.
- [ ] AC3: The bundle reader refuses symlinks, special files and oversized files, never follows a
  symlink, never runs git on the agent's copy, and reports deletions (unit and integration tests).
- [ ] AC4: Credentials: the claim token is gone after claim; the clone token never appears on disk,
  in argv or in logs; the callback token never reaches `kete` or the tool user.
- [ ] AC5: Bun/Node, pip, git and cargo work through the proxy with its CA (at least one real
  package install per ecosystem the image supports).
- [ ] AC6: The image builds; the publish step works on a test tag (or dry run); go vet/test,
  integration and end-to-end suites pass locally and in CI; lint; `upstream:check`.

## Risks and constraints
- **Security-critical:** the entrypoint holds every credential and runs as root; keep it small and
  tested like the helper.
- **Size:** likely two PRs (C, then D + e2e); the plan decides.
- **CI minutes:** the end-to-end workflow is path-filtered and builds the image once.
- **Known gap until piece A:** the gateway key reaches `kete` as an environment variable.
