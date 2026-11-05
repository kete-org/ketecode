# Result: WS1 session mode

## What changed
- `packages/util/src/kete/session-mode.ts` (new): `KeteSessionModes` — the `kete.sessionMode` key, `code | work`, `parse`.
- `packages/core/src/kete/session-mode.ts` (new): `KeteSessionMode` — `guardCreate` (unknown or unavailable mode refused; a child inherits its parent's mode and can't name another), `guardMetadata` (key fixed after create), `agent` (Work → its profile's agent; Code → none, so the default chain stays), `mode`.
- Upstream, marked: `core/src/session.ts` (create runs `guardCreate`; `agent:` falls back to the mode's agent), `core/src/session/session.ts` (`setMetadata` runs `guardMetadata`), `core/src/session/transfer.ts` (an imported session's metadata runs `guardCreate`; review finding).
- Tests: `core/test/kete/session-mode.test.ts` (pure guards), `session-mode-session.test.ts` (real `Session.Service` and `SessionTransfer`).
- Docs: `docs/upstream-patches.md` ("Session mode (WS1 1.2)"), `docs/desktop-enhancement-plan.md` (metadata key instead of a `mode` field).

## Checks
The implementer had no shell; the main session ran every check.

| Check | Result |
|---|---|
| util, core `bun run typecheck` | clean (after typing two test assertions) |
| core targeted: session-mode ×2, session-agent-model, unattended-session, add-dir, session-create | all pass (60 in the last run) |
| core full `bun run test` | ripgrep/shell/location tests fail locally; see `verify --base main` |
| server `bun run test ./test/kete` | 49 pass, 0 fail |
| `bun run lint`, `upstream:check` | exit 0; pass |
| `verify --base main` | see PR |
| Review | reviewer: changes needed → session import bypassed the create check (fixed, tested, recorded), cards (done at close); upstream-guard: approve |

Fixed after the implementer: `guardCreate` refused a child that left the key out under a Work parent; it now inherits it.

## Acceptance criteria
- [x] AC1 — code/no key accepted; `chat` and unavailable `work` refused naming the mode (create and import).
- [x] AC2 — `setMetadata` adding, changing or removing the key refused; equal key with other changes accepted.
- [x] AC3 — child inherits the parent's mode; a different named mode is refused.
- [x] AC4 — Code stores no agent (default chain); Work (injected available profile) gets its profile's agent; an explicit agent is kept.
- [x] AC5 — checks above.

## Cards updated
unattended (locked keys, how create builds metadata/agent), roles-skills (default agent incl. Work, other `agents.select` callers), permissions, config-kete. Handoff gaps all added.

## Metrics
- Agents used: scout, librarian ×2, planner, implementer (no shell), reviewer, upstream-guard
- Scout lookups: 1, docs enough: 0 (0%)
- Tokens / cost (from /usage): n/a
- Time: n/a (2026-11-05)
