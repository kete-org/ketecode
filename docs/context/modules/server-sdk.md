---
module: server-sdk
paths: [packages/server/src/kete/local-guard.ts, packages/server/script/kete/isolated-test.ts, packages/server/src/process.ts, packages/server/src/kete/socket-listen.ts, packages/server/src/kete/constant-time.ts, packages/server/src/auth.ts, packages/server/src/middleware/authorization.ts, packages/server/src/options.ts, packages/protocol, packages/client]
verified-at: 4e26b57120
---
## Quick answers
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
  `build`'s `replacements` array (`routes.ts:141-148`) is where the workerd profile already swaps
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
  `metadata?: SessionCreateInput["metadata"]` (`data.ts:1447-1455`, two `kete_change`-marked lines:
  the `SessionCreateInput` type import and the field); the body already spreads `...payload` into
  `api().session.create({ ...payload, id, location })` (`data.ts:1481`) so no body change was needed.
  Added for the Kete chat panel to set `kete.permissionMode` atomically at session creation
  (`packages/app/src/new-session/composer-adapter.ts`; `permissions` card) — nothing else in `data.ts`
  changed, and every other `data.session.create` caller is unaffected since the field is optional.
- Why does a browser request to `kete serve` sometimes get a bare 403? `KeteLocalGuard.middleware` (`packages/server/src/kete/local-guard.ts:58-67`) rejects it before auth/routing — check `Host`/`Origin`.
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
  `listen`/`bind` in `packages/server/src/process.ts:143-166` (hostname + port). With
  `ServerOptions.socket` set (`server/src/options.ts:16`, marked) it calls
  `KeteSocketListen.bind(path)` instead (`process.ts:59`), same `{ http, server, scope }` shape
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
  `middleware/authorization.ts:31-39`: a `?auth_token=` query (base64 `user:pass`) is checked
  **before** the Basic header; in job mode a query token yields an empty credential (401), marked
  `:34`. A PTY connect ticket in the URL skips the check entirely (`authorization.ts:53-56`; the
  handler validates the ticket; also `process.ts:194`) — unreachable in job mode, PTY is refused.

## Purpose
Two independent Kete-owned server concerns: (1) `local-guard.ts` — browser-facing DNS-rebinding/cross-site defenses in front of every `kete serve` HTTP server, layered outside upstream's own CORS/auth; (2) `isolated-test.ts` — a test-runner wrapper giving `packages/server`'s test suite a throwaway HOME/XDG/credential-free environment, mirroring `packages/core/script/test.ts`. Also covers the protocol/client SDK generation pipeline that turns server endpoint and config-schema changes into typed client code.

## Entry points
- `packages/server/src/process.ts:74` — `KeteLocalGuard.middleware({ hostname, cors, allowedHosts })` applied in the served-app pipe, after upstream's `HttpMiddleware.cors(...)` in source order but documented (and tested) to run "before CORS and auth" (`process.ts:73`, `kete_change`).
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
| `packages/server/src/process.ts:16,74` | — | Upstream file; imports and applies `KeteLocalGuard.middleware` (`kete_change`) |
| `packages/server/src/process.ts:17,59` | — | Upstream file; socket bind instead of TCP when `options.socket` (`kete_change`) |
| `packages/server/src/kete/socket-listen.ts` | 92 | unix-socket path checks, stale-socket unlink, 0600, `NodeHttpServer.make(..., { path })` |
| `packages/server/src/kete/constant-time.ts` | 19 | constant-time string compare for Basic auth |
| `packages/server/src/auth.ts:34`, `middleware/authorization.ts:34`, `options.ts:16` | — | Upstream; marked one-line edits (constant-time, job-mode query-token refusal, `socket` option) |
| `packages/protocol/script/generate-openapi.ts` | — | Generates `openapi.json` from the effect `HttpApi` definition (includes `ConfigKete.*` schemas) |
| `packages/client/script/build.ts` | — | Generates the promise/effect SDK clients from the OpenAPI document |
| `packages/client/src/solid/data.ts:1447-1481` | — | Hand-written (not generated) reactive `Data["session"].create()` wrapper; `kete_change`-marked `metadata` passthrough |

## Data flow
**Local guard:** every inbound request to the served app passes `HttpServerRequest.headers.{host,origin}` into `KeteLocalGuard.check` (`local-guard.ts:37-48`): missing/invalid/disallowed `Host` → reject; present `Origin` must be an app scheme (`oc://renderer`, Tauri), a `--cors`-allowed origin, or same-origin as `Host` → otherwise reject. A reject short-circuits with `HttpServerResponse.text("Forbidden", {status: 403})` and a `logWarning`, never reaching auth or routing (`local-guard.ts:58-67`).

**Isolated tests:** `isolated-test.ts` creates a `mkdtemp` HOME, strips provider-credential-shaped env vars and anything under `Brand.envPrefix` (`KETE_*`) or matching `API_KEY|AUTHORIZATION|TOKEN|SECRET|PASSWORD|CREDENTIALS?` (`isolated-test.ts:16-21`), sets `HOME`/`XDG_*`/`OPENCODE_CONFIG_DIR` to point inside it, then spawns `bun test --only-failures ...args` as a child process with that env, forwarding `SIGINT` and exit code, and removes the temp dir afterward.

**Protocol/client generation:** `packages/protocol/src/client.ts`'s `ClientApi` (the effect `HttpApi` definition, including config schemas like `ConfigKete`) → `OpenApi.fromApi` → stabilized (`openapi-stabilize.ts`) → written to `packages/protocol/openapi.json` → consumed by `packages/client/script/build.ts` to emit typed SDK code under `packages/client/src/{promise,effect}/generated/`.

**Socket listener (job mode):** `kete serve --stdio --socket <path>` → `ServerOptions.socket` → `KeteSocketListen.bind` → `prepare` checks → listen → chmod 0600 → finalizer unlinks. Clients use Bun `fetch(url, { unix })` with an `http://localhost` base (Host `localhost` passes the local guard).

## Data and APIs used
- No platform/database calls in `local-guard.ts` — pure header inspection (CLAUDE.md §3 "Runtime → Platform API, never → database" is not implicated here; this is inbound-request filtering only).
- `packages/protocol/openapi.json` and `packages/client/src/*/generated/` are the only cross-package "APIs" this card covers; both are generated, never hand-edited (CLAUDE.md §4, §8). Check-only mode: `bun run check:generated` in each package (`--check` flag in `generate-openapi.ts`, `git diff --exit-code` in `client/package.json`).

## Rules that must not break
- `process.ts:74`'s `kete_change` marker and comment ("before CORS and auth") — any upstream merge that reorders the middleware pipe must re-verify request rejection still precedes auth (CLAUDE.md §9 "Never weaken ... permission checks").
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
