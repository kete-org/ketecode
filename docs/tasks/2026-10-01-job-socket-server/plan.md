# Plan: Job mode piece A1: kete's server on a unix socket, secrets by descriptor

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

**Large task: needs the user's approval before building.** It edits 7 upstream files (all marked,
listed in §Upstream edits), changes a security boundary (auth, secrets, process dumpability), and
changes the entrypoint ↔ runtime contract (`contracts.md` §6d: `KETE_JOB_GATEWAY_KEY_FD`; in job
mode `KETE_GATEWAY_KEY` is ignored) and the CLI surface (`kete serve --socket`, job mode only).
No HTTP endpoint, protocol or config-schema change, so no protocol/client regeneration
(`check:generated` confirms it).

## Cards read
- docs/context/modules/job-mode.md (verified-at 72feb4e6f7, stale: no)
- docs/context/modules/server-sdk.md (verified-at 3499a107b0, stale: no)
- docs/context/modules/cli.md (verified-at 72feb4e6f7, stale: no)
- docs/context/modules/gateway.md (verified-at bfd6c66, stale: no)
- docs/context/modules/job-entrypoint.md (verified-at 63ffbe874c, **stale**: only
  `internal/itest/scenarios_test.go`, a proxy-failure test retry; nothing this plan relies on)
- docs/context/modules/root-helper.md (verified-at 72feb4e6f7, **stale**: unique cgroup leaf names
  in `launch_linux.go`; irrelevant here). Both go to the librarian at close (handoff.md).
- docs/context/pitfalls.md, decisions.md, commands.md, CLAUDE.md §3, §4, §9, §10.

## Design (the choices the steps implement)

### 1. Unix-socket listener in `kete serve`
- **Flag:** `kete serve --socket <path>` (`Flag.string("socket")`, optional). **Job mode only:**
  outside job mode it is refused ("`--socket` is only available in job mode"); in job mode `kete
  serve` refuses to start **without** it, with `--port`/`--hostname`, or in a mode other than
  `--stdio` (no TCP listener can exist in job mode; the lease pipe stays). This check runs for every
  `ServerProcess.run` caller, so the background service, a TUI's standalone child and ACP all
  refuse in job mode instead of opening TCP. Outside job mode nothing changes (AC5).
- **Seam:** `ServerProcess.start` (server) already takes `ServerOptions`; add one optional
  `socket` field and swap `listen(...)` for a Kete bind when it's set. The bind lives in a new
  Kete file, `packages/server/src/kete/socket-listen.ts` `KeteSocketListen.bind(path)`, returning
  the same `{ http, server, scope }` shape as process.ts's private `bind` (copy its scope handling;
  use `NodeHttpServer.make(() => server, { path })`).
- **`bind(path)` checks, in order (each failure is an Error naming the rule, never a secret):**
  not win32; `path` absolute; UTF-8 byte length ≤ 103 (sun_path is 108 on Linux and 104 on macOS,
  minus the NUL; 103 is safe on both); parent directory `lstat`: a real directory (not a symlink),
  owned by `process.geteuid()`, `mode & 0o077 === 0`; an existing entry at `path`: a socket →
  `unlink` (stale); anything else → refuse, leave it untouched. Listen, then `chmod(path, 0o600)`.
  Finalizer: `unlink` if it still exists (ignore `ENOENT`; Bun's close already unlinks — spike).
- **Ready line:** unchanged code — `HttpServer.formatAddress` of a unix address is
  `unix://<path>`, so `--stdio` prints `{"url":"unix://<path>"}`. `urls()` in process.ts returns
  `[]` for a string address, so `/api/info` lists no connection URLs (fine).
- **Host/Origin guard:** Bun's `fetch(…, { unix })` sends `Host: localhost`, which
  `KeteLocalGuard` always allows. No change.

### 2. Job-mode standalone path (Kete-owned, `standalone.ts` untouched)
`cli/src/services/standalone.ts` is **not** edited. Job mode needs different arguments (`--socket`,
no `--port`), no password in the environment, a secrets descriptor, a socket-directory lifecycle
and a stricter ready-line check; putting those branches into upstream's standalone (used by every
TUI/`kete run --standalone`) would mean a large marked block in a hot upstream file. A Kete sibling
reusing upstream's `selfCommand()` and `CrossSpawnSpawner` is smaller and merge-safe.
- New `packages/cli/src/kete/job-standalone.ts` `KeteJobStandalone`:
  - `runtimeDirectory(env)`: base = `XDG_RUNTIME_DIR` when set and absolute, else `os.tmpdir()`
    (in a job: `TMPDIR` = `/var/lib/kete-job/kete/tmp`, kete's private dir; the entrypoint sets no
    `XDG_RUNTIME_DIR`). `mkdtemp(join(base, "kete-"))` (creates 0700), then `lstat` re-check
    (directory, owner = euid, `mode & 0o077 === 0`). Socket = `<dir>/s`; refuse when its byte
    length > 103 (same limit as the server; no TCP fallback, ever).
  - `command({ password, gatewayKey, socket, command? })` — **pure, exported for tests**:
    `ChildProcess.make(executable, [...args, "serve", "--stdio", "--socket", socket], { cwd,
    env: { KETE_JOB_SECRETS_FD: "3" } (public name, via `Brand.envPrefix`, like standalone.ts's
    password line), extendEnv: true, stdin: "pipe", stderr: as standalone.ts, killSignal SIGTERM,
    forceKillAfter 3 s, additionalFds: { fd3: { type: "input", stream: Stream.make(<UTF-8 JSON
    {"v":1,"password":…,"gateway_key"?:…}>) } } })`. The cross-spawn spawner writes the stream and
    ends the pipe (`util/src/cross-spawn-spawner.ts:171-185`, `endOnDone: true`).
  - `start({ gatewayKey })`: password `randomBytes(32).toString("base64url")`; make the dir; spawn;
    read the first stdout line (same Deferred/drain pattern as standalone.ts:39-62); decode
    `{url}`; **require** `url === "unix://" + socket` else fail; register a finalizer that removes
    `<dir>/s` (if present) and `rmdir`s the dir (not recursive). Returns
    `{ endpoint: { url: "http://localhost", auth: { type: "basic", username: "opencode", password } },
    socket, pid }`. Provided with `LayerNode.compile(CrossSpawnSpawner.node)` like standalone.ts.
- **Client:** `job.ts` builds the client with `baseUrl: "http://localhost"` and a fetch wrapper
  `fetch(request, { ...init, timeout: false, unix: socket })` in job mode (TCP path unchanged).
  Spike (planner, Bun 1.4.2): node:http on a unix path + Bun `fetch(…, { unix })` works, the server
  sees `Host: localhost` and the auth header. **Gotcha:** with `HTTP_PROXY` set, Bun still connects
  to the unix socket but sends an absolute-form request target (`http://localhost/api/…`); the
  e2e test runs with a bogus `HTTP_PROXY` to prove routing still works (step 12). The entrypoint
  sets only `HTTPS_PROXY`.

### 3. Secrets by descriptor
- **`kete job run` (parent)**, job mode, in a new `packages/cli/src/kete/job-preflight.ts`
  `KeteJobPreflight.run(deps)` (deps injected for tests: `dumpable`, `readDescriptor`, `hasAccount`,
  `env`), called first thing in `job.ts`'s handler when `KeteJobMode.enabled(process.env)`:
  1. `KeteDumpable.disable()` (§4); a failure → `refused` (exit 2) before anything is read.
  2. `KETE_JOB_GATEWAY_KEY_FD` (read as the bridged `OPENCODE_JOB_GATEWAY_KEY_FD`): when set,
     digits only, 3 ≤ n ≤ 1023; `fstat` type FIFO, socket or regular file (Go's `os.Pipe` is a
     FIFO; Bun's extra `"pipe"` is a socketpair — spike; a regular file is what tests can open);
     read to EOF with a 10 s timeout and a 4096-byte cap (+1 to detect overflow); **close the fd in
     every path**; the key must be 1–4096 bytes of printable ASCII `0x21–0x7e` (same bound as the
     entrypoint's claim check, `internal/platform/claim.go:113`). Delete the variable from
     `process.env`. Any failure → `refused` naming the variable, never the content.
  3. Delete `OPENCODE_GATEWAY_KEY`, `OPENCODE_PASSWORD`, `OPENCODE_SERVER_PASSWORD` from
     `process.env` (an env key is **ignored** in job mode, and must not reach the child).
  4. No descriptor key and no account (`KeteAccount.read(KeteAccount.defaults())` returns
     nothing) → `refused`: "Job mode: no gateway key — pass it with `KETE_JOB_GATEWAY_KEY_FD` or sign
     in." Returns `{ gatewayKey?: string }`.
- **Shared reader + holder:** new `packages/util/src/kete/job-secrets.ts` `KeteJobSecrets`:
  `gatewayKeyFdVariable`/`secretsFdVariable` (`OPENCODE_JOB_GATEWAY_KEY_FD`,
  `OPENCODE_JOB_SECRETS_FD`), `readDescriptor(fd, { maxBytes, timeoutMs })` (the fstat/read/close
  logic above, async via `fs.createReadStream("", { fd, autoClose: true })` with a timer that
  destroys the stream), `validGatewayKey(text)`, and the **in-memory gateway key overlay**:
  `setGatewayKey(key)` (write-once; a second call throws) and `gatewayKey()`. It is process-scoped,
  written once before the server boots and read by the gateway plugin — the same lifetime as
  `process.env`, without being in `/proc/<pid>/environ` or inherited by children. This is the one
  piece of module state the design needs (CLAUDE.md §10): passing it through `ServerOptions` →
  routes → plugin registration would add several more upstream edits for no isolation gain.
- **`kete serve` child**, new `packages/cli/src/kete/job-serve.ts` `KeteJobServe.prepare(input,
  deps?)` (Effect), called from `server-process.ts` before `Env.password` is read:
  - Job mode off: `input.socket` set → fail (D1); otherwise return `undefined` (no change).
  - Job mode on: `process.platform === "win32"` → fail; mode must be `"stdio"`, `socket` set,
    `port`/`hostname` unset → else fail; `KeteDumpable.disable()` → failure fails; read
    `OPENCODE_JOB_SECRETS_FD` (must be set; delete it from `process.env`), `readDescriptor` (16 KiB
    cap), decode `{v:1, password: non-empty string, gateway_key?: valid key}` with Effect `Schema`;
    delete `OPENCODE_GATEWAY_KEY`/`OPENCODE_PASSWORD`/`OPENCODE_SERVER_PASSWORD` from
    `process.env`; `gateway_key` present → `KeteJobSecrets.setGatewayKey`; absent and no account →
    fail (defence in depth for the parent's check). Returns `{ password, socket }`.
- **Gateway** (`packages/core/src/kete/gateway.ts`, Kete-owned): where `load()` calls
  `configured(entries, environment, signedIn)`, pass `jobEnvironment(environment)` instead: when
  `KeteJobMode.enabled(environment)`, a copy with `[keyVariable]` set to
  `KeteJobSecrets.gatewayKey()` (or deleted when none) — so the env key is never used in job mode
  and the descriptor key behaves exactly like the env fallback (existing precedence kept: account >
  `providers.kete.settings.apiKey` > overlay; D2). Inject the getter through `make(options)`
  (`jobKey?: () => string | undefined`, default `KeteJobSecrets.gatewayKey`) so tests don't touch
  the write-once holder. Update the file's header comment.

### 4. Non-dumpable (`prctl(PR_SET_DUMPABLE, 0)`)
- New `packages/cli/src/kete/dumpable.ts` `KeteDumpable.disable(platform = process.platform,
  prctl = linuxPrctl)`: returns `{kind:"ok"} | {kind:"unsupported"} | {kind:"failed", errno}`.
  Non-Linux → `unsupported` (no-op; job mode is Linux-only, macOS tests still run). Linux:
  `dlopen` the musl libc `/lib/libc.musl-${arm64 ? "aarch64" : "x86_64"}.so.1` when it exists,
  else `libc.so.6` (copy the selection from `core/src/util/process-lock-ffi.bun.ts:30-34`), symbols
  `prctl: { args: ["i32","u64","u64","u64","u64"], returns: "i32" }` and `__errno_location`;
  `prctl(4 /*PR_SET_DUMPABLE*/, 0, 0, 0, 0)`; non-zero → `failed` with errno; **read back**
  `prctl(3 /*PR_GET_DUMPABLE*/, 0,0,0,0)` must return `0`, else `failed` (errno 0); `close()` the
  library in `finally`. Lives in `cli` (Bun-only binary), not `util` (util is imported by non-Bun
  consumers; a static `bun:ffi` import there would break them).
- **Called in both processes before any secret is read:** the parent in `KeteJobPreflight.run`
  step 1 (before the key fd); the child in `KeteJobServe.prepare` (before the secrets fd).
  `unsupported` is fine; `failed` refuses to start (parent: `refused` exit 2; child: `prepare`
  fails → no ready line → the parent reports `error`, exit 1).
- Side effect to remember: after this, `/proc/<pid>/environ`, `/proc/<pid>/fd` of the process are
  readable only by root (`status` and `cmdline` stay world-readable). The tests account for it
  (step 12); kete's own `/proc/self` access is unaffected (same-task checks).

### 5. Auth hardening
- **Constant time:** new `packages/server/src/kete/constant-time.ts` `KeteConstantTime.equal(given,
  expected)`: pure JS over UTF-8 bytes (no `node:crypto`, so the workerd profile keeps working):
  `diff = g.length ^ e.length`, loop over every byte of `expected` OR-ing `e[i] ^ (g[i] ?? 0)`,
  return `diff === 0`. `ServerAuth.authorized` (`server/src/auth.ts:33`) uses it for the password
  (marked line). The username stays `===` (public constant). The only other secret comparison in
  server/cli source is `service-registration.ts:37` (comparing our own registration file, not a
  credential check) — unchanged. PTY tickets are map lookups, and PTY is refused in job mode.
- **`?auth_token=` in job mode:** `middleware/authorization.ts` `credentialFromRequest`: when the
  query token is present and `KeteJobMode.enabled(process.env)`, return the empty credential (so
  the request is unauthorized even if a valid Basic header is also present) — one marked line plus
  the import. Outside job mode unchanged.

### 6. Entrypoint (Go, `packages/kete-job-entrypoint`, Kete-owned)
- `internal/entry/entry_linux.go` `KeteEnvList`: drop `"KETE_GATEWAY_KEY=" + e.GatewayKey`, add
  `"KETE_JOB_GATEWAY_KEY_FD=3"`; refresh its comment (kete's own server is a unix socket now; still
  no `HTTP_PROXY`/`NO_PROXY`, every upstream is HTTPS).
- `StartKete`: `r, w, err := os.Pipe()`; write `e.GatewayKey` to `w` (≤ 4096 bytes < pipe
  capacity, so it can't block), close `w`; `launch.Options{…, Extra: []*os.File{r}}` (fd 3 in the
  target — `launch_linux.go:26,66,71`; stage 2 keeps fds below the spec fd open,
  `stage2_linux.go:102`); `defer r.Close()` so the parent's copy closes after `Start`. An empty key
  is an error (claim validation already guarantees non-empty).
- `internal/itest/fakekete/main.go`: replace the `KETE_GATEWAY_KEY` presence check with: env
  `KETE_GATEWAY_KEY` must be **absent** (`env-leak:KETE_GATEWAY_KEY`), `KETE_JOB_GATEWAY_KEY_FD`
  must be `"3"`, fd 3 reads (to EOF, ≤ 4097 bytes) a non-empty printable key, then close it.
- `internal/itest/scenarios_test.go` TestCredentials: the environ scan now covers all four tokens
  (`i < 3` → every token, i.e. the gateway key may appear in **no** environ, kete's included);
  keep the stderr/disk checks.
- The egress firewall needs no change: unix sockets aren't filtered by nftables, and port A stays
  the only TCP port the `kete` uid reaches.
- Docs: `README.md` "Environments" (`:154-169`, the `kete` env list), "Credentials" row (`:192`:
  memory → pipe → `kete`'s fd 3 → read once and closed), "Launching" (`:238-245`: the key pipe is
  `Extra` fd 3).

## Files
| File | Read / change | Why |
|---|---|---|
| `packages/server/src/process.ts` | change (upstream, 2 marked lines) | import `KeteSocketListen`; `bound` uses it when `options.socket` is set (`:58`); read `bind` `:151-165` to copy its scope handling |
| `packages/server/src/options.ts` | change (upstream, 1 marked line) | `socket: Schema.optional(Schema.String)` in `ServerOptions` |
| `packages/server/src/auth.ts` | change (upstream, 2 marked lines) | constant-time password compare (`:33`) |
| `packages/server/src/middleware/authorization.ts` | change (upstream, 2 marked lines) | refuse `?auth_token=` in job mode (`:32-33`) |
| `packages/server/src/kete/socket-listen.ts` | create | `KeteSocketListen.bind(path)` (§1) |
| `packages/server/src/kete/constant-time.ts` | create | `KeteConstantTime.equal` (§5) |
| `packages/cli/src/server-process.ts` | change (upstream, marked block) | `Options.socket`; call `KeteJobServe.prepare` before `Env.password` (`:73`); `password` from it when set (`:79`); pass `socket` to `start` (`:88-97`) |
| `packages/cli/src/commands/commands.ts` | change (upstream, 1 marked line) | serve `socket` flag (`:520-529`) with a description saying job mode only |
| `packages/cli/src/commands/handlers/serve.ts` | change (upstream, 1 marked line) | pass `socket: Option.getOrUndefined(input.socket)` |
| `packages/cli/src/kete/dumpable.ts` | create | `KeteDumpable.disable` (§4) |
| `packages/cli/src/kete/job-serve.ts` | create | `KeteJobServe.prepare` (§3, child side) |
| `packages/cli/src/kete/job-preflight.ts` | create | `KeteJobPreflight.run` (§3, parent side) |
| `packages/cli/src/kete/job-standalone.ts` | create | `KeteJobStandalone` runtime dir, `command`, `start` (§2) |
| `packages/cli/src/kete/job.ts` | change | job mode: preflight first; `KeteJobStandalone.start` instead of `ServerConnection.resolve`; unix fetch wrapper; a start failure → `error` result (exit 1), printed like `refusedResult` |
| `packages/cli/src/kete/job-connection.ts` | change (comment only) | header now says the job-mode child is the Kete socket standalone |
| `packages/cli/src/kete/job-run.ts` | read | `Result`/`Outcome` (`:136-185`) for the error result shape |
| `packages/cli/src/services/standalone.ts` | read | pattern to mirror (`:19-66`); not edited |
| `packages/cli/src/util/process.ts` | read | `selfCommand()` |
| `packages/cli/src/env.ts` | read | `Env.password` names |
| `packages/util/src/kete/job-secrets.ts` | create | descriptor reader, key validation, gateway key overlay (§3) |
| `packages/util/src/kete/job-mode.ts` | read | `enabled`, `message` wording style |
| `packages/util/src/kete/env.ts` | read | the `KETE_`→`OPENCODE_` bridge (why the child gets `KETE_JOB_SECRETS_FD`) |
| `packages/util/src/kete/account.ts` | read | `KeteAccount.read`/`defaults` for the no-key check |
| `packages/util/src/cross-spawn-spawner.ts` | read `:130-210` | how `additionalFds` input pipes are written/ended |
| `packages/core/src/util/process-lock-ffi.bun.ts` | read | libc selection and errno pattern |
| `packages/core/src/kete/gateway.ts` | change | job-mode environment overlay in `load()`; `make({ jobKey })`; header comment (§3). Also check whether the first discovery is awaited before the plugin is ready (affects step 12's flakiness) |
| `packages/core/src/models-dev.ts` | read | the `models.json` shape for the e2e fixture |
| `packages/core/test/kete/job-spawn-sites.test.ts` | change | classify `cli/src/kete/job-standalone.ts` as `self` (it matches `ChildProcess.make(`/`LayerNode.compile(` + `CrossSpawnSpawner`) |
| `packages/core/test/kete/gateway.test.ts` | change | AC2 key precedence in job mode |
| `packages/util/test/kete/job-secrets.test.ts` | create | reader/validation/holder |
| `packages/cli/test/kete/dumpable.test.ts` | create | AC3 |
| `packages/cli/test/kete/job-preflight.test.ts` | create | AC2/AC3 parent refusals and ordering |
| `packages/cli/test/kete/job-serve.test.ts` | create | AC1/AC2/AC3/AC5 child prepare rules |
| `packages/cli/test/kete/job-standalone.test.ts` | create | AC1/AC2 pure command, runtime dir, ready-line check |
| `packages/cli/test/kete/job-socket.subprocess.test.ts` | create | AC1–AC3 real processes (self-contained, §Tests) |
| `packages/cli/test/kete/cli.test.ts` | read | `Bun.spawn` of `src/index.ts` pattern (`:20-48`) |
| `packages/cli/test/acp/subprocess.ts` | read `:72-135` | fake LLM server + `KETE_MODELS_PATH` fixture + SSE helper pattern |
| `packages/server/test/process.test.ts`, `packages/server/test/fixture/server.ts` | read | how `ServerProcess.start` is tested (for the socket test) |
| `packages/server/test/kete/job-run.test.ts` | read | a valid job spec/policy for the e2e |
| `packages/server/test/kete/socket-listen.test.ts` | create | AC1 server side |
| `packages/server/test/kete/job-auth.test.ts` | create | AC4 (query token, constant-time helper) |
| `packages/kete-job-entrypoint/internal/entry/entry_linux.go` | change | `KeteEnvList`, `StartKete` (§6) |
| `packages/kete-job-entrypoint/internal/launch/launch_linux.go`, `stage2_linux.go` | read | `Extra` fds semantics |
| `packages/kete-job-entrypoint/internal/itest/fakekete/main.go` | change | key by fd 3, env key absent (§6) |
| `packages/kete-job-entrypoint/internal/itest/scenarios_test.go` | change | TestCredentials scans the gateway key in every environ |
| `packages/kete-job-entrypoint/README.md` | change | Environments, Credentials, Launching |
| `docs/jobs.md` | change | "Job mode" env table (`:162-164`): `KETE_JOB_GATEWAY_KEY_FD`, `KETE_GATEWAY_KEY` ignored in job mode, the socket server, non-dumpable, `?auth_token` refused |
| `docs/context/contracts.md` | change | §6d: the key by fd 3, no `KETE_GATEWAY_KEY` |
| `docs/upstream-patches.md` | change | new section "Job mode, piece A1 (feature/job-socket-server)": the 7 upstream files, why no seam, sync checklist |

## Steps
1. **Spikes already done by the planner (Bun 1.4.2, macOS):** node:http listens on a unix path
   and Bun `fetch(…, { unix })` reaches it (Host `localhost`, auth header kept; mkdtemp dir 0700;
   socket created 0755 under umask → hence the chmod); Bun's node:child_process extra `"pipe"` at
   index 3 arrives as a **socket** and reads to EOF; `Bun.spawn` with a numeric fd at `stdio[3]`
   passes a regular file. If any of these fails on Linux, stop and write to handoff.md.
2. `util/src/kete/job-secrets.ts` + `util/test/kete/job-secrets.test.ts` (fd parsing; fstat type
   refusal for a directory/tty; empty, oversize, non-printable keys refused; fd closed after read,
   success and failure — assert `fs.fstatSync(fd)` throws `EBADF`; timeout with a FIFO whose writer
   stays open, Linux/macOS via `mkfifo`; holder write-once).
3. `cli/src/kete/dumpable.ts` + `cli/test/kete/dumpable.test.ts`.
4. `server/src/kete/socket-listen.ts`, `server/src/kete/constant-time.ts`; the marked edits in
   `server/src/options.ts`, `process.ts`, `auth.ts`, `middleware/authorization.ts`; tests
   `server/test/kete/socket-listen.test.ts`, `job-auth.test.ts`.
5. `cli/src/kete/job-serve.ts`; marked edits in `cli/src/server-process.ts`,
   `commands/commands.ts`, `commands/handlers/serve.ts`; `cli/test/kete/job-serve.test.ts`.
6. `cli/src/kete/job-standalone.ts`, `job-preflight.ts`; `job.ts` wiring; tests.
7. `core/src/kete/gateway.ts` overlay + test.
8. `core/test/kete/job-spawn-sites.test.ts` row for `job-standalone.ts`.
9. Go: entrypoint, fakekete, TestCredentials, README.
10. Docs: `docs/jobs.md`, `contracts.md` §6d, `docs/upstream-patches.md`.
11. Narrow checks per step (Verification), then package checks.
12. `cli/test/kete/job-socket.subprocess.test.ts` (see Tests) and its Linux container run.
13. `upstream:check`, lint, `verify --base main`; record results and evidence per AC in result.md.

## Tests per AC
- **AC1 (socket, 0700, session, no TCP):**
  - `server/test/kete/socket-listen.test.ts` (skipped on win32): `bind` in a mkdtemp dir; a
    request over `fetch(…, { unix })` is served; `server.address()` is a string and
    `formatAddress` is `unix://<path>`; socket mode 0600; a stale socket at the path is replaced;
    a regular file at the path → refused, file intact; dir `chmod 0755` → refused; relative path
    and a > 103-byte path → refused. One `ServerProcess.start({ socket, password, … })` case using
    the `server/test/process.test.ts` fixture: `/api/info` over the socket needs the password.
  - `cli/test/kete/job-serve.test.ts`: off + socket → refused; on without socket, with `--port`,
    in `default`/`service` mode → refused (no TCP in job mode).
  - `cli/test/kete/job-standalone.test.ts`: `command()` args contain `--socket <path>` and no
    `--port`; runtime dir 0700 under `XDG_RUNTIME_DIR` else tmpdir; a too-long base → refused;
    a ready line with another URL → refused.
  - `cli/test/kete/job-socket.subprocess.test.ts` (real processes; **imports only `bun:test` and
    `node:*`** so it runs anywhere): a temp git repo (`git init`, a commit, `spec.branch`), an
    isolated HOME/XDG, `KETE_MODELS_PATH` → an inline `models.json` with one model of a catalog
    provider the gateway routes (e.g. `deepseek` for `/compat/deepseek/v1`; read `gateway.ts`
    `routes` and `models-dev.ts`), a fake gateway `Bun.serve` on `127.0.0.1:0` serving
    `GET …/models` and `POST …/chat/completions` (OpenAI-chat SSE, copied inline from
    `cli/test/acp/subprocess.ts`), `KETE_JOB_MODE=1`, `KETE_JOB_MAX_OUTPUT_TOKENS`,
    `KETE_GATEWAY_URL`, a bogus `HTTP_PROXY`, `KETE_GATEWAY_KEY=env-key-must-be-ignored`, and the
    real key on fd 3 (`Bun.spawn` `stdio: ["ignore","pipe","pipe", fd]` of a 0600 temp file).
    Command: `JOBSOCK_E2E_BIN` (not a `KETE_*` name) when set, else `[process.execPath, "run",
    <cli>/src/index.ts]` with `cwd` = `packages/cli`. The fake gateway **holds the model
    response** until the test has sampled the processes. Asserts: outcome `completed`, a
    `session_id`; the gateway saw `Bearer <fd key>` and never the env key. **Linux only:** find the
    serve child by scanning `/proc/*/stat` for ppid = the job run pid; its `cmdline` has
    `--socket <dir>/s`, `<dir>` is 0700 and owned by us, `<dir>/s` is a socket; **no TCP
    listener**: as root, no `socket:[inode]` in `/proc/<pid>/fd` of either pid matches a LISTEN
    (`0A`) row of `/proc/net/tcp{,6}`; as non-root (fd dirs unreadable once non-dumpable), the
    LISTEN rows owned by our uid during the run equal those before it, plus only the fake gateway's
    port. After the run, `<dir>` is gone.
  - Second case: no fd, no account, `KETE_GATEWAY_KEY` set → `refused`, exit 2 (env key ignored).
- **AC2 (no env, no log):** `job-standalone` `command()` env has `KETE_JOB_SECRETS_FD` and no
  `PASSWORD`/`GATEWAY_KEY` name, and the secrets only in `fd3`; `job-preflight` deletes the env
  names and closes the fd; `job-serve` deletes them in the child; gateway test: job mode + env key
  + no overlay → no key; job mode + overlay → overlay; off → env key (unchanged). Subprocess test:
  the key string appears in neither process's stdout/stderr (run with `KETE_PRINT_LOGS=1` so the
  child's logs are captured) nor any file under the isolated XDG dirs; **as root on Linux**,
  `/proc/<pid>/environ` of both pids contains neither the key nor `KETE_GATEWAY_KEY`/`PASSWORD`
  names (non-root can't read it after prctl — the test logs that it skipped this part). Go:
  fakekete + TestCredentials (root, every environ).
- **AC3 (non-dumpable):** `dumpable.test.ts`: Linux — a child `bun` process calls `disable()` and
  prints `PR_GET_DUMPABLE`; the parent reads `/proc/<child>/status` `Dumpable:\t0`; non-Linux →
  `unsupported`; an injected `prctl` returning -1 → `failed` with errno; returning 0 but read-back
  1 → `failed`. `job-preflight.test.ts`/`job-serve.test.ts`: a failing `dumpable` dep refuses
  **before** the descriptor is read (the injected reader is never called). Subprocess test on
  Linux: both pids' `/proc/<pid>/status` show `Dumpable:\t0`.
- **AC4:** `server/test/kete/job-auth.test.ts`: `authorizedRequest` with a correct
  `?auth_token=` → true when off, false in job mode (set/restore `process.env.OPENCODE_JOB_MODE`),
  also false with a correct Basic header plus the token; Basic alone still true in job mode;
  `KeteConstantTime.equal` cases (equal, different, prefix, longer, empty, non-ASCII). Existing
  upstream auth tests keep passing.
- **AC5:** existing suites unchanged and green (server and cli full suites include `serve`,
  standalone, service and the ACP subprocess tests); plus a `cli.test.ts`-style spawn of `kete
  serve --socket /tmp/x` without job mode → non-zero exit and the "job mode only" message.
- **AC6:** entrypoint unit + integration suites (13/13) in the `golang:1.26-bookworm` container.
- **AC7:** typecheck/lint/upstream:check/verify; `check:generated` in protocol and client shows
  no drift.

### Linux runs (≈ 3.5 GB free: no new image pulls)
- **CI:** `kete-build.yml` (ubuntu-latest, non-root) already runs `bun test test/kete` in
  `packages/cli`, `util`, `server` — the Linux branches of `dumpable.test.ts`, the subprocess test
  (non-root subset: session over the socket, `Dumpable: 0`, the uid-filtered TCP check) run there
  automatically. After the coordinator pushes: `gh workflow run kete-build.yml --repo
  kete-org/ketecode --ref feature/job-socket-server` (or the PR run).
- **Local, as root, for the root-only AC1/AC2 checks** — reuse the local `golang:1.26-bookworm`
  image (Colima is aarch64), a Linux Bun binary in the scratchpad (~95 MB) and a cross-built `kete`
  (~100–150 MB); the self-contained test file is copied out of the repo so `packages/cli`'s
  `bunfig.toml` preload (`@opentui/solid/preload`) and macOS `node_modules` are not involved:
  ```sh
  S=<scratchpad>
  curl -fsSL -o $S/bun.zip https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-aarch64.zip && unzip -oq $S/bun.zip -d $S
  (cd packages/cli && bun run build --target=kete-linux-arm64 --skip-install --skip-web-ui)
  mkdir -p $S/e2e && cp packages/cli/test/kete/job-socket.subprocess.test.ts $S/e2e/
  docker run --rm -v $S/bun-linux-aarch64:/opt/bun:ro -v "$PWD/packages/cli/dist/cli-linux-arm64/bin:/opt/kete:ro" \
    -v $S/e2e:/work -w /work -e JOBSOCK_E2E_BIN=/opt/kete/kete golang:1.26-bookworm /opt/bun/bun test ./job-socket.subprocess.test.ts
  ```
  Delete `$S/bun*`, `$S/e2e` and `packages/cli/dist/` afterwards. If the cross build fails for
  lack of a Linux native package, record it in handoff.md and rely on CI for the non-root subset —
  do not `bun install` other platforms (disk).

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `packages/server`: `bun run test ./test/kete/socket-listen.test.ts`; `packages/cli`: `bun test ./test/kete/job-serve.test.ts ./test/kete/job-standalone.test.ts ./test/kete/job-socket.subprocess.test.ts`; Linux root run above |
| AC2 | `packages/util`: `bun test ./test/kete/job-secrets.test.ts`; `packages/cli`: `bun test ./test/kete/job-preflight.test.ts ./test/kete/job-standalone.test.ts ./test/kete/job-socket.subprocess.test.ts`; `packages/core`: `bun run test ./test/kete/gateway.test.ts`; Linux root run; AC6's TestCredentials |
| AC3 | `packages/cli`: `bun test ./test/kete/dumpable.test.ts ./test/kete/job-preflight.test.ts ./test/kete/job-serve.test.ts`; Linux: CI + root run |
| AC4 | `packages/server`: `bun run test ./test/kete/job-auth.test.ts`, then `bun run test ./test/auth.test.ts` |
| AC5 | `packages/server`: `bun run test`; `packages/cli`: `bun run test`; `packages/core`: `bun run test ./test/kete/job-spawn-sites.test.ts` |
| AC6 | `docker run --rm -v "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-bookworm sh -c 'test -z "$(gofmt -l .)" && go vet ./... && go vet -tags integration ./... && go test -race ./...'` (with the `kete-egress-gomod`/`kete-egress-gocache` volumes), then `docker run --rm --privileged --cgroupns=private -v "$PWD/packages:/src" -w /src/kete-job-entrypoint golang:1.26-bookworm bash scripts/integration.sh` → 13/13 |
| AC7 | `bun run typecheck` in util, core, server, cli; `bun run lint` (root); `bun run --cwd packages/kete-tools upstream:check`; `bun run check:generated` in `packages/protocol` and `packages/client` (expect no drift); `bun run --cwd packages/kete-tools verify --base main` |

## Upstream edits (all `kete_change`-marked; record in `docs/upstream-patches.md`)
| File | Edit | Why no seam |
|---|---|---|
| `server/src/options.ts` | `socket` field | `ServerOptions` is the only way options reach `ServerProcess.start` |
| `server/src/process.ts` | import + `bound` picks `KeteSocketListen.bind` | `listen`/`bind` are private and TCP-only; no listener injection point |
| `server/src/auth.ts` | import + constant-time password compare | the comparison itself is the defect |
| `server/src/middleware/authorization.ts` | import + query token ignored in job mode | the credential extraction is private to this file |
| `cli/src/server-process.ts` | `Options.socket`, `KeteJobServe.prepare` block, password source, `socket` passed to `start` | the password is read and the server started inside `processEffect`; no hook between |
| `cli/src/commands/commands.ts` | serve `--socket` flag | the approved interface; serve's Spec is upstream |
| `cli/src/commands/handlers/serve.ts` | pass `socket` | maps flags to `ServerProcess.run` |
Not edited: `cli/src/services/standalone.ts` (Kete sibling instead, §2).

## Decisions for the user
- **D1** `kete serve --socket` is refused outside job mode (smallest new surface; AC5 stays
  trivially true). Alternative: allow it everywhere on Unix (a new general CLI contract).
- **D2** In job mode the descriptor key replaces only the environment fallback (existing order:
  account > `providers.kete.settings.apiKey` > key); the env key is always ignored. Alternative:
  descriptor first, ignoring account/config in job mode. Recommended: as planned (a job's kete home
  is fresh; minimal change). A2 (sync from the gateway key) may revisit.
- **D3** Socket directory base: `XDG_RUNTIME_DIR` if set, else `TMPDIR` (kete's private
  `/var/lib/kete-job/kete/tmp` in a job). No entrypoint change needed.
- **D4** Password and key reach the serve child together as one JSON message on fd 3
  (`KETE_JOB_SECRETS_FD=3`, internal, not a contract), not two descriptors.
- **D5** Root-only `/proc` checks (environ, fd inodes) run locally in the existing
  `golang:1.26-bookworm` image with a cross-built `kete`; CI runs the non-root subset. Alternative:
  a `sudo` step in `kete-build.yml` (workflow change, actionlint).
- **D6** Descriptors may be a FIFO, a socket or a regular file (Bun's extra pipe is a socketpair;
  tests use a file); anything else is refused.

## Risks
- Bun-on-Linux behaviour of the extra-fd pipe and `fetch({unix})` is spiked on macOS only
  (step 1; CI and the root run confirm).
- The subprocess e2e depends on the gateway's first discovery finishing before the session's
  first step; check in `gateway.ts` whether it's awaited, otherwise wait in the test for the fake
  gateway's `GET …/models` before expecting the model request.
- A process-scoped key holder is module state (justified in §3); keep it write-once.

## Cards to update after the build
- job-mode (socket server, descriptors, dumpable, auth_token, refusals; replace the "TCP loopback"
  and "gateway key by environment variable" Quick answers)
- server-sdk (socket listener, `ServerOptions.socket`, constant-time auth, query-token rule;
  `paths` + `server/src/kete/{socket-listen,constant-time}.ts`)
- cli (`--socket`, `KeteJobStandalone`, `KeteJobPreflight`, `KeteJobServe`, `KeteDumpable`)
- gateway (job-mode overlay; refresh the old `verified-at`)
- job-entrypoint (key by fd 3, Credentials, Rules; refresh stale)
- root-helper (refresh stale only)
- contracts.md §6d (done in the build), pitfalls.md: non-dumpable makes `/proc/<pid>/environ` and
  `/fd` root-only; `HTTP_PROXY` turns unix fetches into absolute-form requests
