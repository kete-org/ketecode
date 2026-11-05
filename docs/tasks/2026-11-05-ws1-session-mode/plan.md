# Plan: WS1 session mode

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Large task: upstream edits and a new session-metadata contract (`kete.sessionMode`), security-relevant
> (the lock that keeps a session in Work's restrictions for 1.3).** Spec approved under the Phase A
> pre-approval; the plan needs the same approval before building.
>
> Upstream files edited (all `kete_change`-marked): `packages/core/src/session.ts` (import + 3 lines in
> `create`) and `packages/core/src/session/session.ts` (import + 1 line in `setMetadata`). No seam exists:
> session hooks can't fail (`permissions` card: `plugin/hooks.ts:23-30`), so create/update refusals are plain
> guard calls, exactly like `KeteAddDir.guard` and `KeteUnattendedPolicy.guardMetadata` beside them.
>
> **Deviation from the spec's wording (same outcome, fewer upstream edits):** the default agent is applied
> **once, at create**, by storing the Work profile's agent as the session's `agent` when none is named
> (`agent: input.agent ?? KeteSessionMode.agent(...)`). Every place that resolves a session's agent
> (`SessionContext.select` `session/context.ts:133`, `SessionRunnerModel.resolve` `session/runner/model.ts:81`,
> three `schedule/check.ts` sites `:192,:254,:369`, `config/plugin/command.ts:112`, Kete's
> `plan-approval.ts:137`) already calls `Agent.select(session.agent)`, so all of them agree on the agent and
> model with zero edits there. A Code session stores no agent (`KeteSessionMode.agent` returns `undefined`),
> so `Agent.select` keeps today's default (configured `default_agent`, then `build`). An explicit agent
> always wins, and `Session.switchAgent` still changes it later. `context.ts`, `runner/model.ts`,
> `schedule/check.ts` and `command.ts` are therefore **not** edited.

## Cards read
- docs/context/modules/unattended.md (verified-at 18dcd2e376, stale: no)
- docs/context/modules/permissions.md (stale: no)
- docs/context/modules/config-kete.md (verified-at 4b77172c15, stale: no)
- docs/context/modules/roles-skills.md (stale: no; Quick answer "How is a session's default agent chosen?")
- docs/context/modules/server-sdk.md (stale: no; only to confirm no API change — metadata is already a free record)
- `node scripts/agent/stale-cards.mjs permissions unattended config-kete roles-skills server-sdk` → "All cards current."

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/util/src/kete/permission-mode.ts` | read | pattern for the shared key/list/`parse` module (header comment, `export * as`) |
| `packages/util/src/kete/session-mode.ts` | **create** | `KeteSessionModes`: `metadataKey = "kete.sessionMode"`, `modes = ["code","work"] as const`, `Mode`, `parse(value): Mode \| undefined`. util has no internal deps, so the literal list is duplicated from the schema (step 2 adds a compile-time check) |
| `packages/schema/src/kete/modes.ts` | read | `KeteModesRpc.Id`, `Profile` (`agent`, `available`) |
| `packages/core/src/kete/modes.ts` | read | `KeteModes.get(id)` — default profile lookup |
| `packages/core/src/kete/unattended-policy.ts` | read (`:160-187`) | `LockedError` + `guardMetadata`: the lock pattern (die with an `Error` subclass, `isDeepStrictEqual`) to copy |
| `packages/core/src/kete/add-dir.ts` | read (`:30-42`, `:128-140`) | `RefusedError` + `guard` — create-time refusal pattern |
| `packages/core/src/kete/session-mode.ts` | **create** | `KeteSessionMode`: `RefusedError`, `LockedError`, `mode`, `guardCreate`, `guardMetadata`, `agent` (step 2) |
| `packages/core/src/session.ts` | **change** (upstream) | imports `:70-71`; `create` `:301` (add a guard line after it), `:314` (`agent:`), `:317` (`metadata:` uses the guarded value) |
| `packages/core/src/session/session.ts` | **change** (upstream) | imports `:32-33`; `setMetadata` `:92` (add the lock line after the unattended one) |
| `packages/core/src/agent.ts` | read (`:13`, `:55-64`, `:103-107`) | `Agent.select` default chain (why Code returns `undefined`) |
| `packages/core/test/kete/unattended-session.test.ts` | read | real `Session.Service` harness to copy for the session test |
| `packages/core/test/kete/session-mode.test.ts` | **create** | pure tests of `guardCreate`/`guardMetadata`/`agent`, Work profile injected as available |
| `packages/core/test/kete/session-mode-session.test.ts` | **create** | real `Session.Service`: create, setMetadata lock, child inheritance, stored agent |
| `docs/upstream-patches.md` | **change** | new "Session mode (WS1 1.2)" section after "Unattended runs" (`:529`), listing both upstream files |
| `docs/desktop-enhancement-plan.md` | **change** (`:155`, `:173`, `:231`) | `mode` on `POST /session` → metadata key `kete.sessionMode`; default agent stored at create, not an `agent.ts` edit |

## Steps
1. **util** `packages/util/src/kete/session-mode.ts`, modelled on `permission-mode.ts`: header comment (who
   writes/reads the key; a session without it is Code; it can only be set at create), `export * as
   KeteSessionModes from "./session-mode.js"`, `metadataKey`, `modes`, `Mode`, `parse`. No labels (1.4 uses
   `KeteModes.summaries`).
2. **core** `packages/core/src/kete/session-mode.ts` (`export * as KeteSessionMode`), pure, no services:
   - One-line compile-time check that util's `Mode` and `KeteModesRpc.Id` are the same union (both
     directions), with a comment saying why.
   - Profile lookup parameter `lookup: (id: KeteModesRpc.Id) => KeteModesRpc.Profile = KeteModes.get`
     (tests inject an available Work profile).
   - `class RefusedError extends Error` (name `KeteSessionModeRefusedError`) and `class LockedError extends
     Error` (name `KeteSessionModeLockedError`, message `This session's "kete.sessionMode" is locked: …`),
     same shape as `KeteAddDir.RefusedError` / `KeteUnattendedPolicy.LockedError`; raised with `Effect.die`
     like their siblings (D1 in the unattended card).
   - `mode(metadata): Mode` — `parse(metadata?.[metadataKey]) ?? "code"` (for already-validated metadata).
   - `guardCreate(parent: Metadata | undefined, next: Metadata | undefined, lookup?):
     Effect<Metadata | undefined>`:
     - `next === undefined` → `undefined` (upstream then inherits the parent's whole metadata, mode
       included — unchanged behaviour).
     - key present in `next`: `parse` fails → die `RefusedError` naming the value (`JSON.stringify` it, so
       `"chat"` and `42` both read clearly); profile `available: false` → die `RefusedError` saying the
       `"work"` mode isn't available yet.
     - `parent` defined: the child's mode (key, or `"code"` if absent) must equal `mode(parent)`, else die
       `RefusedError("a child session must stay in its parent's mode")`. If the parent has the key and
       `next` doesn't, return `{ ...next, [metadataKey]: parent[metadataKey] }` (a child that supplies its own
       metadata, e.g. `{}`, can't drop out of Work — mirrors `inheritMetadata`). Otherwise return `next`.
   - `guardMetadata(current, next): Effect<void>` — same body as `KeteUnattendedPolicy.guardMetadata`
     (`:175-187`) for this key, dying with this module's `LockedError`.
   - `agent(metadata, lookup?): Agent.ID | undefined` (`Agent` from `@opencode/schema/agent`) — `"code"` →
     `undefined` (comment: today's default chain stays in charge, so `default_agent` still wins in Code);
     otherwise `Agent.ID.make(lookup(mode).agent)`.
3. **`packages/core/src/session.ts`** (upstream, every line `// kete_change`):
   - import `KeteSessionMode` beside `:70-71`.
   - new line after `:301`: `const moded = yield* KeteSessionMode.guardCreate(parent?.metadata, guarded)`,
     comment "validate kete.sessionMode; a child stays in its parent's mode".
   - `:314`: `agent: input.agent ?? KeteSessionMode.agent(moded ?? parent?.metadata)`, comment "a session
     that names no agent starts with its mode's agent".
   - `:317`: in the existing marked line replace `guarded` with `moded`; keep its comment.
   - Nothing else (no reformatting).
4. **`packages/core/src/session/session.ts`** (upstream, marked): import beside `:32-33`; new line after `:92`:
   `yield* KeteSessionMode.guardMetadata(session.metadata, input.metadata)`, comment "kete.sessionMode is
   fixed at create (WS1)".
5. **Tests** (`bun:test`, `testEffect`, under `packages/core/test/kete/`):
   - `session-mode.test.ts` (pure): `guardCreate` accepts none / `"code"`; refuses `"chat"`, `42` and
     `"work"` (default lookup), each message naming the value; accepts `"work"` with an injected lookup
     returning `{ ...KeteModes.get("work"), available: true }`; child rules (no key + Work parent → key
     added; `"code"` under a Work parent refused; `"work"` under a Code parent refused). `guardMetadata`:
     add / change / remove refused (`LockedError`); equal value with other keys changed passes; absent →
     absent passes. `agent`: no key and `"code"` → `undefined`; Work (injected) → the profile's agent.
     Assert defects via `Effect.exit` + `Cause` as `unattended-session.test.ts` does.
   - `session-mode-session.test.ts` (real `Session.Service`, harness copied from
     `unattended-session.test.ts`): AC1 create with `"code"` and without the key → `agent` undefined and
     metadata as given; `"chat"` and `"work"` refused (defect names the mode). AC2 `setMetadata` adding,
     changing, removing the key refused; keeping it equal while changing another key succeeds. AC3 a child
     of a `"code"` parent with no metadata and with its own `{}` carries the parent's key; a `"work"` child
     refused. AC4 an explicit `agent` on create is stored as given. (A Work create through
     `Session.Service` can't happen until 1.3; the pure test covers it, per the spec.)
6. **Docs**: `docs/upstream-patches.md` section (rows for both files, why no seam, the agent-at-create
   choice); `docs/desktop-enhancement-plan.md` lines 155/173/231 as in the Files table.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | in `packages/core/`: `bun run test ./test/kete/session-mode.test.ts`, then `bun run test ./test/kete/session-mode-session.test.ts` |
| AC2 | in `packages/core/`: `bun run test ./test/kete/session-mode-session.test.ts` |
| AC3 | in `packages/core/`: `bun run test ./test/kete/session-mode-session.test.ts` |
| AC4 | in `packages/core/`: `bun run test ./test/kete/session-mode.test.ts`, then `bun run test ./test/kete/session-agent-model.test.ts` (Code default path unchanged) |
| AC5 | `packages/util/`: `bun run typecheck`; `packages/core/`: `bun run typecheck`, `bun run test ./test/kete/unattended-session.test.ts`, `bun run test ./test/kete/add-dir.test.ts`, then `bun run test`; `packages/server/`: `bun run test ./test/kete/`; root: `bun run lint`, `bun run --cwd packages/kete-tools upstream:check`, `bun run --cwd packages/kete-tools verify --base main` |

No `bun run generate`: no endpoint, protocol or schema type changes (metadata is already `Record<string, Json>`).

## Cards to update after the build
- `unattended` — Quick answer "which keys are locked": add `kete.sessionMode` (`KeteSessionMode.guardMetadata`).
- `permissions` — Quick answer on `setMetadata` guards: add the session-mode lock.
- `config-kete` — modes Quick answer: profiles are read at session create (`KeteSessionMode`); `available: false` refuses the create.
- `roles-skills` — "How is a session's default agent chosen?": a Work session stores its profile's agent at create.
