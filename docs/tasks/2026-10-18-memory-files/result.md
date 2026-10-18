# Result: CLAUDE.md compatibility, @imports and nested memory (A2a)

## What changed
- `packages/core/src/kete/memory-files.ts` (new): the `kete.memory-files` plugin. It loads CLAUDE.md / `.claude/CLAUDE.md` where a folder has no AGENTS.md, plus `~/.claude/CLAUDE.md`, expands `@path` imports, and injects nested CLAUDE.md files through the tool `execute.after` hook.
- `packages/core/src/kete/memory-imports.ts` (new): token parsing and the rules for what may be read. Allowed roots (sensitive `~/.claude` and the global config are markdown only), a secret denylist (names, `.git`, home credential folders), caps (64 KiB per file, 256 KiB in total, depth 5), and `usableRoot` / `memoryFileAllowed`.
- `packages/core/src/plugin/internal.ts` (upstream, 2 marked lines): registration after `ConfigInstructionPlugin`.
- `packages/schema/src/config/kete.ts`: `kete.memory.claudeMd` / `imports`.
- Generated: `packages/protocol/openapi.json` and `packages/client/src/promise/generated/types.ts`.
- Tests: `packages/core/test/kete/memory-files.test.ts`, `memory-imports.test.ts`.
- Docs: `.github/README.md`, `CHANGELOG.md`, `docs/upstream-patches.md`, cards.

## Checks
| Check | Result |
|---|---|
| typecheck schema, core | pass |
| A2a tests | 29 pass, 0 fail |
| `core` `bun run test ./test/kete` | 1528 pass, 0 fail |
| upstream instruction and read tests | 54 pass |
| protocol / client `check:generated` | pass |
| root lint | 0 warnings, 0 errors |
| upstream:check | passed |
| reviewer | approve, 4 minors (all fixed: shared budget, `.git` deny, order comment, watch before early return) |
| upstream-guard | approve, no findings |
| security review | round 1: 2 high, 2 medium, 3 low. Round 2: highs and mediums fixed, plus 1 medium (plain folder as root) and 2 low found. Round 3: those fixed. The stat-then-read race and the nested re-read stay documented as low |

The implementer had no shell tool, so checks ran from the main session.

## Acceptance criteria
- [x] AC1 CLAUDE.md fallback, AGENTS.md wins, symlink loads once: memory-files.test.ts
- [x] AC2 `~/.claude/CLAUDE.md` order, `global: false`: memory-files.test.ts
- [x] AC3 imports after the importer, depth 5, cycles, code spans and fences, emails: both test files
- [x] AC4 refusals (outside, secret, symlink, size, total) with a note, never read: memory-files.test.ts plus the "security review" describe
- [x] AC5 re-render on edit of CLAUDE.md and of an import: memory-files.test.ts
- [x] AC6 nested CLAUDE.md once per session: memory-files.test.ts
- [x] AC7 switches and project discovery off: memory-files.test.ts (also: a project config can't re-enable)
- [x] AC8 checks: table above

## Not done / follow-ups
- Upstream's own AGENTS.md follows symlinks without containment, which predates this task. It is reported privately to the maintainer and deliberately not changed in this public PR.
- Not verified on Windows.

## Cards updated
instructions, config-kete, pitfalls (librarian), with the planner's "Docs enough: no" gaps.

## Metrics
- Agents used: scout, librarian ×3, planner ×2 (first stopped on a stale card), implementer (no shell), reviewer, upstream-guard, security reviewer (3 rounds)
- Scout lookups: 1, docs enough: 0 (0%)
- Tokens / cost (from /usage): not shown
- Time: ~3 h
