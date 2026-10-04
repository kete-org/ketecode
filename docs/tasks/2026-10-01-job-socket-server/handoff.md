# Handoff: Job mode piece A: kete's server on a unix socket with a per-run secret, and the gateway key by descriptor

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-01 scout

(Summary pasted by the coordinator.)

- Q1 → docs enough: no — missing: unix-socket server/client (server-sdk). `kete job run` → `Standalone.start()` spawns `kete serve --stdio --port 0` with `CrossSpawnSpawner` directly (`cli/src/services/standalone.ts:19-61`), password `randomBytes(32)` via `KETE_PASSWORD`, ready line `{"url":…}`. TCP assumed in `server/src/process.ts` `listen`/`bind` (`:142-165`), `cli/src/server-process.ts` options (`:23-28`), `serve` flags (`commands.ts:518-529`), `ServerOptions.port`. Effect `NodeHttpServer` accepts `path`; `formatAddress` gives `unix://…`; Bun `fetch(…, { unix })` verified (streaming, auth header, Host: localhost). The client needs an `http://localhost` base URL plus a fetch wrapper with `unix:`. Gotchas: socket perms come from the 0700 dir; `sun_path` ≈ 108 bytes; unlink stale sockets; other `Standalone.start()` users keep TCP.
- Q2 → docs enough: no — missing: server auth (server-sdk). Basic `opencode:<password>` (`server/src/auth.ts`, `===`, not constant-time), also `?auth_token=` (`middleware/authorization.ts:30-36`), PTY ticket bypass (PTY off in jobs). The standalone password is already per-run (32 random bytes) but travels by env (`/proc/<pid>/environ`).
- Q3 → docs enough: no — missing: runtime self-connections (server-sdk / job-mode). Only the `kete job run` client talks to the server in a job; PTY and WebSocket are already replaced/refused.
- Q4 → docs enough: no — missing: sync with only a gateway key (sync), launcher extra fds (job-entrypoint). Key read in `core/src/kete/gateway.ts:40,134-141,418-441` (`OPENCODE_GATEWAY_KEY`); used for models, pricing, balance, requests. Sync and registration need an account file — sync from the key (§8 item 6) is NOT implemented. Entrypoint passes `KETE_GATEWAY_KEY` env (`entry_linux.go:196-219`); its launcher supports `Extra` fds (fd 3+). Plan: fd 3 pipe → `kete job run` reads once → forwards to the serve child via `additionalFds` → a util module feeds `KeteGateway`'s environment overlay.
- Q5 → docs enough: no — missing: dumpable semantics (job-mode). exec resets dumpable, so `kete` must `prctl(PR_SET_DUMPABLE,0)` itself in both processes via `bun:ffi` libc (precedent `core/src/util/process-lock-ffi.bun.ts:30-34`). Still undone: `openat2` for kete's own files, the entrypoint-owned audit/result sink, sync from the gateway key.

## 2026-10-01 coordinator

- spec.md approved by the user (2026-10-01). Split chosen: A1 (this task) → A2 sync from the gateway key → image PR 2 → A3 openat2 + audit sink.
- Tooling: no Go on the Mac (Docker/Colima, golang:1.26-bookworm, cache volumes kete-egress-gomod/kete-egress-gocache); disk is tight (~5 GB free) — pull nothing large. Build with a general-purpose agent following implementer.md (the implementer agent type has no shell). Before any PR: actionlint on changed workflows; check every CI check on the final commit before merging.

## 2026-10-01 planner

- plan.md written (Large: 7 marked upstream edits, security, entrypoint ↔ runtime contract change).
- Stale cards: `job-entrypoint` (only `internal/itest/scenarios_test.go`, a proxy-failure test retry)
  and `root-helper` (unique cgroup leaf names, README/itest) — checked the diffs, nothing this plan
  relies on; planned anyway. The librarian must refresh both at close.
- Docs enough: no — missing: server-sdk — how `ServerProcess.start` listens (`server/src/process.ts`
  `listen`/`bind` `:142-165`, TCP-only, private) and where `kete serve`'s password comes from
  (`cli/src/server-process.ts:73-85`, `Env.password`).
- Docs enough: no — missing: server-sdk — the auth path: `server/src/auth.ts:29-35` (`===`),
  `middleware/authorization.ts:30-37` (`?auth_token=` decoded before the Basic header), the PTY
  ticket bypass (`process.ts:192-196`, `authorization.ts:53-54`).
- Docs enough: no — missing: cli — `kete serve`'s flags live in `commands/commands.ts:520-529` and
  map to `ServerProcess.run` in `commands/handlers/serve.ts`; the standalone child is spawned by
  `services/standalone.ts:19-66` (CrossSpawnSpawner, `KETE_PASSWORD` env, ready line).
- Docs enough: no — missing: gateway — the card doesn't say `make({ environment })` captures
  `process.env` and that `configured()` is the single key-resolution point (`gateway.ts:418-441`).
- Docs enough: no — missing: job-entrypoint — `launch.Options.Extra` becomes fds 3.. in the target
  (`launch_linux.go:26,66,71`; stage 2 keeps them open, `stage2_linux.go:102`).
- Docs enough: yes — job-mode (flag semantics, `KeteJobServer`, spawn-sites test), cli (job.ts
  flow, import boundaries), process-lock FFI precedent (from the scout's Q5 answer).
- Spikes run by the planner (scratchpad, Bun 1.4.2 macOS): node:http on a unix path + Bun
  `fetch({unix})` works (Host `localhost`; socket created 0755, dir 0700); with `HTTP_PROXY` set Bun
  sends an absolute-form target over the unix socket; Bun's node:child_process extra `"pipe"`
  arrives as a **socket** (not a FIFO); `Bun.spawn` passes a numeric fd at `stdio[3]`.
- Decisions D1–D6 in plan.md need the user's answer with the plan approval.

## 2026-10-01 coordinator

- plan.md approved by the user (2026-10-01): D2 CHANGED from the plan — in job mode the descriptor key is the ONLY gateway key; an account file and any configured apiKey are ignored (every model call metered on the job key); D1, D3–D6 at the planner defaults.

## 2026-10-01 implementer

**Status: built; checks STOPPED at the disk guard.** Free space fell from 3.2 GB to 1.2 GB during
the Linux runs (the Colima VM disk grew from the tar-streamed containers; the scratchpad binaries are
already deleted), below the coordinator's 1.5 GB stop line, so the package-wide checks below were
not run. Nothing committed or staged.

Done (plan steps 2–12, with D2 as changed: the descriptor key is the only gateway key in job mode):
- util: `src/kete/job-secrets.ts` (descriptor reader, key validation, write-once overlay) + test.
- cli: `src/kete/{dumpable,job-serve,job-preflight,job-standalone}.ts`; `job.ts` wiring
  (preflight first, socket standalone, unix fetch, start failure → `error` exit 1);
  `job-connection.ts` comment; tests `dumpable`, `job-serve`, `job-preflight`, `job-standalone`,
  `job-socket.subprocess`.
- server: `src/kete/{socket-listen,constant-time}.ts`; tests `socket-listen`, `job-auth`.
- core: `gateway.ts` job-mode key (no account read; `kete auth login`, config `apiKey` and env key
  ignored; `make({ jobKey })`); `gateway.test.ts` (+4); `job-spawn-sites.test.ts` row.
- Go: `entry_linux.go` (`KETE_JOB_GATEWAY_KEY_FD=3`, key on an `os.Pipe` as `Extra` fd 3, empty
  key refused), `fakekete` (fd 3 key, env key must be absent), `TestCredentials` (gateway key and
  `KETE_GATEWAY_KEY=` in no environ, root included), README.
- Docs: `docs/jobs.md` (env table + three bullets), `docs/upstream-patches.md` (new section).
- Upstream files (all marked): server `options.ts`, `process.ts`, `auth.ts`,
  `middleware/authorization.ts`; cli `server-process.ts` (start/end block + line markers),
  `commands/commands.ts`, `commands/handlers/serve.ts`.

Deviations / decisions:
- `readDescriptor` uses `Bun.file(fd).stream()` + cancel, not `fs.createReadStream` (plan §3):
  spike — a blocking threadpool read of a FIFO whose writer stays open can't be interrupted, so the
  plan's timeout hung forever; Bun's stream polls pipes/sockets and cancels (FIFO, socketpair and
  regular file all read; we close the fd ourselves). Guarded with `typeof Bun` (util has no Bun use).
- `dumpable.ts` loads `bun:ffi` with a lazy `require` so the Node build still bundles.
- `KeteJobServe.prepare` runs at the top of `processEffect` (before the service-mode incumbent
  check, not just before `Env.password`), so a job-mode service refuses before any TCP probing.
- **`/proc/<pid>/status` has no `Dumpable:` field** (plan AC3 test was wrong). Evidence used
  instead: non-root → `/proc/<pid>/environ` owned by uid 0; root without CAP_SYS_PTRACE → environ
  EACCES; root with it → the processes' own `PR_GET_DUMPABLE` read-back.
- Reading a non-dumpable process's environ needs CAP_SYS_PTRACE even as root (docker drops it):
  the root environ check runs only with `--cap-add=SYS_PTRACE`.
- `/proc/<pid>/environ` is the exec-time environment: the parent `kete job run` still shows a
  `KETE_GATEWAY_KEY` its caller passed (deleting from `process.env` doesn't rewrite it). It is
  ignored and not forwarded (the serve child's environ has none); the entrypoint no longer sets it.
- Source-mode e2e runs the CLI from the job's cwd, so it passes the package bunfig through
  `BUN_OPTIONS=--config=…` (inherited by the serve child).
- `docs/context/contracts.md` §6d NOT edited (implementer rule: never edit docs/context) — the
  librarian must add: key by fd 3 (`KETE_JOB_GATEWAY_KEY_FD`), no `KETE_GATEWAY_KEY`, socket server.

Results (real counts):
- util `bun test ./test/kete/job-secrets.test.ts`: 17 pass, 0 fail.
- cli `bun test ./test/kete/dumpable.test.ts`: 5 pass, 1 skip (Linux) on macOS;
  `job-serve`: 9 pass; `job-preflight` + `job-standalone`: 15 pass;
  `job-socket.subprocess` (macOS, source mode): 3 pass.
- server `bun run test ./test/kete/socket-listen.test.ts ./test/kete/job-auth.test.ts`: 16 pass;
  `./test/auth.test.ts ./test/process.test.ts`: 2 pass.
- core `bun run test ./test/kete/gateway.test.ts`: 19 pass; `job-spawn-sites`: 4 pass.
- typecheck: server PASS, cli PASS (after steps 4/6); util and core not run separately.
- Go (golang:1.26-bookworm): gofmt clean, `go vet` (+ integration tag) clean, `go test -race ./...`
  all ok; integration suite 13/13, 13/13, 13/13 (3 runs).
- Linux e2e (cross-built `kete-linux-arm64` + Linux Bun 1.4.2, `JOBSOCK_E2E_BIN`): root with
  SYS_PTRACE 9/9, root without 9/9, non-root (nobody) 9/9 (subprocess 3 + dumpable 6).

NOT run (disk guard): full `bun run test` in cli and server, `bun run test` (all Kete) in core,
`bun test ./test/kete` in util; `bun turbo typecheck`/util+core typecheck; root `bun run lint`;
`upstream:check`; `check:generated` in protocol/client (no endpoint/schema exposed changed —
`ServerOptions` is not in the protocol, the serve flag is CLI-only — expected no drift);
`verify --base main`. Formatting (prettier) of the new files not checked.

## 2026-10-01 implementer (review fixes)

Findings → fixes (no commit, nothing staged):
1. MAJOR gateway URLs: `core/src/kete/gateway.ts` `configured` — with `job`, url/platform come only
   from `OPENCODE_GATEWAY_URL`/`OPENCODE_PLATFORM_URL` (the entrypoint's KETE_GATEWAY_URL /
   KETE_PLATFORM_URL, `entry_linux.go:217-218`); `providers.kete.settings.baseURL` and
   `kete.platform.url` ignored. Header comment updated. Tests: `configured` job case (config URLs
   ignored, none without env), the plugin D2 test now points the config baseURL at a dead port and
   the env URL at the gateway, and a new plugin test: config baseURL only → no requests, no provider.
2. `util/src/kete/job-secrets.ts`: the Bun reader is created inside the `try`; `finally` cancels it
   if it exists and always closes the fd.
3. `cli/src/kete/job-standalone.ts`: child stderr is piped, forwarded to our stderr (the VM's kete
   log in a job) and its last line (≤ 300 chars) appended to "exited before reporting readiness".
   Test: a child that prints a refusal and exits → the error carries it, no key, dir removed.
4. `cli/src/kete/job.ts`: explicit guard — in job mode without a started socket server, `error`
   result; `ServerConnection.resolve` is never reached.
5. `job-standalone.ts` `checkRuntimeBase`: base must exist, be a directory, and not be group/world
   writable unless sticky. Test: 0777 and 0775 refused, 1777 and 0755 accepted, missing refused.
6. `job-standalone.ts`: `error as Error` → `instanceof Error ? error : new Error(String(error))`.
7. `kete-job-entrypoint/internal/itest/scenarios_test.go` TestCredentials: an EACCES/EPERM reading
   a (still present) non-root process's environ is recorded as a leak (test fails), not skipped.

Re-run (real counts): typecheck util/core/cli/server PASS; Kete tests util 162 pass, cli 156 pass
1 skip, core 249 pass, server 37 pass 1 skip; core gateway.test 20 pass; job-standalone 11 pass;
macOS e2e 3 pass; Go gofmt/vet clean, unit all ok, integration 13/13 (1 run); Linux container e2e
(cross-built binary) 9/9 as root+SYS_PTRACE, root, non-root; lint 0 warnings/errors;
upstream:check passed. Scratch binaries deleted. Not re-run: `verify --base main`.
