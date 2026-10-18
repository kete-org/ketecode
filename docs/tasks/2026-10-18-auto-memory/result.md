# Result: quick "remember this" and auto memory (A2b)

## What changed
- `packages/core/src/kete/auto-memory.ts` (new): the `memory` tool (view, write, append and delete in `project` and `user` scopes, under `<state>/memory/`), notes in the system prompt per session, the `/remember` and `/memory` commands, and the `kete.memory.auto` switch. Off in job mode and in unattended sessions.
- `packages/core/src/kete/permission-mode.ts`: memory decisions. Viewing is always allowed. Plan mode refuses changes, Ask mode asks before every change, and a user-scope change asks unless a rule or "Always" allowed it.
- `packages/core/src/plugin/internal.ts` (upstream, marked): registration.
- `packages/schema/src/config/kete.ts`: `kete.memory.auto`. The protocol and client are regenerated.
- `packages/util/src/kete/redact.ts`: more token shapes. `author:` no longer matches the `auth` rule.
- Tests: `packages/core/test/kete/auto-memory.test.ts`, `packages/util/test/kete/redact.test.ts`.
- Docs: `.github/README.md`, `CHANGELOG.md`, `docs/permissions.md`, `docs/upstream-patches.md`, cards.

## Checks
| Check | Result |
|---|---|
| typecheck schema, core | pass |
| A2b tests | all pass |
| `core` `bun run test ./test/kete` | 1549 pass, 0 fail |
| `util` `bun test ./test/kete` | 412 pass, 0 fail |
| `cli` `bun test ./test/kete` | 407 pass, 0 fail |
| root lint, upstream:check | pass |
| reviewer | approve (minors: `memory.md` comment added, result.md filled) |
| upstream-guard | approve |
| security review | round 1: 1 high (silent user-wide save via prompt injection), 3 medium, 5 low. Round 2: all fixed except LOW-5 (documented), plus a new high (the memory rule never ran through apply()). Round 3: fixed and confirmed by PoC through apply() |

The implementer had no shell tool, so checks ran from the main session. The implementer's file lock (`EffectFlock`) wasn't available to internal plugins, so it was replaced by an in-process semaphore plus atomic writes (documented shortcut).

## Acceptance criteria
- [x] AC1 write, append, view and delete in both scopes on disk: "auto memory: scopes"
- [x] AC2 names and caps: "auto memory: names and caps", plus Windows names under "security review"
- [x] AC3 redaction before disk: "auto memory: redact"
- [x] AC4 indexes load with the header, capped: "auto memory: load" (now fenced)
- [x] AC5 `/remember` and `/memory`: "auto memory: commands"
- [x] AC6 off in any config, in job mode and in unattended sessions: "auto memory: off"
- [x] AC7 permission deny blocks writes, and the mode rules: "auto memory: permission"
- [x] AC8 checks: table above

## Known limits
- LOW-5: a `memory: deny` rule blocks writes but doesn't stop already-saved notes from loading. The permission service has no evaluate-without-asking API. `kete.memory.auto: false` stops loading.
- Two kete processes appending to one file at the same moment can lose one append. Writes are atomic.
- Notes reload after this process writes. Edits from another session show after a restart.

## Metrics
- Agents used: librarian ×3, planner, implementer (no shell), reviewer, upstream-guard, security reviewer (2 rounds)
- Scout lookups: 0
- Tokens / cost (from /usage): not shown
- Time: ~2 h
