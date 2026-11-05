# Spec: WS1 mode profiles

- Task: `docs/tasks/2026-11-05-ws1-mode-profiles` · Size: large · Created: 2026-11-05
- Status: closed (approved 2026-11-05, Phase A pre-approval: "continue building until Phase A is complete", recommended options) <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
The runtime reads and validates the Code and Work mode profiles, and tells clients which modes exist and
which are available. PR 1.1 of `docs/desktop-enhancement-plan.md`. Nothing changes how a session behaves
yet: 1.2 uses the profile's agent, 1.3 enforces Work's rules.

## Scope
Modules: `config-kete` (profiles are Kete config shipped in the binary), `permissions` (the fields 1.3
enforces), the handshake (`packages/schema/src/kete/handshake.ts`, `core/src/kete/handshake.ts`).

- **Schema** (`packages/schema/src/kete/modes.ts`, Kete-owned): an Effect `Schema` for a profile:
  - `id: "code" | "work"`, `name`, `description`, `agent` (the agent a new session starts with),
    `available: boolean`;
  - `files: "workspace" | "granted"` (Work: only folders the user granted);
  - `shell: { run: "any" | "allowlist" | "off", allow: string[], windows: "same" | "off" }`;
  - `network: "default" | "off"` (`default` = today's sandbox setting);
  - `git`, `web`, `mcp`: booleans (whether those tools are offered);
  - `approvals: "default" | "action-class"` (Work asks per action class, WS3);
  - `outputs: "in-place" | "kete-outputs"` (Work writes to `Kete Outputs/`, WS2).
  - Unknown keys are rejected, so a typo can't silently drop a restriction.
- **Profiles**: `code.jsonc` with today's behaviour (`build`, workspace, shell any, network default, git/web/mcp
  on, default approvals, in place); `work.jsonc` filled in (`work-orchestrator`, granted folders, shell
  allowlist `python`/`node` and off on Windows, network off, git off, web on, mcp off, action-class approvals,
  `kete-outputs`) with `available: false` until 1.3 enforces it.
- **Loader** (`packages/core/src/kete/modes.ts`): the profiles are embedded in the binary (text imports, as
  `models-dev/snapshot.txt` is), parsed as JSONC and decoded with the schema. An invalid profile is a test
  failure and a startup error, never a silent default. `list()` and `get(id)`.
- **RPC**, not a route: `kete.modes` with `list` → `[{ id, name, description, agent, available }]`, served on
  the existing `POST /api/rpc/kete.modes/list` like `kete.handshake`. The plan's `GET /api/kete/modes`
  becomes this RPC: no upstream route edit, no openapi or SDK regeneration (the same choice as 0.1).
  Registered by the Kete-owned handshake plugin (plan change: no `core/src/plugin/internal.ts` edit).
- **Handshake**: `modes` comes from the loader (the available ids), still `["code"]` until 1.3.
- Plan doc and `docs/upstream-patches.md` updated; `config-kete` card notes the profiles.

## Out of scope
- Session `mode` and the default agent from the profile (1.2); enforcing Work's rules (1.3); the
  `work-orchestrator` agent and the UI switch (1.4).
- User-editable or project profiles: the two profiles ship in the binary.

## Acceptance criteria
- [ ] AC1: Schema tests: both shipped profiles decode; an unknown key, a wrong `id` and a missing field are
  rejected with a message naming the field.
- [ ] AC2: Loader tests: `list()` returns code then work with Work unavailable; `get("code").agent === "build"`;
  `get("work")` carries network off, git off and the Windows shell rule.
- [ ] AC3: Server test: `POST /api/rpc/kete.modes/list` returns both modes with the right `available`
  flags; handshake `modes` is `["code"]`.
- [ ] AC4: Built binary (`bun run build --single --skip-install --skip-web-ui`) answers `kete.modes/list`
  (the embedded profiles survive compilation).
- [ ] AC5: core and schema typecheck and tests, server kete tests, lint, `upstream:check` pass.

## Risks and constraints
- Contract: `kete.modes` is a new plugin RPC; adding fields later is fine, changing one needs care (1.4's
  switch reads it). The handshake protocol stays 1 (no field changes).
- Security: this PR enforces nothing. The schema is strict so 1.3 can rely on every Work field being
  present. Profiles carry no secrets.
- Upstream edits: none (the plan registers `kete.modes` in the handshake plugin).
