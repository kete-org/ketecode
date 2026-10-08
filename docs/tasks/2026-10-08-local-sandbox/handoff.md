# Handoff: Local OS sandbox (Wave 0b)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-08 implementer (single agent)

Decisions:
- **.git handling:** `.git` stays writable so git works; protected are the files through which git
  runs commands: `config`, `config.worktree`, `hooks/`, `info/attributes`, `commondir`, `gitdir`
  (also under `modules/*` and `worktrees/*`), the `.git` entry itself (no rename/replace, no nested
  `.git` on macOS), and `core.hooksPath` (read from the config file at spawn). Linked worktrees: the
  gitdir and common dir are writable with the same protections. Considered and rejected: writes to
  `.git` only for classifier-approved git commands (a test can run git too), and protecting all of
  `.git` (breaks commit).
- **Network default:** approved commands only. "Approved" is decided by the permission hooks marking
  the shell request's metadata (`kete.sandbox.approved`): permission-mode when the final effect is
  "ask" (later hooks can only turn ask into deny) or every part is a saved Always allow; the
  unattended policy hook when its policy allows. Explicit config rules don't count (repository config
  can carry them). macOS without network keeps loopback, the machine's own addresses (Seatbelt's
  "localhost" covers them — verified) and Unix sockets in workspace/temp; DNS goes through
  /var/run/mDNSResponder and is blocked. Linux uses a new network namespace.
- **macOS Mach services:** default-deny with a small allowlist. Measured on macOS 26: with
  `(allow default)` alone, `open -a` launched an app and AppleEvents reached Finder; with
  `(deny mach-lookup)` + allowlist both fail, as do pbcopy/pbpaste; launchctl submit already fails
  inside sandbox-exec. Added `(deny appleevent-send)` and `(deny job-creation)` anyway.
- **macOS temp:** the per-user `/private/var/folders/*/*/{T,C}` are writable (Apple's xcrun shims
  behind /usr/bin/git write there regardless of TMPDIR — found by a failing test).
- **Fallback:** no sandbox → warn once at start, TUI footer, `kete sandbox` exit 1; commands pass a
  `sandbox_off` check with reason `unavailable`/`disabled` that doesn't ask, so an org policy
  denying `sandbox_off` makes the sandbox required. `mode: "required"` refuses locally.
- **Linux placeholders** for missing protected names in the config search path: empty dirs, and for
  `kete.json(c)` a `{}` file with mode 000 (the config loader reads EACCES as missing); counted
  process-wide and removed when unchanged.
- **Notice:** appended only when a sandboxed command failed with EPERM/EROFS/DNS-style errors, to keep
  upstream outputs (and their tests) unchanged otherwise.
- Instruction files (AGENTS.md, CLAUDE.md) are not write-protected by the sandbox (ordinary repository
  text; edits ask via permissions). `.vscode/`/`.idea/` not protected (documented gap).

Open / follow-ups:
- VS Code / JetBrains / web: no sandbox status indicator yet (the shell tool notice, the permission
  prompt text, `kete sandbox` and the runtime's start-up warning cover it); add one via the RPC.
- Permission system gap noticed: `.claude/**` and `.agents/**` are loaded as configuration but aren't
  in `KeteShellRisk.protectedPath` (edits there don't always ask). The sandbox protects them for
  commands; the edit-tool rule should follow.
- Landlock / Windows / per-host allowlist: see ADR 0013 "Revisit".
- The shell permission prompt doesn't say that approving grants network inside the sandbox
  (documented in docs/sandbox.md and docs/permissions.md).

## 2026-10-08 implementer (security review fixes)

Review of PR #24 (two blockers, should-fixes, nits), all addressed:
- B1 Unix sockets in shared temp: each session gets a private temp dir (TMPDIR/TMP/TEMP); without
  network macOS allows socket connects only in the workspace and that dir; Linux mounts a private
  tmpfs on /tmp and /var/tmp, hides `$XDG_RUNTIME_DIR`, `/run/user/<uid>` and `SSH_AUTH_SOCK`, and
  the child loses `SSH_AUTH_SOCK`, `SSH_AGENT_PID`, `GPG_AGENT_INFO`, `DBUS_SESSION_BUS_ADDRESS`
  (kept with network). Test: a socket server in shared /tmp is unreachable, one in the workspace works.
- B2 Linux missing git internals: `commondir` ("."), `gitdir`, `config.worktree`, `info/attributes`
  get placeholders (mode 644; git treats them as absent — checked commit, worktree list,
  rev-parse) bound read-only; `modules`/`worktrees` pinned. Test: `echo … > .git/commondir` fails.
- S3 bwrap from /usr/bin, /bin, /usr/local/bin first; PATH entries under HOME or temp dirs ignored.
- S4 saved "Always allow" no longer grants network.
- S5 the approval mark moved to a new last hook (`KeteSandbox.ApprovalPlugin`, guarded, after
  `KeteUnattended.Plugin`); permission-mode no longer marks; unattended policy sets a separate flag
  the last hook honours only if the decision is still "allow". Test: a hook turning ask→allow before
  it leaves no mark.
- S6 loopback kept open on macOS by default, documented; `kete.sandbox.loopback: false` blocks it
  (project config may set false only).
- Nits: `--new-session` for bwrap; the macOS per-user cache dir documented as a persistence spot;
  Seatbelt denies writes to `.git/modules` and `.git/worktrees` entries (rename-away-and-back);
  macOS test for renaming a nested repository's parent (config still protected) and `.git/commondir`.
- Residual: a disk plugin's `evaluate` hook registered after the internal ones could still loosen
  a decision after the approval hook; plugins are runtime code the user installed (repository
  `.kete/plugins` is write-protected by the sandbox).

## 2026-10-08 implementer (re-check fixes)

- macOS rename bypass (`mv .git/modules/sub x; edit; mv back`, same with `.git/info`): Seatbelt checks
  a rename's paths only. Added `(deny file-write-unlink (require-all (vnode-type DIRECTORY)
  (require-any …)))` for `info`, `(modules|worktrees)/…/info` and every directory under `modules` and
  `worktrees`. Found that filters listed in one rule are OR'd: without `require-all` the rule also
  hit files (index.lock renames in linked worktrees failed) — that is what blocked the reviewer's
  sibling rename. Tested: the move-out/edit/move-back sequences fail; status, add, commit, branch,
  checkout, stash, submodule status and git inside the submodule work. (`git worktree add/remove`
  already needed `sandbox: "off"`: they write protected files.)
- Linux equivalent: submodule git directories are found by HEAD or config (names may contain "/"),
  and every directory on the way (`info`, `modules`, `worktrees`, intermediate dirs, the git dirs)
  is pinned. `rename` then fails with EXDEV and `mv` copies and deletes: the protected files stay;
  the copy is ordinary files. The remaining Linux path is the documented nested-repository gap, now
  spelled out for submodule `.git` files in docs/sandbox.md.
- Nit (Permission.reply): the network mark now comes from the person's reply to that very shell
  request (`core/src/permission.ts`, marked); requests an "always" resolves without showing them get
  no mark; the approval hook only carries the unattended policy's allow. Test:
  `core/test/kete/sandbox-reply.test.ts`.
