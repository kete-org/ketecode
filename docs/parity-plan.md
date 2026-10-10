# Parity plan: Kete Code vs Claude Code and Codex CLI

One plan for every known gap against Claude Code and OpenAI's Codex CLI, merged and ordered.
It extends the competitive program approved on 2026-10-07 (Waves 0–4) with the gaps found on
2026-10-10: the Codex terminal comparison (`docs/tasks/2026-10-10-tui-codex-parity/spec.md`) and a
second Claude Code pass. Items marked *new* are not in the original waves. Approved by the
maintainer on 2026-10-10.

Direction: parity on the daily basics; lead on any model, local and self-hosted, context efficiency
and organization control. Build on OpenCode (CLAUDE.md §4); never copy Claude Code or Codex code or
assets.

Status keys: **done** (merged) · **in flight** (open PR or in progress) · **approved** (spec
approved, not built) · **planned** (in an approved wave, no spec yet) · *new* (proposed here, needs
a spec). Size: S (days), M (a week), L (more).

## Already at parity (no work)
Undo/redo of files and conversation · custom slash commands with arguments · markdown subagents,
including in isolated worktrees · workflows and orchestration · question tool · background shell ·
web search and fetch · image paste · `kete run --format json` with `--continue`/`--fork` · MCP OAuth,
resources and prompts-as-commands · VS Code diff review, editor context and diagnostics · `/init`,
`/review` · external editor · queued prompts and side questions · focus-gated notifications · model
variant cycling · per-message copy · session tabs, fork, resume · auto and manual compaction.

## Done or in flight (Waves 0–1a)
| Item | Status |
|---|---|
| Safe permission defaults and modes (Default/Auto/Ask/Plan) | done (#20, #22) |
| Local OS sandbox | done (#24) |
| Task list (todo) · LSP diagnostics · config hooks | done (#29, #30, #31) |
| Wave 1a follow-ups (sandbox_off policy forms, project hook env, Windows hooks) | in flight (`fix/wave1a-followups`) |
| Automated PR review and GitHub @kete mentions | done (#28; platform #75) |
| Scheduled cloud jobs · admin analytics and spend limits · gateway cloud providers | done (platform #74, #76, #85) |
| Terminal brand: violet, wordmark, animated logo, outlined prompt, prompt at the bottom of home | in flight (PR #33) |

## The plan

### Milestone A — Daily driver (Wave 1b + terminal basics)
Goal: nobody moving from Claude Code or Codex misses a basic.

| # | Item | Source | Status | Size | Upstream edits |
|---|---|---|---|---|---|
| A1 | **Status line**: configurable items (directory, branch, permission mode, context %, model + variant, cost, sandbox, balance, todo, local model), `/statusline` picker, setting in the TUI config. One item for Wave 1b's status line and the parity spec's P1 | both | approved (spec P1) | M | 1 (TUI config key) |
| A2 | **Memory**: CLAUDE.md compatibility, `@imports`, nested memory, quick "remember this", auto memory | Claude Code | planned (1b) | M | config loader |
| A3 | **Git helpers**: commit message generation, PR creation command | Claude Code | planned (1b) | S | none |
| A4 | **`/doctor`**: install, config, auth, provider, MCP, sandbox, terminal checks | Claude Code | planned (1b) | S | none |
| A5 | **Session sharing to the portal** (today `/share` exists but hosted sharing is off) | Claude Code | planned (1b) | M | none (platform API) |
| A6 | **Prompt history search** (Ctrl+R; rename moves to `<leader>r`) | Codex | approved (spec P2) | S | prompt |
| A7 | **New-session notices and tips**, sharing one notice list with the VS Code panel | Codex + panel | approved (spec P3) | S | none (slot) |
| A8 | **Terminal setup helper** (Shift+Enter newline per terminal) *new* | Claude Code | *new* | S | none |
| A9 | **`kete skill` commands**: `add <source>` (git repo, optionally a subfolder or tag; local path; org marketplace skill), `list`, `remove`, `update`; project `.kete/skills/` by default, `--global`. Shows the skill's files and scripts and asks before installing; pins the exact commit in a lockfile so `update` shows what changed; reuses the sync writer's hash checks and executable-bit stripping; runs nothing at install; org policy can limit sources; synced org skills can't be overwritten | Claude Code + Codex | *new* (approved 2026-10-10) | S–M | none |

### Milestone B — Context and trust (*new*, "Wave 1c")
Goal: lead on context efficiency and safe autonomy, the any-model advantage.

| # | Item | Source | Status | Size | Upstream edits |
|---|---|---|---|---|---|
| B1 | **Load MCP tools only when needed**: send tool names, fetch schemas on demand (tool search) | Claude Code | *new* | L | tool registry |
| B2 | **`/context` breakdown**: system prompt, tools, MCP, memory files, messages | Claude Code | *new* | M | none |
| B3 | **Prompt caching for Anthropic models**: verify what upstream's provider adapters do; add cache breakpoints if missing (gateway and BYOK) | Claude Code | *new* | S–M | provider adapter |
| B4 | **Plan approval**: Plan mode ends with a plan the user approves, then switches to Accept-edits or Default | Claude Code | *new* | M | plan agent |
| B5 | **More hook events**: before compaction, subagent stop | Claude Code | *new* | S | none |
| B6 | **`@`-mention MCP resources** in the prompt | Claude Code | *new* | S | autocomplete |
| B7 | **Output styles**: named personas (default, explanatory, learning, reviewer) | Claude Code | *new* | S | system prompt seam |
| B8 | **Security-review command**, reusing review_v1 | Claude Code | *new* | S | none |

### Milestone C — Power users (terminal)
| # | Item | Source | Status | Size | Upstream edits |
|---|---|---|---|---|---|
| C1 | **Transcript search** (`<leader>/`, `/find`) and a `/copy` picker (response, single code block, transcript) | Codex | approved (spec P4) | M | session route |
| C2 | **Vim mode** for the prompt (check upstream first) | Codex + Claude Code | approved (spec P5) | L | prompt |
| C3 | **Reasoning effort up/down** (Alt+. / Alt+,), **`/keymap debug`**, **Mermaid** investigation | Codex | approved (spec P6) | S | small |

### Milestone D — Team and automation (Wave 2)
| # | Item | Source | Status | Size |
|---|---|---|---|---|
| D1 | GitHub Action | Claude Code | planned (2) | M |
| D2 | Interactive cloud sessions and remote control of a local session (with Phase 8 P5) | Claude Code | planned (2) | L |
| D3 | SDK as `@ketecode/sdk`, plus Python | Claude Code | planned (2) | M |
| D4 | **Streaming JSON output** from `kete run` (for CI, Harness, SDK) | Claude Code | *new* | S |
| D5 | **Local recurring tasks** (`/loop`); cloud schedules already exist | Claude Code | *new* | S |

### Milestone E — Enterprise (Wave 3)
| # | Item | Source | Status | Size |
|---|---|---|---|---|
| E1 | SSO/SCIM | Claude Code | deferred by maintainer (2026-10-10) | L |
| E2 | Proxy and custom CA verified end to end | Claude Code | planned (3) | S |
| E3 | **Local managed-settings file** that users can't override, for offline and self-hosted machines; most restrictive wins with platform policy | Claude Code | *new* | M |
| E4 | **Plugin bundles and marketplace browsing** in the CLI (commands, agents, hooks, MCP together), installing from the platform's marketplace and MCP registry; single skills install earlier through A9 | Claude Code | *new* | L |

### Milestone F — Reach (Wave 4)
| # | Item | Source | Status | Size |
|---|---|---|---|---|
| F1 | Browser automation preset (Playwright MCP) | Claude Code | planned (4) | S |
| F2 | IDE pre-apply diff review everywhere; JetBrains Marketplace listing | Claude Code | planned (4) | M |
| F3 | Desktop app | Claude Code | planned (4, later) | L |
| F4 | **Jupyter notebook editing tool** | Claude Code | *new* | S |

## Order of work
One TypeScript agent at a time in the main checkout, so the milestones run in sequence; platform
work (A5, D2, E4's marketplace side) runs alongside.

1. Finish in-flight work: Wave 1a follow-ups, PR #33, release 0.2.7.
2. **Milestone A**, with A1 (status line) first, because A4, B2 and the mode label build on it.
3. **B3 and B1** next. Prompt caching is cheap and cuts cost at once; lazy MCP tools is the largest
   context win. Then B2, B4, and the small B items.
4. **Milestone C**, then **D4/D5**, then Wave 2's larger items (D1–D3).
5. **E3, E4**, then Wave 4.

Each item gets a task folder under `docs/tasks/` before it is built. The maintainer approved this
plan, including every item marked *new*, on 2026-10-10. Specs that follow the recommended options
are pre-approved; ask only on real trade-offs.

## Not planned
Voice mode (Codex F8), Codex's agent Command Center (session tabs cover it), browsing Codex cloud
chats, agents messaging each other as a team (belongs to Phase 6 multi-agent work).
