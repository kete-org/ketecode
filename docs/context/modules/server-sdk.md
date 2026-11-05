---
module: server-sdk
paths: [packages/server/src/kete/local-guard.ts, packages/server/script/kete/isolated-test.ts, packages/server/src/process.ts, packages/server/src/kete/socket-listen.ts, packages/server/src/kete/constant-time.ts, packages/server/src/auth.ts, packages/server/src/middleware/authorization.ts, packages/server/src/options.ts, packages/protocol, packages/client]
verified-at: 4b77172c15
---
## Quick answers
- What is `kete.modes/list`? A plugin RPC (`KeteModesRpc.Definition`, `schema/src/kete/modes.ts:49`) returning the mode profile summaries (`KeteModes.summaries()`), registered next to the handshake in `core/src/kete/handshake.ts:25`; the handshake's `modes` field is `KeteModes.available()` (`:22`), so the two always agree.
- What is the `kete.handshake` RPC? A plugin RPC (`kete.handshake/get`, no input) returning `{ protocol, runtime, modes }`: defined in `schema/src/kete/handshake.ts`, `KeteHandshakeRpc.PROTOCOL` (`:15`) is the one protocol number (bump on a changed or removed field; clients accept an exact match only), registered by `core/src/kete/handshake.ts:15-24` and listed in `core/src/plugin/internal.ts:355`. The app calls it from `app/src/kete/handshake.ts:15`; card `web-app`.
- How does an RPC call with no `location` resolve? `requestRef` in `server/src/location.ts:71-78` falls back to `process.cwd()`, so location-free RPCs like the handshake answer anywhere.
- What is a plugin's `ctx.app.version`? The runtime version (`plugin/src/app.ts:1-5`; used by `core/src/kete/share/plugin.ts:156` and the handshake's `runtime`).
- What error does a client get for an unknown RPC? An `RpcError` (HTTP 400) with type `rpc.unavailable` or `rpc.method_not_found` (`core/src/rpc.ts:108-114`); guard with `isRpcError` (`client/src/promise/generated/types.ts:3226`). `rpc.unavailable` also fires if a location closes mid-call (`core/src/rpc.ts:133-135`).
- Is there any plain Kete HTTP route, and how do I add one? None today. Kete server code is middleware (`server/src/kete/account-gate.ts:57`, `local-guard.ts`, applied in `process.ts:81-83`) plus plugin RPCs on `POST /api/rpc/:rpcID/:method`. A new Kete call should be a plugin RPC (`Rpc.define` in `packages/schema/src/kete/`, registered from a core plugin), which needs no openapi/SDK regeneration.
- Does the `kete.share` RPC need regeneration? No: it is a plugin RPC on the generic `POST /api/rpc/:rpcID/:method` route (`schema/src/kete/share.ts:69`); no protocol or client change. Card `session-share`.
- How does a client call a Kete RPC and where is `rpc.register` used? Define it with `Rpc.define` in `schema/src/kete/*.ts` (e.g. `local-models.ts:62`, `doctor.ts:62`); a core plugin registers handlers with `ctx.rpc.register(Definition, {...})` (`core/src/kete/sync/plugin.ts:232`, `core/src/kete/doctor.ts:156`, `core/src/kete/folder-trust/rpc.ts:38`); the one generic route `POST /api/rpc/:rpcID/:method` (`protocol/src/groups/rpc.ts:14`, handler `server/src/handlers/rpc.ts:8`) serves them all, so no new endpoint or regeneration; clients call `client.api.rpc.call({ rpcID, method, input, location })` (TUI: `tui/src/kete/local-models.ts:23`).
- How can a Kete runtime RPC restrict a method to a local, same-user client? It cannot from the request: `rpc.call` passes only `params.rpcID`, `params.method` and `payload.input` to `Rpc.Service.call` (`server/src/handlers/rpc.ts:8-13`), and `ctx.rpc.register` handlers receive only `input` (`plugin/src/effect/rpc.ts:15-16,25`). No existing Kete RPC checks its caller (`core/src/kete/folder-trust/rpc.ts`, `doctor.ts`, `share/plugin.ts` all trust the route). What the server knows, and where:
  - Bind: `options.hostname ?? "127.0.0.1"` (`server/src/process.ts:60`, option `options.ts:14`); `kete serve --hostname` sets it (`cli/src/server-process.ts:83,121`; flag `cli/src/commands/commands.ts:601`). A job-mode `--socket` binds a unix socket instead (`process.ts:64`, `options.ts:16`, `kete/socket-listen.ts`). Only `process.ts` has it; the `app` layer and plugins get no hostname.
  - Guard: `KeteLocalGuard.middleware({ hostname, cors, allowedHosts })` (`process.ts:81`) checks only the `Host` and `Origin` headers (`local-guard.ts:37-48`). It accepts any IP literal and `localhost` on purpose so LAN pairing by address works (`local-guard.ts:6-8,71`), so it cannot tell a loopback client from a LAN or tunnelled one, and it carries no user identity. It runs before auth and does not pass anything to handlers.
  - Auth: one shared server password, user name `opencode` (`server/src/auth.ts:25-31`, `process.ts:190`). Pairing (`server.pair`, `handlers/server.ts:32`, codes in `server/src/pairing.ts`, 5 min) and `kete pair --remote` (OpenTunnel, `cli/src/commands/commands.ts:583`, `cli/src/services/remote-tunnel`, started `cli/src/server-process.ts:212`) hand a paired client a session token signed from that password (`auth.ts:42-48`), accepted anywhere the password is (`auth.ts:36`). So a paired or remote client is indistinguishable from the desktop sidecar once authorized; no per-client identity, no same-user check.
  - Now implemented for the account RPC: `KeteAccountGate.middleware({ hostname, socket, remoteURLs })` (`server/src/kete/account-gate.ts:57`, applied `process.ts:81`, `kete_change`) answers 403 for every `kete.account` method except `status` unless the bind is loopback, there is no unix socket, `remoteURLs` is empty and no SSH/Codespaces/dev-container env is set (`account-gate.ts:16-31`). `remoteURLs` is a getter, empty until the tunnel reports a URL; the tunnel exists only in service mode with `config.remote` (`cli/src/server-process.ts:204-216`). Reuse this gate for any other credential-changing RPC. A peer-address check alone is unsafe because the tunnel dials from loopback.
- What is the plugin RPC define/register/emit/call pattern? Example `kete.todo`. (1) Schema: `Rpc.define({ id, methods: { get: { input, output } }, events: { updated: { schema } } })` in `schema/src/kete/todo.ts:47-54` (id `"kete.todo"`, `:46`). (2) Core plugin: `ctx.rpc.register(KeteTodoRpc.Definition, { get: (input) => Effect })` returns a registration (`core/src/kete/todo.ts:87-90`, then `.pipe(Effect.orDie)`); the plugin is added in `core/src/plugin/internal.ts`. (3) Emit: `registration.events.emit("updated", payload)` (`core/src/kete/todo.ts:99-101`; typed by `RpcRegistration` in `plugin/src/effect/rpc.ts:18-22`; implemented `core/src/rpc.ts:91`); it is published on the bus as `rpc.<id>.<event>`, e.g. `rpc.kete.todo.updated`. (4) Client: `client.rpc.call({ rpcID, method, input, location }, { signal })` and decode `response.output` against the schema (`tui/src/kete/todo.tsx:20-25`); subscribe by matching `event.type === \`rpc.${ID}.updated\`` on the event stream (`tui/src/kete/todo.tsx:13,28-31,68-71`). Other examples: `kete.context` (`core/src/kete/context-breakdown.ts:278`), `kete.folder-trust` (registration plus `config.updated` re-emit, `core/src/kete/folder-trust/rpc.ts:38-52`). Handler errors map to `RpcError`/`RpcInternalError` (`server/src/handlers/rpc.ts:16-21`).
- Was the protocol regenerated for `kete.unattended`? Yes (2026-10-05): `protocol/openapi.json` and `client/src/promise/generated/types.ts` gained `kete.unattended.passEnv` (config schema only; no endpoint change).
- Was the protocol regenerated for sandbox, hooks and lsp (wave 1a)? Yes: `protocol/openapi.json` and `client/src/promise/generated/types.ts` (~`:2179`) gained `kete.sandbox`, `kete.hooks` (`ConfigKete.HookEncoded`: `command`, `match`, `timeout`, `network`, `sandbox`; plus `unsandboxed`) and `kete.lsp` (`unsandboxed`) from `ConfigKete` (`schema/src/config/kete.ts`); config schema only, no endpoint change.
- Which clients render `form.created`? A form is a question the runtime asks (`schema/src/form.ts`). Rendered: the TUI (`tui/src/routes/session/form.tsx` `FormPrompt`, mounted in `routes/session/index.tsx:1636` for the session, its subagents and the `"global"` owner, and in `routes/home.tsx:115-121` for `"global"` only) and the web UI (`app/src/session/requests/session-question-dock.tsx` `SessionQuestionDock`, mounted by `session/composer/session-composer-region.tsx:77`; requests come from `session/requests/model.ts:34-39` via `data.session.form.sync/list` per session tree). The `"global"` owner (a session-less MCP elicitation or pre-session question) is listed by `app/src/kete/global-form-dock.tsx:28`, mounted in `app/src/composer/composer.tsx:58`. The VS Code extension and JetBrains plugin render nothing themselves: they frame that same web UI (`packages/kete-vscode`, `packages/kete-jetbrains`; no form code in either, and no `form.created` handling), so they get the web UI's behaviour. ACP (`cli/src/acp/translate.ts:109`, handled in `cli/src/acp/turn.ts:169`) does not render a form itself: it turns `form.created` for its session or subagents into a `FormAsk` output. The TUI's desktop notification for a new form is `tui/src/feature-plugins/system/notifications.ts:45`; `kete run` handles `"global"` forms in `cli/src/run/noninteractive.ts:65-70`.
- Did the MCP presets task change the API? Only the config schema (`kete.integrations`), so `protocol/openapi.json` and `client/src/promise/generated/types.ts` were regenerated; no endpoint changed.
- What regenerated for offline mode? `kete.offline` appears in `packages/protocol/openapi.json` (~line 13194) and `packages/client/src/promise/generated/types.ts` (~2159). The local models status uses the existing plugin RPC route (`POST /api/rpc/:rpcID/:method`), so there is no new endpoint.
- What is the `LayerNode` replacement graph `routes.ts`/`instance.ts` build (upstream, not covered
  elsewhere)? `packages/core/src/instance.ts` compiles one per-location `LayerNode.group(nodes)`
  graph (`instance.ts:114`); `Options.replacements` (caller-supplied) win over its own
  `vanillaReplacements` (`instance.ts:142-145`, a `discovery: false` instance's `Config`/
  `InstructionDiscovery` no-scan defaults) but lose to the location's own bindings
  (`Location.node`/`InstancePlugins.node`, `instance.ts:152-158`) — ordering: vanilla defaults, then
  caller replacements, then instance bindings, each later group winning. `packages/server/src/routes.ts`
  `build` (`:141-148`) is a *different*, server-wide `AppNodeBuilder.build` graph, one layer up: its
  own `replacements` array ends with `...overrides` (caller-supplied, e.g. the workerd profile) and
  then (as of job mode) `...KeteJobServer.replacements(options)` last of all. Don't confuse the two —
  `overrides` at the `routes.ts` level flow into `instance.ts`'s graph as part of its own
  `Options.replacements` for a location instance, not the other way around.
- Is `packages/server/src/routes.ts`'s replacement list itself Kete-owned or upstream? Upstream —
  `build`'s `replacements` array (`routes.ts:147-`) is where the workerd profile already swaps
  `CrossSpawnSpawner.node` for a refusing stub (`server/src/workerd.ts:79`); job mode reuses the same
  seam with one marked line, `...KeteJobServer.replacements(options)`, appended **last** (after
  `...overrides`) so it always wins. Not covered in depth here — see the `job-mode` card
  (`packages/server/src/kete/job-server.ts`) for the replacement list itself.
- Is `packages/client/src/solid/data.ts` generated? No — it's hand-written upstream code (`kete`-free
  path, needs `kete_change` markers). Generated client code is only
  `packages/client/src/{promise,effect}/generated/` and `src/effect/api` (`packages/client/package.json`
  `check:generated`). `data.ts` is the reactive Solid store the web app calls (e.g.
  `data.session.create(...)`); it wraps the generated `api().session.*` calls and is a different
  surface from `SessionCreateInput` (`src/promise/generated/types.ts`).
- Does `data.session.create()` forward session `metadata`? Yes — its input type has an optional
  `metadata?: SessionCreateInput["metadata"]` (`data.ts:1521`, two `kete_change`-marked lines:
  the `SessionCreateInput` type import and the field); the body already spreads `...payload` into
  `api().session.create({ ...payload, id, location })` (`data.ts:1549`) so no body change was needed.
  Added for the Kete chat panel to set `kete.permissionMode` atomically at session creation
  (`packages/app/src/new-session/composer-adapter.ts`; `permissions` card) — nothing else in `data.ts`
  changed, and every other `data.session.create` caller is unaffected since the field is optional.
- Why does a browser request to `kete serve` sometimes get a bare 403? `KeteLocalGuard.middleware` (`packages/server/src/kete/local-guard.ts:57-65`) rejects it before auth/routing — check `Host`/`Origin`.
- How do I allow an extra hostname (e.g. a forwarded Codespaces host)? `KETE_SERVER_ALLOWED_HOSTS` env var (internal name `OPENCODE_SERVER_ALLOWED_HOSTS`, `local-guard.ts:18`), comma-separated, leading `.` allows subdomains.
- Why do `packages/server` tests need a special runner instead of `bun test`? `bun run test` (`script/kete/isolated-test.ts`) isolates HOME/XDG and strips credentials so tests don't read/sync the developer's real Kete account (CLAUDE.md §8) — but CI runs `bun test test/kete` directly for this package, bypassing that isolation (see Gotchas).
- After changing a server endpoint or the config schema, what do I regenerate? `bun run generate` in `packages/protocol` then `packages/client` (CLAUDE.md §8); see Data and APIs used.
- How do I write an end-to-end test against a fake model? `createEmbeddedRoutes({}, replacements)`
  + `TestLLM` + a `SessionRunnerModel` replacement + the routes' own web handler as a client's
  `fetch` (`server/test/session-instances.test.ts:33-180` is the pattern to copy) — a real
  in-process server, no network. `ServerProcess.start` itself takes no replacements, so this
  pattern (not `ServerProcess.start`) is what any Kete e2e test needs. A test that must import a
  `cli/src/*` module (e.g. `kete job run`'s orchestration) has to live under `server/test/kete/`,
  not `cli/test/kete/` — the CLI package can't import `core` at all
  (`cli/test/import-boundaries.test.ts`), and a plain relative cross-package import (not a
  `tsconfig` project reference) typechecks fine under `tsgo -b` (`server/test/kete/job-run.test.ts`
  is the precedent).
- Can a client discover the server's data/audit directory over HTTP? No — `server.info` exposes
  only `paths.tmp` (`protocol/src/groups/server.ts:4-12`); there is no endpoint for the data or
  audit directory. A remote client (e.g. `kete job run --server <url>`) can't read the server's
  audit log and falls back to classifying the session's own execution event instead
  (`unattended`/`cli` cards, `docs/jobs.md`).

- How does `ServerProcess.start` listen, and can it use a unix socket? TCP by default: the private
  `listen`/`bind` in `packages/server/src/process.ts:148-` (hostname + port). With
  `ServerOptions.socket` set (`server/src/options.ts:16`, marked) it calls
  `KeteSocketListen.bind(path)` instead (`process.ts:63`), same `{ http, server, scope }` shape
  (`packages/server/src/kete/socket-listen.ts:67-92`). `prepare` (`:34-64`) refuses Windows, a
  relative path, > 103 bytes (sun_path), a parent dir that is a symlink, not owned by the euid or
  has any group/other bits; unlinks a stale **socket** and refuses any other file there; after
  listening it `chmod`s the socket 0600 and unlinks it on close. Only `kete serve --socket` in job
  mode sets it (`cli` / `job-mode` cards). The `urls()` list is empty for a socket; the ready line
  `{"url":"unix://<path>"}` is printed by the CLI side.
- Where does `kete serve`'s password come from? `cli/src/server-process.ts:83-96`: in job mode the
  descriptor password from `KeteJobServe.prepare` (marked); service mode → service config or
  random; otherwise `Env.password` (`KETE_PASSWORD`/`KETE_SERVER_PASSWORD`, deleted from env in
  `--stdio` mode) or random. The upstream standalone child (`cli/src/services/standalone.ts:19-61`)
  passes a random 32-byte password as `KETE_PASSWORD`.
- How does server auth work? Basic `opencode:<password>` (`server/src/auth.ts:16-18` sets the
  username); `authorized` (`auth.ts:30-36`) compares the password with
  `KeteConstantTime.equal` (`server/src/kete/constant-time.ts:13-19`, pure JS over UTF-8 so workerd
  works; folds the length difference in) instead of upstream's `===`. Credentials come from
  `middleware/authorization.ts:34-40`: a `?auth_token=` query (base64 `user:pass`) is checked
  **before** the Basic header; in job mode a query token yields an empty credential (401), marked
  `:37`. A PTY connect ticket in the URL skips the check entirely (`authorization.ts:84-97`; the
  handler validates the ticket; also `process.ts:195`) — unreachable in job mode, PTY is refused.

## Purpose
Two independent Kete-owned server concerns: (1) `local-guard.ts` — browser-facing DNS-rebinding/cross-site defenses in front of every `kete serve` HTTP server, layered outside upstream's own CORS/auth; (2) `isolated-test.ts` — a test-runner wrapper giving `packages/server`'s test suite a throwaway HOME/XDG/credential-free environment, mirroring `packages/core/script/test.ts`. Also covers the protocol/client SDK generation pipeline that turns server endpoint and config-schema changes into typed client code.

## Entry points
- `packages/server/src/process.ts:80` — `KeteLocalGuard.middleware({ hostname, cors, allowedHosts })` applied in the served-app pipe, after upstream's `HttpMiddleware.cors(...)` in source order but documented (and tested) to run "before CORS and auth" (`process.ts:73`, `kete_change`).
- `packages/server/package.json` `"test"` script → `bun run script/kete/isolated-test.ts` (no `kete_change` marker possible — JSON; documented in docs/upstream-patches.md "Isolated server tests").
- `packages/protocol/script/generate-openapi.ts` — `bun run generate` (writes `packages/protocol/openapi.json` from `ClientApi`, `effect/unstable/httpapi`'s `OpenApi.fromApi`).
- `packages/client/script/build.ts` — `bun run generate` in `packages/client` (writes `src/promise/generated/`, `src/effect/generated/`, `src/effect/api`).

- `packages/server/src/kete/socket-listen.ts` `KeteSocketListen.prepare`/`bind` — the unix-socket
  listener (job mode).
- `packages/server/src/kete/constant-time.ts` `KeteConstantTime.equal` — used by `auth.ts:34`.

## Key files
| File | Lines | Role |
| --- | --- | --- |
| `packages/server/src/kete/local-guard.ts` | 96 | `check()`, `middleware()`, `allowedHostsFromEnvironment()` — Host/Origin verdicts |
| `packages/server/test/kete/local-guard.test.ts` | 114 | Unit tests for `check()`'s Host/Origin decision table |
| `packages/server/script/kete/isolated-test.ts` | 47 | Spawns `bun test` with a temp HOME/XDG and a filtered, credential-free env |
| `packages/server/src/process.ts:19,80` | — | Upstream file; imports and applies `KeteLocalGuard.middleware` (`kete_change`) |
| `packages/server/src/process.ts:20,63` | — | Upstream file; socket bind instead of TCP when `options.socket` (`kete_change`) |
| `packages/server/src/kete/socket-listen.ts` | 92 | unix-socket path checks, stale-socket unlink, 0600, `NodeHttpServer.make(..., { path })` |
| `packages/server/src/kete/constant-time.ts` | 19 | constant-time string compare for Basic auth |
| `packages/server/src/auth.ts:34`, `middleware/authorization.ts:37`, `options.ts:16` | — | Upstream; marked one-line edits (constant-time, job-mode query-token refusal, `socket` option) |
| `packages/protocol/script/generate-openapi.ts` | — | Generates `openapi.json` from the effect `HttpApi` definition (includes `ConfigKete.*` schemas) |
| `packages/client/script/build.ts` | — | Generates the promise/effect SDK clients from the OpenAPI document |
| `packages/client/src/solid/data.ts:1521-1549` | — | Hand-written (not generated) reactive `Data["session"].create()` wrapper; `kete_change`-marked `metadata` passthrough |

## Data flow
**Local guard:** every inbound request to the served app passes `HttpServerRequest.headers.{host,origin}` into `KeteLocalGuard.check` (`local-guard.ts:37-48`): missing/invalid/disallowed `Host` → reject; present `Origin` must be an app scheme (`oc://renderer`, Tauri), a `--cors`-allowed origin, or same-origin as `Host` → otherwise reject. A reject short-circuits with `HttpServerResponse.text("Forbidden", {status: 403})` and a `logWarning`, never reaching auth or routing (`local-guard.ts:57-65`).

**Isolated tests:** `isolated-test.ts` creates a `mkdtemp` HOME, strips provider-credential-shaped env vars and anything under `Brand.envPrefix` (`KETE_*`) or matching `API_KEY|AUTHORIZATION|TOKEN|SECRET|PASSWORD|CREDENTIALS?` (`isolated-test.ts:16-21`), sets `HOME`/`XDG_*`/`OPENCODE_CONFIG_DIR` to point inside it, then spawns `bun test --only-failures ...args` as a child process with that env, forwarding `SIGINT` and exit code, and removes the temp dir afterward.

**Protocol/client generation:** `packages/protocol/src/client.ts`'s `ClientApi` (the effect `HttpApi` definition, including config schemas like `ConfigKete`) → `OpenApi.fromApi` → stabilized (`openapi-stabilize.ts`) → written to `packages/protocol/openapi.json` → consumed by `packages/client/script/build.ts` to emit typed SDK code under `packages/client/src/{promise,effect}/generated/`.

**Socket listener (job mode):** `kete serve --stdio --socket <path>` → `ServerOptions.socket` → `KeteSocketListen.bind` → `prepare` checks → listen → chmod 0600 → finalizer unlinks. Clients use Bun `fetch(url, { unix })` with an `http://localhost` base (Host `localhost` passes the local guard).

## Data and APIs used
- No platform/database calls in `local-guard.ts` — pure header inspection (CLAUDE.md §3 "Runtime → Platform API, never → database" is not implicated here; this is inbound-request filtering only).
- `packages/protocol/openapi.json` and `packages/client/src/*/generated/` are the only cross-package "APIs" this card covers; both are generated, never hand-edited (CLAUDE.md §4, §8). Check-only mode: `bun run check:generated` in each package (`--check` flag in `generate-openapi.ts`, `git diff --exit-code` in `client/package.json`).

## Rules that must not break
- `process.ts:80`'s `kete_change` marker and comment ("before CORS and auth") — any upstream merge that reorders the middleware pipe must re-verify request rejection still precedes auth (CLAUDE.md §9 "Never weaken ... permission checks").
- Behavior change vs. upstream: Kete Code accepts only the server's own origin and `--cors`-listed origins — not upstream's `http://localhost:*`/`127.0.0.1:*`/`https://*.opencode.ai` allowance (docs/upstream-patches.md "VS Code extension"). Don't silently widen this back.
- `local-guard.ts` never logs or echoes the raw rejected `Host`/`Origin` value into a response body — only a generic "Forbidden" text (secret/PII hygiene, CLAUDE.md §9).
- Generated files (`openapi.json`, `packages/client/src/*/generated/`) must be committed together with the schema/endpoint change that produced them (CLAUDE.md §8); a PR that changes `packages/schema` or `packages/server/src/` without a regen will fail `check:generated`.

- `ServerOptions.socket` is not part of the protocol (CLI-only flag), so it needs no regeneration.

## Testing
- Narrowest: `bun test ./test/kete/local-guard.test.ts` inside `packages/server` for the guard; for isolation itself there's no unit test — it's exercised implicitly by every other server test running under it.
- Package-wide (per CLAUDE.md §8): `bun run test` inside `packages/server`, which runs `script/kete/isolated-test.ts` — do not bypass with bare `bun test`.
- Protocol/client: `bun run check:generated` in `packages/protocol` and `packages/client` after any schema/endpoint change.
- Socket and auth: `bun run test ./test/kete/socket-listen.test.ts ./test/kete/job-auth.test.ts`
  inside `packages/server` (path checks, stale socket, 0600, `fetch({unix})`; constant-time compare,
  `auth_token` refused in job mode and accepted outside it).
- `bun test ./test/kete/session-create-metadata.test.ts` inside `packages/client` — asserts
  `data.session.create()` forwards a given `metadata` and sends no `metadata` key when omitted
  (fake-`fetch` setup copied from `test/solid-data.test.ts:801-825`).

## Changes
- Extending the guard's allowlist logic: edit `allowedHost`/`sameOrigin` in `local-guard.ts` (keep it a pure function of `(name, options)`/`(origin, host)` for testability), add cases to `local-guard.test.ts`.
- Widening what environment variables `isolated-test.ts` strips: edit the filter predicate at `isolated-test.ts:16-21`; keep the "provider secret shape" regex and the `Brand.envPrefix` check both applied (either alone under-strips).
- Any change to `packages/server/src/` request handling, or to a schema `packages/protocol` embeds (e.g. `ConfigKete`): regenerate per CLAUDE.md §8 and commit both generated trees.

- The socket/auth edits are recorded in `docs/upstream-patches.md` (job mode piece A1 section).

## Gotchas
- Bun `fetch` over `unix:` with `HTTP_PROXY` set sends an absolute-form request target; keep proxy
  variables out of a socket client's env (the job's `kete` has `HTTPS_PROXY` only).
- A socket's permissions come from its 0700 directory (Bun creates the socket 0755 before the chmod).
- **CI vs. CLAUDE.md §8 conflict:** `.github/workflows/kete-build.yml:90` runs the server's Kete tests as `suite server test/kete "bun test test/kete"` — a bare `bun test`, not `bun run test` — which does **not** go through `isolated-test.ts`'s HOME/XDG isolation. This contradicts CLAUDE.md §8's instruction that server tests must use the isolated runner. Locally, always use `bun run test` (or the isolated script directly) to match the documented safety behavior even though CI doesn't.
- `local-guard.ts:70`'s `allowedHost` treats any IP literal or `localhost` as always allowed regardless of what the server was actually bound to — intentional (an IP literal can't be DNS-rebound) but means binding to `0.0.0.0` doesn't itself restrict which local IPs can reach it; that's a separate `--hostname` concern.
- `isolated-test.ts` forwards `process.argv.slice(2)` to the child `bun test` — passing a path filter still works (`bun run test ./test/path/to/file.test.ts` per CLAUDE.md §8), but flags meant for the wrapper itself would be misrouted since there are none defined.
