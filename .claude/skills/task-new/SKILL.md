---
name: task-new
description: Start a medium or large task — create its folder and agree spec.md with the user.
disable-model-invocation: true
argument-hint: <slug> [medium|large] [title]
---
Start a task: `$ARGUMENTS`

1. Read `docs/context/INDEX.md` (task sizes and flow).
2. Size it. Small (a few files; no upstream edit, shared contract, config schema or security change): no folder — say so, then scout if needed → edit → narrow check. Otherwise run `node scripts/agent/task-new.mjs $ARGUMENTS`.
3. Draft `spec.md` in the new folder with the user: goal, scope (name the module cards), out of scope, testable acceptance criteria, risks. Use the `scout` agent for any "where/how" question; don't explore code yourself.
4. Stop when the user agrees the spec (Large: when they approve it). Set its Status line. Next: `/task-plan <folder>`.
