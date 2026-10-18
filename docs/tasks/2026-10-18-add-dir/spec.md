# Spec: extra working directories (A13)

- Task: `docs/tasks/2026-10-18-add-dir` · Size: large · Created: 2026-10-18
- Status: approved 2026-10-18, plan approved 2026-10-18 (the user said to carry on through every remaining item without stopping, 2026-10-18; recorded in handoff.md) <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
Let a session work in a second folder (a sibling repo, a shared library) without opening the whole
disk. `--add-dir <path>` at start and `/add-dir <path>` during a session grant it explicitly, for that
session only, under the same permission rules as the workspace. Parity item A13.

## Scope
Cards: `permissions` (main; also covers `/mode` and folder trust today; it also closes the scout's
file-access and saved-permission gap), `sandbox`, `cli`, `pitfalls`.

- **State:** the session's extra folders are kept in session metadata (`kete.dirs`: real absolute
  paths), the same way `/mode` keeps the permission mode. It is session only: never saved for the
  project, and never sent to the platform.
- **Granting:**
  - CLI: `--add-dir <path>` (repeatable) on the TUI start command and on `kete run`. It is applied
    through the same get-merge-patch of session metadata the permission-mode flags use.
  - TUI: `/add-dir <path>` adds a folder. `/add-dir` alone lists the session's folders. `/add-dir
    remove <path>` drops one.
  - The SDK/server path is the session metadata update the clients already use. There is no new endpoint.
- **Validation** (in the runtime, so every client gets it): the path must exist and be a directory,
  and it is stored as its real path. Refused:
  - `/` and any file system root
  - the home folder itself, or any folder above it
  - credential folders (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config/gh`,
    `~/.config/gcloud`, as the memory-import rules list them)
  - Kete's own config, state and data folders
  - a folder already inside the workspace (nothing to add)
  The limit is 10 folders. A refused path gets a clear reason and changes nothing.
- **Enforcement** (a Kete plugin on the existing permission `evaluate` hook): for action
  `external_directory`, a request whose target folder's **real path** is inside one of the session's
  folders is allowed, so a symlink inside an added folder that points elsewhere is not covered. Every
  other rule still applies:
  - edit, write and shell permissions are unchanged
  - the session's permission mode (ask, accept-edits, plan) still applies
  - an enforced org policy deny, a user deny rule and folder-trust holds win over the grant
  - external_directory `deny` rules in config win too
  The grant only answers "may this session reach this folder".
- **Shell sandbox:** when the local sandbox is on, the session's folders are added to its writable
  roots, with the same symlink and credential masks. When the sandbox can't do that for a session, the
  shell's cwd check still applies (as today) and the docs say so.
- **Never loaded from an added folder:** its `.kete` config, plugins, agents, commands, skills,
  `AGENTS.md`, `CLAUDE.md` or memory. It is a place to work, not a project to configure from. Tests
  prove it.
- **Job mode:** `--add-dir` is refused (jobs have one workspace). Unattended local runs (`kete run`)
  accept it, because the person passed it explicitly.
- **Docs:** `.github/README.md`, the CHANGELOG, `docs/permissions.md` (or the permissions doc the repo
  has), and `docs/upstream-patches.md` for any upstream edit.

## Out of scope
- Saving extra folders for a project (config `additionalDirectories`) or across sessions.
- VS Code and JetBrains UI for adding folders. They can set the metadata later.
- Path checks on arbitrary shell command arguments. The sandbox is the control for shell, as today.

## Acceptance criteria
- [ ] AC1 `--add-dir ../lib` makes read, edit, write, patch, glob and grep under `../lib` pass the
  external-directory check without asking. Without it they ask, as today.
- [ ] AC2 `/add-dir <path>`, `/add-dir` (list) and `/add-dir remove <path>` work in the TUI and persist
  in session metadata. A new session starts without them.
- [ ] AC3 refusals: `/`, home, a folder above home, `~/.ssh` (and the other credential folders), a
  Kete state folder, a missing path, a file, a folder inside the workspace, an 11th folder. Each is
  refused with a reason and nothing is stored.
- [ ] AC4 a symlink inside an added folder that points outside it (e.g. to `~/.ssh`) is not granted.
  `..` traversal out of an added folder (`../lib/../../secret`) is not granted.
- [ ] AC5 a deny rule (org policy or config) on external_directory or on edit still wins over an added
  folder. Plan mode still blocks edits there.
- [ ] AC6 with the sandbox on, a shell command can write in an added folder and still can't write
  outside it.
- [ ] AC7 an added folder's `.kete/`, AGENTS.md, CLAUDE.md and skills are not loaded (a test asserts
  their content is absent).
- [ ] AC8 job mode refuses `--add-dir`.
- [ ] AC9 checks: typecheck and tests in core, cli and tui (Kete tests plus the affected upstream tests),
  `upstream:check`, and the regenerated protocol and client if the schema changed. Any new file that
  touches the file system is classified in `job-fs-sites.test.ts`.

## Risks and constraints
- **Security (main):** this widens the workspace boundary. The defences are explicit per-session
  grants, real-path containment, refused sensitive roots, rules that only tighten (deny wins), no config
  loaded from added folders, and sandbox masks. A security review runs before merge, with tests for
  traversal, symlink escape and permission bypass.
- **Contracts:** the `--add-dir` flag, `/add-dir` and the `kete.dirs` session metadata key become
  contracts.
- **Upstream:** prefer the permission `evaluate` hook and session metadata, both existing seams. Any
  upstream edit (CLI flag wiring, sandbox input) is minimal, marked and recorded.
- **Cross-platform:** real-path containment uses `FSUtil.contains` (case-insensitive on Windows).
  There is a test with a Windows-style path where it's cheap.
