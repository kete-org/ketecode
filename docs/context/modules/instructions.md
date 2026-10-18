---
module: instructions
paths: [packages/core/src/config/plugin/instruction.ts, packages/core/src/instruction-discovery.ts, packages/core/src/session/instructions.ts, packages/core/src/tool/plugin/read.ts]
verified-at: ecfae5cce7
---
## Quick answers
- Which instruction files does the runtime load? Only `AGENTS.md`. `ConfigInstructionPlugin` (`core/src/config/plugin/instruction.ts:36-121`): the global `<config>/AGENTS.md`, then every project `AGENTS.md` walking up from the cwd to the project root (nearest first; to the home folder when the cwd is under it), de-duplicated by path (`new Set`, `:51,71`). `CLAUDE.md` is not read, and there is no `@import` expansion.
- How is it shown to the model? One block per file, `Instructions from: <path>` then the content (`core/src/instruction-discovery.ts:123-125`, source key `core/instructions` `:17`); the plugin rescans on a watcher event (100 ms debounce, `instruction.ts:110`) and `discovery.reload()` re-renders, a change is sent as a diff (`renderUpdate` `:127`).
- Are nested `AGENTS.md` files loaded? Yes, lazily: after a successful `read` of a file or directory, `AGENTS.md` files between it and the location root (root excluded, it is already loaded) are found (`core/src/tool/plugin/read.ts:16,82-106`) and handed to `SessionInstructions.load` (`core/src/session/instructions.ts:46-112`), which injects one durable synthetic message per new path (ledger = message metadata, so compaction or revert re-injects). External-directory reads and failures are skipped silently.
- Does folder trust gate them? No: `AGENTS.md` and "instructions" load as before in an untrusted folder (`core/src/kete/folder-trust.ts:27`); only executable project config is held back (`permissions`/`hooks`/`job-mode` cards). Job review mode turns project `AGENTS.md` discovery off (`job-mode` card).
- Does the `instructions:` config key work? It is decoded (`core/src/config/normalize.ts:223-224`) but nothing in `core/src` reads it in v2 (grep found no consumer); do not tell users it adds files.
- Where do I add a Kete instruction source? `InstructionDiscovery.Service.transform((editor) => editor.add(file))` from a Kete plugin registered in `core/src/plugin/internal.ts` (the upstream one is in `post`, `:324`; register yours so it runs after it, since insertion order is render order: global, then nearest to farthest project file, then siblings by registration order).

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
- `bun run test ./test/<path>` inside `packages/core/` for the upstream instruction tests (search `test/` for `instruction`); no Kete test exists for this seam yet.

## Changes
- None by Kete today (upstream behavior, documented from a scout finding).

## Gotchas
- Users coming from Claude Code expect `CLAUDE.md` and `@file` imports: neither works; put the content in `AGENTS.md`.
- The location-root `AGENTS.md` is loaded up front, so the `read` walk deliberately drops it (`read.ts` filters `dirname(file) !== root`).
- When the cwd is inside the global config folder, `discovery.global: false` also excludes the global file from the ancestor walk.
