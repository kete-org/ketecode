# Decisions

One line per ADR (`docs/adr/0001`–`0004`, `0008`, `0009`), then the CLAUDE.md rules that act like
decisions, then the platform ADRs this repo follows without owning.

## ADRs (`docs/adr/`)

- **0001 — OpenCode upstream strategy** (`docs/adr/0001-opencode-upstream-strategy.md:14-29`):
  extend upstream instead of replacing/restructuring it; prefer config → upstream
  plugins/hooks → Kete modules → DI → minimal upstream edit, in that order; every
  upstream-file edit carries a `kete_change` marker (unmarkable files listed in
  `docs/upstream-patches.md`); syncs merge a tag on `upstream/vX.Y.Z`, never copy files
  by hand; license/attribution stay intact. **Bites:** any time you're about to add a
  new engine/manager/config system — search for the upstream equivalent first
  (`packages/kete-tools upstream:check` enforces the marker half of this).
- **0002 — Runtime/platform separation** (`docs/adr/0002-runtime-platform-separation.md:15-27`):
  `kete-code` is the execution plane, `kete-code-platform` the control plane; the
  runtime talks to the platform only through the versioned Platform API, never the
  database, and core isn't coupled to a specific cloud. **Bites:** any change that would
  add a control-plane responsibility here, or a direct DB/cloud-SDK dependency in
  runtime core.
- **0003 — Inherited hosted services are opt-in** (`docs/adr/0003-hosted-services-opt-in.md:17-25`):
  upstream's hosted services (OpenCode Zen, Go) are off by default; enabled only by
  `kete auth login`, an env key, or an explicit config entry — switches live in
  `packages/core/src/kete/hosted.ts` (`anonymousOpencodeZen = false`). **Bites:** every
  upstream sync must be reviewed for new default-enabled endpoints/telemetry/providers
  (`docs/adr/0003-hosted-services-opt-in.md:32-33`); a fresh install has no working
  model until the user connects a provider.
- **0004 — Gateway client uses the gateway's native routes** (`docs/adr/0004-gateway-client.md:21-44`):
  the gateway client is a Kete-owned provider plugin (`kete`, `packages/core/src/kete/gateway.ts`)
  that discovers models per native route (`/anthropic/v1`, `/openai/v1`, `/gemini/v1beta`,
  `/compat/{provider}/v1`) rather than treating the gateway as one OpenAI-compatible
  provider; supersedes the "OpenAI-compatible provider" wording in `CLAUDE.md` §3
  (noted at `docs/adr/0004-gateway-client.md:42-43`). **Bites:** adding a new gateway
  provider needs a matching `routes` entry (`gateway.ts:97-128`); don't reintroduce a
  single-OpenAI-compatible-provider gateway config.
- **0008 — Unattended runs fail closed** (`docs/adr/0008-unattended-runs-fail-closed.md:15-31`):
  a run started as unattended (a job, or `kete job run`) is enforced by the runtime, not the
  client — every `ask` is denied unless the run's own policy allows it (deny still wins, the
  policy only narrows); a spending budget and a time limit are required or the run is refused;
  `--auto` stays an interactive-only client convenience. Implemented as session metadata
  `kete.unattended` plus two more permission-tightening hooks alongside permission-mode and the
  subagent ceiling — see the `unattended` card. The audit log (ADR 0008 §"Consequences") is a
  separate, not-yet-built task. **Bites:** any new permission-adjacent hook needs to run in the
  right place in `plugin/internal.ts`'s `pre`/`post` order relative to `KeteUnattended.PolicyPlugin`
  (first) and `KeteUnattended.Plugin` (last) or it can leak an `ask` past the unattended fail-close.

- **0009 — Public CLI distribution and verified self-update** (`docs/adr/0009-public-cli-distribution.md`):
  public downloads from `kete-org/kete-releases` (source stays private); `SHA256SUMS` signed twice
  in a tag-only `sign` job: cosign keyless (install scripts) and Ed25519 with a key pinned in the
  binary (`packages/cli/src/kete/update-keys.json`, what `kete upgrade` verifies; chosen over
  sigstore-js: no new dependency, no TUF network fetch); `install.sh`/`install.ps1` fail closed
  without cosign unless `--checksum-only`; Homebrew tap and npm (`@ketecode/cli` + platform
  packages) from the `distribute` job (GitHub App token, `NPM_TOKEN`); `KeteUpdater` replaces
  `UpdaterDisabled`; the extension is published only by `kete-extension-publish.yml`. **Bites:**
  release file names, signature formats/identity, script flags, npm/formula names are public
  contracts; never let the updater install anything unverified or run a package manager.

## CLAUDE.md rules that act like decisions

- **§3 One runtime, thin clients** (`CLAUDE.md:68-70`): CLI/TUI, VS Code, JetBrains are
  all clients of a local `kete serve` over HTTP+SSE via the SDK — never agent logic in
  an extension.
- **§3 Runtime → Platform API, never → database** (`CLAUDE.md:71-73`): no direct
  Supabase/platform-DB connection from the runtime.
- **§3 Two required model-access modes** (`CLAUDE.md:74-77`): direct (BYOK/local) and
  gateway, neither a hard dependency for local use.
- **§3 No provider assumptions** (`CLAUDE.md:78-79`): no `if model == "claude"`;
  provider-specific logic stays in adapters.
- **§3 Execution location is explicit** (`CLAUDE.md:80-84`): `RuntimeType = "local" |
  "kete_cloud" | "enterprise_private"`, even though only `"local"` exists today.
- **§3 Platform independent** (`CLAUDE.md:86-87`): runtime core never depends on
  Vercel/Cloudflare/Supabase/AWS/Azure/GCP directly.
- **§3 Don't over-engineer future abstractions** (`CLAUDE.md:88-89`): sandboxes,
  multi-agent, workflows get clean seams, not speculative build-out.
- **§4 Upstream-first order** (`CLAUDE.md:100-106`): config → plugins/hooks → Kete
  modules → DI → minimal upstream edit.
- **§4 `kete_change` markers** (`CLAUDE.md:108-120`): every upstream-file edit marked;
  never reformat/refactor unrelated upstream code.
- **§5 Branding is centralized** (`CLAUDE.md:135-142`): binary `kete`, config dirs
  `~/.config/kete`/`./.kete` with no `.opencode` fallback, no hard-coded endpoints/
  credentials/org IDs/model names.
- **§5 Config precedence** (`CLAUDE.md:139-140`): platform policy → organization →
  project → user → workspace; for security policy the more restrictive setting wins.
- **§9 Never weaken security controls to ship a feature** (`CLAUDE.md:225-227`): fix the
  design instead, for auth, permissions, workspace boundary, secrets, TLS, input
  validation, sandboxing.
- **§9 High-risk operations need explicit policy** (`CLAUDE.md:229-232`): deletes,
  system files, `git push`/force-push/`reset --hard`, package installs, Docker,
  migrations, prod DBs, infra, deployment, credential access, external network.
- **§9 Workspace boundary** (`CLAUDE.md:233-234`): access to a workspace never implies
  access to `~/.ssh`, `~/Documents`, `~/Downloads`, or other repos; guard path traversal.
- **§9 Secrets** (`CLAUDE.md:237-240`): redact from tool output, logs, telemetry,
  errors; long-lived credentials in OS-native storage only, never plaintext config.
- **§9 MCP servers/plugins are trust boundaries** (`CLAUDE.md:241-242`): configured
  doesn't mean trusted — validate responses, scope permissions.
- **§10 No hidden failures** (`CLAUDE.md:252-253`): never swallow errors, skip failing
  tests, disable checks, or report success after failure.
- **§10 No fake implementations** (`CLAUDE.md:254-255`): no hard-coded success, fake API
  calls, mock auth, dummy persistence, silent fallbacks outside tests/labelled
  prototypes.
- **§10 No global mutable state** (`CLAUDE.md:262-263`): assume concurrent agents;
  protect files, git state, sessions, caches.
- **§11 Cross-platform** (`CLAUDE.md:269-271`): path utilities only, test paths/line
  endings/process spawning/PTY on Windows.
- **§11 Context efficiency** (`CLAUDE.md:275-276`): never send whole repos to a model;
  use search/indexing/summaries/caching.

## Platform ADRs this repo follows (owned by kete-code-platform)

- **Platform ADR 0008** (platform-managed agents): the shape and lifecycle of synced
  agents — this repo only consumes it, via `docs/platform/sync-v1.md` and
  `packages/util/src/kete/sync/contract.ts` (see `docs/context/contracts.md` §2).
- **Platform ADR 0016** (default tiers): tier→model resolution happens on the platform;
  the runtime only ever sees the resolved `model` on a `SyncedAgent`
  (`contract.ts:47`).
- **Platform ADR 0017** (mode `"all"`): a platform agent that's both primary and
  subagent-usable is sent as `mode: "primary", delegable: true` and mapped locally to
  Kete's `mode: "all"` (`packages/core/src/kete/sync/plugin.ts:13-14,402`) — see
  `docs/context/contracts.md` §2.

These three live and are decided in `kete-code-platform`; don't reverse or reinterpret
them here — only extend the client side per the contract doc.
