# Plan: WS1 mode profiles

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

**Large: new shared contract (`kete.modes` plugin RPC, read by 1.4's switch). No upstream file is edited,
no config schema change, no openapi/SDK regeneration, nothing enforced (security-neutral). Needs the user's
approval of this plan (spec approved under the Phase A pre-approval).**

**Deviation from spec (upstream-first, CLAUDE.md §4: a Kete-owned module before an upstream edit):** the spec
registers a new plugin in `core/src/plugin/internal.ts` (marked edit). The Kete-owned `KeteHandshake.Plugin`
is already in that list and already needs the loader (handshake `modes`), so it registers `kete.modes` too.
Result: zero upstream edits. If the user prefers a separate plugin id, the fallback is the spec's marked
import and list entry in `internal.ts` next to `KeteHandshake` (`:136`, `:355`).

## Cards read
- docs/context/modules/config-kete.md (verified-at 4b77172c15, stale: no)
- docs/context/modules/permissions.md (verified-at 4b77172c15, stale: no)
- docs/context/modules/server-sdk.md (verified-at 4b77172c15, stale: no)
- docs/context/pitfalls.md, docs/context/commands.md

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/schema/src/kete/handshake.ts` | read | pattern for a Kete RPC schema file (namespace export, `Rpc.define`, annotations) |
| `packages/schema/src/kete/todo.ts` | read (`:19-24`) | `Schema.Literals` + `annotate({ identifier })` pattern |
| `packages/schema/src/kete/modes.ts` | **new** | `Profile` schema, `Summary`, `Definition` (`kete.modes`, method `list`) |
| `packages/schema/test/kete/handshake.test.ts` | read | schema test pattern |
| `packages/schema/test/kete/modes.test.ts` | **new** | AC1 rejection cases |
| `packages/core/src/kete/modes/code.jsonc` | change | fill in every field (today's behaviour) |
| `packages/core/src/kete/modes/work.jsonc` | change | fill in Work's fields, `available: false`; drop `placeholder` |
| `packages/core/src/kete/unattended-policy.ts` | read (`:80-95`) | the `onExcessProperty: "error"` decode pattern |
| `packages/core/src/kete/modes.ts` | **new** | loader: embedded profiles, strict decode, `list()`, `get(id)`, `summaries()`, `available()` |
| `packages/core/src/kete/handshake.ts` | change | `modes` from the loader; also registers `kete.modes` |
| `packages/core/src/kete/todo.ts` | read (`:85-92`) | `ctx.rpc.register(...)` then `.pipe(Effect.orDie)` pattern |
| `packages/core/test/kete/modes.test.ts` | rewrite | today it only checks JSONC well-formedness; becomes AC1 (shipped profiles decode) + AC2 |
| `packages/server/test/kete/handshake.test.ts` | change | add the `kete.modes/list` test (AC3); the handshake assertion stays `["code"]` |
| `docs/desktop-enhancement-plan.md` | change (`:157`, `:172`, `:226-228`) | `GET /api/kete/modes` becomes the `kete.modes` RPC; no route mount |
| `docs/upstream-patches.md` | change (WS0 handshake section, `:1801-1817`) | one sentence: the handshake plugin also serves `kete.modes`; its test list gains the new tests |

## Steps
0. The worktree has no `node_modules`: run `bun install` at the worktree root first.
1. **Schema** `packages/schema/src/kete/modes.ts` (`export * as KeteModesRpc from "./modes.js"`):
   - `Id = Schema.Literals(["code", "work"])`; `Shell = Schema.Struct({ run: Literals(["any","allowlist","off"]),
     allow: Schema.Array(Schema.String), windows: Literals(["same","off"]) })`;
   - `Profile = Schema.Struct({ id, name, description, agent: String, available: Boolean, files: Literals(["workspace","granted"]),
     shell, network: Literals(["default","off"]), git, web, mcp: Boolean, approvals: Literals(["default","action-class"]),
     outputs: Literals(["in-place","kete-outputs"]) })`, each annotated `KeteModes.*`.
   - `Summary = Schema.Struct({ id, name, description, agent, available })`.
   - `ID = "kete.modes"`; `Definition = Rpc.define({ id: ID, methods: { list: { input: Schema.Struct({}), output: Schema.Array(Summary) } }, events: {} })`.
   - Header comment: adding fields is fine; changing or removing one breaks 1.4's switch. Unknown keys are
     rejected by the decode options (step 3), so callers must decode with `onExcessProperty: "error"`.
2. **Profiles**: `code.jsonc` = `build`, `available: true`, workspace, shell `{ run: "any", allow: [], windows: "same" }`,
   network default, git/web/mcp true, approvals default, outputs in-place. `work.jsonc` = `work-orchestrator`,
   `available: false` (comment: until 1.3 enforces it), granted, shell `{ run: "allowlist", allow: ["python","node"], windows: "off" }`,
   network off, git false, web true, mcp false, action-class, kete-outputs. Update the "nothing reads them" comments.
3. **Loader** `packages/core/src/kete/modes.ts` (`export * as KeteModes from "./modes.js"`):
   - `import code from "./modes/code.jsonc"` and `work` likewise, **without** `with { type: "text" }`: Bun parses
     JSONC (comments, trailing commas) at bundle time, so the value survives `bun build --compile` and no
     `jsonc-parser` call is needed. bun-types declares `*.jsonc` as `any`; hand it straight to the decoder as
     `unknown` (no assertion). If `bun check` rejects the import, fall back to `with { type: "text" }` +
     `jsonc-parser` `parse` with an errors array (as `kete/doctor.ts` does) and report it.
   - Decode each with `Schema.decodeUnknownSync(Profile, { errors: "all", onExcessProperty: "error" })` at module
     load; on failure throw `new Error(\`mode profile ${file}: ${message}\`, { cause })`. Startup error, never a
     default. Also throw if a file's `id` differs from its file name.
   - `list()` → `[code, work]` (that order); `get(id: KeteModesRpc.Id)` → `Profile`; `summaries()` → `list()`
     mapped to the `Summary` fields; `available()` → ids whose `available` is true.
4. **Handshake + RPC** `packages/core/src/kete/handshake.ts`: `modes: KeteModes.available()` (still `["code"]`);
   register `KeteModesRpc.Definition` with `list: () => Effect.succeed(KeteModes.summaries())` in the same
   plugin effect (`Effect.all([...])`, then `Effect.asVoid, Effect.orDie` as now). Update the header comment.
   Do not touch `internal.ts`.
5. **Tests**:
   - schema `modes.test.ts`: a valid inline profile decodes; with `{ errors: "all", onExcessProperty: "error" }`
     an unknown top-level key, an unknown key inside `shell`, `id: "chat"` and a missing `network` each throw
     with a message naming the field (`toThrow(/network/)` etc.).
   - core `modes.test.ts` (replace the file): both shipped profiles load (importing the module is the decode);
     `list()` ids `["code","work"]`, work `available === false`; `get("code").agent === "build"`; `get("work")`
     network `"off"`, git `false`, `shell.windows === "off"`; `summaries()` entries carry no `shell` key;
     `available()` is `["code"]`.
   - server `handshake.test.ts`: new `it.live` posting `{ input: {} }` to `/api/rpc/kete.modes/list` with the
     existing test's setup → 200, `output` = two summaries, `available` true then false.
6. **Docs**: the plan doc lines listed above; the `upstream-patches.md` note.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `bun test ./test/kete/modes.test.ts` in `packages/schema`; `bun run test ./test/kete/modes.test.ts` in `packages/core` (shipped profiles decode) |
| AC2 | `bun run test ./test/kete/modes.test.ts` in `packages/core` |
| AC3 | `bun run test ./test/kete/handshake.test.ts` in `packages/server` |
| AC4 | `bun run build --single --skip-install --skip-web-ui` in `packages/cli`; then with a throwaway HOME (`H=$(mktemp -d)`): `HOME=$H XDG_CONFIG_HOME=$H/c XDG_DATA_HOME=$H/d XDG_STATE_HOME=$H/s KETE_SERVER_PASSWORD=smoke dist/cli-<os>-<arch>/bin/kete serve --port 4787 &`, then `curl -s -u opencode:smoke -X POST -H 'content-type: application/json' -d '{"input":{}}' http://127.0.0.1:4787/api/rpc/kete.modes/list` lists both modes; kill the server, remove `$H` |
| AC5 | `bun run typecheck` and `bun run test` in `packages/schema` and `packages/core`; `bun run test ./test/kete` in `packages/server`; root `bun run lint`; `bun run --cwd packages/kete-tools upstream:check` |

## Cards to update after the build
- `config-kete`: mode profiles (`core/src/kete/modes/*.jsonc`, embedded, strict decode, not user-editable; loader `core/src/kete/modes.ts`).
- `server-sdk`: Quick answer for `kete.modes/list` (served by the handshake plugin) and where handshake `modes` comes from.
- `permissions`: one line that the profile fields (`files`, `shell`, `network`, `git`/`web`/`mcp`, `approvals`) exist but are enforced only from 1.3.
