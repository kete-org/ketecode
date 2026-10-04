---
name: task-build
description: Build a planned task with the implementer, then verify it.
disable-model-invocation: true
argument-hint: <task folder>
---
Build the task in `$ARGUMENTS`.

1. Call the `implementer` agent with the task folder path.
2. If it replies PLAN WRONG: call the `planner` again with the folder path (it reads `handoff.md`), then the implementer again.
3. Call the `verifier` agent with the folder path.
4. On FAIL: call the implementer once more with the folder path and the failing lines. A second verification failure goes back to the `planner`; if the next round fails too, stop and ask the user. No further loops.
5. Next: `/task-review $ARGUMENTS`.

Independent work may run in parallel; parallel code edits only in separate git worktrees.
