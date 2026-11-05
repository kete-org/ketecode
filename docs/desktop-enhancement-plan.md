# Desktop enhancement plan: Code | Work workstation

Status: **approved** (2026-11-04); Phase A (WS0 + WS1) next. Nothing in this plan is built yet. The source brief is
"Enhance the Kete Code Desktop App (Work mode + WorkBuddy-parity features)". `specs/work-mode-spec.md`,
which the brief names, is not in this repository, so the brief is treated as the spec. Platform items are
marked **[platform]** and become issue specs under `docs/platform-issues/`, not code here.

## 0. Where the brief and this repository differ

| Brief | This repository | Plan |
|---|---|---|
| `packages/kete` (runtime, `kete serve`) | `packages/core` (agent, tools, permissions), `packages/server` (HTTP/SSE), `packages/cli` (`kete serve`) | Use the real packages. Kete code goes in `src/kete/` inside each. |
| `packages/kete/modes/*.jsonc` | `packages/core/src/kete/modes/{code,work}.jsonc` (Phase 0) | Keep that location. |
| `docs/UPSTREAM_TOUCHPOINTS.md` | `docs/upstream-patches.md`, checked by `upstream:check` | Keep `upstream-patches.md` as the single record (CLAUDE.md §4); don't start a second list. |
| "short-lived Kete token from `kete login`" (§3.5) | `kete login` stores a long-lived org API key (`kete_sk_…`) in the OS key store | **Open question Q1.** Short-lived tokens need a platform token-exchange endpoint. |
| Connector tokens never on the desktop (WS6) | Upstream MCP OAuth stores tokens locally (`core/src/mcp/oauth.ts`, `Credential.OAuth`) | Vaulted connectors are a new path through the gateway proxy. Local/custom MCP keeps the upstream behaviour. |
| Network-off for skills (§3.3, WS1, WS5) | The OS sandbox covers macOS (Seatbelt) and Linux (bwrap); **Windows has none** | **Open question Q2.** It blocks "network off" on Windows. |
| Playwright-Electron e2e | None exists. The app has Playwright browser e2e (`packages/app/e2e`) and story component tests. | A new harness in WS0 (PR 0.4). |

Existing work this builds on (merged 2026-11-04): Electron desktop (#78), desktop sign-in through the
`kete.account` RPC (#82), the sidebar and composer-first home with a Build | Plan switch (#83).

## 1. Current state and gaps per workstream

**WS0 Groundwork.**
- Exists:
  - The desktop main process starts or adopts `kete serve --service` through `client.Service.ensure`, with a version requirement (`desktop/src/main/service/background-service.ts:58-73`, `cli-version.ts`).
  - `/api/info` (version, pid) serves as the start-up compatibility probe (`client/src/service-probe.ts`).
  - The renderer polls `server.info` every 10 s (`app/src/runtime/server/health.ts`), and the SSE client asks the main process to reconnect (`desktop/src/main/ipc-handlers/app.ts:33`).
  - `ServerUnavailablePanel` (incompatible / unreachable) appears only inside the session route.
  - Sign-in exists (#82).
- Gaps:
  - Nothing in the main process watches for a sidecar crash, so restarts happen only when the renderer asks.
  - No global "runtime stopped, restarting" banner.
  - No app↔server protocol version after connect (only CLI/service versions).
  - No 5 s recovery target or test.
  - No Electron e2e.
  - The packaged app has never been run by hand.
  - macOS CI hasn't run on `main` lately (runner capacity).

**WS1 Mode switch and Work profile.**
- Exists:
  - `modes/code.jsonc` (agent `build`) and a placeholder `work.jsonc`. Nothing reads them, and there's no schema.
  - Default agent is hard-coded `build` (`core/src/agent.ts:13`); plugins add agents through `agent.transform` (`kete/roles.ts`).
  - Permission modes (`kete/permission-mode.ts`).
  - Shell risk classes (`kete/shell-risk.ts`).
  - `external_directory` asks plus `cd` tracking (`kete/shell-directory.ts`).
  - Real-path resolution (`kete/real-path.ts`).
  - `--add-dir` grants (`kete/add-dir-plugin.ts`).
  - OS sandbox with network off by default (macOS and Linux).
  - Per-server MCP rules.
- Gaps:
  - No profile loader or validation.
  - No `GET /modes` and no session `mode`.
  - No per-profile permission set.
  - No bash allowlist (only risk classes), no git-off rule, no per-profile web/MCP switch.
  - No `work-orchestrator` agent.
  - No Code | Work switch in the UI.

**WS2 Folder grants and outputs.**
- Exists:
  - Per-session extra folders (`--add-dir`, `/add-dir`, `kete.dirs`) with sandbox write access; subagents inherit them.
  - Folder trust (`util/src/kete/folder-trust.ts`, `kete trust`), which holds back project policy until trusted (a different concept).
  - Symlink and `..` resolution before checks (`KeteRealPath.follow`).
  - Native folder picker (`desktop/src/main/files/index.ts`, `Platform.openDirectoryPickerDialog`).
- Gaps:
  - No persistent per-user/device grant store, no Settings → Folders, no live revoke.
  - No `Kete Outputs/` or never-overwrite rule.
  - No collision suffix.

**WS3 Plan-before-run and approvals.**
- Exists:
  - Upstream `plan` agent and Kete Plan mode (read-only tools).
  - `permission.asked` / `permission.replied` over SSE; replies through `Permission.reply`.
  - No timeout path, so an ask never turns into an approval.
  - `SessionPermissionDock` per session; an "approval" inbox state only for sessions the client opened (`shell/titlebar/inbox-model.ts`).
  - Unattended policy fails closed.
- Gaps:
  - No structured Plan artifact (steps, files, connectors, egress, credits) and no Run/Edit/Cancel.
  - No action-class gates (`fs.delete`, `fs.overwrite`, `net.send`, `payment.*`, `mcp.write`) from the profile.
  - No `decided_via`.
  - No approvals inbox across sessions, no badge, no OS notification.

**WS4 Library.**
- Exists:
  - `node:sqlite` storage with migrations in the desktop main process (`desktop/src/main/storage/database.ts`).
  - docx/pptx/xlsx rendering workers (`gui-plugins/src/microsoft-office/`).
  - `Platform.openPath`; `shell.showItemInFolder` in the main process (not exposed).
- Gaps: everything else — index, views, search, PDF preview, templates, share links **[platform]**, scheduling hand-off.

**WS5 Loom.**
- Exists:
  - Skill discovery from `~/.config/kete/skills`, project `.kete/skills`, `.claude`/`.agents` roots and config URLs.
  - YAML-only front-matter.
  - `kete skill add` with `skills.lock.json`.
  - The Extensions settings page has a skills subtab.
- Gaps:
  - No gallery, no permission manifest, no per-skill network enforcement.
  - No kete-loom-pro listing **[platform]**, no verified/unverified badge.
  - No `/skill` composer entry beyond the existing command list (to confirm).
- Note: the brief's `~/.kete/skills` is not a path Kete uses (`~/.config/kete/skills`).

**WS6 Connectors.**
- Exists:
  - Upstream MCP client and config.
  - Kete MCP presets (harness, slack, playwright) in `schema/src/kete/mcp-presets.ts`.
  - Secrets kept as `{kete-secret:…}` in the OS key store.
  - Upstream remote-MCP OAuth with PKCE.
  - Offline mode skips remote servers.
- Gaps:
  - No catalog UI.
  - No portal-held OAuth or gateway MCP proxy **[platform]**.
  - No read-only vs read-write toggle, no `mcp.write` gate, no "used by".

**WS7 Experts.**
- Exists: agents and starter roles (code-reviewer, qa, docs-writer, security, devops); the Build | Plan switch.
- Gaps:
  - No expert model or portal sync **[platform]**.
  - No Team (auto) orchestrator or assignment view.
  - No default Work experts, no Reviewer-last rule, no JD → expert **[platform]**.

**WS8 Automation.**
- Exists:
  - `core/src/schedule.ts` (cron / interval / one-shot, SQL-backed) behind `experimental.schedules`.
  - The `schedule` tool.
  - The audit log for unattended runs (`kete/audit.ts`).
- Gaps:
  - No UI or run history.
  - No cloud runner **[platform]**.
  - No folder-grant validation.
  - No pause-on-gate notification.
  - The known follow-up that schedule condition commands bypass the OS sandbox must be fixed before Automation ships.

**WS9 Phone control.**
- Exists: the `pairing` GUI plugin (a template for Settings → Phone) and the notification plumbing.
- Gaps: everything — link code, realtime device channel, mirrored approvals, queue **[platform relay]**.

**WS10 Credits and audit.**
- Exists:
  - Gateway balance from `GET /api/v1/me`, refreshed every minute (`core/src/kete/gateway.ts`).
  - Per-session `cost`.
  - `kete.budget.session`.
  - The unattended audit log.
- Gaps:
  - No credit UI, low-balance warning or BYO-key "not metered" state.
  - No per-task estimate vs actual.
  - No general Activity/Audit view or CSV export.
  - No Paystack top-up link **[platform]**.

## 2. Upstream files expected to change (all marked `kete_change`, recorded in `docs/upstream-patches.md`)

| File | Why | Workstream |
|---|---|---|
| `packages/core/src/agent.ts` | the default agent comes from the session's mode profile instead of the hard-coded `build` | WS1 |
| `packages/core/src/session/*` (create path) | store `mode` on the session (metadata, as `kete/mode.ts` already does) | WS1 |
| `packages/core/src/permission.ts` | `decided_via` on replies; action-class asks (`fs.delete`, `net.send`, …) | WS3 |
| `packages/server/src/process.ts` / routes | register library/approvals routes (one marked mount, as the account gate does); the protocol handshake is the `kete.handshake` plugin RPC and needs no route | WS0, WS1, WS3 |
| `packages/desktop/src/main/service/background-service.ts` | a crash watcher that calls the existing `ensure`, plus a banner event | WS0 |
| `packages/app/src/shell/state/layout.tsx` | accept the new top-level routes (Assistant, Experts, Loom, Connectors, Automation, Library), or keep them as `/?view=` | WS4–WS8 |
| `packages/app/src/shell/routes/routes.tsx` | mount the Kete destinations | WS4–WS8 |
| `packages/desktop/src/shared/ipc-rpc/files.ts` + `app/src/runtime/platform/platform.tsx` | expose "reveal in Finder/Explorer" | WS4 |
| `packages/gui-plugins/src/{main,renderer}.ts` + README | register Kete settings pages (Folders, Phone, Privacy) | WS2, WS9, §6 |

Everything else lives in `src/kete/` paths. The upstream-merge test in §8 of the brief becomes a
`kete-tools` check: a dry-run merge of upstream `main` whose conflicts must all sit in files listed in
`upstream-patches.md`.

## 3. API and event additions (names and payloads; JSON over the existing server)

HTTP (under `/api/kete/…`, local-only where noted, gated like `kete.account`):
- `POST /api/rpc/kete.handshake/get` (the `kete.handshake` plugin RPC) → `{ output: { protocol: 1, runtime: "0.3.0", modes: ["code","work"] } }`. The desktop refuses to connect when `protocol` differs from its own (WS0).
- `POST /api/rpc/kete.modes/list` (the `kete.modes` plugin RPC, served by the handshake plugin) → `{ output: [{ id, name, description, agent, available }] }` (WS1).
- `POST /session` gains an optional `mode: "code" | "work"`. The mode is fixed for the session's lifetime (WS1).
- `GET|POST|DELETE /api/kete/folders` → `{ id, path, realPath, addedAt }[]`. Local-only; revoking applies at once to running sessions (WS2).
- `POST /api/kete/plan/:sessionID/:planID/{run|cancel}`, `PUT …/plan/:planID` (edit) (WS3).
- `GET /api/kete/approvals?state=pending` → the cross-session inbox (WS3).
- `GET /api/kete/library?type=&expert=&q=&from=&to=` and `POST /api/kete/library/:id/{rerun|template|reveal}` (WS4).
- `GET /api/kete/skills/gallery`, `POST /api/kete/skills/:id/{enable|disable|pin}` (WS5).
- `GET /api/kete/activity/:sessionID?format=csv` (WS10).

SSE (the existing event stream; `kete.*` types):
- `kete.sidecar.restarting` / `kete.sidecar.ready` (from the desktop, WS0)
- `kete.folder.granted` / `kete.folder.revoked` `{ id, path }`
- `kete.plan.proposed` `{ sessionID, planID, steps[], reads[], writes[], connectors[], egress[], credits: { estimate } }`
- `approval.requested` `{ id, sessionID, action: "fs.delete"|"fs.overwrite"|"net.send"|"payment.*"|"mcp.write", preview }`; `approval.decided` `{ id, decision, decided_via: "desktop"|"telegram"|"whatsapp" }`. These carry Kete action-class gates and are built on `permission.asked/replied`, not a second permission system.
- `kete.library.added` `{ id, path, type }`
- `kete.credits.updated` `{ balance_micros, currency }` (already published as integration metadata; surfaced as an event)

## 4. Storage

Local SQLite (runtime data dir, following `core`'s SQL migrations; the desktop's `node:sqlite` covers only
desktop UI state):
- `kete_folder_grant(id, path, real_path, added_at, revoked_at)`
- `kete_plan(id, session_id, body_json, state, created_at, decided_at)`
- `kete_approval(id, session_id, action, preview_json, decision, decided_via, requested_at, decided_at)`. There's no TTL, so a pending row stays pending.
- `kete_library_item(id, path, task_id, session_id, mode, experts_json, skills_json, sources_json, prompt, type, size, tags_json, created_at)` plus an FTS5 table `kete_library_fts(title, prompt, text)`
- `kete_template(id, name, prompt, variables_json, expert, skills_json, default_folder, created_at)`

**[platform]** issue specs (Supabase migrations are owned by `kete-code-platform`):
- `folder_grants` (metadata sync)
- `library_items` (metadata only)
- share links (storage + 24 h signed URL)
- `experts` (+ JD → expert)
- connector OAuth vault + gateway MCP proxy
- kete-loom-pro entitlement listing
- cloud schedule runner
- phone relay (link code, device channel, queue, mirrored approvals)
- Paystack top-up URL
- short-lived desktop token exchange (Q1)

## 5. PR breakdown (each about 600 lines or less; Large tasks get spec and plan approval)

**Phase A — WS0 and WS1, the next two to build.**
1. **0.1 Handshake.**
   - What: the `kete.handshake` RPC (`POST /api/rpc/kete.handshake/get`) and a protocol constant in `schema`. The desktop and app refuse a mismatched protocol and show the existing "incompatible" panel app-wide.
   - Tests: a unit test on the check; a server test on the route.
2. **0.2 Sidecar supervision.**
   - What: a main-process watcher on the service process exit and failed health. Restart through the existing `ensure` with backoff, plus a global "Kete Code runtime restarted" banner.
   - Tests: kill the sidecar and expect `ready` within 5 s (desktop `bun test` with a fake service, then e2e in 0.4).
3. **0.3 Packaged-app smoke.**
   - What: a documented macOS and Windows clean-install checklist (log in, Code session, kill the sidecar), plus a `kete-desktop.yml` step that launches the packaged app headless and waits for `POST /api/rpc/kete.handshake/get`.
   - Also re-run the cancelled macOS jobs.
4. **0.4 Electron e2e harness.**
   - What: Playwright `_electron` against the packaged dev build, with one test (launch → new session → answer from a fake provider).
   - Runs on manual dispatch and in the release workflow, not on every PR, to stay within free minutes.
5. **1.1 Profile schema and loader.**
   - What: an Effect `Schema` for `modes/*.jsonc` (id, name, agent, permissions, tools, shell allowlist, network, git, web, mcp, approvals, outputs) and a validated loader.
   - `kete.modes/list` plugin RPC (no route mount).
   - `work.jsonc` filled in (still unavailable until 1.3).
6. **1.2 Session mode.**
   - What: `mode` on session create (stored in metadata; immutable). The default agent comes from the profile, a marked edit in `agent.ts`.
   - Code mode is unchanged (agent `build`).
7. **1.3 Work enforcement in the runtime.**
   - What: a Kete permission/tool plugin that applies the profile:
     - fs scope limited to granted folders (resolved real paths; WS2's store, with a session-only fallback until 2.1 lands);
     - shell allowlist of the bundled `python`/`node` only, no `curl`/`git`, using `shell-risk` parsing;
     - git tools denied;
     - web/MCP per profile;
     - network off via the OS sandbox.
   - Each rule rejects and writes an audit entry.
   - Tests: one per rule (outside folder, `curl`, `git`, symlink escape, `..`, MCP off).
8. **1.4 `work-orchestrator` agent and the Code | Work switch.**
   - What: the agent (prompt, tools from the profile) and a top-of-sidebar switch that remembers the last mode per workspace (`Persist.serverWorkspace`).
   - New sessions use the selected mode.
   - Tests: a component story test.

**Phase B — WS2 and WS3.**
- 2.1 grant store with live revoke;
- 2.2 Settings → Folders plugin page;
- 2.3 `Kete Outputs/` writer, never-overwrite and suffixes;
- 2.4 path-traversal suite;
- 3.1 action-class gates and `decided_via`;
- 3.2 Plan artifact plus Run/Edit/Cancel;
- 3.3 approvals inbox, badge and OS notification;
- 3.4 e2e: plan → approve → `net.send` rejected → nothing sent.

**Phase C — WS4 and WS10.**
- 4.1 library index and FTS;
- 4.2 Library view and filters;
- 4.3 previews (reuse the Office workers, plus PDF) and reveal;
- 4.4 templates;
- 10.1 credits UI and BYO "not metered";
- 10.2 Activity view and CSV.

**Phase D — WS5 and WS7.** Gallery, permission manifest, per-skill network enforcement; default Work experts, Team (auto), Reviewer-last.

**Phase E — WS6, WS8, WS9.** These depend on platform issues: connectors through the gateway proxy, local and cloud automation, phone relay.

The platform issue specs are written during the phase that needs them: Q1 in Phase A, and folder sync at the start of Phase B.

## 6. Cross-cutting decisions to make

- **Python for skills:** a uv-managed venv under the app data dir with a pinned CPython from `python-build-standalone`. It's downloaded on first use and checksummed, not bundled. That keeps the installer small and avoids notarising a second interpreter now. Bundling stays an option for v1.1 (open question Q3).
- **Performance budgets** (cold start < 3 s, sidecar < 2 s, library search < 200 ms for 5,000 items) become measured checks in the e2e harness, not assumptions.
- **Telemetry** stays off; a Privacy page documents it before anything is added.
- **i18n:** every new string goes through `useLanguage().t` / plugin `ctx.t`, English only.

## 7. Decisions (2026-11-04, at approval)

- Phase A (WS0 + WS1) starts now; each PR is a Large task with spec and plan approval and merges when green.
- **Q2 Windows:** Work mode refuses shell/script skills (python/node) on Windows in the runtime until a
  Windows sandbox exists. Built-in document tools still work.
- **Q1 Token:** Phase A keeps the key-store credential from `kete login`; the short-lived token exchange
  is specified as a platform issue (`docs/platform-issues/desktop-token-exchange.md`) to replace it later.
- Still open: Q3 (Python), Q4 (routes), Q5.

## 8. Risks and open questions

- **Q1 Desktop credential:** the brief wants a short-lived token; today it's a long-lived key in the OS key store. Keep the key for Phase A, or add a platform token exchange first?
- **Q2 Windows network-off:** there's no OS sandbox on Windows. Options:
  - (a) Work mode disables shell skills on Windows;
  - (b) a Windows sandbox (AppContainer / Job objects) as its own task;
  - (c) proxy-only egress control. Phase A ships (a) unless you choose otherwise.
- **Q3 Python:** downloaded uv-managed CPython (recommended) vs a bundled, signed interpreter.
- **Q4 New top-level routes:** a marked `layout.tsx` edit (cleaner URLs) vs `/?view=` query views (no upstream edit).
- **Q5 Scope of "beats WorkBuddy":** this plan matches the six headline areas; the design canvas, kanban and mobile app stay out (brief §9).
- **Risks:**
  - The schedule sandbox bypass must be fixed before Automation.
  - Upstream may change `permission.ts` and the agent default; the patch record tracks them.
  - Free-minutes CI: Electron e2e runs on dispatch and release, not on every PR.
  - macOS runner capacity has blocked CI all afternoon.
  - Connector tokens through a gateway proxy add latency and a platform dependency, so local MCP must keep working offline.
