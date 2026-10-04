# Handoff: Job mode piece A3: openat2 confinement and entrypoint-owned audit/result sink

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-01 scout

(Summary pasted by the coordinator.)

- Q1 requirements → docs enough: no — missing: platform docs name no tool list, no NO_XDEV, no truncate/rewrite rule for the sink (user decides in spec). Text: kete-code-platform docs/jobs.md:396-421, ADR 0019:100-113, ADR 0021:182-185.
- Q2 file tools → docs enough: no — missing: the file-tool seam and job-mode injection point (job-mode card). read/write/edit/patch → `Environment.files` → `makeLocalDriver` (node:fs, follows symlinks); seam `core/src/environment/environment.ts:24-33`, replaceable via `KeteJobServer.replacements`; glob/grep via `FileSystem`/`FSUtil`/`FileSystemSearch` (file-access.ts:95, filesystem.ts:81). No openat2 path in TS; bun:ffi precedents `cli/src/kete/dumpable.ts`, `core/src/util/process-lock-ffi.bun.ts:30-34` (job-mode card).
- Q3 audit/result → docs enough: no — missing: what the entrypoint does with audit/result (job-entrypoint, audit cards). Audit writer `core/src/kete/audit.ts:137-168,233-265,345-360`; entrypoint reads `AuditRel(sessionID)` from kete's data dir and uploads (`job.go:821-828`); result = kete stdout to root-created `/var/log/kete-job/kete.stdout` (`entry_linux.go:304-314`).
- Q4 layout → docs enough: yes. Worktree `/srv/kete-job/work/repo` (tool:kete-job), parent 2750 root:kete-job, kete home `/var/lib/kete-job/kete` 0700 (`layout.go:35,86,124-141`).

## 2026-10-01 coordinator

- spec.md approved by the user (2026-10-01) with D1 = confine all in-process worktree access (file tools + glob/list/search), D2 = a pipe as the audit sink, D3 = the result stays on kete's stdout.

## 2026-10-01 planner

Done: plan.md written (Large; needs approval). No upstream edits. The routing is three `LayerNode` replacements in `server/src/kete/job-server.ts`: `Environment.node` (openat2 driver), `FSUtil.node` (path-aware wrapper) and `FileSystemSearch.node` (`fff: false` → ripgrep through the helper). Cards checked with stale-cards.mjs: all current.

Decisions proposed for the user (not settled by the spec): N1 the audit pipe relayed by `kete job run` (the serve child writes to its own fd 4); N2 `audit_log` left out of the job result; N3 the job-mode cap counted in bytes, 19,000,000 detail + 1,000,000 reserve, hard 20,000,000; N4 the extent of FSUtil confinement (content, listing and realPath routed; mutations refused; metadata delegated); N5 the entrypoint at the cap or with an empty pipe. Full text is in plan.md "New decisions".

Docs enough: no. Missing:
- job-mode card: the in-process file-access map. Which paths read the worktree in-process: Environment local driver, FSUtil (read tool AGENTS.md discovery, `config/plugin/instruction.ts`, `session/instructions.ts`, `project.ts:258`, `vcs.ts:146`, `snapshot.ts:94`), `FileSystemSearch`'s native `fff` indexer; and that glob/grep reach the worktree via a ripgrep subprocess, with only a type check through `Environment.files`. Also: there is no "list" tool in v2 (a read of a directory = `Environment.files.list`).
- job-mode card: how `Environment.node`/`FSUtil.node`/`FileSystemSearch.node` can be replaced (location vs global tags, `FSUtil.layer` exported for wrapping, derived helpers bypass overrides).
- audit-log card: the writer's 20 MiB cap counts UTF-16 length (`serialized.length`), not bytes, and `permission`/`run` lines are uncapped; the card says "20 MB".
- cli card / audit-log card: `kete job run` builds its result from the audit file (`job-run.ts:285-300,656-674`), so a sink with no file needs a reader path for the parent.
- job-entrypoint card: how the audit is read and uploaded (`entry_linux.go:417-425` `OpenAudit` with `layout.AuditRel`, `job.go:815-829`), and that the e2e lifecycle can't leave a symlink in the worktree (the bundle refuses it with `push_error: symlink`).
- No card says the effect `ChildProcess` `additionalFds` can only create new pipes (it can't pass an existing fd), which is why the relay is needed.

Risks for the implementer:
- `O_DIRECTORY`/`O_NOFOLLOW` values differ between x86_64 and arm64 (the plan gives a per-arch table and a test against `fs.constants`).
- The serve child's fd 4 from Node/Bun spawn is likely a socketpair, not a FIFO (accept both in the child, FIFO only in the parent).
- Job mode can no longer start on macOS: `job-socket.subprocess.test.ts` must branch.
- Existing server tests that build a job-mode server need a fake opener.
- The FSUtil wrapper may refuse a legitimate in-worktree FSUtil write nobody has found yet; the e2e lifecycle is the backstop.

## 2026-10-01 coordinator

- plan.md approved by the user (2026-10-01) with N1–N5 at the planner's recommendations (relay the audit pipe through `kete job run`; no `audit_log` in the job-mode result; byte cap 19 MB + 1 MB reserve, 20 MB hard stop interrupts; FSUtil: confine content reads, listings, realPath, refuse writes, metadata passes; no upload with a fixed note when empty or over cap). Build started.

## 2026-10-01 implementer

Done: plan.md steps 1–13, built as planned. **No upstream file edited** (the only non-Kete paths touched are docs: `docs/jobs.md`, `docs/upstream-patches.md`, `docs/context/contracts.md`). Not committed.

New: `util/src/kete/{linux-ffi,confined-fs,job-fs-util,job-audit-sink}.ts`, `core/src/kete/job-files.ts`; tests `util/test/kete/{confined-fs,confined-fs-linux,job-fs-util,job-audit-sink}.test.ts` + `fixture/fake-syscalls.ts`, `core/test/kete/{job-files,job-files-linux,audit-sink,job-fs-sites}.test.ts`, `server/test/kete/{job-files-wiring.test.ts,fake-confine.ts}`.
Changed: `server/src/kete/job-server.ts` (4th param `confine`, 3 replacements → 11 items), `core/src/kete/audit.ts` (storage seam: `Storage`, `storageFor`, `createSink`, N3 byte caps), `cli/src/kete/{job-preflight,job-serve,job-standalone,job,job-run}.ts`, entrypoint `internal/{entry/entry_linux.go,layout/layout.go,job/{deps,job}.go,itest/fakekete/main.go,itest/scenarios_test.go,fakeplatform/gateway.go,e2e/{e2e_test,scan_test}.go}` + tests, READMEs, `core/src/kete/skill/kete.md`, `core/test/kete/job-spawn-sites.test.ts` (classified `job-files.ts`), existing server/cli tests.

Deviations from the plan (small, all fail-closed):
- `KeteJobServe.prepare` also probes the confined root (`confinable` dep) right after non-dumpable, before secrets are read. Reason: when the server's own `replacements()` throws at boot, the child's last stderr line was a stack frame, so `kete job run` reported a useless reason. `replacements()` still enforces it (defence in depth). Also `job-standalone.ts` now skips stack-frame lines (`at …`) when keeping the child's last stderr line.
- `realPath` in the FSUtil wrapper returns `<root.real>/<rel>` (canonical, valid because no symlink can be in the path) rather than the lexical path.
- FSUtil classification also covers methods the plan's N4 list didn't name: `glob` → delegated (names only, like `scan`); `copyFile`, `chown`, `makeTemp*` (when `directory` is inside the tree) → refused. `stream`/`sink` refused with `Stream.fail`/`Sink.fail`.
- `remove`'s tree walk is recursion with a depth bound (512), not an explicit stack; same bound.
- The relay keeps every `run` line and up to 10,000 `model`/`permission` lines (so `run ended` is never dropped).
- Go: `job.SessionID` (and its test) removed — only the old audit path used it. `OpenAudit()` returns sentinel errors `job.ErrAuditTooLarge` / `job.ErrAuditReaderStuck`; "kete never started" → "missing or refused" note.
- `job-auth.test.ts` needed no change (it builds no server).

Docs enough: no — for the librarian (cards listed in plan.md "Cards to update"), plus:
- job-mode card: `KeteJobServe.prepare` order is now dumpable → confinable → secrets → audit fd; job mode can't start on macOS.
- cli card: a start failure's reason skips stack-frame lines.
- audit-log card: sink accounting is per sink writer (WeakMap), shared by `begin` and the hooks.

Open:
- AC5 e2e scenario finished in 8 s, which looks fast for npm+pip+cargo installs, but its asserter passed (markers checked). Probably caching; worth a glance on CI.
- CI x86_64 runs (`kete-job-image.yml`, `kete-job-entrypoint.yml`) were not triggered (not allowed); the Kete-tests job on the PR will run the Linux TS tests on x86_64.

Checks (all PASS): util/core/server/cli `bun run typecheck`; `bun turbo typecheck` (37/37); root `bun run lint`; Kete tests util (218), core (`bun run test ./test/kete`, 266), server (`bun run test ./test/kete`, 39), cli (172); Linux real-openat2 tests in `oven/bun:1.4.2` arm64 glibc (util confined-fs-linux, core job-files-linux + conformance suite, server job-files-wiring incl. the embedded read-tool symlink refusal, cli job-socket.subprocess full run with fd-4 audit pipe) and in `oven/bun:1.4.2-alpine` musl as privileged root with `CONFINED_FS_ROOT_TESTS=1` (bind-mounted /proc magic-link case ran and passed); AC5 targeted core tests: only the known ripgrep `tool-search` failures, which `verify` confirms are on main too; `upstream:check` passed; `verify --base main`: 0 new failures (core 30 fail = base 30); Go gofmt/vet (plain, integration, e2e)/`go test -race ./...`; full `scripts/integration.sh` (incl. new `TestAuditOverLimit`); image e2e `--scenario all` (no-agent, lifecycle with the symlink steps, ac5, export scans) passed on arm64. Building kete reordered `packages/cli/package.json`; reverted.

## 2026-10-02 implementer (review fixes)

1. MAJOR fixed — `cli/src/kete/job-run.ts` `collectOutcome`: relay failure is checked before **and after** `pollAuditEnded` (shared `auditFailed()`), so a `run ended` whose push failed is `audit_failed`, never the event-stream fallback; the poll loop also stops as soon as the relay fails. Test: `cli/test/kete/job-run.test.ts` "a relay that fails during the poll … is audit_failed".
2. Fixed — `util/src/kete/job-fs-util.ts`: `scan`, `globUp`, `glob` moved from delegated to routed. A scan rooted in the worktree (including the default cwd) is a component-wise walk over the confined `ops.list` (minimatch, partial-match pruning, symlinks neither entered nor reported, bounds 200,000 entries / depth 64 → fails rather than truncates). A scan rooted elsewhere (or an absolute pattern) runs the real glob with `symlink: false` forced and drops every result in the worktree whose confined `realPath` fails (i.e. reached via a link); `glob` gets the same filter; `globUp` is re-implemented over the confined scan. Tests: `job-fs-util.test.ts` (fake kernel: symlinked skills dir to kete's data dir and to `/`, dot/pruning/missing start, globUp) and new `job-fs-util-linux.test.ts` (real symlinked dir to an outside dir of known names and to `/`; rooted in the tree, above it, absolute pattern, globUp, glob — no outside names). Residual limitations recorded in `docs/jobs.md` (metadata calls still follow links; a walk rooted outside the tree, or `FileSystem.glob`, may spend CPU through a link before results are dropped; `symlink: true` is ignored in job mode for kete's own global config dirs too).
3. **Partly — deviation.** `cli/src/kete/job-standalone.ts`: the parent's end of the child's fd 4 can't be closed: effect's `ChildProcessHandle` and the upstream `util/src/cross-spawn-spawner.ts` expose only a PassThrough stream (`getOutputFd`), not the socket, so destroying our stream leaves the socket open and the child blocks once the buffers fill (checked by reading `setupFds`). Closing it would need an upstream edit to `cross-spawn-spawner.ts` (or a Kete-owned spawner for this child); I didn't make either without approval. What happens now: the relay stops, subscribers are told at once (job.ts interrupts the session; result `audit_failed`), and the child's next writes block, then fail after its 10 s writer timeout and interrupt the run, if the parent's interrupt hasn't ended it. Draining to nowhere was rejected (the child would keep "auditing" into the void). The comments (file header and at the relay) now say exactly this. Coordinator: decide whether the ≤10 s stall is worth a marked upstream edit exposing the fd's socket.
4. Fixed — `core/test/kete/job-fs-sites.test.ts` walks `packages/util/src` too (plus the `glob` package import pattern), with new categories `wrapped` (fs-util, glob, NodeFileSystem platform layer) and `confinement` (confined-fs, linux-ffi, job-audit-sink, job-secrets), and data-dir/off-in-job/replaced entries for the 13 other util sites.
5. Fixed — the double blank line is gone (code now sits there).

Checks after the fixes (PASS): lint; typecheck util/core/server/cli; Kete tests util (225, 14 skip), core (266; a first run had 7 worktree timeouts under load, re-run clean), server (39 after re-run; the 2 `job-run.test.ts` timeouts of the first run passed alone), cli (172); Linux `oven/bun:1.4.2` container: util `confined-fs-linux`, `job-fs-util-linux`, `job-fs-util`; core `job-files-linux`, `job-fs-sites`; server `job-files-wiring`, `job-mode`; cli `job-socket.subprocess`, `job-run` — all pass; image rebuilt with the new kete, e2e `--scenario lifecycle` passed (export scan too); `upstream:check` passed. musl/root container and full Go suites not re-run: no Go change and nothing musl-specific changed.
