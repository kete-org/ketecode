# Task metrics

One row per closed task. A rising scout hit rate means the knowledge base is working. After
about 10 tasks, drop any agent that isn't saving calls.

| Date | Task | Size | Agents used | Scout lookups | Docs enough | Hit rate | Tokens / cost | Time |
|---|---|---|---|---|---|---|---|---|
| 2026-09-28 | runtime-type | large | scout, planner, implementer, reviewer, librarian | 3 | 3 | 100% | ~0.55M subagent tokens | ~1 h 30 min |
| 2026-09-28 | unattended-policy | large | scout, planner, 2× implementer, 2× reviewer, 2× upstream-guard, librarian | 5 | 3 | 60% | ~1.6M subagent tokens | ~3 h |
| 2026-09-28 | audit-log | large | scout, planner, 2× implementer, 2× reviewer, librarian | 5 | 1 | 20% | ~1.3M subagent tokens | ~2 h 45 min |
| 2026-09-28 | job-run | large | scout, 2× planner, 2× implementer, 3× reviewer, upstream-guard, librarian | 6 | 2 | 33% | ~2.1M subagent tokens | ~3 h 30 min |
| 2026-09-29 | chat-panel-design | large | scout, 2× planner, 4× implementer, reviewer, upstream-guard, librarian | 6 | 3 | 50% | ~1.7M subagent tokens | ~1 day |
| 2026-09-29 | job-tool-isolation (job mode part 1) | large | planner, implementer, reviewer, upstream-guard, librarian | 0 | – | – | ~0.9M subagent tokens | ~4 h |
| 2026-09-30 | job-root-helper | large | scout, planner, 4× implementer, 2× reviewer, librarian | 5 | 3 | 60% | ~2.5M subagent tokens | ~1 day |
| 2026-09-30 | job-egress | large | planner, general builder, 2× reviewer, librarian | (shared) | – | – | ~1.6M subagent tokens | ~6 h |
| 2026-10-01 | job-socket-server (A1) | large | scout, planner, builder, reviewer, upstream-guard, librarian | 5 | 0 | 0% | n/a | ~6 h |
| 2026-10-01 | job-sync-key (A2) | large | scout, planner, implementer, verifier, reviewer, librarian | 5 | 1 | 20% | n/a | ~1 day |
| 2026-10-01 | job-image (piece D, PR 2) | large | planner, general builder, general investigator, reviewer, librarian | 1 | – | – | n/a | ~1 day |
| 2026-10-02 | job-file-confinement (A3) | large | scout, planner, general builder, 2× reviewer, librarian | 4 | 1 | 25% | n/a | ~1 day |
| 2026-10-02 | job-gateway-allowlist | medium | scout, reviewer | 1 | 1 | 100% | n/a (~167k subagent tokens) | ~2 h |
| 2026-10-03 | job-host-profiles (self-hosted P1) | large | one build agent (no subagents) | 0 | – | – | n/a | ~3 h |
| 2026-10-03 | job-host-agent (self-hosted P2) | large | one build agent (no subagents) | 0 | – | – | n/a | ~3 h |
| 2026-10-03 | job-host-firecracker (self-hosted P4) | large | one build agent, reviewer | 0 | – | – | n/a | ~4 h |
| 2026-10-03 | job-host-dedicated (self-hosted P5, agent side) | large | one build agent, reviewer | 0 | – | – | n/a | ~3 h 30 min |
| 2026-10-04 | cli-distribution | large | one build agent, reviewer | 0 | – | – | n/a (~84k subagent tokens) | ~3 h |
| 2026-10-04 | job-host-cloudvm-images (self-hosted P7) | large | one build agent, librarian | 0 | – | – | n/a | ~3 h |
