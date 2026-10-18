# Spec: CLAUDE.md compatibility, @imports and nested memory (A2a)

- Task: `docs/tasks/2026-10-18-memory-files` · Size: large · Created: 2026-10-18
- Status: approved 2026-10-18, plan approved 2026-10-18 (the user said to carry on through every remaining item without stopping, 2026-10-18; recorded in handoff.md) <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
People moving from Claude Code keep their memory files working. Kete reads `CLAUDE.md` where there is no
`AGENTS.md`, expands `@path` imports in memory files, and picks up nested `CLAUDE.md` files the way it
already does for nested `AGENTS.md`. Parity item A2, first half. A2b (a quick "remember this" note and
auto memory) is a separate task.

## Scope
Cards: `instructions` (main), `config-kete`, `roles-skills` (`.claude` compatibility), `pitfalls`.

- **CLAUDE.md compatibility** (a Kete plugin on the `InstructionDiscovery.Service.transform` seam,
  registered after upstream's `opencode.config.instruction` in `core/src/plugin/internal.ts`):
  - Global: `~/.claude/CLAUDE.md`, loaded after `~/.config/kete/AGENTS.md`, when the global scope is on
    (`discovery.global`).
  - Project: in each folder of upstream's walk (cwd up to the project root, or home), `CLAUDE.md` or
    `.claude/CLAUDE.md`, **only when that folder has no `AGENTS.md`**. Many repos keep both, or symlink
    one to the other, so loading both would send the text twice. Files are also de-duplicated by real
    path, against each other and against the `AGENTS.md` files upstream already loaded.
  - The same watcher, debounce and reload behaviour as upstream. An unreadable file marks the source
    unavailable, as upstream does.
- **`@path` imports** in every memory file, `AGENTS.md` and `CLAUDE.md` alike, global and project:
  - Syntax as in Claude Code: `@relative/path`, `@./x`, `@../x`, `@~/x` or `@/abs/x` as a token outside
    code spans and fenced code blocks. Relative paths resolve from the importing file's folder.
  - Each imported file is added as its own instruction entry right after the file that imports it, so
    the model sees `Instructions from: <path>`. The importing file's text is unchanged. Imports nest up
    to 5 deep. Cycles and repeats load a file once.
  - **Allowed locations:** a project memory file may import from inside the project root,
    `~/.claude/` or the global config folder. A global memory file may import from those two folders
    and from the current project. Anything else is skipped with a debug log and a one-line note in the
    rendered block (`(import of <path> skipped: outside the allowed folders)`), never read.
  - **Never imported:** secret-looking files (`.env*`, `*.pem`, `*.key`, `id_*`, `*credentials*`,
    `.npmrc`, `.netrc`, using the same patterns as the runtime's existing secret-file rules if it has
    them) and anything under `~/.ssh`, `~/.aws`, `~/.gnupg`. Also never imported: symlinks that resolve
    outside the allowed folders, non-regular files, and files over 64 KiB. The total of all imports is
    capped at 256 KiB (the rest is skipped with a note).
  - Imported files are watched, and a change re-renders.
- **Nested memory:** after a `read`, upstream injects nested `AGENTS.md` files (`tool/plugin/read.ts`).
  Extend that walk to `CLAUDE.md` / `.claude/CLAUDE.md` under the same "only if the folder has no
  AGENTS.md" rule, through a small Kete helper the read plugin calls (one marked upstream edit).
  Imports inside nested files are expanded with the same rules.
- **Switches:** a Kete config switch turns off CLAUDE.md compatibility, and a second one turns off
  imports. Both default on. They are typed config, and the schema and generated client are regenerated
  if they're added there. `discovery.project` and `discovery.global` (and job review mode, which turns
  project discovery off) keep their meaning for the new files.
- **Docs:** the `instructions` card, the README's memory section, the CHANGELOG, and
  `docs/upstream-patches.md`.

## Out of scope
- A2b: a quick "remember this" note (`/remember`), a `/memory` command and auto memory.
- `CLAUDE.local.md`, `~/.claude/projects/...` memory and Claude Code's managed-policy memory paths.
- Gating memory files on folder trust. A10 deliberately leaves instruction files loading, and this
  task keeps that rule. Imports are bounded by the allowed folders above instead.
- Changing upstream's `instructions:` config key (unconsumed in v2).

## Acceptance criteria
- [ ] AC1 a project with only `CLAUDE.md` (or only `.claude/CLAUDE.md`) gets it as an instruction source.
  With `AGENTS.md` alongside, only `AGENTS.md` is loaded. A `CLAUDE.md` symlinked to `AGENTS.md` is
  loaded once.
- [ ] AC2 `~/.claude/CLAUDE.md` loads after the global `AGENTS.md` and not when the global scope is off.
- [ ] AC3 `@docs/style.md` in `AGENTS.md` adds that file after it. Nested imports work to depth 5, and
  a cycle loads each file once. `@x` inside a code span or fenced block is ignored. An email address
  (`me@example.com`) is not an import.
- [ ] AC4 an import outside the allowed folders, a secret-looking file, a symlink leaving the allowed
  folders, a file over 64 KiB, or imports past 256 KiB in total are skipped with a note and never read
  (a test asserts the file's content is absent from the rendered instructions).
- [ ] AC5 editing `CLAUDE.md` or an imported file re-renders the instructions.
- [ ] AC6 reading a file under `sub/` whose folder has a `CLAUDE.md` (and no `AGENTS.md`) injects it
  once per session, as nested `AGENTS.md` files are today.
- [ ] AC7 the two config switches turn the features off, and job review mode loads no project
  `CLAUDE.md`.
- [ ] AC8 checks: `core` typecheck and tests (Kete tests plus the upstream instruction tests),
  `upstream:check`, and the protocol/client regenerated and committed if the config schema changed.

## Risks and constraints
- **Security:** imports read files into model context, which is a path to exfiltrating secrets
  through a malicious repo's `AGENTS.md`. Mitigations: allowed folders, the secret-file denylist,
  symlink containment, size caps, and never following a path outside the allowed roots. Tests cover
  traversal (`@../../..`), `~/.ssh`, symlinks and `.env`. A security review runs before merge.
- **Upstream:** one marked registration line in `plugin/internal.ts` and one marked call in
  `tool/plugin/read.ts`. Everything else is in `core/src/kete/`.
- **Contracts:** the config switches (if added to the schema) become config contracts.
- **Context size:** imports add tokens to every request. The caps bound that cost.
- **Cross-platform:** paths through `path` utilities. A test covers `~` expansion. Windows
  case-insensitive containment uses the existing `FSUtil.contains`.
