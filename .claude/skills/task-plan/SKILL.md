---
name: task-plan
description: Have the planner turn a task's agreed spec.md into plan.md.
disable-model-invocation: true
argument-hint: <task folder>
---
Plan the task in `$ARGUMENTS`.

1. Run `node scripts/agent/stale-cards.mjs` for the cards the spec names. If any are stale, have the `librarian` agent refresh them first (pass it the card names).
2. Call the `planner` agent with the task folder path only — never paste the spec or chat history.
3. Read its ≤10-line reply and `plan.md`. Large task, or a plan that edits upstream files, a shared contract, the config schema or security: show the user the plan's file table and steps and wait for approval.
4. Next: `/task-build $ARGUMENTS`.
