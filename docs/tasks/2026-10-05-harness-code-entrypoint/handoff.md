# Handoff: Job entrypoint: Harness Code clones (jobs-v1 additive fields, clone-done revoke)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-05 build agent

Done: the platform's runtime handover items 1–8 (see result.md). CI green on the first round for
`kete-job-entrypoint` and `kete-build` (PR #9, draft).

Decisions: GitHub keeps its failure paths unchanged (clone-done only after a successful clone);
`null`/non-string provider or username refused; Harness clone-done also on a refused branch.

Open: release order — ship an image with this entrypoint only after kete-org/ketecode-portal#68 is
deployed. Real Harness verification is on the platform's staging list.
