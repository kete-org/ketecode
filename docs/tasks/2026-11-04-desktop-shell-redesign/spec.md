# Spec: Desktop shell redesign

- Task: `docs/tasks/2026-11-04-desktop-shell-redesign` · Size: large · Created: 2026-11-04
- Status: built (2026-11-04) <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
Make the desktop (and web) app feel like a focused workspace: a persistent left sidebar for navigation
and recent sessions, and a composer-first home where a new session starts. The layout reference is the
WorkBuddy hero screenshot (saved at `ref/hero.png` in the session scratchpad); Kete keeps its own name,
purple brand (#6E47F5), icons and copy. No WorkBuddy name, mascot, wording or assets.

## Scope
Modules: `web-app` (packages/app shell, home, new-session, composer), `ui-branding` (Kete theme,
tokens), `account-login` (account footer reads `kete.account`). The desktop loads the same
`@opencode/app` UI, so one change covers both.

1. **Left sidebar, on by default.** Built on upstream's existing vertical sidebar (`appearance.tabLayout`,
   `sidebarOpen`, `mod+shift+b`, collapse/peek), not a new one. Kete makes the vertical layout the
   default and replaces the sidebar body with a Kete component (`app/src/kete/sidebar/`):
   - top: window controls space, collapse toggle, search;
   - nav: **New session**, then existing destinations only (Settings; others only if they already exist);
   - **Sessions** (count, collapsible): recent sessions across projects, title + relative time
     ("5 min ago", "10:36", "Yesterday"), busy dot for running sessions, current one highlighted,
     "View more" after N, which opens the former projects + sessions home as a full session list;
   - **Projects** (count, collapsible): each project with its recent sessions underneath;
   - footer: account (organization name + plan/host from `kete.account`; "Sign in" when signed out,
     opening Settings → Account), notifications button.
   The horizontal tab strip stays available as a setting; existing keyboard shortcuts keep working.
2. **Composer-first home.** `/` and the new-session screen show a centered greeting
   ("Kete Code" + "What should we build today?"), the mode toggle, and a large rounded composer card. Under the card:
   project/workspace picker and the permission picker (existing controls, restyled). The model picker
   stays in the card. The current projects + sessions home grid is no longer the default home (its
   content moves to the sidebar).
3. **Mode toggle.** A segmented switch above the composer: **Build** | **Plan**, selecting the session's
   agent through the existing agent selection. Plan moves out of `KeteModeToggle`: the picker under the
   card keeps only the permission choices (Default / Auto / Ask). A session that was in Plan mode shows
   Plan on the switch.
4. **Visual polish.** In the Kete theme/tokens only: softer neutral surfaces, larger base type in the
   shell, rounded cards (composer ~16px), more spacing, purple accents for primary actions and
   selection; light and dark both.

## Out of scope
- New destinations the runtime doesn't have yet (Assistant, Experts/Connectors marketplace,
  Automation, Library); pinned sessions (no pin store exists).
- Session view (the chat transcript) beyond inheriting the theme polish.
- VS Code extension and TUI.
- Any WorkBuddy branding, mascot or illustration; a mascot of our own.
- Mobile layout changes (upstream turns the sidebar off on mobile; keep that).

## Acceptance criteria
- [ ] AC1: On first launch (no saved appearance settings) the sidebar is shown on the left; a user who
      saved `tabLayout: "horizontal"` keeps it. `mod+shift+b` collapses and restores it (unit test on the
      settings default + component test).
- [ ] AC2: The sidebar lists recent sessions across projects newest first with relative times, marks the
      current and busy sessions, and selecting one opens it; "View more" shows the rest (unit test on the
      records/formatter; component test on selection).
- [ ] AC3: The Projects section groups sessions by project and the counts match (unit test).
- [ ] AC4: The footer shows the organization when signed in and "Sign in" when signed out, and updates
      on `rpc.kete.account.changed` without a reload; it never shows a key or key id (unit test).
- [ ] AC5: `/` opens the composer-first home; submitting a prompt there starts a session in the chosen
      project, exactly as the current new-session screen does (component or e2e test).
- [ ] AC6: The Build | Plan toggle selects the build or plan agent for the new session and reflects the
      current agent; with no plan agent available it is hidden; the permission picker no longer offers
      Plan, and its Default / Auto / Ask behavior is unchanged (unit tests).
- [ ] AC7: Light and dark themes render the new shell with Kete tokens; no hard-coded colors outside
      the Kete theme/token files (lint/grep check + screenshots attached to the PR).
- [ ] AC8: Upstream edits are minimal, marked `kete_change` and recorded in `docs/upstream-patches.md`;
      `upstream:check` passes.
- [ ] AC9: typecheck (app, ui, desktop), `bun run test:unit` in app, Kete tests, lint pass; the desktop
      dev build shows the new shell (manual check with screenshots).

## Risks and constraints
- **Upstream syncs.** `shell/shell.tsx` and `shell/titlebar/titlebar.tsx` are untouched upstream files
  today. Plan: one marked swap of the vertical-sidebar Portal body for a Kete component, plus a marked
  settings default; the home change goes through the already-Kete-modified `new-session/view.tsx` and a
  marked route default. Anything larger needs a note in the plan.
- **Settings contract.** Changing the `tabLayout` default must not override a user's saved choice.
- **Accessibility.** Sidebar is keyboard navigable (existing tab-strip semantics), visible focus, labels
  on icon buttons, contrast AA in both themes.
- **No security/schema change** expected; the account footer only reads `kete.account.status`.
- **Brand/IP.** Layout inspiration only; nothing copied from WorkBuddy.
- **Performance.** Sidebar uses the existing `homeSessionsQuery`; no extra polling.

## Decisions (at approval)
1. Plan lives only on the Build | Plan switch; the permission picker keeps Default / Auto / Ask.
2. Greeting: "Kete Code" + "What should we build today?" (suggested; not objected to).
3. The former home stays reachable behind the sidebar's "View more"; it is no longer the default `/`.
