# Handoff: Automated PR review — runtime side (`review_v1`)

## 2026-10-09 builder (single session)

Done: everything in spec.md; checks in result.md. Not merged.

### Design decisions
- **Findings channel.** The `review` tool (job mode, review jobs only) checks the whole review against
  the contract and records it in kete's state directory (`review.json`, last call wins; kete's home,
  which the tool user can't write, and a review job runs no tool process at all). `kete job run`
  reads it into its `--json` result's `review`; the entrypoint takes that `review` from kete's stdout
  (also unforgeable by the tool user) and bounds it again in Go before posting. The entrypoint does
  not read the record file directly, so a run killed at its time limit reports no review (missing).
- **Read-only enforcement, layered.** (1) Entrypoint: no `KETE_JOB_TOOL_SOCKET`, no tool-user hosts.
  (2) Server: tool runner always the fail-closed stub, repository AGENTS.md never loaded as
  instructions (initial discovery off, read-tool nearby injection no-op). (3) Plugin: only `read` and
  `review` offered; every other tool refused at `tool.execute.before`; every permission action but
  `read` denied (incl. `external_directory`). Shell is **denied**, not read-only-classified.
- **No search tool.** grep/glob spawn ripgrep through the tool runner — a subprocess on the checkout,
  which the contract forbids — so they are unavailable; the agent has the changed-file list, the diff
  (≤ 160 KiB) and `read` (files and directories, confined). Follow-up option: an in-process search
  over the confined driver.
- **Pristine layout.** Head → `refs/heads/<spec.branch>`, base → `refs/heads/<base_ref>`, HEAD = base
  (a first layout with HEAD = head broke `AgentCopy`; caught by the real-git test). A spec whose
  branch equals the base is refused.
- **Merge base.** Depth 50, deepened once by 450, head re-verified after the deepen; no merge base →
  `refused` (the handoff allowed refusing instead of a `base...head` fallback).
- **Bounding.** Strict shape errors drop the review whole (as the platform would); value overruns are
  cut (texts by JavaScript length, invalid findings dropped, `max_findings`, then drop from the end to
  fit 64 KiB measured without HTML escaping). Notes are fixed words.

### Not verified here
- The job-image e2e scenario `review` runs only in CI (Docker, privileged, Linux); see result.md.
- Real GitHub serving `refs/pull/<n>/head` of a fork PR over the base repo's clone token (the
  platform's staging list covers the API side).
- The synced reviewer agent's own permission rules: if they wholly deny `review`, the tool is hidden
  and the job reports no review (missing).

### Open questions
- Should a time-limited run still post the findings recorded so far (entrypoint reading the record)?
- Is an in-process search for review mode wanted (quality vs. surface)?
