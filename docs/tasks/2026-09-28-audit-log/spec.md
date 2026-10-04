# Spec: Audit log for unattended runs (ADR 0008)

- Task: `docs/tasks/2026-09-28-audit-log` · Size: large · Created: 2026-09-28
- Status: approved (user, 2026-09-28)

## Goal
Every unattended run leaves a local, append-only record of what it did — tool calls, permission
decisions, model calls, file changes and commands — with secrets redacted, so a person (and later
`kete job run` and the cloud worker) can see afterwards what happened and which permissions to allow.

## Scope
- **Who is audited:** unattended session families only (`kete.unattended`, the `unattended` card).
  Interactive sessions are unchanged: no extra writes, no overhead.
- **Where:** one JSON Lines file per run, `<data dir>/audit/<root session id>.jsonl` (under
  `Global.Path.data`), append-only, file mode 0600. A run's subagents write to their root's file.
- **What each line holds** (versioned: `"v": 1`, a timestamp, `session_id`, root id, and the
  correlation ids that exist: `tool_call_id`, `message_id`):
  - `tool`: tool id, agent, redacted and truncated input, status, and the output's size plus a
    redacted, truncated excerpt (not the full output).
  - `permission`: action, resources, final effect (`allow`/`deny`), and for a deny the reason — the
    decision after every hook, so the unattended deny is recorded.
  - `model`: provider, model, token counts and cost per step.
  - `file`: path and operation for `edit`/`write`/`patch` (and the tool call that did it).
  - `command`: the shell command (redacted), working directory, exit code, duration.
  - `run`: started (the run's policy, limits) and ended (reason: completed, time limit, budget,
    error).
- **Redaction:** a small Kete redactor applied to every string field before it is written: known
  secret shapes (API keys, bearer tokens, private-key blocks, `KEY=value` pairs for secret-looking
  names, credentials in URLs). Truncation bounds each field (e.g. 2 KB) and each line.
- **Size bound:** a per-run cap (e.g. 20 MB). On reaching it the log writes one `truncated` line and
  stops recording detail but keeps recording `permission` and `run` lines.
- **Fail closed:** if the audit file can't be opened or written, the unattended run stops with a
  clear error (a run that can't be audited doesn't continue).
- Docs: `skill/kete.md` (where the log is), a new `audit-log` card, `docs/upstream-patches.md` for
  the plugin registration line.

## Out of scope
- Uploading to the platform (central audit logs are platform-owned; needs a platform endpoint first).
- A reading command (`kete audit …`); `kete job run` (next task) prints the file's path.
- Auditing interactive sessions.
- Retention/cleanup of old run files beyond the per-run cap.

## Acceptance criteria
- [x] AC1: An unattended run writes a `run` started line, and a `run` ended line with the reason
  (core Kete test).
- [x] AC2: A tool call, a denied `ask` (the unattended deny, with its reason), an allowed call, a
  model step (tokens, cost), an edit (file path) and a shell command each produce the expected line;
  a subagent's lines go to the root's file (tests).
- [x] AC3: Secrets in tool input, output excerpts and commands are redacted (an API key, a bearer
  token, a private key block, `PASSWORD=…`, a URL with credentials); long fields are truncated (tests).
- [x] AC4: Past the per-run cap, detail stops and one `truncated` line is written; permission and run
  lines continue (test).
- [x] AC5: When the audit file can't be written, the unattended run stops with a clear error (test).
- [x] AC6: An interactive session writes nothing (test).
- [x] AC7: core typecheck; core Kete tests; `bun run lint`; `upstream:check`; `verify --base main`.

## Risks and constraints
- **Security/privacy:** the log is itself sensitive (commands, paths, excerpts). Local only, 0600,
  under the data dir; never sent anywhere by this task. Redaction is best-effort pattern matching;
  excerpts, not full outputs, limit exposure.
- **Upstream edits:** a marked line in `plugin/internal.ts` (register last in `post` to see the final
  permission decision); upstream-guard reviews.
- **Contract:** the line format (`v: 1`) will be read by `kete job run`, the cloud worker and later
  the platform; additive changes only.
- Must not slow the agent loop: writes are small appends; no work for interactive sessions.
