# Handoff: kete skill commands (A9)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-17 planner
Done: wrote plan.md. The cards cli, roles-skills, sync and config-kete are current (stale-cards: all current).

Decisions:
- The task is Large: one upstream edit (a marked `Handlers` block in `cli/src/index.ts`) plus the README, it is security-sensitive, and it creates new contracts. The user must approve plan.md before the build.
- The CLI can't import `@opencode/core` (`cli/test/import-boundaries.test.ts`), so core's skill frontmatter parser and `Wildcard.match` are mirrored in Kete code (util `skill-source.ts`, cli `skill-flow.ts`). The frontmatter mirror is YAML-only and stricter (no colon-sanitize retry).
- `JobGit.run` gets an optional `childEnv` (`GIT_TERMINAL_PROMPT=0`, `GIT_LFS_SKIP_SMUDGE=1`); hooks are disabled with `-c core.hooksPath=<empty dir>`.
- Policy: not signed in means no policy; signed in with no cache forces an ask; a cache that can't be read refuses. The resource is `host/path` for git sources and the absolute path for local ones.
- A source that contains `.kete-skill.json` is refused (it would pose as an org skill).
- The spec says "documented in docs/platform/sync-v1.md". That file is a platform contract copy, so the plan does not edit it. The action goes in the Kete cards and contracts.md instead; if it belongs in sync-v1.md, the platform repo should add it upstream first.

Docs enough: no. Missing:
- cli card: that the CLI must not import core (no frontmatter parser or wildcard matcher available to the CLI).
- cli card: that `JobGit.run` passes no env to git (its `env` is only read for job mode).
- roles-skills card: core's YAML-only front-matter guard (`core/src/config/markdown.ts`, GHSA-m7hc-g593-r9wg) and that `safeRelative` refuses root `SKILL.md` and `.kete-skill.json`.
- README: it has no command list (the spec assumed one), so the plan adds a short Skills note under Agents.

Open questions: none blocking. The size limits (256 files, 10 MiB) and the script-extension list are the planner's choice.

## 2026-10-17 implementer
Done: steps 1-7 written. **No check was run**: this agent had no shell tool (only Read/Edit/Write/Grep/Glob), so typecheck, tests, lint and `upstream:check` are all unrun. Run them first.

Files: util `src/kete/skill-source.ts`, `skill-lock.ts` (+ tests `skill-source.test.ts`, `skill-lock.test.ts`); cli `src/kete/skill-flow.ts`, `skill.ts`, `commands.ts` (skill group), `job-git.ts` (`childEnv`), `index.ts` (one marked block), `test/kete/skill.test.ts`; README (marked), CHANGELOG, `docs/upstream-patches.md`.

Decisions beyond the plan:
- Lockfile unreadable or an unknown version exits 2 (refused) via `readLock`, not 1.
- `update` also takes `--global` (the spec listed only `--yes`), otherwise global skills can't be updated.
- `list` shows one scope (`--global` picks it), but org skills are always shown.
- Files are read once while walking and written from memory, so what is reviewed (and hashed) is what is installed.
- Extra refusals: a name with a backslash or NUL, and a lock key that isn't a valid skill name (no traversal from an edited lockfile).
- Tests reach the git fixture through `url.<bare>.insteadOf` in a `GIT_CONFIG_GLOBAL` passed as `Deps.gitEnv`.
- Docs not done (librarian owns `docs/context`): cards cli, roles-skills, sync, contracts.md, pitfalls.md per plan "Cards to update".

Risks to check when running: `Bun.YAML` typing in util; `let lock` assigned in a closure in `update` (uses `lock!`); the pinned-commit test depends on the fallback full fetch; policy `Deps.git` spy typing in the deny test.

## Verification (2026-10-18, main session)
The implementer and verifier had no shell, so the checks were run from the main session.
Fixed three type errors: two util test imports now use `@opencode/util/kete/...`, and `--path` is
narrowed through a local in `skill-flow.ts`. Also fixed "1 files" pluralisation.
- typecheck util + cli: pass
- `bun test ./test/kete`: util 408 pass / 0 fail (14 skipped elsewhere), cli 398 pass / 0 fail; skill.test.ts 33/33, incl. the POSIX symlink, exec-bit and hook tests
- cli import-boundaries 4/4, root lint clean, upstream:check passed
- Smoke test of the real CLI: local add --yes (review, 0600 files, lockfile v1), list (org skills read-only), non-TTY without --yes refused with nothing written
