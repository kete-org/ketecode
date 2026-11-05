# Spec: WS1 Work enforcement

- Task: `docs/tasks/2026-11-05-ws1-work-enforcement` · Size: large · Created: 2026-11-05
- Status: closed (approved 2026-11-05, Phase A pre-approval: "continue building until Phase A is complete", recommended options) <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
The runtime enforces the Work profile on every Work session (`kete.sessionMode: "work"`, 1.2), so Work is
safe to offer: the agent can only touch folders the user granted, run only the bundled interpreters (never on
Windows), never use git, MCP or tools outside an allowlist, and gets no network from the shell. Every refusal is
written to the session's audit log. PR 1.3 of `docs/desktop-enhancement-plan.md`; stacked on 1.2.

## Scope
Modules: `permissions` (hooks), `sandbox`, `add-dir`, `audit-log`, `config-kete` (profiles), `roles-skills`.

A Kete-owned plugin (`core/src/kete/work-mode.ts`, registered next to the other Kete plugins) that does nothing for
Code sessions. For a Work session (read once per session; the mode is locked) it applies the profile's fields:

- **Tools: deny by default.** Only an allowlist runs: the file tools (`read`, `glob`, `grep`, `edit`, `write`,
  `patch`), `shell` (gated below), the web tools when `web` is on (`webfetch`, `websearch`), and the session's own
  bookkeeping tools (todo, skill, subagent/task, question, plan) — the planner confirms the exact names. So MCP tools
  (`mcp: false`), `worktree`, `session_move` and anything a plugin adds later are refused. Refused tools are also
  removed from the model's tool list, as Review mode does.
- **Files (`files: "granted"`).** A path is allowed only if its real path (symlinks and `..` resolved,
  `KeteRealPath`) is inside the session's location directory or a granted extra folder (`kete.dirs`, live). The
  project root and sibling folders don't count. `external_directory` outside the granted roots is denied, never
  asked. Covers every file tool's path input and the shell's working directory and `cd`. Phase B's grant store
  replaces "location + `kete.dirs`" later.
- **Shell (`shell`).** On Windows: refused outright (no OS sandbox; decision Q2). Elsewhere: every command segment's
  program must be in `allow` (`python`, `node`, plus `python3`); a wrapper (`sudo`, `env`, `sh -c`, `xargs`, `eval`,
  …), a substitution, or a line the tokenizer can't parse is refused. `git` and `gh` are never allowed (`git: false`).
- **Network (`network: "off"`).** The shell sandbox runs with network off for Work sessions whatever the global
  `kete.sandbox` setting says, and `sandbox_network` / `sandbox_off` requests are denied.
- **Audit.** Each refusal appends a line to the root session's audit log (`<data>/audit/<root>.jsonl`, line format
  v1, additive: a new line type for Work refusals) with the rule, tool and redacted input. A write failure is
  logged as an error; the action stays refused.
- **Availability.** Work stays `available: false` until 1.4 adds the `work-orchestrator` agent (a Work session
  without its agent would fail); tests exercise enforcement with sessions created through an injected available
  profile.

## Out of scope
- The grant store, Settings → Folders, `Kete Outputs/` and never-overwrite (WS2); action-class approvals (WS3).
- A Windows sandbox. Bundled or downloaded Python (Q3).

## Acceptance criteria
One test per rule, against a real Work session (injected available profile):
- [ ] AC1: Files — a read and a write outside the granted roots are refused; a symlink inside that points outside,
  and a `../` path, are refused; a sibling folder in the same project is refused; a granted `kete.dirs` folder is
  allowed; the location directory is allowed.
- [ ] AC2: Shell — `python script.py` and `node x.js` pass the gate; `curl …`, `git status`, `gh pr list`,
  `sh -c "python x"`, `env python x`, `python x | curl …`, `$(…)` are refused; on Windows every command is refused.
- [ ] AC3: Tools — an MCP tool, `worktree` and an unknown tool are refused and absent from the tool list; the web
  tools are allowed (profile `web: true`).
- [ ] AC4: Network — a Work session's sandboxed shell gets network off with a global setting of `all`, and a
  `sandbox_network` request is denied.
- [ ] AC5: Every refusal above writes an audit line (rule, tool) without secrets; a Code session is unaffected by
  every rule (same inputs pass as today).
- [ ] AC6: core typecheck, `bun run test ./test/kete`, server kete tests, lint, `upstream:check`, `verify --base main`.

## Risks and constraints
- Security-critical: deny by default, fail closed (an unparseable command or path is refused). A security review
  (`security-reviewer`) runs on the diff in addition to the reviewer.
- Upstream edits only if no Kete seam reaches a rule (e.g. the sandbox's per-session network, or a file path the
  project root counts as internal); each marked and recorded.
- Audit format stays v1-compatible (additive line type only).
