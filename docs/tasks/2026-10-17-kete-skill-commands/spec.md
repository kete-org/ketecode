# Spec: kete skill commands (A9)

- Task: `docs/tasks/2026-10-17-kete-skill-commands` · Size: medium · Created: 2026-10-17
- Status: built 2026-10-18 (agreed and plan approved 2026-10-17) <!-- draft → agreed (medium) / approved (large) → built → closed -->

## Goal
People can install, list, update and remove skills from a git repo or a local folder with one
command (`kete skill add <source>`). Before anything is written they see exactly what the skill
contains, and it is pinned to an exact commit, so `update` shows what changed. Today the only ways
to get a skill are to copy files by hand or use org sync.

## Scope
New `kete skill` command group in the CLI (cards: `cli`, `roles-skills`, `sync`, `config-kete`).

- **`kete skill add <source> [--path <subfolder>] [--ref <branch|tag|commit>] [--name <name>] [--global] [--yes]`**
  - Source: a git URL (`https://…`, `ssh://…`, `git@host:…`) or a local folder. The GitHub
    shorthand `owner/repo` means `https://github.com/owner/repo`.
  - Fetch: a shallow clone into a temporary folder through `packages/cli/src/kete/job-git.ts` `run`
    (no shell, with a timeout and an abort signal). Repo hooks, submodules and LFS smudge are off.
    The resolved commit is recorded.
  - Validate: the chosen folder has a `SKILL.md` whose frontmatter parses (the same rules core
    uses to load skills). Only regular files are copied: no `.git`, no symlinks, and no path that
    escapes the folder (reuse `KeteSyncSkills.safeRelative`). File count and total size are
    bounded.
  - Review: print the name, description, source, commit and every file with its size. Scripts
    (a shebang, an executable bit, or a script extension such as `.sh`, `.py`, `.js`, `.ps1`) are
    marked. Then ask. With `--yes` there is no question. In a non-interactive shell without
    `--yes`, nothing is installed.
  - Install: write to `.kete/skills/<name>/` (or `~/.config/kete/skills/<name>/` with `--global`).
    Files are written `0o600`, so the executable bit is stripped, as in the sync writer. The
    install is atomic: a temp folder renamed into place. Nothing from the skill runs at install.
  - Lockfile: `skills.lock.json` beside that `skills/` folder records, per skill, the source,
    the subfolder, the requested ref, the resolved commit, the sha256 of each file and the install
    time. The format is versioned (`"version": 1`).
- **`kete skill list [--global]`**: installed skills with their source and commit, plus other
  skills found in the same folders, labelled "local" (not tracked) or "org" (synced, read-only).
- **`kete skill update [<name>] [--yes]`**: re-resolve the recorded ref. If the commit changed,
  show the files added, removed and changed (with scripts marked) and ask, then reinstall. A skill
  pinned to a commit says it is pinned. A file edited locally since install (its hash differs from
  the lockfile) is reported, and the update needs confirmation.
- **`kete skill remove <name> [--global] [--yes]`**: removes only skills in the lockfile. It
  refuses untracked folders (they may be the person's own work) and org-synced skills.
- **Org-synced skills are protected:** `add` refuses a name that an org-synced skill already uses
  (recognized by its `.kete-skill.json` manifest). `update`/`remove` never touch
  `managed/<org>/skills/`.
- **Org policy can limit sources** through the existing policy rules (`KeteSyncPolicy.evaluate`).
  The action is `skill.install` and the resource is the normalized source (e.g.
  `github.com/acme/skills`). `deny` blocks, `ask` forces the confirmation even with `--yes`, and a
  policy that can't be read fails closed. This needs no contract change; the format is documented
  in `docs/platform/sync-v1.md`.
- Upstream edit: one `kete_change` entry in the `Handlers` map in `packages/cli/src/index.ts`.
  The rest goes in `packages/cli/src/kete/` and `packages/util/src/kete/`.
- Docs: the README command list, the CHANGELOG, the `cli` and `roles-skills` cards (also closing
  the scout's gaps on skill discovery dirs and the git helper), and the `sync` card (the
  synced-skill manifest).

## Out of scope
- **Marketplace skills** (`kete skill add marketplace:<slug>`): the portal has a marketplace
  (platform ADR 0012), but no `/api/v1` endpoint serves it to the runtime. This is parity-plan
  **A17**: a platform API, then a runtime client that plugs into this task's source kinds. Keep the
  source parsing open to a third kind so A17 adds a source without reshaping `add`.
- A TUI `/skill` command or a VS Code UI (the CLI first; clients can follow).
- Searching or browsing skills, ratings, and signature verification of skill sources.
- Installing into `.claude/skills` or `.agents/skills` (they are still read, but not written).
- Running or testing a skill's scripts.

## Acceptance criteria
- [ ] AC1 add (git): from a local bare repo fixture, with `--ref` and `--path`, the skill is
  installed under `.kete/skills/<name>/` and the lockfile records the resolved commit and the file
  hashes.
- [ ] AC2 add (local folder) works the same, with the source recorded as a path.
- [ ] AC3 review: the output lists every file, and scripts are marked. A "no" answer, or a
  non-interactive shell without `--yes`, writes nothing (no skill folder, no lockfile change).
- [ ] AC4 safety: a symlink, a `..` path, a missing or invalid `SKILL.md`, too many files, or an
  oversize source is rejected with nothing written. Installed files have no executable bit (POSIX).
  Repo hooks don't run during the clone (a fixture with a hook proves it).
- [ ] AC5 `--global` installs to the global config `skills/` folder and its own lockfile.
- [ ] AC6 list shows installed, local and org skills with the right labels.
- [ ] AC7 update: with a new commit on the fixture branch, update shows the added, removed and
  changed files, then reinstalls and updates the lockfile. A pinned commit reports pinned. A
  locally edited file is reported before the update.
- [ ] AC8 remove deletes a tracked skill and its lockfile entry, and refuses untracked and
  org-synced folders.
- [ ] AC9 org protection: `add` with a name used by a synced skill (one with a manifest) fails
  and changes nothing.
- [ ] AC10 policy: a `skill.install` deny rule blocks the source, and an ask rule forces the
  prompt even with `--yes`.
- [ ] AC11 errors: an unreachable repo or a timeout gives a clear message with a non-zero exit,
  and the temp folder is removed. Credentials in a URL never appear in output or in the lockfile.
- [ ] AC12 checks: typecheck and Kete tests pass in `util` and `cli`, and `upstream:check` passes.

## Risks and constraints
- **Security (main risk):** this installs third-party instructions and scripts that an agent may
  later follow or run. The mitigations are a review before install, nothing run at install, the
  executable bit stripped, the policy hook, and a commit pinned with hashes. A security review is
  recommended before merge, as for A10/A13. Tests must cover path traversal, symlinks, hooks, and
  credential redaction.
- **Contracts:** the `kete skill` CLI, the lockfile format and the `skill.install` policy action
  become contracts once released, so the lockfile is versioned from v1.
- **Git:** the person's git config and credentials are used for private repos. We never prompt
  for or store credentials ourselves (`GIT_TERMINAL_PROMPT=0` so a missing credential fails fast
  instead of hanging).
- **Cross-platform:** Windows paths and the absence of file modes there. The rename has to work
  across temp locations, so the temp folder sits beside the target.
- **Concurrency:** two installs at once must not corrupt the lockfile. Write it to a temp file and
  rename, re-reading just before the write.
- **Upstream:** a single marked line in `packages/cli/src/index.ts`. Skill loading in core is
  unchanged.
