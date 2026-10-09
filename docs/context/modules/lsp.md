---
module: lsp
paths: [packages/core/src/kete/lsp.ts, packages/core/src/kete/lsp/*]
verified-at: 0f5cf9baaa
---
## Quick answers
- Did upstream have LSP? v1 did (`packages/opencode/src/lsp`, tag v1.4.9; reference for the protocol flow). v2 has none (TODOs in `core/src/file-mutation.ts`, `tool/plugin/edit.ts`, `tool/plugin/write.ts`) but keeps the `lsp` config key (`schema/src/config/lsp.ts`, normalized in `core/src/config/normalize.ts`), which this module reads. No upstream tool was edited: diagnostics are appended in a `tool.execute.after` hook.
- Which servers? Built-ins in `lsp/servers.ts` (typescript, python with a basedpyright alternative, go, rust), only from PATH (`core/src/util/which.ts`); never downloaded.
- Can a repository add a server command? No: `command`/`env`/`initialization`/new servers count only from documents under the global config dir; a project can only disable (`lsp: false`, `<id>.disabled`). `ignored` is logged once.
- Sandbox? Each server is wrapped by Seatbelt/bwrap via `KeteSandboxResolve.resolve` with a private temp dir passed as the "workspace" (so nothing in the real workspace is writable and Linux placeholders land in that temp dir), `network: false`; sandbox `off` or unavailable+`auto` → unsandboxed; `required`+unavailable → not started (`lsp.ts:134`).
- Job mode / review mode? The plugin returns immediately (`KeteJobMode.enabled`); remote-workspace locations too. Spawns go through `Environment.spawner` (classified `seam` in `core/test/kete/job-spawn-sites.test.ts`).

## Purpose
Feed compiler/linter errors from language servers back to the agent after its edits.

## Entry points
- `KeteLsp.Plugin` / `make(deps)` (`core/src/kete/lsp.ts:113`), registered after `KeteTodo` in `pre` (`core/src/plugin/internal.ts:305`).

## Key files
| File | Role |
| --- | --- |
| `packages/core/src/kete/lsp.ts` | plugin: touched files (`touched`, `:63`), sandboxed launch, lazy start/LRU (`MAX_SERVERS`, `:49`), `diagnose`, the after hook (`:358`) |
| `packages/core/src/kete/lsp/rpc.ts` | Content-Length JSON-RPC connection (16 MiB frame cap, timeouts, unknown requests answered) |
| `packages/core/src/kete/lsp/client.ts` | initialize, didOpen/didChange (full text), publishDiagnostics with a quiet period |
| `packages/core/src/kete/lsp/servers.ts` | catalogue, settings from `lsp` per document, root markers, language ids |
| `packages/core/src/kete/lsp/diagnostics.ts` | parse, clean, per-session dedupe (`Reported`), bounded report |

## Data flow
`edit`/`write`/`patch` completes → absolute paths (write `output.target`, patch `output.applied[].target`, edit `input.path` via `FileAccess.resolve`) → servers by extension → root → start or reuse → `touch` → wait (quiet 300 ms, max 4 s) → `report` → appended text content.

## Data and APIs used
- Config `lsp` (upstream schema), `kete.sandbox` settings, `Environment.spawner`, `Global` dirs.

## Rules that must not break
- Never fail the edit; never download servers; project config only disables; sandboxed without network when available; nothing in job mode.

## Testing
- `bun run test ./test/kete/lsp.test.ts` in `packages/core/` (fake server `test/fixture/kete/fake-lsp-server.js`; a real-sandbox case skips when unavailable unless `KETE_SANDBOX_TESTS=required`; `KETE_LSP_SMOKE_TS=<typescript-language-server>` runs a real TypeScript smoke test).

## Changes
- 2026-10-10 created (wave 1a, `docs/tasks/2026-10-10-wave1a`).

## Gotchas
- `typescript-language-server` needs TypeScript 5.x (`tsserver.js`); TypeScript 7 has none — set `initialization.tsserver.path` in the global config or the server fails to start (logged, skipped).
- On macOS the shared temp dirs stay writable in the sandbox, so tests under `os.tmpdir()` can't show the workspace being read-only.
