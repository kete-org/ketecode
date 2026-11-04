# Handoff: Plan approval (parity B4)

## 2026-11-04 security review (security-reviewer subagent)
No path raises permissions without the user's own form answer (forms are answered only through the
server's `session.form.reply`; subagents, codemode, workflows and unattended runs are refused).
Fixed after the review:
- the app, VS Code panel and ACP only show forms of known kinds, so the form is now a `question` form;
- `kete run` dismisses it with a message, now feedback instead of a failed run;
- a stale or duplicate answer: one open question per session, Plan mode re-checked before changing anything;
- a session without an agent whose default is `plan`, and a missing `build` agent;
- a plain dismissal ends the step, like the question tool;
- `Permission.assert(question)` so policies can deny it.
Not fixed: the metadata read-modify-write isn't atomic with a concurrent `/add-dir` removal (a microsecond
window needing a user action; same as every metadata writer). Not checked: a ~200-line plan in the TUI's
form (it renders the description unscrolled; options might be pushed off screen) — manual check.
