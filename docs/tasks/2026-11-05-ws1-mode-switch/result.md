# Result: WS1 work-orchestrator and Code|Work switch

## What changed
- `packages/core/src/kete/work-agent.ts` (new): the `kete.work-agent` plugin adds `work-orchestrator`.
  - It's a primary agent marked `hidden`, so it never appears in Code's picker and is never the default.
  - Its prompt covers delegated knowledge work. It has no extra permissions: the Work plugin (1.3) sets the limits.
  - It's added for every user, including users signed in to an org.
  - Registered in `core/src/plugin/internal.ts` (marked). Test: `core/test/kete/work-agent.test.ts`.
- `packages/app/src/kete/mode-switch/` (new):
  - `state.ts`: decodes `kete.modes`; an older runtime or an error means Code only.
  - `effective`: a remembered mode that isn't available falls back to Code.
  - `createFields`: merges `kete.sessionMode` with the permission-mode draft. Work sends no agent, so the runtime fills in the mode's agent.
  - `step` and `choose`/`chosen`: keyboard movement and the hand-off to the composer.
  - `view.tsx`: a radiogroup with a roving tabindex. An unavailable Work is shown `aria-disabled`, with a visible "Not available yet" hint linked by `aria-describedby`.
  - `mode-switch.tsx`: the connector. It remembers the choice per workspace (`Persist.serverWorkspace`, key `kete-mode`).
- `packages/app/src/kete/sidebar/{sidebar.tsx,view.tsx,sidebar.css}`: the switch mounts in the Kete sidebar while a new-session draft is open. That's the only screen that has a workspace; see Deviations.
- `packages/app/src/new-session/composer-adapter.ts` (marked block): `session.create` takes `agent` and `metadata` from `KeteModeSwitch.createFields`.
- `packages/app/src/runtime/i18n/en.ts`: two marked `kete.mode.*` keys.
- Tests: `mode-switch/state.test.ts`; stories `App/Kete/Shell` (mode switch, Work available) and four specs in `component-tests/kete-shell.spec.ts`.
- Docs: `docs/upstream-patches.md`, `docs/desktop-enhancement-plan.md`; cards `web-app` and `roles-skills` (paths).

## Deviations
- The switch shows only on the new-session screen, not at the top of every sidebar. Session tabs have no directory,
  so there is no workspace to remember the choice for, and the new-session screen is where the choice applies.

## Checks
The implementer had no shell; the main session ran every check.

| Check | Result |
|---|---|
| core, app `bun run typecheck` | clean (after fixing a keyed `<Show>` callback) |
| core `bun run test ./test/kete` | 1833 pass / 12 skip / 0 fail |
| app `bun run test:unit src/kete` | 1086 pass |
| app `bun run test:components -- component-tests/kete-shell.spec.ts` | 12 pass (4 new) |
| `bun run lint`, `upstream:check` | exit 0; pass |
| `verify --base main` | 0 new failures in util, server, core, tui, cli |
| Reviews | reviewer: approve. upstream-guard: approve. Long marked line → wrapped in a start/end block. Card paths added. accessibility: hint contrast 3.4:1 → `--kete-text-2` (6.8–7.4:1); everything else passed |

## Acceptance criteria
- [x] AC1: `work-agent.test.ts` covers presence (with and without an account), `hidden`, not the default, and that an explicit session agent resolves.
- [x] AC2: `state.test.ts` (decoding, fallbacks, `effective`, `createFields`, `step`, `choose`).
- [x] AC3: stories and specs: Code checked; Work disabled with its hint; Work selectable when available; arrow keys and roving focus.
- [x] AC4: checks above.

Work stays `available: false` (file I/O follow-up after 1.3b), so nothing can create a Work session yet.

## Cards updated
web-app (mode-switch paths, RPC and `kete.sessionMode` answer), roles-skills (work-agent path, hidden-agent answer).

## Metrics
- Agents used: scout, librarian, planner, implementer (no shell), reviewer, upstream-guard, accessibility-reviewer
- Scout lookups: 1, docs enough: 0 (0%)
- Tokens / cost (from /usage): n/a
- Time: n/a (2026-11-05)
