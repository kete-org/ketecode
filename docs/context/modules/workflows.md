---
module: workflows
paths: [packages/core/src/kete/workflows.ts, packages/schema/src/config/kete.ts]
verified-at: 4e26b57120
---

## Quick answers
- Anything new for workflows? Only the `kete` config schema gained `offline` (`schema/src/config/kete.ts:72`); workflow behaviour is unchanged.
- Where workflows are configured: `kete.workflows` (a record keyed by workflow name), schema at `packages/schema/src/config/kete.ts:64-69`, each entry a `Workflow` (`:64-69`) of `WorkflowStep`s (`:47-62`).
- How a step's task is filled in: `{{input}}` (the workflow call's `input`) and `{{steps.<id>}}` (an earlier step's final answer) — `render()`, `workflows.ts:116-120`, placeholder regex `:34`.
- What actually runs a step: the `subagent` tool, called through a `Tool.Service` snapshot (`workflows.ts:287-301`) — a step gets every check/limit the `subagent` tool itself applies (permission, nesting depth, `kete.subagents` timeout/concurrency, worktrees).
- Concurrency of independent steps: up to `kete.subagents.max_concurrent` at once (`workflows.ts:282`, reusing `KeteSubagents.limits`), not a separate workflow-level setting.
- What stops a later step from running: any earlier step that isn't `"completed"` — `failed`, `skipped`, or `backgrounded` all block dependents (`run()`, `workflows.ts:146-156`).

## Purpose
Adds a `workflow` tool (docs/architecture.md §67) that runs a named, configured sequence of agent steps without duplicating any subagent machinery: every step is itself a `subagent` tool call, so orchestration lives entirely in scheduling steps by their dependency graph and stitching outputs into later prompts. The tool only exists while at least one workflow is configured (`workflows.ts:244-250`), and only workflows in `kete.workflows` can be run — there's no ad hoc/inline workflow definition path.

## Entry points
- `workflow` tool, `Input = { name, input }` (`workflows.ts:203-208`), registered by `kete.workflows` `Plugin` (`:234-337`).
- Slash command `/<name>` per the header comment (`:1-10`) and the tool's own description (`:229-231`) — routed through the same config-command plugin as any other command (see the subagents card's `config/plugin/command.ts` entry point) rather than through code in this file.

## Key files
| File | Lines | Role |
|---|---|---|
| `packages/core/src/kete/workflows.ts` | 359 | `validate`, `render`, `run`, `describe`, the `workflow` tool + plugin |
| `packages/schema/src/config/kete.ts` | 80 | `WorkflowStep` (`:47-62`), `Workflow` (`:64-69`), embedded in `ConfigKete.Info.workflows` (`:76-78`); the file's other growth (`Runtime`, ADR 0005) is unrelated |

## Data flow
1. Config load: `kete.workflows` entries are Kete-owned (no upstream config collision, file header `kete.ts:1-3`); the plugin watches `config.changes()` and `config.updated` events, debounced 100ms, to add/remove the tool as workflows appear/disappear (`workflows.ts:244-259`).
2. Tool call with `{ name, input }` → look up the workflow, `validate(name, workflow)` (`:37-113`) → on success a `Plan` (topologically ordered steps + full transitive `dependencies` map, Kahn's algorithm `:62-76`), on failure every problem is listed at once (`:278-281`) rather than stopping at the first.
3. `validate` also rejects: duplicate step ids (`:46`), self-dependency (`:53`), unknown `after`/`continue` targets (`:54`), a step with both `continue` and its own `worktree: true` (`:56-57`, since `continue` reuses the earlier step's session/worktree), dependency cycles (`:67-69`), `{{...}}` references to anything but `input`/`steps.<known-dependency>` (`:89-99`), and same-session (`continue`-chained) steps that aren't otherwise ordered relative to each other (`:101-109`, they'd race on one session).
4. `run(plan, input, concurrency, step)` (`:139-180`) executes in waves: each iteration, steps whose dependencies aren't yet `"completed"` are marked `"skipped"` with a reason naming the blocker (`:146-156`); steps whose dependencies are all `"completed"` run together via `Effect.forEach(..., { concurrency })` (`:163-171`); loop ends when nothing is `"ready"` (`:162`, guards against infinite loop on an already-invalid plan).
5. Each step's `StepRun` (`workflows.ts:284-316`) reports progress, takes a `tools.snapshot()` (`:287`), builds a synthetic `subagent` tool-call input (`agent`, `description: "<workflow>: <step>"`, `prompt` from `render()`, optional `sessionID` for `continue`, optional `worktree`) and calls `snapshot.execute(...)` (`:300-301`) — this is the seam: from here on it's the ordinary `subagent` tool path (subagents card) including its own permission/depth/admission/timeout/worktree logic.
6. The subagent's structured output is decoded (`SubagentOutput`, `:221-226`); `status: "running"` → step `"backgrounded"` (stops downstream steps per rule above); otherwise `"completed"` with the session id and output text.
7. `describe(plan, results)` (`:185-201`) renders the `<workflow>`/`<step>` XML-ish text the model sees, truncating any single step's output over `PREVIEW = 4000` chars (`:182,189-191`) and pointing at the full session for the rest.

## Data and APIs used
- `Config.Service` for `kete.workflows` and `kete.subagents.max_concurrent` (via `KeteSubagents.limits`, `workflows.ts:21,282`).
- `Tool.Service` (`packages/core/src/tool.ts:43`) — `snapshot()` returns an `Snapshot.execute` closure (`tool.ts:51-60`) that runs a tool call exactly as the model's own tool calls do, including hooks and permission checks; unmodified upstream, no `kete_change` marker.
- Session/permission hooks (`ctx.session.hook("context"|"compaction"|"generate", hook)`, `:355-357`) append the list of configured workflows to the `workflow` tool's description, mirroring how the `subagent` tool lists available agents (subagents card, `subagent.ts:319-346`).

## Rules that must not break
- A workflow step must never bypass the `subagent` tool's own checks — this file must not call `Session.create`/`sessions.prompt` directly; it must go through `Tool.Service` snapshot execution (`:300-301`) so permission, depth, admission, timeout and worktree logic stay in one place.
- `validate` must reject a cycle and every other structural problem before `run` starts (`:60,111`) — `run` assumes a valid, acyclic `Plan` and will silently under-run (stop early, `:162`) on one that isn't.
- `continue` implies `after` that step (`validate`'s `deps` construction, `:51`) and forbids `worktree: true` on the continuing step (`:56-57`) — a continued session's worktree, if any, was already established by the step it continues.
- Concurrency for a wave is `kete.subagents.max_concurrent`, not a separate cap (`:282,318`) — raising workflow parallelism means raising that shared subagent setting, by design (it's the same admission pool the steps' `subagent` calls compete for).

## Testing
- `bun run test ./test/kete/workflows.test.ts` inside `packages/core` — `validate`/`render`/`run`/`describe` and the tool/plugin wiring.
- `bun run test ./test/tool-subagent.test.ts` inside `packages/core` — exercise indirectly, since every step is a `subagent` call; useful when a workflow regression turns out to be a `subagent` tool regression.

## Changes
- `docs/upstream-patches.md` section "Workflows" is the authoritative patch note: this file is purely additive (registers `KeteWorkflows.Plugin` in `packages/core/src/plugin/internal.ts`); it also notes the Security/DevOps starter roles were changed to `mode: "all"` so a workflow step (or the default agent) can address them as subagents.
- `docs/architecture.md` §67 (Workflow Engine) is the direction doc — this implementation is the "orchestrate agents/tools rather than duplicate them" approach it calls for.
- No `kete_change` markers apply to this file itself (path contains `kete`, per CLAUDE.md §4); the only upstream touch is the one-line, marked registration `KeteWorkflows.Plugin` in `packages/core/src/plugin/internal.ts:289-290`.

## Gotchas
- `{{steps.<id>}}` only resolves for a step's *transitive* dependencies (`dependencies.get(step.id)!.has(id)`, `:96-97`), not merely any earlier-numbered step — referencing a sibling step's output without an `after`/`continue` edge to it is a validation error, not a runtime `undefined`.
- A `"backgrounded"` step stops everything after it in that same run (`describe`, `:195-196`; `run`, `:150-156` treats it as not `"completed"`) — the workflow tool call returns `state: "incomplete"` immediately; there is no automatic resume when the backgrounded subagent later finishes (the model is only notified the way any backgrounded subagent notifies its parent, per the subagents card).
- The tool is added/removed dynamically based on whether `kete.workflows` is non-empty (`:244-250`); a config edit that empties `kete.workflows` makes the `workflow` tool disappear from the model's tool list on the next debounce tick, not immediately.
- `render()` on an unresolvable `{{steps.<id>}}` reference silently substitutes `""` (`:118`, `outputs.get(...) ?? ""`) rather than failing — but `validate` should have already rejected any such reference, so this path is a defense-in-depth fallback, not the normal error path.
