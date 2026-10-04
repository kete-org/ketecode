# Plan: kete job run: local unattended jobs (ADR 0005/0008)

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Large — needs the user's approval before building.** It has:
> - **one upstream edit**: `packages/cli/src/index.ts` (`Handlers` map, a `// kete_change start/end` block). No other upstream file changes; `commands/commands.ts` is untouched (the Kete `specs` spread at `:493` already exists).
> - **new contracts**: job spec v1, the exit codes, and the `--json` result object (additive-only from now on; the cloud worker will depend on them).
> - **a security change**: the runtime denies edits to Kete configuration in every unattended run (spec decision), in Kete-owned `core/src/kete/unattended*.ts`.
> - No endpoint, protocol, config-schema or client change → **no protocol/client regeneration** (a `check:generated` run confirms it).
> - **Approved by the user (2026-09-28)** with D1 changed (CLI-side `git worktree add -b`) and D2–D4 as recommended — see "User decisions" below.

Base: `main` at 13837894b7, branch `feature/job-run`.

## Cards read
- docs/context/modules/unattended.md (verified-at fb83638b3f, stale: no)
- docs/context/modules/audit-log.md (verified-at fb83638b3f, stale: no)
- docs/context/modules/cli.md (verified-at 715843563a, stale: no)
- docs/context/modules/worktrees-parallel.md (verified-at a6f16f244a, stale: no)
- docs/context/modules/server-sdk.md (verified-at 715843563a, stale: no)
- docs/context/modules/permissions.md (verified-at fb83638b3f, stale: no)
- docs/context/modules/config-kete.md (verified-at 715843563a, stale: no)
- docs/context/commands.md, pitfalls.md, decisions.md (0005, 0008)

## Decisions

### User decisions (2026-09-28, via the coordinator)
- **D1 — changed from the recommendation:** the CLI creates the worktree **and** the branch itself with git — `git -C <repo root> worktree add -b <branch> <path> <HEAD sha>` through a timeout-bounded spawn — and does **not** call `POST /api/worktree`, so no project `commands.start` setup script runs outside the job's policy and audit. A `--server` on another machine is refused with exit `2`. Worktree location and session location: see Design "Worktree".
- **D2, D3, D4:** as recommended below.

### Options as originally proposed (kept for the record)
- **D1 — where the job's branch is created.** `POST /api/worktree` makes a **detached** worktree (`core/src/git.ts:657` `git worktree add --detach`); no endpoint creates a branch. **Recommended (A):** the CLI runs `git switch --create <branch> <HEAD of the user's checkout>` itself in the returned worktree directory (the same two-step that `kete/worktrees.ts:229-238` does for subagents). No new endpoint, no upstream edit, but it needs the worktree on this machine: with a `--server` whose worktree directory isn't visible locally, the job removes the worktree it just created and exits `2` ("a job's branch needs the server on this machine"). Default/background and `--standalone` servers are always local; the cloud worker will run its server locally too. **(B):** a Kete-owned server endpoint that creates worktree + branch (protocol + client regeneration, a route registration in an upstream server file) — works remotely; defer until a remote job is needed.
- **D2 — what counts as "Kete configuration" for the unattended edit deny.** **Recommended:** any `edit` resource (edit/write/patch all assert action `edit`) with a path segment `.kete` or a file name `kete.json`/`kete.jsonc` (from `Brand.projectDirectory`/`Brand.configFiles`, case-insensitive, anywhere in the project — config discovery reads every level up to the repo root), or any absolute path inside the global config directory (`Global.Service.config`); **and**, best-effort, a `shell` command whose text mentions any of those. Note the upstream default agent rules *allow* `external_directory` into the global config dir (`core/src/agent.ts:63`), so without this a job could write `~/.config/kete/kete.json`. Known gaps (documented, not fixed): a symlink pointing into `.kete/` (resources are lexical, `file-access.ts:97-106`) and an obfuscated shell command.
- **D3 — a denied action and the exit code.** In an unattended run a denied tool call fails and the agent carries on; the run then ends completed or failed on its own. **Recommended:** no separate exit code; the outcome is how the run ended, and every denial (action, resources, message, from the audit log's `permission` lines with `effect: "deny"`) is listed in the summary and the JSON result. Alternative: exit non-zero whenever anything was denied.
- **D4 — audit path with a remote server.** **Recommended:** no endpoint change; the summary says `audit/<session id>.jsonl in the server's data directory` and `audit_local: false` in JSON. Alternative: add `paths.data` to `server.info` (upstream protocol edit + regeneration).

## Design (what the implementer builds)
- **Job spec v1 (JSON only):** `{version: 1, prompt?: string, prompt_file?: string, agent?: string, model?: string ("provider/model#variant", parsed like `kete run -m`), policy: {version?: 1, allow?: [{action, resource}], budget: number>0, timeout: number>0 (minutes)}, branch?: string}`. Unknown fields rejected at every level. Exactly one of `prompt`/`prompt_file` (non-empty after trim); `prompt_file` resolves relative to the spec file's directory, must be a regular file ≤ 1 MiB, UTF-8. `policy` is decoded with the **same** `Policy` schema core uses (moved to `@opencode/schema/kete/unattended`, since the CLI can't import core — `test/import-boundaries.test.ts`), plus job-only rules: `budget` and `timeout` required; `allow` rules need non-empty `action`/`resource`, and `question`/`budget` actions are refused ("can never be allowed in an unattended run"). `branch` must pass a pure ref-name check (no spaces/control chars, no `..`, `@{`, `\`, `~^:?*[`, no leading `-`/`/`, no trailing `/`/`.lock`/`.`). Every error names the field path (`policy.budget: missing`, `policy.allow[1].action: ...`, `extra: unknown field`).
- **Server must be on this machine (D1):** `--server <url>` whose host isn't loopback (`localhost`, `127.0.0.0/8`, `::1`) → exit `2` before anything is created ("`kete job run` needs the server on this machine"). Background service and `--standalone` are local. Additionally, `client.location.get({location: {directory: cwd}})` must report `directory` equal (after `realpath`) to the local cwd, else exit `2` (a loopback tunnel to another machine).
- **Worktree (D1, user's choice):** location follows upstream's default convention, computable without core: `<Global.Path.data>/worktree/<project id first 6 chars>/job-<id8>` — the same parent upstream `WorktreeStrategies` uses (`core/src/worktree/strategies.ts:51`, `path.join(global.data, "worktree", project.id.slice(0, 6))`), project id from `location.get`'s `project.id`, `Global.Path.data` from `@opencode/util/global`. Name collision → `job-<id8>-2 … -10` like upstream `worktree.ts:219-224`, then exit `2`. A project that reconfigures its worktree directory through a plugin is **not** honored (not visible without core) — documented in `docs/jobs.md`. `<id8>` = 8 lowercase hex chars from `crypto.randomUUID()`; default branch `${Brand.cliName}/job/<id8>`. Command: `git -C <repo root> worktree add -b <branch> <path> <HEAD sha>` (HEAD sha read first, so the base is exactly the user's committed HEAD). The worktree is not in upstream's worktree inventory (`worktree.refresh` discovers it); `KeteWorktrees.sweep` only touches its own `kete.worktree/` lease records, so it never removes a job worktree.
- **Session location:** `client.session.create({location: {directory: <worktree>/<cwd's path relative to the repo root>}})` — the server opens a new location there (same git repository → same project); the job never moves an existing session.
- **Cleanup before start only:** if anything fails after `worktree add` but before the prompt is submitted, `git worktree remove --force <path>` and `git branch -D <branch>` (the branch still equals the base, nothing lost); failures of the cleanup are reported, not swallowed. Once the prompt is submitted, the worktree and branch are always kept.
- **Run sequence (`job-run.ts`, pure over injected deps):** parse+validate (any failure → exit `2`, nothing started, no client or git call) → server-locality check → `git rev-parse --show-toplevel` + `rev-parse HEAD` in the cwd (not a repo → run in place, say so, `isolated: false`; a repo with no commit → exit `2`; a `branch` in the spec outside a repo → exit `2`) → `location.get` (project id + locality) → `git worktree add -b` (failure, e.g. branch exists → exit `2`) → `client.session.create({agent?, model?, location: {directory: <worktree>/<subpath>}, metadata: {"kete.unattended": policy}})` (never `permissions`) → if the server is the background service, `client.session.environment` with `Env.session()` like `kete run` → subscribe to events **before** `client.session.prompt({..., delivery: "steer"})` → `client.session.wait` → collect the outcome.
- **During the run:** a `permission.asked` for the job's session family is a runtime bug: reply `reject`, interrupt, outcome `error` with message "bug: the runtime asked for a permission in an unattended run". SIGINT → `session.interrupt`, second SIGINT exits `130` at once. A client watchdog at `timeout + 2 min` interrupts if the runtime hasn't ended the run (network calls stay bounded). Event-stream disconnect → outcome `error`.
- **Outcome:** read `<auditDir>/<root id>.jsonl` (audit dir injected; handler default `path.join(Global.Path.data, "audit")`); poll up to 5 s for the `type:"run", event:"ended"` line (the audit hook writes it asynchronously after the execution event). Reason → exit: `completed 0`, `error 1`, `refused 2`, `audit_failed 2`, `time_limit 3`, `budget 4`, `interrupted 130`. No local file (remote server / audit refused before `run started`): classify the root's execution event — `succeeded 0`; `failed` with `error.type === "unattended"` classified by `KeteUnattendedSchema.classify(message)` (refused/audit → 2, time limit → 3, budget → 4), other failure → 1; `interrupted` → 130 if this CLI interrupted, else 3 if `session.time.created + timeout` has passed, else 1. Cost: sum of the audit `model` lines' `cost_usd` (whole family), else the root session's `cost` marked "root session only".
- **Output:** final assistant text of the root session (last assistant message's text parts, via `client.message.list`) on stdout; stderr: one start line (branch, worktree, session id) and a summary (outcome, exit code, branch, worktree, cost, duration, audit log path, denials). `--json`: exactly one object on stdout, nothing else on stdout: `{version: 1, outcome, exit_code, session_id, text, isolated, branch, worktree, directory, cost_usd, cost_scope: "family"|"root", duration_ms, audit_log, audit_local, denied: [{action, resources, message}], message?}`; for a spec error `{version: 1, outcome: "refused", exit_code: 2, message}`.
- **Runtime deny (`core`):** `KeteUnattendedPolicy.configTarget(action, resources, {globalConfig})` (pure) → `applyLate` checks it **first**, for `allow` and `ask` alike, in an unattended family: effect `deny`, message "unattended run: editing Kete configuration (.kete/, kete.json, the global config) is not allowed". `applyLate` stays the last hook, so nothing can re-allow it; interactive families are untouched.
- **Shared stop messages:** `@opencode/schema/kete/unattended` owns the message builders (`refused`, `timeLimit`, `budget`, `auditUnavailable`) and `classify(message)`; `core/src/kete/unattended.ts` `refused`/`stoppedDeadline`/`stoppedBudget` and `audit.ts:295-299` build their messages through them (text unchanged), so the CLI fallback and the runtime can't drift.

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/schema/src/kete/unattended.ts` | create | `AllowRule`/`Policy` schemas moved from core (same identifiers, strict), stop-message builders + `classify`; Kete path, no markers |
| `packages/schema/src/schema.ts` | read (`:12` `optional`) | helper the moved schema uses |
| `packages/core/src/kete/unattended-policy.ts` | change | re-export `AllowRule`/`Policy` from the schema module (keep `KeteUnattendedPolicy.Policy` API); add pure `configTarget` |
| `packages/core/src/kete/unattended.ts` | change | `applyLate(get, event, paths)` config deny first; `Plugin` passes `global.config`; message builders from the schema module |
| `packages/core/src/kete/audit.ts` | read `:60-130`, `:137-141`, `:285-300`, `:501-515`; change `:295-299` | line shapes the CLI parses; audit-unavailable message via the shared builder |
| `packages/core/src/file-access.ts` | read `:95-125` | `edit` resource shape: location-relative inside the project, absolute outside |
| `packages/core/src/tool/plugin/shell.ts` | read `:120-140` | `shell` resources are command texts (D2 shell check) |
| `packages/core/src/agent.ts` | read `:55-64` | default `external_directory` allow for the global config dir |
| `packages/util/src/kete/brand.ts` | read | `projectDirectory`, `configFiles`, `cliName` (branch prefix `${Brand.cliName}/job/`) |
| `packages/util/src/global.ts` | read | `Global.Path.data` for the CLI's default audit dir |
| `packages/core/test/kete/unattended.test.ts` | change | pure `configTarget` + `applyLate` cases |
| `packages/core/test/kete/unattended-service.test.ts` | change | AC6 with a real `Permission.Service` |
| `packages/cli/src/kete/job-spec.ts` | create | parse + validate spec v1 (pure; `readFile` injected) |
| `packages/cli/src/kete/job-git.ts` | create | timeout-bounded `git` via `node:child_process` `execFile` (no shell, cross-platform), `AbortSignal`; `worktree add` gets a longer timeout (5 min) than other calls (30 s) |
| `packages/core/src/worktree/strategies.ts` | read `:45-53` | upstream's worktree parent directory convention the CLI mirrors |
| `packages/core/src/worktree.ts` | read `:205-225` | name/suffix handling to mirror; `KeteWorktreeName.valid` rule (one path segment) |
| `packages/cli/src/kete/job-run.ts` | create | orchestration, outcome, result object; imports only `@opencode/client/promise`, `@opencode/schema`, `@opencode/util`, `node:*`, `effect` (so the server e2e test can import it) |
| `packages/cli/src/kete/job.ts` | create | `Runtime.handler(Commands.commands.job.commands.run, …)`: `ServerConnection.resolve`, client, real deps, SIGINT, `process.exitCode` |
| `packages/cli/src/kete/commands.ts` | change | `Spec.make("job", {commands: [Spec.make("run", …)]})`: `spec` argument, `--server`, `--standalone` (same text as upstream `ServerParams`, not exported), `--json` |
| `packages/cli/src/index.ts` | change (upstream) | `job: { run: () => import("./kete/job") }` in `Handlers` inside `// kete_change start/end`; the only registration seam for a handler |
| `packages/cli/src/commands/commands.ts` | read `:17-26`, `:356-397`, `:493` | `ServerParams` to mirror, `run` spec, spread point |
| `packages/cli/src/commands/handlers/run.ts` | read | handler pattern with `ServerConnection.resolve` |
| `packages/cli/src/kete/whoami.ts` | read | Kete handler pattern |
| `packages/cli/src/services/server-connection.ts` | read | `resolve`, `Resolved.service`/`endpoint` |
| `packages/cli/src/run/run.ts` | read `:75-100` | client with `timeout: false` fetch, `Env.session()` use |
| `packages/cli/src/run/noninteractive.ts` | read `:66-160`, `:640-720` | subscribe-before-prompt, `prompt`/`wait`, permission reply, SIGINT pattern |
| `packages/cli/src/session-target.ts` | read `:90-95` | `parseSessionTargetModel` for `model` |
| `packages/cli/src/env.ts` | read | `Env.session()` |
| `packages/cli/test/import-boundaries.test.ts` | read | no `@opencode/core` in cli src/test |
| `packages/cli/test/kete/job-spec.test.ts` | create | AC1 |
| `packages/cli/test/kete/job-run.test.ts` | create | AC1 "starts nothing", AC4 mapping (audit reasons, event fallback, watchdog), permission-asked bug path, `--json` shape — fake client objects like `test/run/noninteractive.test.ts` |
| `packages/cli/test/run/noninteractive.test.ts` | read `:1-60` | fake-client/event helpers to copy |
| `packages/server/test/kete/job-run.test.ts` | create | AC2–AC6 end to end: real routes, `TestLLM`, a real git repo |
| `packages/server/test/session-instances.test.ts` | read `:1-200` | `createEmbeddedRoutes({}, replacements)` + `TestLLM` + `SessionRunnerModel` replacement + web handler (use it as the client's `fetch`) |
| `packages/server/test/worktree.test.ts` | read `:1-45` | `initRepo`, `api.worktree.*` against a server |
| `packages/core/test/session-step.test.ts` | read `:60-145` | model `cost` entries + usage → step cost (budget case) |
| `packages/core/test/fixture/git.ts` | read `:50` | `initRepo` |
| `packages/ai/src/testing.ts` | read | `TestLLM.tool/text/complete/hangAfter` |
| `packages/schema/src/session-event.ts` | read `:242-261` | execution event shapes |
| `packages/core/src/kete/skill/kete.md` | change | "Unattended jobs" bullet: `kete job run`, config-edit deny |
| `docs/jobs.md` | create | user doc: spec v1 fields, example, isolation, outputs, exit codes, remote-server limits, known gaps |
| `docs/upstream-patches.md` | change | "Unattended runs" section: a "Jobs (feature/job-run)" paragraph — `cli/src/index.ts` `Handlers` block, why no seam works, sync check (upstream adding its own `job` command would collide) |

## Steps
1. **Schema module.** Create `packages/schema/src/kete/unattended.ts` (`export * as KeteUnattendedSchema`): move `AllowRule`, `Policy` verbatim from `unattended-policy.ts:40-55` (identifiers unchanged); add message builders producing today's exact texts and `classify(message) → "refused" | "audit" | "time_limit" | "budget" | undefined`. In `unattended-policy.ts` replace the definitions with re-exports so every existing `KeteUnattendedPolicy.Policy` user compiles unchanged.
2. **Runtime deny (D2).** Add `configTarget` to `unattended-policy.ts` (pure, string/path only, uses `Brand`, `path.posix`/`path.win32`-safe comparisons, lower-cased). Change `applyLate` to take `{globalConfig}` and deny config targets before the `ask` check; wire `global.config` in `Plugin` (`Global.Service` is already yielded). Switch `refused`/`stoppedDeadline`/`stoppedBudget` and `audit.ts:295-299` to the shared builders. Tests: `unattended.test.ts` (relative `.kete/x`, `a/.KETE/x`, `kete.jsonc`, `sub/kete.json`, `../.kete/x`, absolute in global config, Windows-style backslashes, `src/app.ts` untouched, `shell` `echo x > .kete/kete.json`, interactive no-op); `unattended-service.test.ts`: unattended session with `allow: [{action: "edit", resource: "*"}]` and an agent that allows `edit` → `.kete/kete.jsonc` denied, `src/a.ts` allowed; interactive session → `.kete/kete.jsonc` allowed. Run the existing unattended/audit tests (messages must not change).
3. **Spec parser.** `job-spec.ts` + `job-spec.test.ts` (AC1: missing budget, missing timeout, unknown top-level and policy field, bad allow rule, `question` allow, no prompt, both prompt fields, missing/oversized `prompt_file`, bad `version`, bad `branch`, malformed JSON — each asserts the message names the field).
4. **Git helper.** `job-git.ts`: `run(cwd, args, {timeoutMs = 30_000, signal})` → `{exitCode, stdout, stderr}`; never throws on a non-zero exit; kills the child on timeout/abort; `git` missing → a typed error the runner reports. Plus `worktreeAdd(root, {branch, path, base})` (5-minute timeout) and `worktreeDiscard(root, {path, branch})` for the pre-start cleanup.
5. **Runner.** `job-run.ts` per Design. Deps interface: `{client, git, readFile/stat/exists, dataDir (worktree root; handler default `Global.Path.data`), auditDir, now, sleep, stdout, stderr, onInterrupt, environment?}`; returns `{exitCode, result}`. Never swallow an error: every failed step becomes an outcome with a message. `job-run.test.ts` with fake clients and a fake git: invalid spec → exit 2 and zero client/git calls; non-loopback `--server` → exit 2 and no git call; `location.get` directory mismatch → exit 2; worktree path = `<data>/worktree/<proj6>/job-<id>` and `git worktree add -b` args; session create failure → worktree removed and branch deleted; each audit `run ended` reason → its exit; event fallback table; `permission.asked` → reject + interrupt + exit 1; watchdog; `--json` prints exactly one line.
6. **Command + handler.** Add the `job run` spec to `kete/commands.ts`; `kete/job.ts` handler; the `Handlers` entry in `cli/src/index.ts`:
   ```ts
   // kete_change start: `kete job run` (kete/job.ts)
   job: { run: () => import("./kete/job") },
   // kete_change end
   ```
   placed next to the other Kete entries (`index.ts:28-35`); no reformatting around it.
7. **End-to-end test** `packages/server/test/kete/job-run.test.ts`: temp repo via `initRepo`, server routes built as in `session-instances.test.ts` (TestLLM, resolved model with a cost entry, temp `Global`), client `OpenCode.make({baseUrl: "http://kete.local", fetch: handler})`, `runJob` imported from `../../../cli/src/kete/job-run`, `auditDir = <temp global data>/audit`. Cases:
   - AC2: session metadata `kete.unattended` equals the spec policy (`version: 1` filled); the session's location directory is the worktree, under `<temp data>/worktree/<proj6>/`; `git -C wt branch --show-current` is `kete/job/<id>`; base = repo HEAD; no `worktree.create` request was made (count requests in the `fetch` wrapper). Pass the temp global data dir into `runJob` as the data root (dependency, not `Global.Path`).
   - AC3 + AC5: TestLLM `tool("write", {path: "hello.txt", …})` then `text("done")` → exit 0, stdout `done`, stderr summary names branch and audit path; `hello.txt` only in the worktree; `git -C repo status --porcelain` empty; same run with `json: true` → one parseable object with `outcome: "completed"`.
   - AC4 + AC6 e2e: a `write` to `.kete/kete.jsonc` with `allow: [{action: "edit", resource: "*"}]` → denied, listed in `denied`, file absent, run completes (D3); time limit: `hangAfter(...)` with `timeout: 0.01` → exit 3; budget: first step's usage costs more than `budget` and requests a tool → second step refused → exit 4.
   - Not a git repo → runs in place, `isolated: false`.
   If `tsgo -b` in `packages/server` rejects the cross-package import, stop and report (don't add `@ts-ignore`); fallback is to move the e2e harness into `packages/cli/test/kete/` only if it can avoid `@opencode/core` imports.
8. **Docs.** `docs/jobs.md`, `skill/kete.md` bullet, `docs/upstream-patches.md` paragraph. Record in `handoff.md` anything that differed from this plan.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `cd packages/cli && bun test ./test/kete/job-spec.test.ts`, then `bun test ./test/kete/job-run.test.ts -t "invalid"` |
| AC2 | `cd packages/server && bun run test ./test/kete/job-run.test.ts -t "creates a worktree"` |
| AC3 | `cd packages/server && bun run test ./test/kete/job-run.test.ts -t "completes"` |
| AC4 | `cd packages/cli && bun test ./test/kete/job-run.test.ts`, then `cd packages/server && bun run test ./test/kete/job-run.test.ts -t "limit\|budget\|denied"` |
| AC5 | `cd packages/server && bun run test ./test/kete/job-run.test.ts -t "checkout untouched"` |
| AC6 | `cd packages/core && bun run test ./test/kete/unattended.test.ts`, then `bun run test ./test/kete/unattended-service.test.ts`, then `bun run test ./test/kete` (audit tests pin unchanged messages) |
| AC7 | `cd packages/schema && bun run typecheck`; `cd packages/core && bun run typecheck`; `cd packages/cli && bun run typecheck && bun test ./test/kete && bun test ./test/import-boundaries.test.ts`; `cd packages/server && bun run typecheck && bun run test ./test/kete`; `cd packages/core && bun run test ./test/kete`; root `bun run lint`; `bun run --cwd packages/kete-tools upstream:check`; `bun run --cwd packages/kete-tools verify --base main`; `cd packages/protocol && bun run check:generated` and `cd packages/client && bun run check:generated` (expected clean: no endpoint changed) |

Manual smoke (optional, not an AC): `bun run build --single --skip-install --skip-web-ui` in `packages/cli`, then `dist/cli-<os>-<arch>/bin/kete job run ./job.json` in a scratch repo with a real model and `--json`.

## Risks
- `session.execution.*` from the time-limit watch arrives as `interrupted` (not `failed`); without the local audit file only the clock distinguishes time limit from an outside interrupt — acceptable for remote servers, documented.
- The CLI mirrors upstream's default worktree directory; a plugin-configured directory is ignored for jobs (documented). The project's `commands.start` setup script does **not** run for a job (D1), so a project that needs it must do that setup in the prompt, under the job's policy — say so in `docs/jobs.md`.
- The CLI and a local server could use different data directories (e.g. different `XDG_DATA_HOME`); the worktree lands under the CLI's, which the local server can still reach. The audit file is read from the path the server writes; a missing file falls back to the execution event.
- The worktree is based on committed `HEAD`; uncommitted changes in the user's checkout are not in the job — the summary says so when `git status --porcelain` is non-empty.
- The e2e test crosses packages (server test → cli source); see step 7's fallback.
- Shell-text check is best-effort (D2); symlinks into `.kete/` are a known gap.

## Cards to update after the build
- `unattended` — `kete job run` is the real caller; config-edit deny in `applyLate` (D2), `configTarget`, schema moved to `@opencode/schema/kete/unattended`, shared stop messages; Quick answers for the gaps logged in handoff.
- `audit-log` — a reader now exists (`cli/src/kete/job-run.ts`): which lines it reads, the 5 s wait for `run ended`; `audit.ts` message now from the shared builder.
- `cli` — `kete job run` (files, `Handlers` block at `index.ts`, nested-command handler pattern, `ServerParams` not exported so the flags are mirrored), tests incl. the server e2e.
- `permissions` — `applyLate` also denies Kete-config edits (allow or ask) in unattended families; `agent.ts:63` default `external_directory` allow for the global config dir.
- `worktrees-parallel` — `POST /api/worktree` is detached; jobs bypass it: the CLI runs `git worktree add -b` under upstream's `<data>/worktree/<proj6>/` convention, not in the inventory, untouched by `sweep` (D1).
- `server-sdk` — how to run an end-to-end test with a fake model (`createEmbeddedRoutes` + `TestLLM` + web-handler `fetch`).
- `docs/context/contracts.md` — new section: job spec v1, exit codes, `--json` result v1 (additive only).
- `docs/context/commands.md` — the new test files' narrow commands.
