# Spec: Local models: remote Ollama, setup and picker, offline mode, capabilities

- Task: `docs/tasks/2026-10-04-local-models` · Size: large · Created: 2026-10-04
- Status: approved (user, 2026-10-04: program order approved, "take the recommended options") <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
Make local models a first-class way to use Kete Code: point it at Ollama (or LM Studio, vLLM)
on this machine or another one, see clearly whether a local server is reachable and which models
it has, pull a model without leaving Kete, run fully offline when asked, and get honest behaviour
from models that can't call tools or have a small context window.

## Today (from the code, 2026-10-04)
- Upstream providers `ollama` (127.0.0.1:11434), `lmstudio` (:1234), `vllm` (:8000) in
  `core/src/plugin/provider/{ollama,lmstudio,vllm}.ts` auto-discover every 30 s (1 s timeout) and
  register models with `capabilities.tools`, input modalities and `limit.context`. A remote host
  works only through `providers.<id>.settings.baseURL`; there is no env var or UI. A server that
  isn't running fails silently: the provider just never appears.
- `capabilities.tools` is never read: a model without tool support still gets every tool.
- No offline mode. Default outbound calls: models.dev catalog (bundled snapshot is the floor),
  the Kete gateway and platform (`/api/v1/me`, `/models`, `/sync`, runtime registration) when
  configured or signed in, update checks, remote MCP servers and their OAuth metadata, `webfetch`
  and web search, LSP downloads, OTLP (only when configured).

## Scope (modules: core providers and config, tui, app (web UI / VS Code), cli; new card `local-models`)
1. **Remote and LAN hosts.**
   - `OLLAMA_HOST` (Ollama's own variable: `host`, `host:port` or a URL), and `KETE_OLLAMA_HOST`
     overriding it, set Ollama's base URL when `providers.ollama.settings.baseURL` isn't
     configured. Same for LM Studio (`KETE_LMSTUDIO_HOST`) and vLLM (`KETE_VLLM_HOST`). Config wins
     over environment.
   - Implemented as a Kete module that folds these into the providers' settings before the
     upstream plugins read them (minimal upstream wiring, marked).
   - A non-loopback `http://` host is allowed (Ollama has no TLS) but shown once as a warning: code
     sent to it crosses the network unencrypted (D2).
2. **Status, setup and the picker.**
   - A local-server status for each local provider: `reachable` (with model count), `unreachable`
     (with the URL tried and the error), or `not configured`. Exposed to clients over the existing
     server API so the TUI and the web UI read the same thing.
   - TUI model dialog and web/VS Code model picker: a "Local" group listing local models with a
     "no tools" badge where `capabilities.tools` is false and the context size; when a local
     server is unreachable, one line saying so (URL + how to start it), instead of silence.
   - First run: when no model is configured and a local server is reachable, the TUI and web UI
     offer "Use local models (Ollama, N models)" once; accepting sets the default model.
   - `kete models pull <name>` pulls an Ollama model (streams progress from `/api/pull`, honours
     the configured host, cancellable with Ctrl-C), then it appears on the next discovery
     (triggered immediately after a pull).
3. **Offline mode** (`--offline`, `KETE_OFFLINE=1`, or config `kete.offline: true`).
   - Only local providers are offered and used: `ollama`, `lmstudio`, `vllm`, and
     OpenAI-compatible providers whose base URL is loopback or a private-network address. A
     request to any other provider fails with a clear error (fail closed, never a silent fallback).
   - Off in offline mode: models.dev fetch (bundled snapshot only), the Kete gateway and platform
     calls (balance, models, sync, runtime registration), update checks and self-update, remote
     (URL) MCP servers and MCP OAuth metadata, `webfetch` and web search (denied with an
     explanation), LSP auto-download, OpenCode hosted services. Local (stdio) MCP servers keep
     working.
   - **Policy still applies:** organization policy synced earlier (cached) is enforced exactly as
     online; offline never widens permissions (CLAUDE.md "Offline").
   - The TUI and web UI show an "Offline" indicator.
4. **Capabilities and defaults.**
   - A model whose `capabilities.tools` is false runs **without tools**: the agent is told it has
     no tools and the user sees once per session that this model can only answer, not edit or run
     commands (D3). `capabilities.tools` in config overrides discovery (vLLM always reports false).
   - Ollama context window: when the discovered model context is large but Ollama serves a
     smaller window by default, Kete warns once with how to raise it (`OLLAMA_CONTEXT_LENGTH`, or
     `num_ctx` in a Modelfile). Requests send Ollama's `num_ctx` option where the API accepts it
     (D4).
   - The picker and `kete models` show, for local models: tools yes/no, vision, context size.
5. Docs: a "Local models" guide (`docs/local-models.md`), the `local-models` card, the outbound
   call list in the `attribution-hosted` card, README section.

## Out of scope
- Running a model inside Kete (no bundled inference engine) or managing GPU hosts.
- Cloud jobs using local models (they run on Kete's or customers' servers; job mode already
  restricts models).
- New local providers beyond Ollama, LM Studio, vLLM and OpenAI-compatible endpoints.
- Pull support for LM Studio/vLLM (no comparable API); they show status and models only.

## Decisions (recommended options, taken)
- **D1** Environment over nothing, config over environment: `KETE_OLLAMA_HOST` > `OLLAMA_HOST` for
  Ollama; config `providers.<id>.settings.baseURL` wins over both. Reusing `OLLAMA_HOST` matches
  what Ollama users already set.
- **D2** Plain-HTTP non-loopback hosts are allowed with a one-time warning rather than refused:
  Ollama ships without TLS and LAN GPU boxes are the main use; refusing would push users to
  disable the check. HTTPS hosts are verified normally (no TLS bypass).
- **D3** No-tools models run without tools (answer-only) instead of being hidden or sent tool
  schemas they can't follow; a config override exists for servers that under-report.
- **D4** Ollama's small default context is warned about, not silently papered over: the
  OpenAI-compatible endpoint can't always set `num_ctx`, so the warning gives the server-side fix.
- **D5** Offline mode is a single switch that fails closed for non-local providers and keeps
  enforcing cached policy; "local" includes RFC 1918/ULA private addresses so a LAN GPU host works
  offline from the internet.

## Acceptance criteria
- [ ] AC1: With `OLLAMA_HOST=192.168.1.20:11434` (and with `KETE_OLLAMA_HOST`), discovery uses
  that host; config `baseURL` wins over both; a non-loopback `http://` host logs the one-time
  warning (unit tests with a fake server).
- [ ] AC2: Local-server status (`reachable`/`unreachable`/`not configured`) is served by the
  server API and reflected in the TUI model dialog and the web picker, including the unreachable
  line (unit/component tests; TUI frame test).
- [ ] AC3: First-run offer appears once when no model is set and a local server is reachable, and
  accepting sets the default model (tests).
- [ ] AC4: `kete models pull <name>` streams progress, honours the host, handles errors and
  Ctrl-C, and triggers rediscovery (tests against a fake `/api/pull`).
- [ ] AC5: Offline mode: only local providers are listed; a cloud provider request fails closed
  with a clear error; models.dev, gateway, platform sync/registration, update checks, remote MCP
  and webfetch/websearch make no network calls (tests asserting no outbound requests); cached
  policy is still enforced (test).
- [ ] AC6: A model with `capabilities.tools === false` gets no tools and the user notice; a config
  override re-enables tools (tests).
- [ ] AC7: Ollama small-context warning shown once when applicable (test).
- [ ] AC8: Docs and the `local-models` card exist; `upstream:check` passes (every upstream edit
  marked and recorded); touched packages' typecheck and tests pass.

## Risks and constraints
- Security: offline mode must fail closed and never bypass policy; the plain-HTTP warning must not
  become a TLS bypass; `kete models pull` downloads model weights only through the user's own
  Ollama server (Kete never downloads or runs binaries).
- Upstream-first (CLAUDE.md §4): extend the existing provider plugins through configuration and
  Kete modules; upstream provider files get only minimal, marked edits.
- Contracts: new CLI flag/command (`--offline`, `kete models pull`), env vars and config keys
  (`kete.offline`) become public contracts once released.
- Cross-platform: env parsing, `Ctrl-C` cancellation and paths on Windows.
