---
module: add-dir
paths: [packages/core/src/kete/add-dir.ts, packages/core/src/kete/add-dir-plugin.ts, packages/schema/src/kete/add-dir.ts, packages/cli/src/kete/add-dir.ts, packages/tui/src/kete/add-dir.tsx]
verified-at: b8e534dfcb
---

## Quick answers
- How does a session get extra working folders? Session metadata key `kete.dirs` (list of real paths; `add-dir.ts:30`), set by `kete --add-dir <path>` (repeat, max 10), `kete run --add-dir`, or the `/add-dir` command (`add-dir-plugin.ts:133`). Subagents inherit the root session's folders.
- Where is a folder validated? `KeteAddDir.validate` (`add-dir.ts:97`), called by `guard` (`:128`), which `Session.setMetadata` and `Session.create` run (`session/session.ts:84`, `session.ts:263`); a refusal is a defect (`RefusedError`), so clients pre-check through RPC `kete.add-dir` `check` (`schema/src/kete/add-dir.ts`). Refused: file-system root, home or above, credential folders (`SECRET_HOME_DIRS`, `memory-imports.ts:79`, plus sandbox `credentials`), PATH folders, anything inside the workspace, wildcard characters, more than `MAX`; always refused in job mode.
- What does a folder grant? (1) The default `external_directory` ask becomes allow for paths inside it (`granted`, `add-dir-plugin.ts:54`; a path-specific ask or a deny stands; the session_move request is excluded). (2) The sandbox treats it as writable (see the sandbox card). (3) Subagents get allow rules via the ceiling (`permission-ceiling.ts:137`).
- Are folders trusted forever? No: `KeteAddDir.live` (`add-dir.ts:186`) re-checks them on every use, so a folder swapped for a symlink or gone invalid drops out.
- Imported sessions? `withoutDirs` strips `kete.dirs` on import (`session/transfer.ts`, `add-dir.ts:155`), since imports skip the guard.
- Where is the plugin registered? `plugin/internal.ts`, in `pre` right after `KeteUnattended.PolicyPlugin` (loosening hooks go before mode/ceiling) and in `guarded`.

## Purpose
Let one session work outside the workspace in a few user-chosen folders without a prompt per file, without weakening the workspace boundary.

## Entry points
- CLI flag `--add-dir` (`cli/src/commands/commands.ts:47`), applied in `cli/src/run/run.ts:135` through `KeteAddDirCli.addAll` (`cli/src/kete/add-dir.ts:71`).
- TUI: `useKeteAddDir` (`tui/src/kete/add-dir.tsx:70`), metadata merged into the first prompt (`component/prompt/index.tsx:1258`).
- `/add-dir` server-side command and the `kete.add-dir` RPC (`add-dir-plugin.ts:91`).

## Key files
- `packages/core/src/kete/add-dir.ts`: rules, no Session import (the session service imports it).
- `packages/core/src/kete/add-dir-plugin.ts`: grant hook, RPC, command.
- `packages/schema/src/kete/add-dir.ts`: RPC schema.
- `packages/core/src/tool/plugin/shell.ts:139`: passes the live folders to the sandbox.

## Data flow
Flag or command -> RPC `check` (verdicts with real paths) -> session metadata write (`guard` re-validates) -> on each permission `evaluate` and each sandboxed command the folders are re-read with `live`.

## Data and APIs used
Session metadata only; no platform call and no new HTTP endpoint (plugin RPC over the existing `/api/rpc`).

## Rules that must not break
- Validation stays in `guard`; clients' pre-check is only for readable errors.
- Loosen only a default `external_directory` ask inside a folder; never a deny, never session_move.
- Folders are real paths and re-checked at use.
- Not available in job mode.

## Testing
`packages/core/test/kete/add-dir.test.ts`, `packages/cli/test/kete/add-dir.test.ts`, `packages/tui/test/kete/add-dir.test.tsx`, `packages/core/test/kete/sandbox-policy.test.ts`, `sandbox-shell.test.ts`.

## Changes
Added in A13 (task `docs/tasks/2026-10-18-add-dir`). Upstream edits are marked `kete_change` and listed in `docs/upstream-patches.md`.

## Gotchas
- A user-written `external_directory: ask` with resource `*` looks like the default and is loosened for folders.
- A server-side defect reaches clients as a generic error, hence the RPC pre-check.
