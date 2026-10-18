> **Approved 2026-10-18** by the main session under the user's no-stop instruction (handoff.md), including both spec departures (execute.after hook instead of a read.ts edit; `.md`-only imports from `~/.claude/` and the global config).

# Plan: CLAUDE.md compatibility, @imports and nested memory (A2a)

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

**Large task: needs the user's approval before building.** Reasons:
- **Upstream edit:** `packages/core/src/plugin/internal.ts` gets one marked import and one marked registration line. Nothing else upstream changes.
- **Config schema:** a new `kete.memory` object, so the protocol and client are regenerated and the field becomes a config contract.
- **Security:** imports read files into model context, which is a way to exfiltrate secrets. Security review before merge.

**Departure from the spec (fewer upstream edits):** the spec plans a marked call in `tool/plugin/read.ts` for nested files. The plan uses the public `ctx.tool.hook("execute.after")` seam instead (CLAUDE.md §4, step 2 before step 5). `KeteAudit` already uses that seam (`core/src/kete/audit.ts:697`). The hook gets the read's `input.path` and `result.output`. It resolves the path with `FileAccess.Service.resolve` and skips an external directory, as `read.ts:85-106` does. Then it walks and calls `SessionInstructions.load`. `read.ts` stays unedited.

**Security tightening beyond the spec:** inside `~/.claude/` and the global config folder, only `*.md` files can be imported. Without this rule, `@~/.config/kete/kete.json` (MCP headers, `{env:}` secrets) or `@~/.claude/settings.json` / `projects/*.jsonl` (env values, transcripts) would pass the folder check. Project-root imports keep any file type that passes the denylist. Record this in the module header and the card.

## Cards read
- docs/context/modules/instructions.md (verified-at ecfae5cce7, stale: no)
- docs/context/modules/config-kete.md (verified-at 99313fa3c1, stale: no)
- docs/context/modules/roles-skills.md (verified-at 9a95cb7ac3, stale: no; refreshed after the earlier blocked planner run)
- docs/context/pitfalls.md, commands.md, decisions.md via INDEX

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/core/src/config/plugin/instruction.ts` | read | The upstream plugin to mirror: walk (`ancestorDirectories`, `start`/`stop`/`project`, `:32-50`), watcher + 100 ms debounce + `discovery.reload()` (`:51-54,106-113`), `readFileStringSafe`, unavailable handling, `isolate`. Don't edit. |
| `packages/core/src/instruction-discovery.ts` | read | `Editor` API (`list/add/remove/unavailable`, `:28-36`). Map insertion order is render order. `File` class. `project`/`global` flags. |
| `packages/core/src/tool/plugin/read.ts` | read | The nested walk to copy for the hook (`:80-106`: external skip, list-page vs file start, root excluded). Don't edit. |
| `packages/core/src/session/instructions.ts` | read | `SessionInstructions.load({sessionID, paths})`: reads each path, renders `Instructions from:` in the order given, keeps a per-session ledger. Don't edit. |
| `packages/core/src/file-access.ts` | read | `resolve` (`:169`) returns a target whose `externalDirectory` marks an outside read. |
| `packages/core/src/kete/audit.ts:520-560,685-700` | read | Pattern for `ctx.tool.hook("execute.after")` and reading `event.status`/`result.output`. |
| `packages/core/src/kete/lsp.ts:205-230` | read | Pattern for a `define`-style Kete plugin that reads `Config.Service` and `Config.latest(entries, "kete")`. |
| `packages/core/src/kete/shell-risk.ts:270-292` | read | `credential(value)` is the runtime's existing secret-path matcher. Reuse it on the path **relative to its allowed root**: its `.config/kete` pattern would otherwise reject every global-config import. |
| `packages/util/src/fs-util.ts:40-55,100-110,265-275` | read | `resolve` (realpath, or the lexical path on NotFound), `readFileStringSafe`, `contains`. |
| `packages/core/src/kete/memory-imports.ts` | **create** | Pure logic, no services. `importTokens(text)` drops fenced blocks (```/~~~) and inline code spans. It matches `@` at the start of a line or after whitespace (so `me@example.com` doesn't match), takes the token to the next whitespace and trims trailing `.,;:)]`. The token must start with `~/`, `./`, `../`, `/` or a path character. `target(token, importerDir, home)` handles `~` expansion with `path`. `denied(real, roots, home)` returns a reason or undefined. It denies paths outside every allowed root. It denies anything under `home/.ssh`, `home/.aws` or `home/.gnupg`, and any path where `KeteShellRisk.credential(relative-to-root)` matches. It denies basenames matching `^\.env`, `\.(pem\|key)$`, `^id_`, `credentials` or `^\.(npmrc\|netrc)$`, all case-insensitive. Under the `~/.claude` or global-config root, it denies anything that isn't `.md`. Constants: `MAX_DEPTH = 5`, `MAX_FILE = 64 * 1024`, `MAX_TOTAL = 256 * 1024`. |
| `packages/core/src/kete/memory-files.ts` | **create** | `KeteMemoryFiles.Plugin` (`define`, id `kete.memory-files`), with an `expand` Effect shared by both halves (below). |
| `packages/core/src/plugin/internal.ts` | **change (upstream)** | One marked `import { KeteMemoryFiles } from "../kete/memory-files.js" // kete_change` near `:100-107`, and `KeteMemoryFiles.Plugin` with a `// kete_change: …` comment line directly after `ConfigInstructionPlugin.Plugin` in `post` (`:324`), so its transform runs after upstream's. Why no seam works: internal plugins are only listed here, so there's no other way to register one. |
| `packages/schema/src/config/kete.ts` | change (Kete-owned) | Add a `Memory` class: `claudeMd` and `imports`, both optional booleans with descriptions, defaulting to on. Add `memory: Memory.pipe(optional)` in `Info` (`:172-200`). |
| `packages/protocol/openapi.json`, `packages/client/src/*/generated/` | regenerate | `bun run generate` in `packages/protocol`, then in `packages/client`. Never hand-edit. |
| `packages/core/test/instruction-discovery.test.ts` | read | Harness for `ConfigInstructionPlugin` tests (`:158-460`: temp home/project, layers, watcher edits). Copy it for the Kete plugin tests. |
| `packages/core/test/session-instructions.test.ts` | read | Harness for nested injection through `SessionInstructions` and the read tool. |
| `packages/core/test/kete/memory-imports.test.ts` | **create** | Unit tests for the parser and policy (AC3, AC4 pure parts). |
| `packages/core/test/kete/memory-files.test.ts` | **create** | Plugin and hook tests (AC1-AC7). |
| `docs/context/modules/instructions.md` | change | See "Cards to update". |
| `.github/README.md` | change | Kete's README (never upstream's root `README.md`): a short `## Memory files` section before `## Installing skills`: `AGENTS.md` first, `CLAUDE.md` fallback, `@path` imports and their limits, the two switches. |
| `CHANGELOG.md` | change | One bullet under `## Unreleased`. |
| `docs/upstream-patches.md` | change | A new `## Memory files (feature/memory-files)` section at the end: the two `internal.ts` lines and why. |

## Steps
1. **Schema.** Add `ConfigKete.Memory` and `Info.memory` in `packages/schema/src/config/kete.ts`. Descriptions: "Load CLAUDE.md where a folder has no AGENTS.md (default on)" and "Expand @path imports in AGENTS.md and CLAUDE.md (default on)". Run `bun run typecheck` in `packages/schema` and `packages/core`.
2. **`memory-imports.ts`** (pure, as in the file table). Export a `Skip` reason union: `"outside"`, `"secret"`, `"not-markdown"`, `"too-large"`, `"total"`, `"not-file"`. The note text is `(import of <path> skipped: <reason text>)`, with `outside the allowed folders` for `outside`. Write `memory-imports.test.ts` first. It covers code spans, fences, email, `@./x`, `@../x`, `@~/x`, `@/abs`, trailing punctuation, traversal `@../../../etc/passwd` → outside, `~/.ssh/id_ed25519`, `.env.local`, `server.pem`, `~/.claude/.credentials.json`, `~/.config/kete/kete.json` (not markdown), `~/.config/kete/notes.md` (allowed) and Windows-style roots through `path.win32` where cheap.
3. **`expand` in `memory-files.ts`.** Signature: `expand(files: {path, content}[], roots, budget)` → ordered `{ path, content, imports: File[], notes: string[] }`. For each memory file, take the tokens depth-first, resolve each with `fs.resolve` (realpath), and drop it if it's already in the `seen` set. Then check `denied`, then the file type and size from the FileSystem `stat` on the real path. A missing file or dangling link is skipped silently with a debug log, with no note and no unavailable mark. A refused path gets a note and a debug log, and **is never read**. Read it, re-check the length (≤ 64 KiB, so it's bounded even if the file grew after `stat`), add it to the budget, and recurse to depth 5. Return the importing file's text unchanged. Notes go to the importer as trailing lines, `content + "\n\n" + notes.join("\n")`. The rule: the `@` tokens are never rewritten. `seen` starts with every memory file's realpath, so a cycle or repeat loads once.
   - Roots for a **project** file: the project root, plus `~/.claude` and the global config folder only when `discovery.global` is on. Roots for a **global** file: those two folders, plus the project root only when `discovery.project` is on. Every root goes through `fs.resolve`.
4. **The plugin's preloaded half**, mirroring `instruction.ts`:
   - Return early if `!discovery.project && !discovery.global`.
   - Each refresh reads `Config.latest(entries,"kete")?.memory` (`claudeMd`/`imports`, `!== false`), as in `lsp.ts`.
   - Ordered memory list:
     - global `<config>/AGENTS.md`;
     - `~/.claude/CLAUDE.md` when `discovery.global` and `claudeMd` are on;
     - then for each folder of `ancestorDirectories(start, stop)`, nearest first: `AGENTS.md` if it exists, else `CLAUDE.md`, else `.claude/CLAUDE.md` when `claudeMd` is on. This needs `discovery.project` and `FSUtil.contains(root, start)`, as upstream does.
     - The `global` exclusion rule applies as at `:48`.
   - Read the Kete-owned (`CLAUDE.md`) files. An unreadable one makes the source unavailable, as in `projectSource`. Read the `AGENTS.md` files too, but only to scan their imports. Run `expand` when `imports` is on. The result is cached in a `{ current }` ref.
   - Watch all `CLAUDE.md`, `.claude/CLAUDE.md` and `AGENTS.md` candidates. When imports are found, also watch each imported realpath once (a `Set`; `// shortcut: watched imports are never unsubscribed, bounded by the import cap; unsubscribe on a rescan if it ever matters`). All of these go through the same `PubSub` + 100 ms debounce + `refresh` + `discovery.reload()` as upstream. Wrap the work in a `Semaphore` and an `isolate` like upstream's.
   - Transform (synchronous):
     - If the cache is unavailable, call `editor.unavailable()` and return.
     - Take `before = editor.list()` and remove every entry.
     - For each file in the ordered list, emit upstream's entry if it's in `before` (by path), else Kete's `CLAUDE.md` entry. Use the cached content with notes when `before` has the same path, so only the notes are added. Then emit that file's imports.
     - Paths emitted are de-duplicated by realpath. A `CLAUDE.md` symlinked to an already-loaded `AGENTS.md` is emitted once.
     - Re-add any `before` entry not yet emitted, in its original order (other contributors).
     - When neither switch adds anything, leave the editor untouched.
5. **The plugin's nested half:** `ctx.tool.hook("execute.after", …)` for `event.tool === "read"` and `status === "completed"`.
   - Resolve `input.path` with `FileAccess.Service.resolve` and skip an external directory.
   - Start the walk at the path for a `list-page` output, else at its `dirname`. Walk to the location root, excluding the root, as `read.ts:90-100` does.
   - In each folder with no `AGENTS.md`, take `CLAUDE.md` / `.claude/CLAUDE.md` when `claudeMd` is on. Folders that do have one are already handled by upstream's injection.
   - Expand imports for both the new `CLAUDE.md` files and the nested `AGENTS.md` files, with the project roots. Drop every path already in `discovery.list()`.
   - Call `SessionInstructions.load({ sessionID, paths: [file, ...its imports, …] })`. Skip notes are debug-logged only, because `load` renders file content as-is.
   - `Effect.catch` and `catchDefect` to void, as upstream does, so a read never fails. Job review mode is covered: `SessionInstructions.load` is a no-op there and `discovery.project` is false.
   - Known gap: `load` re-reads paths that `expand` checked, a check-then-use window inside the allowed roots. Say so in the module header for the security reviewer.
6. **Register** in `internal.ts` (two marked lines).
7. **Tests** in `memory-files.test.ts`, using the `instruction-discovery.test.ts` harness:
   - AC1: only `CLAUDE.md`, only `.claude/CLAUDE.md`, both files present, and a symlink.
   - AC2: global order, and `global:false`.
   - AC3: an import appears right after its importer, depth 5 (a depth-6 file is absent), a cycle loads once.
   - AC4: each refused case leaves the secret file's content absent from `discovery.load()` render and adds the note line. Also a symlink inside the project pointing to a temp "outside" folder, a 65 KiB file, and 5 × 60 KiB imports over the total.
   - AC5: editing `CLAUDE.md` and editing an imported file both re-render.
   - AC6: read `sub/x.ts` with `sub/CLAUDE.md` → one synthetic message. A second read adds nothing.
   - AC7: `claudeMd:false`, `imports:false`, and `InstructionDiscovery.configured({project:false})`, which is what job review mode sets.
8. **Regenerate** the protocol, then the client.
9. **Docs:** `.github/README.md`, CHANGELOG, `docs/upstream-patches.md`.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1, AC2, AC5, AC6, AC7 | in `packages/core`: `bun run test ./test/kete/memory-files.test.ts` |
| AC3, AC4 | in `packages/core`: `bun run test ./test/kete/memory-imports.test.ts ./test/kete/memory-files.test.ts` |
| AC8 upstream instruction tests | in `packages/core`: `bun run test ./test/instruction-discovery.test.ts ./test/session-instructions.test.ts ./test/tool-read.test.ts` |
| AC8 Kete tests + typecheck | in `packages/core`: `bun run test ./test/kete` then `bun run typecheck`; in `packages/schema`: `bun run typecheck` |
| AC8 generated code | in `packages/protocol` then `packages/client`: `bun run generate`; then `bun run check:generated` in each |
| AC8 markers | root: `bun run --cwd packages/kete-tools upstream:check` |
| Cross-package | root: `bun run lint`; before the PR `bun run --cwd packages/kete-tools verify --base main` |

## Cards to update after the build
- `instructions`:
  - Update the Quick answers and Gotchas: `CLAUDE.md` and imports now work. Explain the switches, the allowed roots, the md-only rule for `~/.claude` and the global config folder, and the caps.
  - Add both new files to Key files, the `internal.ts` registration to Changes, and the hook-based nested path.
  - Add the new Kete tests to Testing.
  - Add `packages/core/src/kete/memory-*.ts` to `paths`.
- `config-kete`: a Quick answers line for `kete.memory` (protocol and client regenerated).
- `pitfalls`, Security: `KeteShellRisk.credential` matches `.config/kete`, so check paths relative to their allowed root when the global config folder is allowed.
