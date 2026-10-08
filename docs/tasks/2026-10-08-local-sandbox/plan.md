# Plan: Local OS sandbox (Wave 0b)

Single agent; plan written with the build (spec pre-approved). Order as built:

1. Schema: `schema/src/config/kete.ts` `Sandbox`; `schema/src/kete/sandbox.ts` RPC. Regenerate protocol + client.
2. Core pure modules in `core/src/kete/sandbox/`: `settings.ts`, `policy.ts`, `seatbelt.ts`,
   `bubblewrap.ts`, `actions.ts`, `plans.ts`; spawning `probe.ts` (kete-guard); fs `resolve.ts`
   (real paths, git layout, hooksPath, caches, credentials, Linux placeholders).
3. `core/src/kete/sandbox.ts`: `make().prepare`, `notice`, `decide`, `status`, guarded `Plugin`.
4. Upstream seams: `core/src/shell.ts` (wrap), `core/src/tool/plugin/shell.ts` (input, metadata,
   prepare, release, notice), `core/src/plugin/internal.ts` (register + guarded).
5. Approval marks: `permission-mode.ts` (asked or saved shell), `unattended.ts` (policy allow);
   sandbox actions bypass permission-mode's Plan rule.
6. Clients: `kete sandbox` (cli), TUI footer plugin, TUI/web permission prompt text.
7. Tests: `core/test/kete/sandbox.test.ts` (unit), `sandbox-policy.test.ts` and
   `sandbox-shell.test.ts` (real sandbox), unattended mark, spawn/fs site allowlists, cli + tui units.
8. CI: install bubblewrap in kete-checks, allow userns, `KETE_SANDBOX_TESTS=required`.
9. Docs: ADR 0013, `docs/sandbox.md`, `docs/permissions.md`, upstream-patches, cards, INDEX.

Verify: core `bun run typecheck`, `bun run test ./test/kete`, cli/tui/app typecheck + kete tests,
root `bun run lint`, `upstream:check`, `verify --base main`; Linux run in Docker (root, bwrap).
