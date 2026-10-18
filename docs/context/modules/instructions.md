---
module: instructions
paths: [packages/core/src/kete/auto-memory.ts, packages/core/src/kete/memory-files.ts, packages/core/src/kete/memory-imports.ts, packages/core/src/config/plugin/instruction.ts, packages/core/src/instruction-discovery.ts, packages/core/src/session/instructions.ts, packages/core/src/tool/plugin/read.ts]
verified-at: 3c3e792370
---
## Quick answers
- Which instruction files does the runtime load? `AGENTS.md`, plus `CLAUDE.md` where a folder has no `AGENTS.md` (Kete, below). `ConfigInstructionPlugin` (`core/src/config/plugin/instruction.ts:36-121`): the global `<config>/AGENTS.md`, then every project `AGENTS.md` walking up from the cwd to the project root (nearest first; to the home folder when the cwd is under it), de-duplicated by path (`new Set`, `:51,71`).
- How is it shown to the model? One block per file, `Instructions from: <path>` then the content (`core/src/instruction-discovery.ts:123-125`, source key `core/instructions` `:17`); the plugin rescans on a watcher event (100 ms debounce, `instruction.ts:110`) and `discovery.reload()` re-renders, a change is sent as a diff (`renderUpdate` `:127`).
- Are nested `AGENTS.md` files loaded? Yes, lazily: after a successful `read` of a file or directory, `AGENTS.md` files between it and the location root (root excluded, it is already loaded) are found (`core/src/tool/plugin/read.ts:16,82-106`) and handed to `SessionInstructions.load` (`core/src/session/instructions.ts:46-112`), which injects one durable synthetic message per new path (ledger = message metadata, so compaction or revert re-injects). External-directory reads and failures are skipped silently.
- How does CLAUDE.md work? Kete plugin `kete.memory-files` (`core/src/kete/memory-files.ts:155`, registered after the upstream plugin at `internal.ts:326`). Per folder, `AGENTS.md` wins; else `CLAUDE.md` or `.claude/CLAUDE.md` (`pick` `:226`); `~/.claude/CLAUDE.md` joins the global files (`:259`). A CLAUDE.md is loaded only if its realpath is a `.md` inside its folder/repository and not a secret (`memoryFileAllowed` `memory-imports.ts:88`), and at most 256 KiB (`withinCap` `:243`).
- How do `@path` imports work? `expand` (`memory-files.ts:66`) inlines each `@token` (not in code fences/spans, `importTokens` `memory-imports.ts:41`) right after the file naming it: depth 5, 64 KiB/file, 256 KiB total (`:15-17`); refusals leave the token and append a note line. `denied` (`:92`) allows only real paths inside a root: the repository (only when `location.vcs` is set and not home/above/`/`, `usableRoot` `:85`, `memory-files.ts:185`), plus `~/.claude` and the global config folder as `sensitive` markdown-only roots (`:178`); it refuses `.git`, `~/.ssh` etc., `KeteShellRisk.credential` matches and a secret-name list (`:65-79`).
- Are nested CLAUDE.md files loaded? Yes, via the tool `execute.after` hook on a completed `read` (`memory-files.ts:361`); same walk as AGENTS.md, repository required, folders under `node_modules`/`vendor` skipped (`:383`), and nested files import only inside their own folder plus `.md` files elsewhere in the repo (`nestedRoots` `:393`). New paths go to `SessionInstructions.load`.
- How do I turn it off? `kete.memory.claudeMd` / `kete.memory.imports` (`schema/src/config/kete.ts:172`); a `false` in any config document wins, a project cannot re-enable (`settings` `memory-files.ts:191`).
- Is the discovery transform async, and how do I reorder entries? `discovery.transform(editor => ...)` is a synchronous callback (no Effect inside; precompute into state, as `memory-files.ts` does with `loaded.current`). Editor has no move: `list()`, `remove(path)` each, then `add` in the new order (`memory-files.ts:335-357`).
- Can a Kete plugin act on a tool's result without editing the tool? Yes: `ctx.tool.hook("execute.after", event => ...)` (`memory-files.ts:361`). The event carries `tool`, `sessionID`, `agent`, `messageID`, `id`, `input`, and `status` (`completed` adds `result`, whose `output` is the tool's structured output) (`plugin/src/effect/tool.ts:29`). That's how nested CLAUDE.md avoids editing `tool/plugin/read.ts`.
- Does folder trust gate them? No: `AGENTS.md` and "instructions" load as before in an untrusted folder (`core/src/kete/folder-trust.ts:27`); only executable project config is held back (`permissions`/`hooks`/`job-mode` cards). Job review mode turns project `AGENTS.md` discovery off (`job-mode` card).
- Does the `instructions:` config key work? It is decoded (`core/src/config/normalize.ts:223-224`) but nothing in `core/src` reads it in v2 (grep found no consumer); do not tell users it adds files.
- Where do I add a Kete instruction source? `InstructionDiscovery.Service.transform((editor) => editor.add(file))` from a Kete plugin registered in `core/src/plugin/internal.ts` (the upstream one is in `post`, `:324`; register yours so it runs after it, since insertion order is render order: global, then nearest to farthest project file, then siblings by registration order).
- What is auto memory and where do notes live? `core/src/kete/auto-memory.ts` (plugin `kete.auto-memory` `:136`, registered `plugin/internal.ts:330` `// kete_change`): a `memory` tool (view/write/append/delete markdown) over Kete's state folder, never the repo: `<state>/memory/<projectID>-<12-hex hash of the directory>/` (project) and `<state>/memory/user/`; `MEMORY.md` is each folder's index (caps `auto-memory.ts:39-45`; a project without a stable id, `ProjectID.global`, gets no project scope, `:91`). Text is redacted on write and again on load.
- How do saved notes reach the model? Not through InstructionDiscovery (it is shared by all sessions of a process, so it cannot hide notes from one unattended session). The `context` session hook (`:327`) adds the two indexes to the system prompt per session, fenced under `HEADER` (`:47`: context, not instructions).
- How do I turn auto memory off? `kete.memory.auto: false` in any config (false anywhere wins). It is also off, with no tool, no notes and no commands, in job mode (`KeteJobMode.enabled`, checked before registration `:138`) and in any unattended session (`kete.unattended` metadata via `KeteUnattendedPolicy.resolve`, fail closed). The tool is removed per request with `delete event.tools[name]` in the `context`/`compaction`/`generate` hooks (`:325-330`, same seam as `core/src/kete/offline.ts`).
- What are `/remember` and `/memory`? Built-in prompt commands registered by `ctx.command.transform` (`:339`), like `/commit` in `git-commands.ts`; `/remember` with no note reports an error, which `core/src/command.ts:80-88` maps to `ExecutionError`. `/memory` lists via the tool.
- Which lock guards writes? `EffectFlock.Service.withLock` (`util/src/effect-flock.ts:82-90`), key `kete-memory-<folder>`; write/append/delete go through temp file + rename.

## Purpose
Explains how agent instructions reach the model and where a Kete feature can add or change them.

## Entry points
- `ConfigInstructionPlugin.Plugin` (`id: opencode.config.instruction`), `core/src/plugin/internal.ts:324`.
- `InstructionDiscovery` service/layer (`core/src/instruction-discovery.ts:55`, node at `internal.ts:209`); `Editor` API: `list/add/update/remove/unavailable`.
- `SessionInstructions.load` called by the `read` tool (`tool/plugin/read.ts`).

## Key files
| File | Role |
| --- | --- |
| `core/src/config/plugin/instruction.ts` | finds and watches global + project `AGENTS.md`; fills the discovery state |
| `core/src/instruction-discovery.ts` | state, editor, render and diff, `load()` as an `Instructions` source |
| `core/src/session/instructions.ts` | per-session injection of nested files found by `read` |
| `core/src/tool/plugin/read.ts` | the walk-up after a read |

## Data flow
Plugin start → resolve cwd, project root, home → candidate files → read (unreadable = skipped, a read error marks the source `unavailable`) → `discovery.transform` adds them → `load()` renders one source into the request. File change → watcher → debounce → rescan → reload. A `read` later adds nested files as synthetic messages.

## Data and APIs used
- `FSUtil.up`/`resolve`, `Watcher.subscribe`, `Global.config`/`home`, `Location` (cwd and project root).
- No platform or network access; nothing here is Kete-owned (no `kete_change` in these files).

## Rules that must not break
- Keep upstream files unedited: add sources through the `transform` seam in a Kete plugin, not by editing `instruction.ts`.
- Instruction content is untrusted repository text: never give it more authority than the user's own prompt, and do not let it relax permissions.
- A source that cannot be read must report `unavailable`, not an empty list (an empty list removes the block from the prompt).

## Testing
- `bun run test ./test/<path>` inside `packages/core/` for the upstream instruction tests (search `test/` for `instruction`); Kete tests: `packages/core/test/kete/memory-files.test.ts`, `memory-imports.test.ts`.

## Changes
- `kete.memory-files` plugin and `memory-imports.ts` (pure rules); only upstream edit is the `internal.ts` registration (`kete_change`).

## Gotchas
- Memory files are repository-controlled text read into model context: every path is checked by realpath containment, never by the written path (a symlinked CLAUDE.md or import must not escape). A cwd with no repository, or a root that is home or above, serves no imports and no nested files.
- Known gap: the nested half hands paths to `SessionInstructions.load`, which re-reads them, and stat precedes read, so a file swapped in between isn't re-checked.
- The location-root `AGENTS.md` is loaded up front, so the `read` walk deliberately drops it (`read.ts` filters `dirname(file) !== root`).
- When the cwd is inside the global config folder, `discovery.global: false` also excludes the global file from the ancestor walk.
- Auto memory known limits: LOW-5, a `memory: deny` rule blocks writes but does not stop already-saved notes from loading (no evaluate-without-asking API in the permission service; `kete.memory.auto: false` stops loading). Cross-process append (`auto-memory.ts:140` shortcut): two kete processes appending to one file at the same instant can lose an append (writes are atomic, nothing corrupts). Another session's new notes show on the next plugin start, not live. `memory.md` (lowercase) is refused as a name (collides with `MEMORY.md` on case-insensitive disks).
