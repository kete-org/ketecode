---
name: task-close
description: Close a task — write result.md, refresh the knowledge base, log metrics.
disable-model-invocation: true
argument-hint: <task folder>
---
Close the task in `$ARGUMENTS`.

1. Write `result.md` in the folder: what changed (files), the verifier's check results, each acceptance criterion with its evidence.
2. Run `node scripts/agent/stale-cards.mjs`.
3. Collect every "Docs enough: no — missing: …" line from this task (`handoff.md` and scout replies this session). Call the `librarian` agent with the folder path, the stale card names and those gaps.
4. Run `node scripts/agent/card-check.mjs`; it must pass.
5. Fill `result.md` → Metrics (agents used; scout lookups and how many said "Docs enough: yes"; tokens or cost from `/usage` if shown; time) and append the same row to `docs/tasks/metrics.md`.
6. Tell the user what's ready to commit. Never commit, push or merge unless the user asks.
