# Result: kete skill commands (A9)

## What changed
- `packages/util/src/kete/skill-source.ts` (new): source union, `gitUrl` (one URL form for git, policy and review), `display`, `policyResource` (lower-case, `www.` folded), `pinned`, YAML-only `frontmatter`
- `packages/util/src/kete/skill-lock.ts` (new): `skills.lock.json` v1 schema, atomic re-read upsert/remove, `diff`
- `packages/cli/src/kete/skill-flow.ts` (new): add/list/update/remove over injected deps; fetch with no hooks, submodules, LFS, prompts, redirects or non-https/ssh protocols; walk (no symlinks, hard links, `..`, `.kete-skill.json`; 256 files, 10 MiB); review; policy `skill.install`; scope checks (no symlinked `.kete`, `skills/`, lockfile or skill folder; nothing outside the project)
- `packages/cli/src/kete/skill.ts` (new): real deps and handlers
- `packages/cli/src/kete/commands.ts`: the `skill` command group
- `packages/cli/src/kete/job-git.ts`: optional `childEnv`
- `packages/cli/src/index.ts` (upstream, one marked block): handler registration
- Tests: `packages/cli/test/kete/skill.test.ts`, `packages/util/test/kete/skill-source.test.ts`, `skill-lock.test.ts`
- Docs: `.github/README.md` (Installing skills), `CHANGELOG.md`, `docs/upstream-patches.md`, `docs/parity-plan.md` (A17 added), module cards

## Checks
| Check | Result |
|---|---|
| typecheck util, cli | pass |
| `bun test ./test/kete` util | 408 pass, 0 fail (before the security fixes; skill files 9/9 after) |
| `bun test ./test/kete` cli | 406 pass, 0 fail (skill.test.ts 41/41) |
| cli import-boundaries | 4/4 |
| root lint | 0 warnings, 0 errors |
| upstream:check | passed |
| reviewer | approve, 4 minors (all fixed) |
| upstream-guard | approve, README marker/necessity minors (note moved to `.github/README.md`) |
| security review | 2 high, 1 medium, 4 low found; all fixed (ecfae5cce7) with regression tests, re-review confirmed, PoC now exits 2; residual lows (re-check scope after the prompt, more host aliases, O_NONBLOCK, realpath walk, Windows names, case-sensitive local rules) fixed in the follow-up commit. Not verified on Windows (junctions, no O_NOFOLLOW) |
| smoke (real CLI) | local `add --yes`, `list`, non-TTY refusal as expected |

Checks were run from the main session: the implementer and verifier had no shell tool this session.

## Acceptance criteria
- [x] AC1 add (git) — skill.test.ts "kete skill add git"
- [x] AC2 add (local) — "kete skill add local"
- [x] AC3 review / no-write on decline or non-TTY — "kete skill add review"
- [x] AC4 safety (symlink, `..`, SKILL.md, limits, exec bit, hooks) — "kete skill add safety", "kete skill security review"
- [x] AC5 `--global` — "kete skill add global"
- [x] AC6 list labels — "kete skill list"
- [x] AC7 update diff, pinned, local edits — "kete skill update"
- [x] AC8 remove tracked only — "kete skill remove"
- [x] AC9 org protection — "kete skill org protection"
- [x] AC10 policy deny / ask (and case-insensitive) — "kete skill policy"
- [x] AC11 errors, timeout, credential redaction — "kete skill errors"
- [x] AC12 checks — table above

## Cards updated
cli, roles-skills, sync, config-kete, account-login, contracts.md, pitfalls.md; new `instructions` card (for A2). Gaps from handoff.md added by the librarian.

## Metrics
- Agents used: scout ×1 (+1 for A2), librarian ×2, planner, implementer, verifier (no shell), reviewer, upstream-guard, security reviewer (general-purpose)
- Scout lookups: 1, docs enough: 0 (0%)
- Tokens / cost (from /usage): not shown
- Time: ~3 h across 2026-10-17/18
