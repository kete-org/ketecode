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

## 2026-10-09 builder (security review fixes, PR #28)

Done on the same branch:
1. **Object checks.** The review fetch and deepen set `fetch.fsckObjects=true` and
   `transfer.fsckObjects=true` (`gitops/ops.go` `fsckConfig`), so root refuses malformed
   fork-authored objects (bad tree entries, `.gitmodules`, `.gitattributes`) at index-pack. Real-git
   test: a commit whose tree has a `..` entry is refused (`hasDotdot`) and is taken without the checks
   (`TestReviewFsckRefusesMalformed`). Applies to review fetches only; ordinary job clones fetch the
   organization's own branch and are unchanged.
2. **Git floor.** New boot step `git_version` fails closed unless root's git is ≥ 2.39.1
   (`gitops.MinVersion`, `CheckVersion`); the image build checks the same floor with `dpkg
   --compare-versions`. A floor is not proof of a patched git (distros backport without bumping the
   version); the image takes debian:trixie's security updates at build time (git 2.47.x there).
3. **AGENTS.md end to end.** Server tests (j)/(k): a review session never sends the root or a
   subdirectory AGENTS.md to the model (session start, and reading a file beside it), while the read
   file's content does reach it; the control without review mode sends both markers.
4. Nits: summary, titles and bodies pass through `KeteRedact.text` in the `review` tool before they
   are recorded (the Go side has no vetted redactor, as for kubevm summaries); the review path runs
   Verify's storage checks (`VerifyStorage`: SHA-1 objects, no alternates).

**Size/time bounds of a review (DoS).** Fetches: depth 50 then at most one deepen of 450, each fetch
bounded by the clone timeout (10 min) and the job's deadline; objects are fsck'd. Merge base and each
diff call: the git call timeout (60 s) each; diff output capped (files 32 KiB, diff 160 KiB; git still
computes the whole diff before the cap, bounded by the 60 s). The agent phase is bounded by the
policy timeout and budget as every job. A pathological PR therefore ends `error`/`refused`, never
hangs the job.
