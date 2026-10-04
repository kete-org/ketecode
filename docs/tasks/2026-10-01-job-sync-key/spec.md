# Spec: Job mode piece A2: sync from the job's gateway key

- Task: `docs/tasks/2026-10-01-job-sync-key` · Size: large · Created: 2026-10-01
- Status: approved (user, 2026-10-01)

## Goal
In a cloud job, `kete` syncs the job's agent, its skills and the organization's policies from the
platform using the job's gateway key (no account file), waits for that first sync before the session
starts, and fails closed if it can't — so every model call carries the agent the gateway pins, and
policies always apply. Piece A2 (kete-code-platform `docs/jobs.md` §8 item 6; ADR 0020 rules 3, 9).

## Scope
- **Credential:** in job mode only, sync (`GET /api/v1/sync` and the skill-file fetches) uses the
  job key from A1's in-memory holder as the Bearer credential and the platform URL from the
  entrypoint's environment (the same rule as the gateway); no account file is read and no account
  URL or `kete.platform.url` is used. Outside job mode nothing changes. The request stays sync v1 —
  the platform scopes by key kind, so no new header.
- **First sync is required:** in job mode the first sync completes before `kete job run` creates its
  session. If it fails, or returns no agent matching `spec.agent` (a slug), `kete job run` refuses
  with a clear `error`/`refused` result before prompting — no default-agent fallback.
- **Policies fail closed:** in job mode the plugin treats the run as signed in for its policy guard,
  so a missing policy set means "ask", which the unattended late hook turns into "deny".
- **Later refreshes** (every 5 min, stale-agent resync) keep today's last-copy fallback.
- **Messages:** a job-mode 401 says the job key was refused (no `kete login` advice).
- **Cache:** written under the job's private config dir as today, keyed by the org from the first
  response.
- Tests with the existing TS fakes (no platform job keys exist yet; that's a platform build task).

## Out of scope
- The platform side (job API keys, job-scoped sync) — kete-code-platform build tasks.
- The image and end-to-end run (PR 2); A3.

## Acceptance criteria
- [ ] AC1: In job mode, sync sends `Authorization: Bearer <job key>` to `<KETE_PLATFORM_URL>/api/v1/sync`
  (and skill files), reads no account file, and ignores configured platform URLs (tests).
- [ ] AC2: The job's synced agent is applied (slug match) and model requests carry its
  `x-kete-agent-id`/`-version`; synced skills and policies apply (tests).
- [ ] AC3: `kete job run` waits for the first sync; a failed first sync, or `spec.agent` not among the
  synced agents, refuses before any prompt, with a clear message (tests).
- [ ] AC4: In job mode with no policies loaded, `edit`/`shell`/`webfetch` are denied (fail closed) (test).
- [ ] AC5: Outside job mode, sync behaves exactly as before (existing tests).
- [ ] AC6: typecheck, Kete tests, lint, `upstream:check`, `verify --base main`.

## Risks and constraints
- Contract: sync v1 unchanged; relies on the platform accepting a job key (not built yet) — the
  platform task must match this.
- Startup latency: the first sync now blocks job start (bounded by the sync timeout).
