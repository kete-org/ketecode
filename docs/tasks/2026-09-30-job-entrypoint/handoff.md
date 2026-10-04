# Handoff: Cloud job entrypoint and image: piece C+D (ADRs 0018-0021, docs/jobs.md §8 items 1-2)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-09-30 coordinator

- spec.md approved by the user (2026-09-30), including the interim gap: the gateway key reaches `kete` by environment variable until piece A. Shared scout notes: docs/tasks/2026-09-30-job-image/handoff.md (Q1 steps, Q2 callback shapes, Q4 bundle, Q5 packaging, Q6 testing). Merged so far: #58 job mode part 1, #59 root helper, #60 egress proxy.
- Tooling: no Go on the Mac; Docker/Colima works. The `implementer` agent type has no shell in this session — build with a general-purpose agent following implementer.md.

## 2026-09-30 planner

- Done: plan.md written: a PR split (PR 1 = C + two small prerequisites; PR 2 = D + the e2e); a new
  separate Go module, `packages/kete-job-entrypoint`; the step table with syscalls and the failure
  mapping; the bundle reader; the fake platform and the e2e; the Dockerfile and GHCR publish; the
  commands; decisions D1-D15. Cards job-mode, root-helper, egress, cli, audit-log, kete-tools-ci,
  gateway, config-kete, brand-env and server-sdk were all current (stale-cards.mjs).
- Blocking findings, all in plan.md "Findings":
  - F1: `kete job run` refuses git in job mode (`job-git.ts:36`, called first at
    `job-run.ts:417`). Fix: a Kete-owned CLI change, "cwd is the prepared worktree", in PR 1.
  - F2: the real kete can't reach its own standalone TCP server through the firewall (the kete uid
    reaches port A only), so the real-kete e2e depends on piece A's unix socket (D1).
  - F3: tools inherit the helper's `oom_score_adj` −1000. Fix: helper stage 2 resets it, in PR 1.
  - F4: egress config v1 fixes the hosts at start, but the gateway and storage hosts arrive after
    claim and uploads. Fix: restart the proxy between phases (D2).
  - F5: the helper must start before claim (ADR 0019 rule 5), so its `--worktree-root` is the
    worktree parent.
  - F6: Docker's DNS is loopback and bridge IPs are blocked ranges, so the e2e uses
    `198.51.100.0/24` and a bind-mounted `resolv.conf`.
- Docs enough: no. Missing: `kete job run`'s job-mode behaviour at worktree creation beyond "stops
  there". The cards don't say the CLI's own git calls (`repoRoot` first) make it fail
  immediately, or that the entrypoint-made worktree has no way in (no flag or env).
- Docs enough: no. Missing: how `kete job run` reaches its standalone server (TCP loopback + basic
  password, `services/standalone.ts`) and that the egress firewall blocks it for the kete uid.
  Belongs on the job-mode or egress card.
- Docs enough: no. Missing: `oom_score_adj` inheritance from the helper to tools (the root-helper
  card is silent).
- Docs enough: no. Missing: whether egress hosts can change after `serve` starts (config/control v1
  can't; implied by the README but not stated as a constraint for the entrypoint).
- Docs enough: no. Missing: the build target names and output paths for a Linux cross-build
  (`build.ts:258` `targetName` → `kete-linux-arm64`, `dist/cli-linux-arm64/bin/kete`); the cli
  card only documents `--single`.
- Docs enough: no. Missing: the release workflow's job graph for adding an image job (the
  kete-tools-ci card has no job list); read `kete-release.yml` directly.
- Docs enough: no. Missing: the platform's machine-config env names and the bundle
  `manifest.json` exact top-level shape. Neither is defined in the platform docs; they're
  decisions D3 and D11.
- Docs enough: yes: root-helper and egress READMEs (flags, fds, control, clients), the jobs.md
  callbacks, and ADR 0021 rules 4-6 were sufficient for the entrypoint and bundle design.
- Open for the user: D1-D15 in plan.md (the most important are D1 on PR 2 timing vs piece A, D2 on
  proxy restarts vs a contract change, D3 on the env names and D4 on image toolchains).

## 2026-09-30 coordinator

- plan.md approved by the user (2026-09-30): D1 order PR 1 (entrypoint) → piece A unix-socket server → PR 2 (image + e2e with the real kete); D2 restart the proxy between phases (no job process running, same ports and log); D4 image ships Node/npm and Python/pip, cargo only in the test layer; D3 and D5–D15 at the planner defaults. Build PR 1 now.

## 2026-10-01 implementer (PR 1 build)

- Done: PR 1 as plan.md §1 describes; nothing from PR 2. **No upstream file edited.** Nothing staged or committed.
  - New module `packages/kete-job-entrypoint/` (go.mod pins = egress's; go.sum copied): `cmd/kete-job-entrypoint` (`__launch` → `__run` → boot), `internal/{bootenv,layout,sysusers,setup,cgroup,launch,egress,helper,platform,gitops,bundle,job,phaselog,entry,fakeplatform}`, `internal/itest` (+ `itest/fakekete`), `scripts/integration.sh`, `README.md` (the contract), `.gitignore`.
  - F3: `packages/kete-root-helper/internal/launch/stage2_linux.go` (stage 2 writes and reads back `0` in `/proc/self/oom_score_adj` before `setgroups`; failure → `identity`), `internal/itest/scenarios_test.go` (`TestOomScoreReset`), README "Spawn sequence" stage 2.
  - F1: `packages/cli/src/kete/job-run.ts` (`Input.jobMode`: no git call, `spec.branch` and `<cwd>/.git` required, `isolated: true`, `worktree` = `directory` = cwd, cleanup never discards; header comment), `job.ts` (`jobMode: KeteJobMode.enabled(process.env)`), tests in `packages/cli/test/kete/job-run.test.ts` (4, fake git that throws) and `packages/server/test/kete/job-run.test.ts` (2: a real run in the prepared worktree with a throwing git; the two refusals); `docs/jobs.md` "Job mode".
  - `.github/workflows/kete-job-entrypoint.yml` (path filter: entrypoint, helper, egress modules + itself; gofmt/vet/vet -tags integration/test -race; the integration suite in a privileged `golang:1.26-bookworm` container with `--cgroupns=private`).
- Checks (real counts; every Go command in `golang:1.26-bookworm` with the `kete-egress-gomod`/`kete-egress-gocache` volumes):
  - Entrypoint: gofmt clean; `go vet ./...` and `go vet -tags integration ./...` clean; `go test -race -count=1 ./...` 12 packages ok (bootenv, bundle, cgroup, egress, gitops, helper, job, launch, phaselog, platform, setup, sysusers).
  - Entrypoint integration (`scripts/integration.sh`), 3 full runs, each 13/13 top-level tests PASS (+3 subtests): TestLifecycle, TestRefuseClaimWithout{Firewall,Proxy,Helper}, TestCloneWrongCommit, TestProcessesAlive, TestProxyFailed, TestHardDeadline, TestCancelled, TestDeadlineTooShort, TestBundleRefusals/{symlink,fifo,oversize}, TestCredentials, TestBinaryBoot. ~25 s per run.
  - Mutation check: with the F3 reset disabled, entrypoint TestLifecycle FAILS ("checks failed: tool-oom") and helper TestOomScoreReset FAILS (`-1000`); restored, both pass.
  - Helper: gofmt/vet/vet -tags integration/unit ok; integration 15/15 PASS (14 existing + TestOomScoreReset).
  - CLI: `bun run typecheck` exit 0; `bun test ./test/kete` 122 pass 0 fail (4 new job-mode tests). Server: `bun run typecheck` exit 0; `bun run test ./test/kete` 21 pass, 1 skip (pre-existing), 0 fail (job-run.test.ts 8 pass, 2 new).
  - Root `bun run lint`: 0 warnings, 0 errors. `bun run --cwd packages/kete-tools upstream:check`: passed.
- Decisions / deviations from plan.md (all in the README):
  - All Go builds and tests use `golang:1.26-bookworm` (disk; the plan named trixie): git 2.39, not 2.47. The workflow uses bookworm too.
  - `--tool-gid` is the `kete-job` gid, not the tool user's own: the helper runs tools with `setgroups([])`, so with its own gid the tool user couldn't enter the root:kete-job 2750 worktree parent (`openat2` EACCES).
  - `GIT_INDEX_FILE` is set only for the bundle's listing; the agent copy (`checkout -b`) needs its own index, else the agent's working copy would have none.
  - `ls-tree` adds `-l` (sizes): a tracked file of the same size is hashed in full (streamed) to decide "unchanged", so a large unchanged file neither fails the limits nor loads into memory.
  - Heartbeats run from claim through report (every `Heartbeat`), not only in the agent phase, so a long clone stays inside the 60 s rule; `kete_cgroup_extra` only in the agent phase. The first agent event (with `effective_timeout_minutes`) is sent before the heartbeat switches to `agent`.
  - An untracked FIFO/socket is invisible to `git ls-files` and so neither read nor bundled; a FIFO at a tracked path is refused `unreadable` (unit and integration tests).
  - When the proxy died or the claim was invalid (instance 1 has no report hosts), the report phase restarts a report-only instance (root → platform) before `result`; then instance 3 adds the upload host.
  - Audit upload cap 20,000,000 bytes (the platform's ≤ 20 MB) rather than the audit writer's 20 MiB.
  - The fake `kete`'s scenario is the spec's prompt (`lifecycle`, `hang`, `symlink`, `fifo`, `oversize`); it also checks the tool's `oom_score_adj` through the helper (F3).
  - In-process integration runs call `entry.Main` with test timings; the test binary is its own launch stage 2 (`__launch` in `init`). TestBinaryBoot runs the real binary in its own cgroup `R/bin-boot`.
  - TestCredentials' disk search covers `/run /var /srv /tmp /etc /root /home` (not `/`, which holds the bind-mounted sources and Go caches); plus every cmdline (all tokens) and every non-root environ (claim, callback, clone tokens) every 10 ms, the logs and stdout.
  - `--env-allow` = `TERM,COLORTERM,NO_COLOR,FORCE_COLOR,CI,COLUMNS,LINES,PAGER,GIT_PAGER,GIT_EDITOR,EDITOR` (the client forwards kete's own env filtered by this list, so it must never name a KETE_*, proxy or CA variable).
- Not done (rule: implementers never edit docs/context): `docs/context/contracts.md` §6d and `commands.md` ("Go job entrypoint") from plan §8 Files, and the cards listed under "Cards to update" — for the librarian. The README carries the full contract (env names, layout, steps, outcomes/push_error, bundle format, credentials).
- Unverified: the `kete-job-entrypoint.yml` CI run (nothing pushed; `gh workflow run` not dispatched); everything in README "Not verified without a real Fly machine"; the real `kete` (piece A).
- Read beyond plan.md's list (to check shapes): kete-code-platform `docs/jobs.md` §2 callbacks (:178-206), `packages/util/src/kete/tool-helper.ts` (env filtering), `core/src/kete/audit.ts` (path, caps), `util/src/kete/brand.ts` (`appDirectory`), `util/src/kete/runtime-registration.ts` and `core/src/kete/gateway.ts` (env names).

## 2026-10-01 implementer (security review minors)

- Done: findings 1-8 applied on feature/job-entrypoint; nothing staged or committed; no upstream file touched.
  1. **processes_alive restarted the proxy** (`job.go` finalize): with a job process alive the proxy is never restarted. `result`, the events and `finish {processes_alive}` go through the instance already in the report phase (root → platform only), and `uploads` is not called (an events message says why). With no such instance (the proxy died too), nothing is reported and the entrypoint exits 1 (the sweeper marks it lost). Safe option chosen: no restart, ever, while a job uid lives. Tests: job `TestProcessesAlive` (2 instances, no uploads/PUT), new `TestProcessesAliveProxyDead`; integration `TestProcessesAlive` now asserts zero `uploads` calls. README §Steps 9.
  2. **Upload host pinned:** new machine-config variable `KETE_JOB_STORAGE_HOST` (bootenv: required plain DNS host; carried through the handover). `ParseUploads` requires every URL to be https, port 443 or none, on exactly that host. `Claim.Validate` refuses (`storage_host`) a storage host equal to the gateway, clone or clone-API host (or empty). Tests: bootenv refusals, `TestParseUploads` (another host, port, IP; `:443` accepted), `TestValidateClaim` (gateway/github.com/api.github.com/empty), job `TestStorageHostClashRefused`; the integration suite and TestBinaryBoot pass it. README "Machine configuration".
  3. **Hard-deadline order:** `deadline()`/new `abort()` SIGKILL the helper first, then `cgroup.kill` both job cgroups, then close the proxy. Test: job `TestSignalAbort` asserts the order `helper-kill,cgroup-kill`.
  4. **hashFile honours the deadline:** a `ctxReader` checks `ctx.Err()` on every Read; a cancelled hash returns the context error (not `unreadable`). Test: `TestHashFileHonoursContext` (cancel mid-read of a 1 GiB reader stops within a few reads).
  5. **Decimal limits:** `BundleMaxFile` 1,000,000 and `BundleMaxBinaryFile` 256,000 (tar 20,000,000, gzip 10,000,000, audit 20,000,000, proxy log 10,000,000 were already decimal). README "Bundle" step 6 states the convention. Unit test limits and oversize fixtures updated.
  6. **TestCredentials:** the poller also checks that the gateway key is in no environ of any process whose uid isn't kete (root included), and after the run every `/var/log/kete-job/*.stderr` (proxy, helper, kete; ≥ 3 files asserted) is searched for all four tokens.
  7. **Error class on failed lines:** `phaselog.FailErr` adds `class` (fixed: `errno`, `http`, `git`, `exit`, `launch_<code>` from a fixed set, `timeout`, `cancelled`, `other`) and a number `errno` (the errno, HTTP status or exit code), never error text; `launch.Error`, `platform.StatusError`, `gitops.Error` implement `ErrorClass()`. Used by entry's setup steps and every job.go failure that has an error. Test: `TestFailErr` (wrapped secret text never printed). The integration suite's phase-line check accepts only these fields.
  8. Nits: the agent loop's planned proxy exit sets its channel to nil instead of `continue`; `GatewayURL` is the normalised URL; `CheckPath` refuses control characters (< 0x20, 0x7f) and backslashes as `unreadable` (`TestCheckPathControlAndBackslash`); SIGTERM/SIGINT abort logs `abort`/`signal` (and a claim failed by the signal logs code `signal`), distinct from `deadline`/`timeout` (`TestSignalAbort`).
- Checks (golang:1.26-bookworm, same cache volumes): gofmt clean; vet and vet -tags integration clean; `go test -race -count=1 ./...` 12 packages ok. Integration suite 3 runs, each 13/13 top-level tests PASS (+3 subtests). Helper integration 15/15 PASS. cli `bun test ./test/kete/job-run.test.ts` 29 pass 0 fail; server `bun run test ./test/kete/job-run.test.ts` 8 pass 0 fail. Root lint 0/0. `upstream:check` passed.
- Open for the platform: `KETE_JOB_STORAGE_HOST` is a new D3 variable the Fly adapter must set; contracts.md §6d (librarian) should list it.

## 2026-10-01 planner (PR 2 refresh)

- Done: appended "## PR 2 refresh (2026-10-01)" to plan.md (R0-R10); earlier sections untouched.
  Cards job-mode, job-entrypoint, sync, gateway, cli, server-sdk, root-helper, egress and
  kete-tools-ci are current (stale-cards.mjs).
- Finding: the gateway key by descriptor and `KETE_PLATFORM_URL` were **already** done in the
  entrypoint by A1 (`entry_linux.go:195-221,281-310`; fakekete asserts fd 3 and no
  `KETE_GATEWAY_KEY`). The entrypoint's only PR 2 change is optional N1. `spec.agent` passes
  through verbatim; `kete job run` validates it.
- Planner choices (inside D1-D15): no Go stage in the Dockerfile (build.sh compiles with
  golang:1.26-bookworm and the existing cache volumes, then a plain `docker build` of a staged
  context); the fake's CA is bind-mounted into the job container's CA bundle, not baked; the fake
  runs from the test image; one job per fake run (no control port); the `docker export` token
  scan is streamed, never written to disk; a cheap `no-agent` scenario.
- Docs enough: no. Missing: models.dev fetching in job mode. No card says `kete serve` fetches
  models.dev periodically (`core/src/models-dev.ts:329-434`, `cli/src/server-process.ts:120`) or
  that port A refuses it, so a job's catalog is the binary's bundled snapshot. Belongs on the
  job-mode and gateway cards (and pitfalls: a model newer than the snapshot can't run in a job).
- Docs enough: no. Missing: the fail-closed policy guard is keyed on a loaded cache, not on
  non-empty `policies`, so `policies: []` counts as loaded (`core/src/kete/sync/plugin.ts:327-335`).
  Belongs on the sync card.
- Docs enough: no. Missing: the fake platform (`internal/fakeplatform/fakeplatform.go:354`)
  routes only `POST /api/v1/jobs/…` on the platform host and 404s the gateway host; the
  job-entrypoint card doesn't list its routes.
- Docs enough: yes: contracts §2/§6d and the A2 result gave the sync shapes, the agent-header
  rule and the env; `job-socket.subprocess.test.ts` is a working TS model for the fake.
- New decisions for the user: N1 (`KETE_DISABLE_MODELS_FETCH=1` in `kete`'s job env) and N2
  (`spec.agent` validated only by `kete`; planner default: no entrypoint check).

## 2026-10-01 coordinator

- PR 2 refresh approved by the user (2026-10-01): N1 = the entrypoint sets `KETE_DISABLE_MODELS_FETCH=1` for `kete` (contracts §6d, additive); N2 = `spec.agent` validated by `kete` only, no entrypoint check. Build PR 2 on `feature/job-image`.

## 2026-10-01 builder (PR 2, piece D)

- Done (nothing staged or committed; **no upstream file edited**; `upstream:check` passed):
  - N1: `KETE_DISABLE_MODELS_FETCH=1` in `KeteEnvList` (`internal/entry/entry_linux.go`), fakekete's expected env, module README "Environments", `docs/context/contracts.md` §6d (additive item + an "Image" bullet with the paths/digest pinning). N2: no entrypoint check.
  - R2 fake platform: `internal/fakeplatform/{sync,gateway,state}.go` (new), `fakeplatform.go` (knobs `Scenario`/`OmitAgent`/`UnknownAgent`/`SyncStatus`, synced org/agent/skill ids, spec `agent` + `model: kete/claude-haiku-4-5`, GET routes before the jobs check, gateway host, header-leak checks, `Done()`), `dns.go` (`Config.Forward`, concurrent UDP, UDP/TCP forwarding), `fakeplatform_test.go` (wrong key 401, callback token on sync = leak, gateway key on a callback = leak, missing/wrong agent header 403 + `kete_agent_not_found` + contract error, the lifecycle/AC5 scripts, SSE). Model: `claude-haiku-4-5` (in the bundled snapshot, `tool_call: true`).
  - `cmd/kete-job-fake-platform/main.go` (one job per run; `job.env` 0644 since the host's docker CLI reads it in CI — test credentials only; writes state on finish, deadline or SIGTERM).
  - `internal/e2e/{e2e_test,scan_test}.go` (tag `e2e`): TestLifecycle, TestAC5, TestNoAgent, TestExportScan (streamed, chunked with overlap; checked by hand that it catches a token across a 1 MiB boundary).
  - `packages/kete-job-image/`: Dockerfile (trixie-slim pinned by digest, D4 packages, users at build time, setuid strip + build-time checks, no build stage), `gitconfig`, `.gitignore` (`.build/`), `test/Dockerfile.e2e` (cargo + fake + asserter), `scripts/build.sh`, `scripts/e2e.sh` (`E2E_STATE`, `E2E_JOB_TIMEOUT`, `E2E_KEEP_LOGS`), README.
  - `.github/workflows/kete-job-image.yml` (new, R5 path filter); `kete-release.yml` `image` job + publish "Record the job image digest"; `kete-job-entrypoint.yml` gains `go vet -tags e2e`; `docs/release.md`.
- Deviations from the plan (all deliberate):
  - Order assertion: the entrypoint sends `events(agent, effective_timeout_minutes)` right **after** starting `kete` (`job.go:525-531`), so `sync` races it. The e2e asserts `revoke < sync < skill_files < first messages` and exactly one eff event, not R4's "sync → events(agent, eff)".
  - Release `image` job pushes **the image the e2e tested** (`docker tag` + `docker push`, token to `docker login --password-stdin`, digest from `RepoDigests`) instead of re-building with `docker/build-push-action`; no third-party actions to pin. Dispatch runs build + e2e and push nothing.
  - The `no-agent` scenario uploads no audit log (kete refuses before any session), so its expected PUTs are bundle + proxy log.
  - The fake answers any model request without both `shell` and `edit` tools with plain text (title/summary requests), and checks the model id; none such were seen.
  - e2e.sh saves/restores `user.max_user_namespaces` through a privileged container (works on Colima and CI alike) rather than `colima ssh`/`sudo`.
- **STOP item — needs a user decision (egress allowlist): cargo can't download crates through the proxy.** Real cargo (trixie's) fetches `GET https://static.crates.io/crates/itoa/1.0.11/download` (the sparse index's `dl` has no markers, so cargo appends `/{crate}/{version}/download`). The egress's built-in crates shapes allow only `crate_file` `/crates/<name>/<name>-<ver>.crate` on the static host and `api_download` `/api/v1/crates/<name>/<ver>/download` (`kete-egress/internal/registry/registry.go:93-94`), so it's refused `403 path_shape`. The index fetch (`index.crates.io/config.json`, `/it/oa/itoa`) passes, so cargo **does** accept the proxy's name-constrained CA. Fix would be one new built-in shape (e.g. `crate_download`: `/crates/<name>/<ver>/download`) in kete-egress + README + a test — a narrow widening of a security allowlist in another module, so not done here. Until decided, `e2e.sh` (all/ac5), `kete-job-image.yml` and the release `image` job fail on TestAC5 (`AC5_CARGO_OK` missing + the path_shape refusal). npm, pip, git and Bun (kete) all pass through the proxy with its CA.
- Observed once, not reproduced (2 later AC5 runs with the same command, plus one diagnostic run, were clean): in the very first AC5 run the npm tool result lacked its trailing `AC5_NPM_OK` line and both the npm and pip results had no `exit` field (kete's shell `finish("exited")` without a code, i.e. `exitCode` failed: a null code/signal or a session error). The helper sends `EXIT` before draining stdout/stderr by design (`kete-root-helper/internal/server/conn_linux.go:263-270`, client grace 1 s, `util/src/kete/tool-helper.ts:599-608`). Possibly a race in the job tool path (piece A/helper); worth a look if CI flakes on AC5 markers.
- Checks (Colima arm64; all Go in `golang:1.26-bookworm` with the cache volumes):
  - Entrypoint: gofmt clean; `go vet ./...`, `-tags integration`, `-tags e2e` clean; `go test -race -count=1 ./...` all packages ok (incl. new fakeplatform tests).
  - Integration `scripts/integration.sh` (full): 13/13 top-level PASS.
  - Image: `build.sh` builds (`kete-job:local`, ~1 GB on disk); kete built with `bun run build --target=kete-linux-arm64 --skip-web-ui` (it reorders `packages/cli/package.json`; reverted, not part of the change).
  - e2e: `no-agent` PASS (refused/2 from the real kete), `lifecycle` PASS (real kete: sync + skill files with the gateway key, 3 scripted model calls with agent headers, `id -un` = kete-tool, edit, bundle = README.md only, audit `run ended completed`, export scan clean), `ac5` **FAIL** (cargo path_shape above; npm/pip markers and their registries OK).
  - `actionlint` (rhysd/actionlint, image removed afterwards) on kete-job-image.yml and kete-release.yml: clean. Root `bun run lint`: 0/0. `upstream:check`: passed.
  - Not run: `gh workflow run` for kete-job-image / kete-job-entrypoint / the release dry run (coordinator runs CI after pushing). amd64 image build (CI only).
- Docs enough: no. Missing: the egress registry card/README doesn't say real cargo uses `static.crates.io/crates/<name>/<ver>/download` (README line ~132 defers "whether real cargo fits" to this e2e). Belongs on the egress card once decided.
- For the librarian: new card `job-image` (+ INDEX row), `job-entrypoint` (fake's sync/gateway routes, container main, e2e, N1), `job-mode` (N1, real-kete e2e), `egress` (AC5 CA checks closed for npm/pip/git/Bun; cargo shape open), `kete-tools-ci` (kete-job-image.yml, release `image` job, digest), `commands.md` "Job image".

## 2026-10-01 coordinator (PR 2 close)

- User approved: cargo `crate_download` shape in kete-egress; investigating and fixing the root-helper lost-tail race (half-close + 5 s linger). Rebuilt image; e2e all three scenarios PASS. Reviewer: approve; minors fixed (image needs extension; no `|| true` on credential cleanup; crate versions start alphanumeric).
