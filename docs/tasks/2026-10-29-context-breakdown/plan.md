# Plan: B2 context breakdown

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Large: needs the user's approval before building.** Upstream edits, and two of them go beyond
> what the spec allowed:
> - `packages/tui/src/plugin/builtins.ts`: one import and one entry (allowed by the spec).
> - `packages/core/src/codemode/catalog.ts:48`: add `export` to `CHARACTERS_PER_TOKEN`
>   (the spec requires it to be exported, not copied).
> - **Not in the spec:** `packages/core/src/plugin/internal.ts`, four marked lines: an import, the
>   `KeteContextBreakdown.Service` in `services`, its `.node` in `requirements`, and the plugin at
>   the end of `post`. No Kete plugin can reach `SessionContext` or `Database` today, because
>   neither is in the plugin requirements (`internal.ts:150-253`). Registering a core plugin also
>   always edits this file. Precedent: `KeteFolderTrust.Service`/`.node` (`:173,:231`).
> - **Not in the spec:** `packages/tui/test/fixture/tui-client.ts`, one marked line that answers
>   `/api/rpc/kete.context/get`, the same way as its `kete.todo` and `kete.doctor` lines (`:172-174`).
> - **No edit to `session/context.ts`.** `Instructions.combine` only flattens the sources and keeps
>   each one's `key` (`instructions/index.ts:124-132`), so each source can be sized from
>   `selection.instructions` by calling `read` and then `initial`.
>
> No HTTP route, protocol, generated client or config schema change. The response carries sizes and
> names only (security review: AC8).

## Cards read
- docs/context/modules/todo.md (verified-at a6f140247e, stale: no). Note: its gotcha says `kete.todo` does **not** check the location, so AC6 follows `SessionContext.select`'s check (`context.ts:129`) instead.
- docs/context/modules/instructions.md (verified-at c979e8f4e1, stale: no)
- docs/context/modules/ui-branding.md (verified-at c979e8f4e1, stale: no)
- docs/context/modules/cli.md (verified-at c979e8f4e1, stale: no)
- Not used, and stale: permissions, mcp-presets, server-sdk. The plan doesn't rely on them.

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/schema/src/kete/context.ts` | create | `KeteContextRpc`: `ID = "kete.context"`, `Definition` with `get({sessionID})`. Output is a union, `{type:"refused", reason}` or `{type:"breakdown", categories[], hiddenMcp?, provider?, estimated:true}`. A category is `{id, label, characters, tokens, items[]}` and an item is `{name, characters, tokens}`. Bound the string lengths and array sizes |
| `packages/schema/src/kete/add-dir.ts`, `todo.ts` | read | the RPC definition pattern (`Rpc.define`, `optional`, identifiers) |
| `packages/core/src/kete/context-breakdown.ts` | create | the Kete service with its location `node` (sizing), and the `Plugin` (RPC plus a `context` hook recorder) |
| `packages/core/src/kete/doctor.ts`, `todo.ts` | read | the plugin, RPC registration and storage/event patterns (`todo.ts:87-91,136-150`) |
| `packages/core/src/kete/folder-trust.ts` | read (only its `Service`/`node` definitions) | the pattern for a Kete location service that is exposed to plugins |
| `packages/core/src/session/context.ts` | read | `select` (`:126-166`: the location check, the merged permissions, the per-source list), `resolveModel`, and the `node` deps (`:212`) |
| `packages/core/src/session/generate.ts` | read `:25-50` | the read-only recipe: `select` → `resolveModel` → `SessionHistory.preview` → `SessionModelRequest.baseTranscript` |
| `packages/core/src/session/history.ts` | read `:103-236` | `preview` is read-only and starts at the latest compaction (AC5); `entriesForRunner` writes, so don't use it |
| `packages/core/src/session/model-request.ts` | read `:92-112` | `baseTranscript`: the system prompt (agent prompt or `SessionSystemPrompt.make`) and the messages; use it as is |
| `packages/core/src/tool.ts` | read `:51-60,:225-270,:293` | `Snapshot` (`definitions`, `codeModeCatalog`); Code Mode is off when `execute` is wholly denied (`whollyDisabled` is not exported) |
| `packages/core/src/codemode/catalog.ts` | change `:48` (marked) | `export const CHARACTERS_PER_TOKEN`; read `:20-60,:180-190` for `Inventory`/`summarize` (total vs shown) |
| `packages/core/src/codemode/instructions.ts` | read | `make`/`render` of the catalog's instruction source |
| `packages/core/src/instruction-discovery.ts` | read `:17-70,:120-130` | `list()` gives the files (path and content) behind the single `core/instructions` source; the per-file header format |
| `packages/core/src/kete/auto-memory.ts` | read `:47,:65-70,:327-334` | `HEADER`, used to recognise the auto memory parts the `context` hook adds |
| `packages/core/src/plugin/internal.ts` | change (4 marked lines) | import; `KeteContextBreakdown.Service` in `services` (next to `KeteFolderTrust.Service` `:173`); `.node` in `requirements` (`:231`); `KeteContextBreakdown.Plugin` last in `post` (after `KeteSandbox.ApprovalPlugin` `:371`) so its `context` hook sees every other hook's additions |
| `packages/client/src/solid/usage.ts` | read | `lastAssistantWithUsage`: mirror its rule (latest assistant with tokens after the last completed compaction) on the core message type |
| `packages/tui/src/feature-plugins/prompt/footer.tsx` `:36-45`, `packages/tui/src/util/session.ts` (`contextUsage`) | read | how the TUI turns step tokens into the context total; compute the same total in core |
| `packages/core/test/session-generate.test.ts`, `packages/core/test/kete/session-agent-model.test.ts` | read | fixtures for a session with an agent, a model, tools and messages through `SessionContext` |
| `packages/core/test/kete/todo.test.ts`, `packages/core/test/kete/doctor.test.ts` | read | Kete plugin test harness (`host`, `location`, `tmpdir`, `testEffect`) |
| `packages/core/test/kete/context-breakdown.test.ts` | create | AC1–AC6, AC8 |
| `packages/tui/src/kete/context.tsx` | create | builtin TUI plugin: the `/context` slash/palette command, an RPC fetch decoded against `KeteContextRpc`, a dialog with a bar and rows sorted by size; the tools, MCP and memory rows expand |
| `packages/tui/src/kete/doctor.tsx` | read | the closest model: slash command (`:206-219`), RPC call with `location` (`:61`), dialog |
| `packages/tui/src/kete/todo.tsx` `:15-75` | read | how a plugin finds the current session ID and calls an RPC with it |
| `packages/tui/src/plugin/builtins.ts` | change (2 marked lines) | import `KeteContext` and add it to `builtins` |
| `packages/tui/test/kete/doctor.test.tsx` | read | the app-fixture test pattern (type the slash command, wait for the frame, Esc) |
| `packages/tui/test/fixture/tui-client.ts` | change `:174` (1 marked line) | answer `/api/rpc/kete.context/get` (a refused or minimal breakdown) |
| `packages/tui/test/kete/context.test.tsx` | create | AC7 |
| `docs/upstream-patches.md` | change | record the `internal.ts`, `catalog.ts`, `builtins.ts` and `tui-client.ts` edits under a new "Context breakdown" section |

## Steps
1. **Schema** (`schema/src/kete/context.ts`). Category ids: `system`, `tools`, `codemode`, `mcp`,
   `memory`, `skills`, `messages`, and `other` (plugin additions seen at the last request).
   `provider` is `{ tokens, contextLimit?, free? }` and is **optional**: leave it out when the
   session has no assistant step with usage (AC3, absent, not zero). `hiddenMcp` is
   `{count, reason}` and is optional. There are no fields for config, env, headers or file contents.
2. **Export the constant**: `export const CHARACTERS_PER_TOKEN = 4 // kete_change` in `catalog.ts:48`.
   Change nothing else in that file.
3. **Core service** (`kete/context-breakdown.ts`, a location node with deps
   `[SessionContext.node, Database.node, InstructionDiscovery.node, Tool.node, SessionStore.node]`
   or whatever the layer actually yields):
   - `estimate(chars) = Math.ceil(chars / CHARACTERS_PER_TOKEN)`, imported from `catalog.ts`. It is
     the only place tokens are computed (AC2).
   - **Location check first (AC6)**: read the session from the store. If it is missing, or its
     `location.directory`/`workspaceID` differs from `Location`, return `refused`. `select` would
     interrupt here (`context.ts:129`), so this check must come before it.
   - `selection = select(id)` and `model = resolveModel(selection.session)`. If there is no model,
     leave out `provider` and size the messages anyway: messages need `model.ref` only as the
     preview boundary, so check whether `preview` accepts the session's own ref. If it doesn't,
     report the messages as unavailable. Don't fail.
   - `history = SessionHistory.preview(db, …)` (read-only; AC5 comes free) and
     `transcript = baseTranscript(...)`.
   - **system**: `transcript.system[0]` (agent prompt or default system prompt).
   - **instructions, one per source**: for each `source` in `selection.instructions`, call
     `source.read`. Skip it if the value is unavailable or removed. Otherwise size it with
     `source.initial(value)`. Map the keys: `core/instructions` goes to **memory** (items from
     `discovery.list()`, one per file path, sized as its rendered block), `core/mcp-guidance` to
     **mcp**, skill keys to **skills**, the codemode key to **codemode**, `api/*` entries to
     **memory** ("session instruction entries"), and anything else to `other`.
   - **tools**: each entry in `selection.tools.definitions` is sized as
     `JSON.stringify({name, description, inputSchema})`. `execute` goes under **codemode** together
     with the catalog source. The codemode category's items say `count` total and `shown` inline,
     from `CodeModeCatalog.summarize` (or the catalog summary already in the instruction value; take
     whichever exists, without rebuilding the catalog).
   - **hidden MCP (AC4)**: if `selection.tools.codeModeCatalog` is undefined, call
     `registry.snapshot(rules without the ones whose action matches "execute")`, using the same
     merged permissions as `context.ts:136`. It hits the catalog cache, because the tool names are
     unchanged. Its catalog tool count is `hiddenMcp.count`, with the reason "a permission rule
     denies `execute` (Code Mode), so MCP tools are not sent". If the count is 0, leave the field out.
   - **messages**: each message in `transcript.messages` is sized as its JSON. Report the item
     count. Synthetic nested `AGENTS.md` messages count here.
   - **provider**: the latest assistant with tokens after the last completed compaction (the
     `usage.ts` rule). Compute the total the same way as `contextUsage`, `contextLimit` from
     `model.limit.context` when it is > 0, and `free` from those two.
4. **Plugin** (same file): register `KeteContextRpc.Definition` (`get` → service). Add a
   `ctx.session.hook("context", …)` recorder that runs last (it is registered last in `post`). It
   only reads, inside `Effect.sync`, and stores for each session: the auto memory parts' sizes
   (text includes `KeteAutoMemory.HEADER`, reported as a **memory** item "auto memory (last
   request)") and the total characters of `event.system`. `other` is that total minus the base
   system and instructions, never below 0, labelled "added by plugins at the last request". Keep at
   most 100 sessions (drop the oldest) and delete an entry on `session.deleted` (as
   `todo.ts:144`). Never run `request.primary/generate`: the `context` hooks have side effects
   (`plugin/warming.ts:96-103` starts a loop).
5. **Register** in `internal.ts`: 4 lines, each with `// kete_change: …` in the style of `:173,:231,:369`.
6. **Core tests** (`test/kete/context-breakdown.test.ts`):
   - AC1: a session with 2 direct tools (`codemode: false`), 1 MCP server's tools in Code Mode,
     an `AGENTS.md`, one skill and 2 messages. Every category is > 0, and each matches the size of
     its fixture text.
   - AC2: each category's `tokens === Math.ceil(characters / CHARACTERS_PER_TOKEN)`, using the
     imported constant.
   - AC3: with and without an assistant step with usage (absent, not 0).
   - AC4: deny `execute` → `hiddenMcp.count === N` and the reason is set; allowed → no `hiddenMcp`.
   - AC5: messages before a completed compaction are not counted.
   - AC6: a session in another directory → `refused`.
   - AC8: an MCP server config with a secret header value. `JSON.stringify(response)` must not
     contain the value, and the response has no `headers`/`env` keys.
7. **TUI** (`tui/src/kete/context.tsx`): `/context` (slash with `palette: true`, as `doctor.tsx`).
   On home (no session) show "Open a session to see its context." Otherwise fetch, decode
   (malformed → an error row, not trusted), and show the dialog: a header with the provider total,
   the model limit and free space when present, and "Estimates (about 4 characters per token)";
   a proportional bar; rows sorted largest first; the tools, MCP and memory rows expand to show
   their items; and the hidden-MCP warning row. Read only, Esc closes. Use the theme's colours,
   no hard-coded names.
8. **Register** in `builtins.ts` (import plus entry, each `// kete_change`, the comment on the same
   line as the existing entries; these are TS lines, not JSX). Add the fixture line in
   `tui-client.ts`.
9. **TUI test** (`test/kete/context.test.tsx`): typing `/cont` shows `/context` in the
   autocomplete; Enter opens the dialog (its title is shown); Esc closes it.
10. **`docs/upstream-patches.md`**: add a "Context breakdown" section that lists the four upstream
    files and why no seam works for each.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1–AC6, AC8 | `cd packages/core && bun run test ./test/kete/context-breakdown.test.ts` |
| AC2 (constant export compiles) | `cd packages/core && bun run typecheck` |
| AC7 | `cd packages/tui && bun test ./test/kete/context.test.tsx` |
| AC9 schema | `cd packages/schema && bun run typecheck && bun run test` |
| AC9 core | `cd packages/core && bun run test ./test/kete` then `bun run test` (30 known machine failures are on `main` too) |
| AC9 tui | `cd packages/tui && bun run typecheck && bun test` (2 known `dialog-shell-output` timeouts) |
| AC9 lint, markers | `bun run lint` (root); `bun run --cwd packages/kete-tools upstream:check` |
| No regression from the new plugin requirement | `cd packages/core && bun run test ./test/session-generate.test.ts ./test/plugin/plan.test.ts` |

## Cards to update after the build
- New `docs/context/modules/context-breakdown.md`, plus its row in `docs/context/INDEX.md`.
- `instructions.md`: add Quick answers. Plugins can't reach `SessionContext`/`Database` unless they are added to the `internal.ts` requirements. `SessionHistory.preview` is the read-only sizing path. `Instructions.List` keeps per-source keys.
- `ui-branding.md`: `/context` under the slash command recipe.
- `todo.md`: no change needed (its gotcha already says it doesn't check the location). The spec's AC6 wording was wrong about that.
- `docs/context/pitfalls.md`: never run `SessionModelRequest.primary/generate` for inspection, because `context` hooks have side effects (warming).
