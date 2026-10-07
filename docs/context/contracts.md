# Contracts with kete-code-platform

Every wire contract this repo shares with `kete-code-platform`. The **platform's copy is
always the source of truth**; the copies under `docs/platform/` are mirrors taken at a
named platform commit. Released contracts change **additively only** (new optional
fields/endpoints) or via a new version (`/api/v2`, a new doc file); never by breaking an
existing field or status code. When the platform changes a contract: re-copy its file
into `docs/platform/`, diff against the previous copy, and update every client below in
the same PR.

## 1. CLI login (v1)

- **Doc:** `docs/platform/cli-login-v1.md:1-16` — taken from `kete-code-platform` at
  commit `cb4ae82` (2026-09-25); source files listed there (`apps/portal/lib/cli-login.ts`,
  `packages/shared/src/api/v1/cli.ts`, `packages/shared/src/api/v1/errors.ts`,
  `apps/portal/lib/platform-api/handlers.ts`).
- **Client:** `packages/cli/src/kete/cli-login.ts` — PKCE (`pkce`, `challengeFor`,
  `state`, :19-32), device name shaping (`deviceName`, :35-38), platform URL
  validation (`LoginError`, :43-49), loopback callback listener and the
  `/api/v1/cli/*` calls. Secrets (verifier, code, key) never reach logs or errors
  (:5-6).
- **Relies on:** the CLI implements PKCE exactly as the platform's authorize endpoint
  expects (parameter shapes in `docs/platform/cli-login-v1.md` §2); the platform relies
  on the CLI never leaking the verifier or key.
- **Change rule:** any change to authorize parameters, the callback shape, or the token
  exchange needs both files updated together (noted at `cli-login-v1.md:13`).

## 2. Sync v1 (`GET /api/v1/sync`)

- **Doc:** `docs/platform/sync-v1.md:1` — copied from platform commit `474a9f7`
  (kete-org/ketecode-portal#37, 2026-09-28); source `packages/shared/src/api/v1/sync.ts`
  there.
- **Mirror schema:** `packages/util/src/kete/sync/contract.ts` — Effect `Schema` kept
  identical in shape to the platform's Zod schema. Header comment (:1-3) states decoding
  ignores unknown fields ("v1 only gains optional fields"); this falls out of Effect
  `Schema.Struct` dropping excess properties by default, exercised via
  `Schema.decodeUnknownOption(SyncResponse)` in `packages/util/src/kete/sync/client.ts:50`.
  Key shapes: `SyncedAgent` (:38-57, `mode`/`delegable` at :44-46), `AgentTools` (:22-34),
  `SyncedMcpServer` (:63-86), `SyncedSkill` (:97-107, files manifest), `SyncedPolicy`
  (:122-134), `SyncResponse` (:136-145, optional `mcp_servers`/`skills`/`policies` for
  older platforms).
- **`delegable` → Kete mode `"all"`:** the contract only ever sends `mode: "primary"`
  plus `delegable: true` for an agent that's also usable as a subagent (platform ADR
  0017). Mapped in `packages/core/src/kete/sync/plugin.ts:402`
  (`agent.mode = managed.mode === "primary" && managed.delegable === true ? "all" : managed.mode`),
  explained at :13-14. Cache compatibility: `packages/util/src/kete/sync/cache.ts:14-16`
  (cache format version 1 predates `delegable`; version 2 cache/sync logic at
  `packages/util/src/kete/sync/sync.ts:55-56` refuses to send a v1 cache's ETag so a
  fresh 200 is always fetched once, rather than risking a 304 for a flag that was never
  cached).
- **Client:** `packages/util/src/kete/sync/client.ts` — `fetchAgents` (:23-63): sends
  `Authorization: Bearer <key>` and `If-None-Match`, handles 304/200/401/5xx/429, never
  logs the key, decodes with `Schema.decodeUnknownOption`.
- **Skills client:** `packages/util/src/kete/sync/skills.ts` — `sync` (:58-89) writes
  skills to `<config>/managed/<organization id>/skills/<slug>/`; `present` (:92-101)
  lists skills fully on disk; skill files are downloaded from
  `GET /api/v1/sync/skills/{id}/files` only for changed hashes (comment :8, `sha256` at
  :202-204); files marked `executable` on the platform are written without the
  executable bit — "Never executable, even when the platform marks it so" (:146).
- **Relies on:** the platform relies on the runtime treating `permissions` as
  ordered/last-match-wins and applying `policies` fail-closed
  (`sync-v1.md` §"Policies"); the runtime relies on the platform never sending a secret
  in `credential` (only `credential.ref`, `docs/platform/sync-v1.md` "MCP servers and
  skills").
- **Change rule:** `sync-v1.md:76-78` ("Compatibility") — v1 only gains optional fields;
  anything breaking ships as `/api/v2`. Re-copy from the platform and diff
  `contract.ts` against it on every platform sync-v1 change.

- **Pending field `integrations` (MCP presets task, 2026-10-05):** the runtime already accepts an
  optional `integrations` object (`packages/util/src/kete/sync/contract.ts:148`, `Schema.Unknown`) and
  reads `integrations.slack.client_id` for `kete mcp add slack`
  (`packages/util/src/kete/sync/integrations.ts`); absent or any other shape means "no organization
  Slack app". kete-code-platform's Slack task adds the field; copy the updated `sync-v1.md` here and
  tighten the schema once it ships.

## 3. Runtime registration (`PUT /api/v1/runtimes/{installation_id}`)

- **Client/contract in one file:** `packages/util/src/kete/runtime-registration.ts` — no
  separate `docs/platform/` mirror; the endpoint and payload shape are defined here
  directly (header :1-7). `runtimeTypes`/`RuntimeType` (:16-17): `"local" | "kete_cloud" |
  "enterprise_private"`, all three live since ADR 0005 (2026-09-28) — the caller resolves
  which one via `resolveRuntimeType(configured, environment)` (:33-43; config value, else
  `OPENCODE_RUNTIME_TYPE`/`KETE_RUNTIME_TYPE`, else `"local"`; unknown → `invalid`, never
  guessed). Local installation id state: `<data>/installation.json`, mode
  `0600` (comment :7, `file` :79-81, written via `writeState` :90-96 with atomic
  rename). Registration call: `register` (:112-166) — PUT with
  `{runtime_type, version, os, arch, device_name}` (:134-141), 10 s timeout (:77), never
  throws (:112 "never throws"), re-registers when version/organization/key/**runtime_type**
  changed or a day has passed (:118-125; a missing stored `runtime_type` is treated as
  `"local"`, so pre-ADR-0005 `installation.json` files stay valid).
- **Relies on:** the platform relies on the runtime sending only non-secret fields
  (never code, prompts, paths — header :4-5); the runtime relies on a 404 meaning "an
  older platform without the endpoint," not an error (:148-149, retried the next day);
  the platform accepts all three `runtime_type` values (`RuntimeType` in kete-code-platform's shared API types,
  `api/v1/runtimes`, and a check constraint on `runtimes.runtime_type`).
- **Change rule:** additive only — new optional fields in the PUT body; a 404 must stay
  a safe no-op forever for old-platform compatibility.

## 4. Gateway (native per-provider passthrough)

- **Client:** `packages/core/src/kete/gateway.ts` — decision recorded in
  `docs/adr/0004-gateway-client.md`. Routes table (model-ID precedence order):
  `routes` (:97-128) — `/anthropic/v1`, `/openai/v1`, `/gemini/v1beta`,
  `/compat/deepseek/v1`, `/compat/openrouter/v1`. Model discovery: `GET
  <prefix>/models` per route (:217-254, `discover`), allowlisted per provider — one
  route failing keeps its last known models (:215-216, :241-246). Auth headers per
  route: `auth` field of each `Route` (:47, e.g. `x-api-key` for Anthropic :101,
  `Authorization: Bearer` for OpenAI-compatible :108/:125). Prices:
  `GET /api/v1/models` (`pricing`, :256-287, schema `PlatformModels` :57-70, prices are
  micro-USD per million tokens per :56). Balance: `GET /api/v1/me` (`me`, :289-303,
  schema `PlatformMe` :72-76), published as the `kete` integration's metadata
  (`balance_micros`, `currency`, `organization`) at :172-179 for clients (e.g. the TUI
  sidebar) to show.
- **Config/env:** `providerID = "kete"` (:37), `urlVariable = "OPENCODE_GATEWAY_URL"`
  (:39, user-facing `KETE_GATEWAY_URL` — the env bridge renames `KETE_*` to
  `OPENCODE_*`, see `packages/util/src/kete/env.ts:1-18`), `keyVariable =
  "OPENCODE_GATEWAY_KEY"` (:40), `platformVariable = "OPENCODE_PLATFORM_URL"` (:41).
  Config keys: `providers.kete.settings.baseURL`/`apiKey`, `kete.platform.url`
  (resolved in `configured`, :418-441). A signed-in account (`kete login`) always wins
  over hand configuration (:210-212, :423-429).
- **Relies on:** the gateway relies on the runtime never treating it as a hard
  dependency for local use (no URL configured → plugin does nothing, header :9); the
  runtime relies on the gateway naming providers the way the catalog does, except
  `gemini`↔`google` (:79-81 `platformRoute`).
- **Change rule:** a new gateway provider needs a matching `routes` entry (ADR
  0004 consequence, `docs/adr/0004-gateway-client.md:48-50`); if the gateway ever
  publishes its own route table, discover it instead of hand-listing routes.

## 5. Gateway agent headers and errors

- **Contract:** `packages/core/src/kete/sync/plugin.ts:1-39` (header),
  `agentIDHeader = "x-kete-agent-id"`, `agentVersionHeader = "x-kete-agent-version"`,
  `errorCodeHeader = "x-kete-error-code"` (:69-71). Every model call a synced agent
  makes carries the id/version headers so the gateway can enforce per-agent budgets
  (:10-11).
- **Error codes:** `agentErrors` (:74-77) — `budget: "kete_agent_budget_exceeded"`;
  `stale: ["kete_agent_paused", "kete_agent_not_found", "kete_agent_model_not_allowed"]`
  (an agent out of date locally, triggers an immediate debounced resync, :38-39).
  `agentErrorMessage` (:80-87) turns a code into the user-facing message; `x-should-retry:
  false` is set on these errors and the retry hook vetoes retries (:35-37, header set at
  :252).
- **Relies on:** the gateway relies on every request from a synced agent carrying both
  headers so budgets attribute correctly; the runtime relies on `x-kete-error-code`
  values being exactly this closed set — an unrecognized code falls through to the
  normal error path.
- **Change rule:** the platform may add error codes; an unrecognized one must stay a
  normal (non-agent) error here, never crash. Header names are load-bearing strings —
  changing them needs a coordinated deploy.

## 6. Cloud-job runtime image ↔ runtime (job mode)

- **Not a platform API contract** — this is the container entrypoint's
  (`packages/kete-job-entrypoint/`, §6d) contract with the runtime it starts (kete-code-platform ADRs 0018–0021, `docs/jobs.md` §8). Recorded here
  because it's an external, versioned-by-need surface like the others in this file.
- **`KETE_JOB_MODE=1`** — turns job mode on; bridged internally to `OPENCODE_JOB_MODE`
  (`packages/util/src/kete/job-mode.ts:18`). Unset/empty is off; any other value is `invalid` and
  treated as **on** (fails closed); an invalid value makes `kete serve` refuse to start
  (`packages/server/src/kete/job-server.ts:84`).
- **`KETE_JOB_MAX_OUTPUT_TOKENS`** — required once job mode is on; a positive integer, the
  output-token ceiling every model request is clamped or set to
  (`packages/util/src/kete/job-mode.ts:68-74`). Missing/invalid refuses every model request locally,
  naming the variable.
- **`KETE_JOB_TOOL_SOCKET`** — a POSIX-absolute path to the Go root helper's unix socket
  (`packages/kete-root-helper/`); bridged internally to `OPENCODE_JOB_TOOL_SOCKET`
  (`packages/util/src/kete/job-mode.ts:61-63`). Unset/empty keeps the fail-closed
  `KeteToolRunner.unavailable` stub (every spawn refused); a non-absolute value is `invalid` and
  makes `kete serve` refuse to start (`packages/server/src/kete/job-server.ts:90-91`), same
  fail-closed treatment as an invalid `KETE_JOB_MODE`. When set, every process spawn in job mode
  runs through `KeteToolHelper.runner` (`packages/util/src/kete/tool-helper.ts`), which speaks the
  helper's own socket protocol — see item 6b below.
- **`KETE_JOB_GATEWAY_KEY_FD`** (piece A1) — the descriptor number (3–1023) holding the gateway
  key; bridged to `OPENCODE_JOB_GATEWAY_KEY_FD` (`packages/util/src/kete/job-secrets.ts:29`). Read
  once and closed by `kete job run`; required in job mode (the only gateway key, D2); replaces the
  former `KETE_GATEWAY_KEY`, which job mode now ignores. Detail: §6d.
- **`KETE_JOB_AUDIT_FD`** (piece A3, additive) — the descriptor number (3–1023, not the key's)
  of a **pipe** the audit log goes to; bridged to `OPENCODE_JOB_AUDIT_FD`
  (`packages/util/src/kete/job-audit-sink.ts`). Required in job mode (missing, not a pipe or equal
  to the key fd → `refused`, 2); `kete job run` marks it close-on-exec and relays its `kete serve`
  child's audit (the child's own fd 4) into it unchanged. `kete` writes no audit file in job mode:
  it can append to the pipe, never seek, truncate or rewrite. Byte caps: detail lines stop at
  19,000,000 bytes, any write past 20,000,000 interrupts the run (`audit_failed`). Detail: §6d.
- **File confinement (piece A3):** in job mode `kete` opens working-tree files only with
  `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS)` beneath its cwd (the
  prepared worktree): its file tools and in-process reads refuse a symlink anywhere in a path, `..`,
  an absolute path outside the worktree and a magic link. Without `openat2` (kernel < 5.6, seccomp,
  non-Linux) `kete serve` refuses to start; `kete job run` reports `error` (1). No variable.
- **Relies on:** the entrypoint relies on the runtime failing closed (refusing every process spawn)
  when `KETE_JOB_TOOL_SOCKET` is unset or invalid; the runtime relies on the entrypoint setting all
  three variables, and starting the root helper at that socket path with the tool cgroup and
  worktree root already prepared, before any tool call or model request — there is no local default
  for any of them.
- **Change rule:** additive only, same as the platform contracts above; a new job-mode variable
  needs a matching entry here and in `docs/jobs.md` "Job mode". Full behavior: the `job-mode` card.

## 6b. Root-helper socket protocol v1 (in-repo contract)

- **Not a platform contract** — both sides (`kete` and the helper) live in this repo, but it's
  versioned like one because the two are built, tested, and released as genuinely separate programs
  (Go vs. TypeScript) that must agree on a wire format.
- **Doc:** `packages/kete-root-helper/README.md` "Protocol v1" is the contract itself (frame format,
  message table, state machine, error codes, flow control, versioning rule).
- **Implementations:** `packages/kete-root-helper/internal/protocol/{frame,messages}.go` (Go) and
  `packages/util/src/kete/tool-helper-protocol.ts` (TypeScript), pinned to the same wire format by
  shared test vectors — `packages/kete-root-helper/internal/protocol/testdata/vectors.json`, read by
  both `protocol_test.go` and `tool-helper-protocol.test.ts`.
- **Relies on:** each side relies on the other refusing (not guessing at) any `protocol` version it
  doesn't implement, and on neither side ever putting argv or env values into an error message
  (may hold secrets).
- **Change rule:** `protocol` is an integer; any change to a frame, field, or error code bumps it,
  updates the README, both implementations, and `testdata/vectors.json` together. Full detail: the
  `root-helper` card.

## 6c. Egress proxy config, fds, control protocol and log format v1 (in-repo contract)

- **Not a runtime ↔ platform API** — the contract between `kete-egress` (`packages/kete-egress/`)
  and the job entrypoint (piece C) that installs and supervises it, derived from platform ADR 0019
  rule 4 and `docs/jobs.md` §7-8. Both sides are in this repo but built and tested separately.
- **Doc:** `packages/kete-egress/README.md` is the contract: Configuration v1
  (`packages/kete-egress/README.md:66-99`), Registry rules (`:101-133`), File descriptors (fds 3-7,
  `:135-157`), Control protocol v1 (`:159-173`), Log format v1 (`:175-216`), Firewall (`:236-282`),
  Clients (CA and proxy variables, `:284-305`), exit codes.
- **Egress requirements mirrored:** three privileged loopback ports A (`kete`), B (tool), R (root);
  per-phase (clone/agent/report), per-port exact-host allowlists; registries GET/HEAD only, path
  shapes, no query/body, target ≤ 1 KiB, ≤ 20,000 requests per job; a 10,000,000-byte request log
  that fails closed.
- **Platform upload:** the request log is the platform's `job-audit/<org>/<job>.proxy.jsonl`
  (`application/x-ndjson`, ≤ 10 MB) — `packages/kete-egress/README.md:177-178`.
- **Relies on:** the entrypoint relies on the proxy refusing any start-up it can't verify (exit 2)
  and on `nft` output being one atomic ruleset; the proxy relies on the entrypoint applying the
  rules before any job user's process and before `claim`, and never putting the job CA into the
  system trust store.
- **Change rule:** config, control and log each carry `version`/`v` 1; a change bumps it and
  updates the README with the code. Limits and registry rules may only be narrowed by
  configuration. Full detail: the `egress` card.
- **Configuration v2 (enterprise runtime P0c):** `docs/platform/egress-config-v2.md` (byte copy of
  the platform's doc at `e5e32ee`, kete-org/ketecode-portal#73) adds `upstream` (CONNECT proxy,
  `proxy_auth_file`/`ca_bundle_file` under `/run/`, `direct`), `internal` CIDR ranges and
  `host:port` allowlist entries, and the forbidden ranges (`internal/blocked.Forbidden`, checked
  against the doc). Parser only: `config.ParseV2` (refusals are `*FieldError` naming the field),
  vector `packages/kete-egress/internal/config/testdata/egress-config-v2/configs.json` with
  `SHA256SUMS`. `serve`/`nft` still read only v1 (`Parse` refuses version 2) until P2.

## 6d. Cloud-job entrypoint ↔ platform, and entrypoint ↔ `kete job run` (in-repo + platform)

- **Doc:** `packages/kete-job-entrypoint/README.md` is the contract (machine configuration, layout,
  steps, outcomes, environments, credentials, bundle format). Full detail: the `job-entrypoint` card.
- **Machine configuration (platform's Fly adapter → entrypoint, D3):** env vars `KETE_JOB_ID`
  (UUID), `KETE_JOB_PLATFORM_URL` (`https://` plain DNS host, port 443 or none, no path/query/
  userinfo), `KETE_JOB_CLAIM_TOKEN` (printable ASCII, 32-512 bytes), `KETE_JOB_STORAGE_HOST` (plain
  DNS host; the only host signed upload URLs may name, and not equal to the gateway, clone or
  (GitHub only) clone-API host) (`packages/kete-job-entrypoint/README.md` "Machine configuration"). Any other
  variable is ignored (only whether one of Fly's own `FLY_*` machine variables is set is noted, as
  one bit, a Fly signal); invalid → exit 2 with no callback.
- **Host profiles (ADR 0023 rule 16, self-hosted P1; additive):** optional fifth variable
  `KETE_JOB_HOST_PROFILE` = `fly` | `microvm` | `dedicated` | `cloudvm`; unset = `fly` only when a
  Fly signal (a `FLY_*` variable or `/.fly`) is present, else exit 2; unknown → exit 2; Fly signals
  with another profile → `setup_host` `fly_signals`, before claim. **The Fly adapter needs no change
  today** (unset + Fly signals = `fly`); it sets `fly` once an image that knows it is pinned.
  Non-fly profiles take the values from a **config pipe** (`--config-fd <n>`, a FIFO only): one
  strict JSON object ≤ 4096 bytes `{job_id, platform_url, claim_token, storage_host, host_profile,
  host_provider (cloudvm: gcp|digitalocean|hetzner|oci), host_generation (dedicated)}`; the four env
  vars must then be unset. The microvm config disk is `kete-job-config v1\n` + that object + NUL
  padding; cloudvm user data is the object. This is the shape kete-code-platform's P2.0 host-agent
  contract must adopt. New phase steps `setup_host`, `host_boundary` (codes `fly_signals`,
  `source`, `init`, `vsock`, `dmi`, `generation`, `gateway`, `private_range`, `ipv6`,
  `config_disk`, `metadata_drop`, `guarded_path`) and `kete-job-init`'s `init_*` steps; all before
  claim, phase lines only. README "Host profiles" and "kete-job-init".
- **Before claim (no callback, so not platform-visible):** off Fly the host-boundary probe (root,
  before any in-guest rule) must reach no gateway port, metadata, private-range or IPv6 sample; on
  Fly the Fly guard fails closed (on Fly, a
  missing `/.fly/api` stops setup: phase `setup_fly` `missing`) and locks `/.fly` root 0700 and
  `/.fly/api` root 0600; then, after the helper, the isolation check runs a probe as the tool user
  and stops on anything reachable (phase step `isolation`, fixed codes `control`, `fly_api`,
  `helper_socket`, `unix_socket`, `kete_dir`, `metadata`, `sixpn`, `resolver`, `loopback`,
  `probe`; `README.md:154-196`). A job stopped here is never claimed (exit 1, the
  platform's handling of an unclaimed job applies). Staging runbook: `README.md:372-405`. **`KETE_JOB_STORAGE_HOST` is new for the platform** (security
  review); the Fly adapter must set it.
- **Callbacks as used** (kete-code-platform `docs/jobs.md` §2, under `{platform}/api/v1/jobs/{id}/`):
  `claim` `{claim_token, features: ["clone_revoke_callback"]}` → 200 `{callback_token, deadline,
  platform_url, gateway_url, gateway_key, clone {url, token, ref, base_sha, provider?, username?},
  spec}` (strictly validated, README "Claim response checks"; retried only while no byte was
  written); then Bearer `callback_token`: `clone-done` `{}` → 204 (after the clone; see below);
  `events` `{phase, message?,
  effective_timeout_minutes?, kete_cgroup_extra?}` → 204, every 30 s from claim to `done`;
  `result` (kete's result v1 bytes verbatim, or one the entrypoint writes) → 204; `uploads`
  `{bundle}` → 200 `{audit, proxy_log, bundle?}` each `{url, expires_at}`; signed-URL `PUT`
  (`application/x-ndjson` logs, `application/gzip` bundle; PUT assumed, D15); `finish`
  `{push_error?}` → 202. A 404 on any callback = gone: kill, no more callbacks.
- **Repository providers (jobs-v1 additive, 2026-10-05; platform ADR 0024, kete-org/ketecode-portal#68):**
  `clone.provider` absent/`github` or `harness_code` (anything else refused, field
  `clone.provider`); `clone.username` absent (= `x-access-token`) or 1-128 printable ASCII without
  `:`. The clone authenticates with `Authorization: Basic base64(username:token)`. GitHub: revoke
  through GitHub's API as before, then `clone-done` best effort (a platform no-op). Harness Code:
  **no** request to the git host's API; `clone-done` (≤ 3 tries, 5xx retried, 404 = gone) after
  the clone, and also on clone or verify failure before the result; the clone phase reaches
  exactly `{platform, clone host}`. Phase step `clone_done`. **Release order:** platforms before
  #68 reject the unknown `features` field (`strictObject`), so an entrypoint with this change must
  not ship in a release (image digest) before #68 is deployed. Shared vector:
  `packages/kete-job-entrypoint/internal/fakeplatform/testdata/jobs-v1/claim-harness-code.json`
  (byte copy of the platform's `docs/contracts/test-vectors/jobs-v1/`, `SHA256SUMS` beside it).
- **Outcomes the entrypoint writes:** `error` (1), `refused` (2), `deadline` (1), `proxy_failed`
  (1), `time_limit` (3). `push_error`: `processes_alive`, `symlink`, `unreadable` (over-limit too,
  until the platform adds a value, D10), `proxy_failed`.
- **Bundle:** one gzip of a tar: `manifest.json` first (a bare JSON array of `{path, mode}` or
  `{path, deleted: true}`, D11, sorted by path bytes), then `files/<path>`; empty array still
  uploaded (D12); decimal limits (`README.md:197-239`). D10-D12 and D15 await the platform's
  confirmation.
- **Entrypoint → `kete job run` (job mode):** cwd is the prepared worktree
  `/srv/kete-job/work/repo` on `spec.branch` at `base_sha`; in job mode `kete job run` makes **no
  git call**, requires `spec.branch` and `<cwd>/.git` (else `refused`, 2), reports `isolated: true`,
  `worktree` = `directory` = cwd, and never removes it (`packages/cli/src/kete/job-run.ts:426-434`,
  `docs/jobs.md` "Job mode"). Invoked as `kete job run --json /var/lib/kete-job/kete/spec.json`
  (the claim's spec with `policy.timeout` replaced by the effective timeout). Env: `HOME`/XDG/
  `TMPDIR` under `/var/lib/kete-job/kete`, `HTTPS_PROXY=http://127.0.0.1:81`, `NODE_EXTRA_CA_CERTS`
  and `SSL_CERT_FILE` = the proxy CA, `KETE_JOB_MODE=1`, `KETE_JOB_TOOL_SOCKET`,
  `KETE_JOB_MAX_OUTPUT_TOKENS=32000` (D14), `KETE_RUNTIME_TYPE=kete_cloud`, `KETE_GATEWAY_URL`,
  `KETE_PLATFORM_URL`, `KETE_JOB_GATEWAY_KEY_FD=3`, `KETE_JOB_AUDIT_FD=4`, `KETE_DISABLE_MODELS_FETCH=1` (`README.md:156-165`;
  `entry_linux.go:195-225`). **`KETE_DISABLE_MODELS_FETCH=1` is additive (PR 2 decision N1,
  2026-10-01):** `kete serve` would otherwise fetch the models.dev catalog periodically
  (`cli/src/server-process.ts:120`), a host port A never allows; a job's catalog is the binary's
  bundled snapshot, so a platform agent pinned to a model newer than the shipped `kete`'s snapshot
  can't run in a job.
  **No `KETE_GATEWAY_KEY`** (since piece A1): the gateway key travels on a pipe that is `kete`'s
  fd 3 (`launch.Options.Extra`, write end closed before launch, empty key refused —
  `packages/kete-job-entrypoint/internal/entry/entry_linux.go:281-310`). `kete job run` becomes
  non-dumpable, reads the fd once (≤ 4096 printable-ASCII bytes, 10 s timeout) and closes it; a
  missing/invalid fd refuses (`refused`, 2) — `packages/cli/src/kete/job-preflight.ts:39-61`. In
  job mode this key is the **only** gateway key (user decision D2): `KETE_GATEWAY_KEY`, an account
  file, a `kete auth login` key and `providers.kete.settings.apiKey` are all ignored, and the
  gateway/platform URLs come **only** from the entrypoint's `KETE_GATEWAY_URL`/`KETE_PLATFORM_URL`
  (`providers.kete.settings.baseURL` and `kete.platform.url` ignored) —
  `packages/core/src/kete/gateway.ts:172-173,447-455`. `kete`'s own server is a unix socket in a
  fresh 0700 dir under its `XDG_RUNTIME_DIR` or `TMPDIR` (`packages/cli/src/kete/job-standalone.ts:43-84`),
  never TCP, so the egress firewall needs no exception for it; its password and the key reach the
  `kete serve` child on that child's fd 3 (`KETE_JOB_SECRETS_FD`, internal, not a contract). The
  entrypoint reads `kete`'s stdout (a root-created file) for the result (D3, unchanged).
  **Audit sink (piece A3, D2/N1/N5):** the entrypoint creates a pipe and passes its write end as
  `kete job run`'s fd 4 with `KETE_JOB_AUDIT_FD=4` (closing its own copy once `kete` has it); a
  reader goroutine copies the read end into the root file `/var/log/kete-job/kete.audit.jsonl`
  (0600), stopping and closing the pipe past 20,000,000 bytes so `kete`'s next write fails. After
  the agents are reaped it waits (≤ 10 s) for the reader and uploads that file: empty → no upload,
  note "audit log not uploaded: empty"; over the limit → note "… too large"; a stuck reader → note
  "… reader stuck". `kete job run`'s result has no `audit_log` in job mode (N2, `audit_local: true`;
  both fields optional in result v1). `entry_linux.go` `StartKete`/`OpenAudit`, `job.go` `upload`.
- **Job-mode sync (piece A2):** `kete job run` makes the first sync itself, before its server starts
  (`packages/cli/src/kete/job-sync.ts`, `job.ts:125-140`): the job's gateway key as Bearer to
  `KETE_PLATFORM_URL/api/v1/sync` (`KETE_PLATFORM_URL` required, http(s) only; never the account's
  URL). `spec.agent` is required and must be a synced agent's slug (the gateway pins
  `x-kete-agent-id` for job keys, ADR 0020 rule 9). Fail closed: a failed sync or managed-skill
  download = `error` (exit 1); missing or unknown agent = `refused` (exit 2); 120 s overall deadline.
  The organization id reaches the `kete serve` child in the fd-3 secrets message (`organization`,
  `job-standalone.ts:108-109`), where the sync plugin loads that cache. The platform's job keys and
  job-scoped sync are not built yet.
- **Image (piece D, `packages/kete-job-image/`):** `ghcr.io/kete-org/kete-job:<kete-v tag>`,
  pinned by the platform **by digest**. Since self-hosted P1 (ADR 0023 rule 17) the tag is a
  linux/amd64 + linux/arm64 index (per-arch tags `<tag>-linux-<arch>`); the index and both per-arch
  digests are signed with cosign keyless signing, identity
  `https://github.com/kete-org/ketecode/.github/workflows/kete-release.yml@refs/tags/<tag>`, issuer
  `https://token.actions.githubusercontent.com`, verified in the release workflow. Release assets:
  `kete-job-image.digest` **unchanged** (one line, the linux/amd64 digest the Fly adapter pins) and
  `kete-job-image.digests` (keyed lines `index`, `linux/amd64`, `linux/arm64`, `cosign-identity`,
  `cosign-issuer`, `tested`); the notes list all. linux/amd64 passes the full e2e; linux/arm64 is
  smoke-tested under QEMU only (stated in the notes and `.digests`). Push and signing run in a
  separate tag-only `image-publish` job. Paths the entrypoint relies on: `/usr/local/bin/kete`,
  `/usr/local/libexec/kete/{kete-job-entrypoint,kete-job-init,kete-root-helper,kete-egress}` (root
  0755), the users `kete`, `kete-tool`, `kete-proxy` and the group `kete-job` created at build time,
  `/etc/gitconfig` `safe.directory`, no setuid/setgid file, `ENTRYPOINT` the entrypoint with no
  `USER`/`CMD`.
- **Relies on:** the platform relies on no claim without a working firewall, proxy and helper, and
  on the callback token never reaching `kete` or the tool user; `kete` relies on the key fd being
  closed for writing before it starts (it reads to EOF); the entrypoint relies on the
  claim's `deadline` being the job's hard limit and on 404 meaning gone; `kete` relies on cwd being
  a real checkout it may not run git in.
- **Change rule:** additive; a new machine-config variable or callback field updates the README,
  this section and the platform's `docs/jobs.md` together.

## 6e. Job API v1 and the gateway's job-key request shape

- **Doc:** `docs/platform/jobs-v1.md:1` — after its two-line header, byte-identical to the
  platform's doc at commit `e5e32ee` (2026-10-07, kete-org/ketecode-portal#73: runtime
  repositories, ADR 0025; also the 429/503 error codes and upload expiry text it had missed). No
  check enforces equality of the doc; the vectors are checked (`SHA256SUMS`). The platform's
  `packages/shared/src/api/v1/jobs.ts` is the source of truth. It covers the user routes, the
  container callbacks §6d uses (claim incl. `features`, events incl. `kete_cgroup_extra`, result,
  uploads, finish, clone-done) and the job error codes. No kete-code mirror schema yet: the entrypoint's Go
  types (`packages/kete-job-entrypoint/internal/platform/platform.go`) are the client.
- **Heartbeat check (ADR 0019 rule 5):** every agent-phase `events` carries `kete_cgroup_extra`
  (processes in the `kete` cgroup whose exe isn't `kete`; an unreadable exe counts), which the
  platform records as a job error when above 0; if the cgroup can't be read, the event carries the
  fixed `message` `KeteCheckFailed` (`internal/job/job.go`) instead of the count.
- **Request shape (gateway docs §2.8, platform `apps/gateway/src/jobs/{request-shape,output-limit}.ts`,
  `schemas/*.ts`):** job mode refuses locally everything the gateway refuses for a job key, so a
  job fails with a local `InvalidRequestError` naming the field, not a gateway 400
  (`packages/core/src/kete/job-request.ts`, `job-request/*`): only the six job routes (no token
  counting, no deepseek); `anthropic-beta` only `interleaved-thinking-2025-05-14`,
  `mid-conversation-output-config-2026-07-01`, `thinking-binding-controls-2026-08-01`;
  `openai-beta` never; query only Gemini `alt=sse` and the Anthropic route's `beta=true` (not
  forwarded by the gateway); the gateway's pre-checks; the output clamp, with an Anthropic
  `thinking.budget_tokens` or OpenRouter `reasoning.max_tokens` lowered below it; then the
  gateway's strict zod schemas, mirrored field for field in
  `packages/core/src/kete/job-request/schemas/*.ts`.
- **Relies on:** `KETE_JOB_MAX_OUTPUT_TOKENS` ≤ the gateway's `JOB_MAX_OUTPUT_TOKENS` (default
  32,000): the runtime clamps to its own value, the gateway refuses anything over its own.
- **Change rule:** when the platform changes a job schema, the allowlists or the output rules,
  re-copy the schema file(s) into `job-request/schemas/` unchanged except imports and the header,
  update `job-request.ts`'s allowlists, and run `job-request-wire.test.ts` (real provider
  packages through the conformers) — it fails when the runtime sends something the copy refuses.

## 6f. Self-hosted job host agent ↔ platform (job-host-v1)

- **Doc:** `docs/platform/job-host-v1.md:1` — copied from platform commit `04d406a` (2026-10-03);
  the platform's `packages/shared/src/api/v1/job-hosts.ts` is the source of truth, its
  `packages/shared/src/job-host-crypto.ts` the TypeScript crypto. Implementation:
  `packages/kete-job-host` (card `job-host`). Routes served from platform P3.
- **Shape:** two signed `POST` routes, `/api/v1/job-hosts/enroll` (≤ 8 KiB) and `/poll` (≤ 1 MiB;
  responses read ≤ 1 MiB). RFC 9421 fixed profile: label `kete`, components `@method @authority
  @path content-type content-digest`, parameters `created;expires(+60);nonce(16 bytes hex);keyid;
  alg="ed25519";tag="kete-job-host-v1"`; `keyid` = host id (poll) or the key fingerprint (enroll).
  Responses are unsigned: TLS to the configured origin, and the poll response echoes the nonce as
  `in_reply_to`. Sealed configuration: HPKE base mode X25519/HKDF-SHA256/AES-128-GCM, `info` =
  label + host/machine/job ids + generation, empty AAD; the plaintext is kete-code's config-pipe
  JSON (§6d host profiles), canonical, ≤ 4096 bytes. Config disk: `kete-job-config v1\n` + JSON +
  NUL to 8192 bytes.
- **Test vectors:** `packages/kete-job-host/testdata/job-host-v1/{signatures,hpke,config-disk}.json`,
  byte-for-byte copies with `SHA256SUMS`; the Go tests pass every case (both repos check them).
- **Relies on:** the platform relies on the agent refusing images outside its allowlist or without
  a valid signature, a `platform_url` other than its configured origin, and machines past deadline
  + 5 min or 135 min (offline too); on reports carrying only phase lines that parse; and on the
  agent never logging or persisting the claim token. The agent relies on the platform keeping a
  machine in `destroy` until it records it terminal, sending `config` until running/terminal, and
  `revision` never decreasing.
- **Change rule:** a contract change re-copies the doc and all three vectors (regenerate
  `SHA256SUMS`), updates `internal/contract`, the `job-host` card and this section together.
- **job-host-v2 (enterprise runtime P0c):** `docs/platform/job-host-v2.md` (byte copy of the
  platform's doc at `e5e32ee`, kete-org/ketecode-portal#73; source of truth
  `packages/shared/src/api/v1/job-hosts-v2.ts`). v1's rules with tag `kete-job-host-v2`
  (`sig.V2`), `version: 2` in every body (a response without it is discarded), HPKE label
  `kete-job-host-v2 sealed-config` (`seal.OpenV2`/`SealV2`), driver `kubernetes` (1–128 slots,
  `runtime_classes`), profile `kubevm` (`MachineConfig.ValidateV2`), state `publishing`, the
  publish outcome (reason-by-status, refs gated by `boundary.publish_refs`, branch never gated),
  and a kubernetes run machine without `repository` refused (`RunMachineV2.ValidateKubernetes` →
  `config_invalid`). Go types: `packages/kete-job-host/internal/contract/v2.go`, decoded with
  `contract.Decode` (required fields, nulls, strict objects). Vectors:
  `packages/kete-job-host/testdata/job-host-v2/{hpke,messages,signatures}.json` + `SHA256SUMS`.
  Not wired into the agent yet (P1/P2). The jobs-v1 side (claim features `runtime_repo`,
  `runtime_publish`; `ParseRuntimeClaimResponse`; `BoundRunResult`) is
  `packages/kete-job-entrypoint/internal/platform/runtime.go`, vectors `claim-runtime-repo.json`
  and `result-boundary.json` beside `claim-harness-code.json`.
- **Pending addition (kete-code P4):** machine reason `host_isolation_lost` (destroyed: the host
  table vanished or changed while it ran; the agent fails closed). In `internal/contract` only;
  the platform must add it to `JobHostMachineReason` and its contract before P3.
- **Pending addition (kete-code P5):** `starts_blocked` value `generation_spent` (a dedicated
  host's generation ran its one job, ADR 0023 rule 8; reported with `free: 0` until the host is
  reset and re-enrolled). In `internal/contract` only; the platform must add it to
  `JobHostStartsBlocked` before a dedicated host polls, or it refuses those reports
  (`malformed_request`). Dedicated R1 relies on the platform answering an enrollment `active` only
  for the fresh token of a provider rebuild it started for the declared generation (the P5
  handoff lists the platform side).

## 6g. Cloudvm image contracts (in-repo, plus one platform-checked marker)

- **Kernel command line `kete.net` / `kete.dns`:** written by the cloudvm disk's built-in GRUB config
  (`packages/kete-job-image/packer/scripts/assemble-disk.sh:81`), read by kete-job-init
  (`packages/kete-job-entrypoint/internal/guestinit/cmdline.go:29`). `kete.net=dhcp` (the only value)
  and `kete.dns=<ip>[,<ip>]` (one or two public IPv4) go together; repeats or anything else are
  refused (`invalid`). Absent: the kernel's `ip=` configured the network (microvm).
- **Disk manifest `kete-cloudvm-disk v1`:** `kete-cloudvm-<arch>.json` next to the raw disk, written
  by `build-disk.sh`/`assemble-disk.sh` (`assemble-disk.sh:174`), checked by `convert-disk.sh` and the
  Packer template: `format`, `arch`, `test`, `job_image`, `job_image_digest`, `kernel_release`,
  `kernel_sha256`, `cmdline`, `disk_gib`, `disk_sha256`. `convert-disk.sh` refuses `test: true`, another
  arch or image, and a disk whose SHA-256 differs.
- **Image marker (platform-checked):** every provider image records `kete-job-image=<index digest>`
  in its description (GCP, DigitalOcean, Hetzner) or the OCI free-form tag `kete_job_image`
  (`packer/cloudvm.pkr.hcl:101`); the platform adapters' `IMAGE_DIGEST_MARKER` /
  `freeformTags.kete_job_image` check it before each create. Change both repos together.
- **Change rule:** a new cmdline parameter or manifest field: the entrypoint README, the `job-image`
  and `job-entrypoint` cards and this section together.

## 7. Local account state files (not wire contracts, but part of the shared surface)

- `<config>/account.json` — `packages/util/src/kete/account.ts:18-28` (`Account`
  schema: `platform_url`, `gateway_url`, `organization {id,name}`, `key_id`,
  `device_name`, `storage`, `created_at`). Written only by `kete login` (header :5-6).
- Key itself: OS credential store via `packages/util/src/kete/secret-store.ts`, or a
  user-only fallback file under `<data>` (header :7-8).
- `<data>/installation.json` — see §3 above.
- `<config>/managed/<organization id>/agents.json` — `packages/util/src/kete/sync/cache.ts:1-5`
  (`Cached` schema :13-24): the whole sync response, replaced atomically on every write.
- `<config>/managed/<organization id>/skills/<slug>/` — synced skill files
  (`packages/util/src/kete/sync/skills.ts:36-42`).

## 8. Config keys and env var names touching these contracts

| Config key | Env var (user-facing `KETE_*`) | Internal (`OPENCODE_*`, post-bridge) | Where read |
|---|---|---|---|
| `providers.kete.settings.baseURL` | `KETE_GATEWAY_URL` | `OPENCODE_GATEWAY_URL` | `gateway.ts:47,451,462` |
| `providers.kete.settings.apiKey` | `KETE_GATEWAY_KEY` | `OPENCODE_GATEWAY_KEY` | `gateway.ts:48,457-460` |
| `kete.platform.url` | `KETE_PLATFORM_URL` | `OPENCODE_PLATFORM_URL` | `gateway.ts:49,453,464` |
| — (no config key) | `KETE_JOB_GATEWAY_KEY_FD` | `OPENCODE_JOB_GATEWAY_KEY_FD` | `util/src/kete/job-secrets.ts:29`, `cli/src/kete/job-preflight.ts:44` (§6d) |
| — (no config key) | `KETE_JOB_MODE` | `OPENCODE_JOB_MODE` | `util/src/kete/job-mode.ts:18` (§6) |
| — (no config key) | `KETE_JOB_MAX_OUTPUT_TOKENS` | `OPENCODE_JOB_MAX_OUTPUT_TOKENS` | `util/src/kete/job-mode.ts:23` (§6) |
| — (no config key) | `KETE_JOB_TOOL_SOCKET` | `OPENCODE_JOB_TOOL_SOCKET` | `util/src/kete/job-mode.ts:61` (§6) |

`KETE_JOB_ID`, `KETE_JOB_PLATFORM_URL`, `KETE_JOB_CLAIM_TOKEN` and `KETE_JOB_STORAGE_HOST` are read
only by the job entrypoint (§6d), never passed to `kete`.

**Job mode overrides this table (§6d, D2):** the key comes only from `KETE_JOB_GATEWAY_KEY_FD`'s
descriptor (`KETE_GATEWAY_KEY`, `apiKey`, accounts ignored, and `KETE_GATEWAY_KEY`/`KETE_PASSWORD`/
`KETE_SERVER_PASSWORD` are deleted from `process.env`, `util/src/kete/job-secrets.ts:37`), and the
URLs only from the env vars (the config keys are ignored) — `gateway.ts:447-455`.
`KETE_JOB_SECRETS_FD` (`job-secrets.ts:33`) is internal (`kete job run` → its `kete serve` child),
not a contract.

The env bridge (`packages/util/src/kete/env.ts:20-49`) renames every `KETE_*` variable to
`OPENCODE_*` once at startup before plugins run; there is deliberately no fallback from
`OPENCODE_*` to `KETE_*` (env.ts:17-18).

## 9. Public release distribution (public contract, ADR 0009)

Not a platform contract: what users, package managers and released `kete` binaries rely on. Changing
any of it needs a migration path (CLAUDE.md §12); old binaries keep reading the same URLs forever.

- **Where:** `https://github.com/kete-org/kete-releases` (`Brand.urls.releases`); release tag
  `kete-v<version>`; latest = GitHub's latest **stable** release.
- **Files per release:** `kete-<version>-<target>.tar.gz` (Linux) / `.zip` (macOS, Windows) for the
  12 targets (`packages/cli/src/kete/release-verify.ts` `targets`), `install.sh`, `install.ps1`,
  `SHA256SUMS` (`<sha256>  <name>` lines, exactly those files), `SHA256SUMS.sig` (64 raw bytes,
  Ed25519 over `SHA256SUMS`, by a key in `packages/cli/src/kete/update-keys.json`),
  `SHA256SUMS.sigstore.json` (cosign bundle, identity
  `https://github.com/kete-org/ketecode/.github/workflows/kete-release.yml@refs/tags/kete-v<version>`,
  issuer `https://token.actions.githubusercontent.com`).
- **`kete upgrade` reads** `releases/latest/download/SHA256SUMS{,.sig}` and
  `releases/download/kete-v<version>/{SHA256SUMS,SHA256SUMS.sig,<archive>}`; the version comes from
  the signed archive names (`release-verify.ts` `releaseOf`). Archive layout: `kete`/`kete.exe` at
  the top level (+ `LICENSE`, `NOTICE`).
- **Install scripts:** `install.sh [--version X] [--install-dir DIR] [--checksum-only]` (default
  `$KETE_INSTALL_DIR` or `~/.local/bin`), `install.ps1 [-Version] [-InstallDir] [-ChecksumOnly]
  [-NoModifyPath]` (default `%LOCALAPPDATA%\Programs\kete\bin`); `KETE_RELEASES_URL` overrides the
  repository (https, or loopback for tests).
- **Package names:** npm `@ketecode/cli` + `@ketecode/cli-{darwin-arm64,darwin-x64,linux-arm64,linux-arm64-musl,linux-x64,linux-x64-musl,windows-arm64,windows-x64}`
  (npm tag `latest`, pre-releases `next`); Homebrew `kete-org/tap/kete` (`Formula/kete.rb` in
  `kete-org/homebrew-tap`). Binary install-method detection (`updater.ts` `detect`): a real path
  under `Cellar/kete/` = Homebrew, under `node_modules` = npm, `ketecode.kete-code*` = the extension.
