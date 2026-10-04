---
name: task-review
description: Review a built task — the reviewer always, the upstream-guard when the change touches an upstream (non-kete) file.
disable-model-invocation: true
argument-hint: <task folder>
---
Review the task in `$ARGUMENTS`.

1. Call the `reviewer` agent with the task folder path.
2. If the diff touches any path without `kete` in it (an upstream OpenCode file), call the `upstream-guard` agent with the folder path too (in parallel with the reviewer).
3. Blockers or majors: send the implementer the folder path and the findings, then re-verify (`/task-build` rules on loops apply).
4. Show the user the verdicts. Next: `/task-close $ARGUMENTS`.
