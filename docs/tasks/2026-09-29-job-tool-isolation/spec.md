# Spec: Job mode, part 1: a process seam and job-mode config and model requests

- Task: `docs/tasks/2026-09-29-job-tool-isolation` · Size: large · Created: 2026-09-29
- Status: approved (user, 2026-09-29)

## Goal
Prepare the runtime for cloud jobs (platform ADRs 0018–0021, `docs/jobs.md` §8 in
kete-code-platform) with the two cross-platform pieces every later piece depends on: one
Kete-owned seam through which the runtime starts every process, and a "job mode" that ignores
untrusted repository configuration and sends only model requests the gateway accepts for job keys.
Pieces 2–4 and 6 (the Go root helper, `openat2`, the unix-socket server, the container image)
are later tasks (user decision, 2026-09-29: start with pieces 1 and 5; the helper is written in Go).

## Scope
- **Job mode** (unattended card): a run is in job mode when `kete job run` starts it inside the
  cloud image, marked explicitly (a flag the entrypoint sets, e.g. `KETE_JOB_MODE=1` or a
  `--cloud` option; the plan chooses), never inferred. Job mode implies unattended (ADR 0008).
- **Process seam (piece 1):** every place the runtime starts a process — the shell tool, PTY,
  git, formatters, language servers, MCP stdio servers, anything else the scout finds — goes
  through one Kete-owned spawner interface. Locally (and interactively) it behaves exactly as
  today. In job mode it routes to a **tool runner** interface whose real implementation (the
  root helper client) is a later task; until then job mode uses a stub that **refuses** to spawn
  (fail closed), never falls back to spawning as `kete`. Processes that can't go through the
  runner in job mode (formatters, language servers, MCP stdio) are disabled in job mode.
- **Job-mode configuration (piece 5, §8 item 5):** the repository's `.kete/`, `kete.json`/
  `kete.jsonc`, plugins, MCP servers and agent definitions are not loaded in job mode (or only
  where they narrow — the plan decides which, per file type); no MCP server starts (D12).
- **Job-mode model requests (§8 item 7):** in job mode the runtime sends only client-defined
  function tools, no provider-side tools, one candidate, an output-token limit within the
  platform's, `store: false` and no `previous_response_id`/`background` for OpenAI Responses,
  and content inline only (text, or base64/`data:` media; never a URL or file reference).
- **Job-mode registration (§8 item 8):** runtime registration off in job mode;
  `runtime_type` comes from config as today.
- Docs: `skill/kete.md`, `docs/jobs.md` (kete-code), the cards touched.

## Out of scope
- The Go root helper, its socket protocol and the tool user (next task); `openat2`; the unix-
  socket server and per-run secret; the gateway key by descriptor; the entrypoint-owned sink;
  the container image and entrypoint.
- Any change to interactive or local `kete job run` behaviour outside job mode.

## Acceptance criteria
- [ ] AC1: Every process the runtime starts goes through the seam (a test enumerates the spawn
  sites, or a lint/grep check fails on a direct spawn outside the seam).
- [ ] AC2: Outside job mode, behaviour is unchanged (existing shell, PTY, git, formatter, LSP and
  MCP tests pass).
- [ ] AC3: In job mode, a shell/tool call with the stub runner is refused with a clear error and
  nothing is spawned as `kete`; formatters, LSPs and MCP stdio servers don't start.
- [ ] AC4: In job mode, repository `.kete/`, `kete.json(c)`, plugins, MCP servers and agent
  definitions are ignored (or only narrow, as the plan specifies) (tests).
- [ ] AC5: In job mode, outgoing model requests conform to the rules above for each provider
  adapter in use (tests on the request bodies); a request that can't conform fails locally
  with a clear error rather than being sent.
- [ ] AC6: In job mode, runtime registration doesn't run.
- [ ] AC7: typecheck, Kete tests and the touched packages' suites; lint; `upstream:check`;
  `verify --base main`.

## Risks and constraints
- **Security:** job mode must fail closed — no path spawns a process as `kete` in job mode.
- **Upstream edits:** spawn sites are in upstream code (shell tool, PTY, git service, formatter,
  LSP, MCP); the seam needs marked edits there — the plan must list them and keep them minimal.
- **Contract:** the job-mode flag becomes part of the image ↔ runtime contract (§8).
- Provider adapters differ; the model-request rules must be enforced per adapter without
  `if model == …` business logic (CLAUDE.md §3: use capabilities, adapters).
