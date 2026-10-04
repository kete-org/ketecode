# Result: Job mode: runtime request shape matches the gateway's job-key allowlist; item 11 audit

## What changed
- `packages/core/src/kete/job-request.ts` — `family` knows only the six job routes (deepseek and
  token counting refused; OpenRouter is its own family); new `transportReason`: `anthropic-beta`
  allowlist (the three values), `openai-beta` refused, query allowlist (Gemini `alt=sse`, Anthropic
  `beta=true`), reading both `request.url` and `request.urlParams`.
- `packages/core/src/kete/job-request/{anthropic-messages,openai-chat,openai-responses,gemini}.ts` —
  the gateway's checks in its order: `background`, provider-tool history (Anthropic blocks,
  Responses hosted items), hosted Responses `tool_choice`, thinking/reasoning budget lowered below
  the clamped output (Anthropic min 1,024, else refused), Gemini `null` part fields omitted, then the
  strict schema. Echoed identifiers are escaped and capped.
- `packages/core/src/kete/job-request/shared.ts` (new) — `Conform`, `schemaReason`, `fitBudget`, `escapeKey`.
- `packages/core/src/kete/job-request/schemas/*.ts` (new) — the gateway's five zod schema files,
  copied unchanged but for `.js` imports, a provenance header and prettier.
- `packages/core/test/kete/job-request.test.ts` (rewritten to schema-valid bodies, new cases),
  `job-request-service.test.ts` (deepseek refused, beta/query refusals send zero bytes),
  `job-request-wire.test.ts` (new: real provider packages → gateway routes → the layer).
- `packages/kete-job-entrypoint/internal/job/job.go` — agent-phase heartbeat sends the fixed
  `KeteCheckFailed` message when the kete cgroup can't be read (was: count silently omitted).
- `packages/kete-job-entrypoint/internal/entry/entry_linux.go` — `KeteExtra` skips only gone pids
  (ENOENT, ESRCH); any other unreadable exe counts as extra (fail closed).
- `internal/job/job_test.go` (`TestHeartbeatKeteCgroupCheck`), `internal/itest/{scenarios_test.go,fakekete/main.go}`
  (`TestKeteCgroupStray`, fake-kete scenario `stray`).
- `docs/platform/jobs-v1.md` (new) — platform contract copy, provenance line like `sync-v1.md`.
- `docs/context/contracts.md` §6e, `modules/job-mode.md`, `modules/job-entrypoint.md`.
- No upstream file edited.

## Item 11 audit (platform `docs/jobs.md` §8 and §10 item 11)

Entrypoint paths are under `packages/kete-job-entrypoint/internal/` (`ep/`). Lines as of this branch.

| # | Requirement | Where met | Status |
|---|---|---|---|
| 1 | Public GHCR image by digest, `kete` + entrypoint, no secrets/CA key | `.github/workflows/kete-release.yml:227-245,291-300`; `packages/kete-job-image/Dockerfile:9,41-42,53`; CA per VM in memory | MET, except package visibility "public" is a manual step (`docs/release.md:41`) |
| 2a | Firewall, proxy (TLS everywhere, SNI = Host = allowed name), per-VM CA; abort before claim | `ep/job/job.go:178-201`; `kete-egress/internal/proxy/connect.go:147-171`, `forward.go:74`; `ca/ca.go:89-90` | MET |
| 2b | `claim`; unset claim token | `ep/job/job.go:202-206,238-241`; bootenv re-exec | MET |
| 2c | Root-owned pristine clone, HEAD = base_sha, revoke, agent copy with own objects | `ep/job/job.go:443,461-472,476-486,489,496` | MET |
| 2d | `kete` as `kete`, `no_new_privs`, timeout min(policy, deadline − now − 5 min) | `ep/entry/entry_linux.go:361-365`; `ep/job/job.go:31-41,508`; `ep/layout/layout.go:95` | MET |
| 2e | Heartbeats ≤ 60 s | `ep/job/job.go:295-325`; `layout.go:99` (30 s) | MET |
| 2f | Heartbeat checks the kete cgroup holds only kete (ADR 0019 rule 5) | `ep/job/job.go:309-318`; `ep/entry/entry_linux.go:372` | **was PARTIAL, fixed here**: failed reads now reported, unreadable exe counts; stray-process integration test added |
| 2g | Supervise proxy; exit → `proxy_failed` | `ep/job/job.go:545-552,667-668` | MET |
| 2h | After kete: close helper socket, kill both cgroups, confirm empty | `ep/job/job.go:625-635`; `ep/helper/helper_linux.go:77-80`; `ep/entry/entry_linux.go:422-437` | MET (socket closes when the SIGTERMed helper exits; no separate close call) |
| 2i | result, bundle from pristine copy with own safe reader, uploads, finish, hard deadline | `ep/job/job.go:244,337,688,710,751-772,786`; `ep/entry/entry_linux.go:503-513`; `ep/bundle/` | MET |
| 3a | Tools as a second user via root helper; socket only kete can use (peer creds) | `kete-root-helper/internal/server/server_linux.go:148`; `ep/entry/entry_linux.go:298,363` | MET |
| 3b | Helper: fixed uid/gid, `CLONE_INTO_CGROUP`, setgroups/setgid/setuid then NNP, chdir after drop, argv/env as data with allowlist, fds closed, pidfd kill in tool cgroup, rate/size limits | `kete-root-helper/internal/launch/launch_linux.go:245-301`, `stage2_linux.go:93,112,124,145`, `ratelimit/`, `config/config.go:79-81` | MET |
| 3c | openat2 confinement; every subprocess via helper or disabled; no git as kete | `packages/util/src/kete/linux-ffi.ts:100-102,279-282`; `packages/server/src/kete/job-server.ts`; `packages/core/src/kete/job-files.ts`; `packages/cli/src/kete/job-git.ts:36` | MET |
| 3d | Fixed setgid worktree parent, shared group, umask 002; bundle uses it | `ep/entry/entry_linux.go:174,365,505` | MET (passed as `kete job run`'s cwd, not a flag) |
| 3e | Privileged loopback ports; kete → A only, tool → B only | `ep/layout/layout.go:92`; `ep/entry/entry_linux.go:111-112,182,203` | MET |
| 3f | No TCP listener; unix socket in 0700 dir; per-run secret | `packages/cli/src/kete/job-standalone.ts:81-99`; `job-serve.ts:104-107`; `packages/server/src/kete/socket-listen.ts:84` | MET |
| 3g | Non-dumpable; `/proc` hidepid=2 | `packages/cli/src/kete/dumpable.ts:53-57`; `ep/setup/setup_linux.go:18,60-68` | MET |
| 3h | Data dir 0700; working tree the only shared dir | `ep/entry/entry_linux.go:169-174` | MET |
| 3i | Per-user cgroups with pids.max/memory.max; oom −1000; protected_* sysctls | `ep/cgroup/cgroup.go:234-237`; `ep/setup/setup_linux.go:21`; `ep/helper/helper_linux.go:47`; `ep/egress/proxy_linux.go:162`; `ep/setup/setup.go:28-29` | MET |
| 3j | Gateway key by descriptor, never env or helper; callback token never reaches kete | `ep/entry/entry_linux.go:202-226,325-334`; `ep/job/job.go:240-241` | MET |
| 4 | Audit and result to an entrypoint-owned sink | `ep/entry/entry_linux.go:276-291,337,347-360`; `packages/util/src/kete/job-audit-sink.ts` | MET (result = kete's stdout, a root-owned file) |
| 5 | Repo config untrusted; no MCP | `packages/server/src/kete/job-server.ts` (`project: false`, `ConfigPluginSource.empty`); `packages/core/src/kete/job-plugin.ts` | MET |
| 6 | Non-interactive creds; sync returns only the job's agent/skills | `packages/core/src/kete/gateway.ts`, `kete/sync/plugin.ts`, `packages/cli/src/kete/job-sync.ts` | MET runtime-side; platform job-scoped sync built on the platform (item 5) |
| 7 | Model requests fit the gateway's job rules | `packages/core/src/kete/job-request.ts`, `job-request/*` | MET, and **extended here** to every gateway job-key rule (part B) |
| 8 | `runtime_type: kete_cloud`; registration off | `ep/entry/entry_linux.go:220`; `packages/util/src/kete/runtime-registration.ts`; `kete/sync/plugin.ts` | MET |
| 9 | Result v1 unchanged, forwarded verbatim | `ep/job/job.go:43-45,671-674` | MET |
| 10 | kete stdout/stderr to a VM file | `ep/entry/entry_linux.go:337-346,361` | MET |

Nothing large is missing. For the coordinator: make the GHCR package public before the first
platform pull (item 1, manual), and item 12's staging run should include `TestKeteCgroupStray`'s
case against the real platform (the count must appear as a `job_events` error).

## Checks
| Check | Result |
|---|---|
| core `bun run typecheck` | pass |
| core `bun run test ./test/kete` | pass (288 pass, 0 fail, 11 skipped) |
| core job-request tests (3 files) | 51 pass |
| entrypoint gofmt + vet (+integration tag) + `go test -race ./...` (Docker) | pass |
| entrypoint integration suite (Docker, privileged) | pass, 15 tests incl. `TestKeteCgroupStray` |
| `bun run lint` | 0 warnings, 0 errors |
| `upstream:check` | passed (no upstream file touched) |
| `verify --base main` | **not completed**: the HEAD pass ran every package's typecheck and tests (util, server, core, tui, cli), but the comparison worktree of `main` failed with "No space left on device" (the disk has ~176 MB free), so no failure report was produced. Rerun after freeing space. Only core and Go code changed; core typecheck and all core Kete tests pass. |
| `node scripts/agent/card-check.mjs` | clean |

## Acceptance criteria
- [x] AC1 — `job-request.test.ts`: per-family refusals for every gateway class (routes, beta, query, background, provider tools and history, tool_choice, n/candidateCount, schema, thinking budget).
- [x] AC2 — `job-request-wire.test.ts` (7 tests): the real Anthropic, OpenAI Responses/Chat, Gemini and OpenRouter packages pass locally; `?beta=true` and `alt=sse` asserted; a provider-header `context-1m` beta refused with zero calls.
- [x] AC3 — Gemini `null` fields omitted (pure test) and no `null` on the real Gemini wire body.
- [x] AC4 — `docs/platform/jobs-v1.md` with provenance (`a2e3fbf`).
- [x] AC5 — table above; `KeteCheckFailed`, fail-closed exe check, unit + integration tests.

## Deviations and findings
- **Conform, not refuse, for the thinking budget.** The gateway refuses `budget_tokens >= limit` and
  `max_tokens <= budget`; the runtime's "max" variant sets the budget to the model's output limit − 1
  (63,999 for a 64k model), so refusing would make that variant unusable in every job. The budget is
  lowered to one below the clamped output, as the output itself is clamped; refused only when that
  would leave an Anthropic budget under 1,024. Stricter than before, never looser.
- **Gemini nulls:** today's upstream lowering never produces `null` for those fields (the shared
  `optionalNull` schemas only allow it in the type), so no upstream edit; the conformer drops them
  defensively and the wire test pins it.
- **Drift the wire test found:** OpenAI **Chat** lowers replayed reasoning to `reasoning_content`,
  which the gateway's Chat schema refuses. Native OpenAI Chat streams no reasoning, so a job's own
  history has none; it now fails locally if it ever does. If the platform wants it allowed, its
  schema must change (platform decision; not changed here).
- **`beta=true`:** the `kete` provider's Anthropic models send `?beta=true` (canonical provider
  `anthropic`); the gateway doesn't forward or check it, so it's on the local allowlist rather than
  refused (refusing would break every Anthropic job).
- **deepseek:** a job pinned to a `kete/deepseek-*` model now fails on its first model request with
  "this route isn't one a job may use" (the gateway would 400). The platform could refuse such a
  `spec.model` at job creation.
- **Schemas in zod, not Effect Schema** (the repo convention): chosen so the copies stay diffable
  with the platform's; zod is already a core dependency.

## Cards updated
- `job-mode`: routes, transport allowlists, conform order, schema copies, Gemini nulls, wire test; Key files, Testing, Changes; line refs refreshed.
- `job-entrypoint`: Quick answer for the heartbeat kete-cgroup check (the scout's "Docs enough" gap), Data flow, Testing, Changes.
- `contracts.md` §6e (Job API v1 and the job-key request shape, with its change rule).

## Metrics
- Agents used: scout (item 11 audit), reviewer (approve; 5 minors, 4 fixed, 1 accepted)
- Scout lookups: 1, docs enough: 1 (100%; one gap added to the job-entrypoint card)
- Tokens / cost (from /usage): n/a (subagents ~167k)
- Time: ~2 h
