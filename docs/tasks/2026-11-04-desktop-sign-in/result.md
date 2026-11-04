# Result: desktop sign-in

## What changed
New:
- `packages/schema/src/kete/account.ts` — `KeteAccountRpc` (status, login, cancel, logout; `changed` event; `localOnlyMessage`).
- `packages/util/src/kete/login-child.ts` — runs `kete login --no-browser` / `kete logout` as a child (argument array, no shell, job mode refused), parses only the approval URL, returns stderr warnings.
- `packages/core/src/kete/account.ts` — the `kete.account` runtime plugin; refuses offline and in job mode; logout cancels a pending login and reports a not-revoked caveat.
- `packages/server/src/kete/account-gate.ts` — refuses login/logout/cancel unless the server is loopback-only, not on a socket, with no tunnel and not in a remote session.
- `packages/gui-plugins/src/kete/account/` — Settings → Account page (controller, page, renderer, i18n).
- `packages/app/src/kete/account-prompt-card.tsx`, `account-prompt-state.ts` — signed-out prompt on the new-session screen, with "Not now".
- Tests: `util/test/kete/login-child.test.ts`, `core/test/kete/account.test.ts` (+ `fixtures/fake-login.ts`), `server/test/kete/account-gate.test.ts`, `gui-plugins/src/kete/account/controller.test.ts`, `app/src/kete/account-prompt-state.test.ts`.

Modified:
- `packages/util/src/kete/brand.ts` — `Brand.urls.platform` = `https://app.ketecode.ai`.
- `packages/server/src/process.ts` (upstream, marked) — gate middleware.
- `packages/core/src/plugin/internal.ts` (upstream, marked) — registers `kete.account`.
- `packages/core/src/kete/gateway.ts`, `packages/core/src/kete/sync/plugin.ts` — reload on `rpc.kete.account.changed`.
- `packages/gui-plugins/src/main.ts`, `renderer.ts`, `README.md` (upstream, marked) — `kete-account` built-in.
- `packages/tui/src/kete/setup-login.ts` — now a wrapper over `login-child`.
- `packages/cli/src/kete/commands.ts` — `--platform-url` help names the default.
- `packages/app/src/kete/panel.tsx`, `panel.css` — hosts the prompt card.
- `packages/core/test/kete/gateway.test.ts`, `job-spawn-sites.test.ts` — sign-out reload test; new spawn site classified `kete-guard`.
- `docs/upstream-patches.md` — "Desktop sign-in" section.

Deleted: the stubs `packages/app/src/kete/account-prompt.{ts,tsx}` and `account-prompt.test.ts`.

## Checks
The verifier agent has no shell; the main session ran every check.

| Check | Result |
|---|---|
| `bun run typecheck` in schema, util, core, server, tui, cli, gui-plugins, app | pass |
| `bun run --cwd packages/kete-tools verify --base main` | util 593/0, server 162/0, core 8804/27 (base 8790/27), tui 1722/2 (base 1722/2), cli 782/0 — **0 new failures** |
| core `account.test.ts` | 12 pass (includes the real-CLI test) |
| server `account-gate.test.ts` | 4 pass |
| util `login-child.test.ts` | 5 pass |
| gui-plugins `src/kete/account` | 8 pass |
| app `bun run test:unit src/kete` | 1032 pass / 0 fail |
| tui `test/kete`, cli `test/kete` | 128 / 430 pass, 0 fail |
| `bun run lint` | exit 0 (67 anti-slop warnings in the new files, warnings only) |
| `upstream:check` | pass |
| protocol / client regenerate | not needed: RPCs use the existing `/api/rpc` endpoint |
| Review | reviewer: 1 major + 5 minors, all fixed except "Not now" (kept by user); upstream-guard: approve (1 wording minor, fixed) |

## Acceptance criteria
- [x] AC1 — `account.test.ts` "status reports signed out, then the organization and platform host without the key id"; real-CLI test asserts signed-in status after approval.
- [x] AC2 — real-CLI test: `kete login --no-browser` against a fake platform on 127.0.0.1 yields `/cli/authorize` with `code_challenge_method=S256`; the fake checks the PKCE verifier and issues the key; status is signed-in. "login rejects an unexpected approval URL" covers the https/loopback rule.
- [x] AC3 — "cancel stops the attempt and announces cancelled"; "login returns the approval URL, repeats it for a second call…".
- [x] AC4 — real-CLI test: `kete logout` makes the fake platform see `POST /api/v1/cli/logout`; status signed-out. Also "logout runs the child, removes the account and announces signed-out", "logout cancels a sign-in that is still waiting", "logout carries a not-revoked warning…".
- [x] AC5 — `account-gate.test.ts` (non-local refused, percent-encoded paths still gated, status passes); "login and logout are refused offline and in job mode, without starting a child". Manual check with `--hostname 0.0.0.0`: **not done**.
- [x] AC6 — `gateway.test.ts` "account: signing out through kete.account removes the gateway models without a restart"; sync reloads on the same event. Limit (accepted in plan): reload covers the location that emitted the event only.
- [x] AC7 — gui-plugins `controller.test.ts`: sign-in opens the URL and waits, cancel, failure, refusal, 403 local-only text, sign-out, caveat notice; app `account-prompt-state.test.ts`. Deviation (approved): the Account page is a GUI plugin, so its tests are in gui-plugins.
- [x] AC8 — "secret values: no payload or event carries the key id, code or verifier"; real-CLI test asserts neither the api key nor the key id appears in any RPC output or event.
- [x] AC9 — see Checks.

Not done: a live sign-out/sign-in from the desktop against `app.ketecode.ai` (needs the user's go-ahead; it signs the machine out).

Scope additions: "Not now" on the prompt (user: keep; not persisted); sign-out is refused offline, like sign-in.

## Cards updated
account-login (new kete.account paths, UI sign-in path, nine Quick answers for the "Docs enough: no" gaps: RPC handlers don't see the caller, the RPC pattern, the GUI settings-page seam, RPC event location scope, remote tunnel, desktop CLI child, `Brand.urls.platform` consumers, running the CLI from source with `--cwd`, spawn-site inventory), brand-env, gateway, sync, server-sdk (`KeteAccountGate`, tunnel facts), web-app (sign-in prompt), ui-branding, permissions (`internal.ts` registration). `card-check.mjs`: 41 cards clean. `stale-cards.mjs` keeps listing these until the change is committed (their `verified-at` is 2800ac0ed3).

## Metrics
- Agents used: scout, librarian ×2 (8 cards refreshed before planning; close), planner, implementer ×2 (build; review fixes), verifier (no shell; main session ran checks), reviewer, upstream-guard
- Scout lookups: 3 recorded "Docs enough" lines, docs enough: 0 (0%)
- Tokens / cost (from /usage): n/a
- Time: n/a (spec, plan, build, review and close on 2026-11-04)
