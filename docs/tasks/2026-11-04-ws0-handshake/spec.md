# Spec: WS0 handshake

- Task: `docs/tasks/2026-11-04-ws0-handshake` · Size: large · Created: 2026-11-04
- Status: closed (approved 2026-11-04, user: "use the RPC approach, start building Phase A") <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
The desktop and web app know which app↔runtime protocol a `kete serve` speaks, and refuse a server
that speaks a different one (or none) with the existing "incompatible" panel on every page, instead of
failing later in confusing ways. PR 0.1 of `docs/desktop-enhancement-plan.md` (Phase A).

## Scope
- **Contract** (module card server-sdk): a `kete.handshake` plugin RPC with one method `get`, defined
  with `Rpc.define` in `packages/schema/src/kete/` (pattern: `todo.ts`). Result:
  `{ protocol: number, runtime: string, modes: string[] }`.
  - `protocol`: a single shared constant (starting at `1`) that server and app both import.
  - `runtime`: the runtime's version string (from the existing version source, not hard-coded).
  - `modes`: the modes this runtime offers. In this PR `["code"]`; Work is added in 1.3.
  - Decision: an RPC, not a plain `GET /api/kete/handshake` route: no upstream mount, no
    `openapi.json`/SDK regeneration, same auth and local guard as every other call. This replaces the
    plan's §3 wording; the plan doc is updated.
- **Handler**: registered from a Kete core plugin (pattern: `core/src/kete/doctor.ts`). Must work
  without a project directory (the app calls it from the home page).
- **App check** (module card web-app): `checkServerHealth` (`app/src/runtime/server/health.ts`) calls
  `kete.handshake.get` after `server.info`. A different `protocol`, or a server with no `kete.handshake`
  RPC, makes the server `incompatible`. Network errors keep today's unhealthy/retry behaviour; auth
  errors keep `unauthorized`.
- **App-wide panel**: when the current server is incompatible, `ServerUnavailablePanel` (reason
  `incompatible`) shows on every route, not only the session and new-session routes. (Plan D1:
  Settings stays reachable so the user can remove or switch the server; session/draft routes keep
  rendering their own panel.) Copy says
  "Kete Code" and tells the user to update.
- The desktop gets this through the shared renderer; no separate main-process check in this PR (0.2
  and 0.3 build on the RPC).
- Upstream edits marked `kete_change` and recorded in `docs/upstream-patches.md`; plan doc §3/§5
  updated to name the RPC.

## Out of scope
- Sidecar supervision, restart banner (0.2); packaged smoke and Electron e2e (0.3, 0.4).
- The Work mode itself and `GET /api/kete/modes` content beyond `["code"]` (1.1–1.4).
- Version negotiation or a compatibility range: exact protocol match only.
- The editor-host extensions (VS Code, JetBrains) beyond what the shared app code gives them.

## Acceptance criteria
- [ ] AC1: Contract — the schema test decodes a valid result and rejects a missing/negative
  `protocol` or non-string `runtime`.
- [ ] AC2: Server — an isolated server test calls `POST /api/rpc/kete.handshake/get` and gets
  `{ protocol: <constant>, runtime: <runtime version>, modes: ["code"] }`, with no project directory.
- [ ] AC3: Check — a unit test of the app's compatibility check: same protocol → compatible;
  different protocol → incompatible; unknown-RPC error (older server) → incompatible; network error →
  not incompatible (retry); unauthorized → unauthorized.
- [ ] AC4: Panel — a story/component test shows the incompatible panel on a non-session page (home)
  when health is incompatible, and no panel when compatible.
- [ ] AC5: The protocol number has one definition; server and app import it (grep shows no second
  literal).
- [ ] AC6: `upstream:check` passes; every upstream edit is marked and recorded; `verify --base main`
  reports no new failures; app/server/core/schema typecheck pass; lint passes.

## Risks and constraints
- Shared contract: the RPC result is a runtime API from this release on; adding fields later is fine,
  changing or removing them needs a protocol bump.
- Compatibility: a newer app refuses servers older than this release (decided: show incompatible
  with an update message). The VS Code and JetBrains hosts bundle their own matching runtime, so they
  are unaffected; a user pointing the web app at an older remote server sees the panel.
- Security: no new endpoint or bypass; the RPC goes through the same server auth and `KeteLocalGuard`.
  The result reveals only the protocol number, version and mode names (`server.info` already reveals
  the version).
- Upstream: the app-wide panel needs a marked edit in the shell layout; keep it to one `Show`.
