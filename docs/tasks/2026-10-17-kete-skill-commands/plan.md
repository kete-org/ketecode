# Plan: kete skill commands (A9)

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

> **Needs approval before building (Large).** One upstream edit: a single `kete_change` entry in
> the `Handlers` map of `packages/cli/src/index.ts`, plus a short section in the upstream-derived
> `README.md`. It is **security-sensitive** because it installs third-party instructions and
> scripts. It also creates **new contracts**: the `kete skill` CLI, `skills.lock.json` v1 and the
> `skill.install` policy action. There is no config schema change and no protocol or SDK change.
> The spec recommends a security review before merge, as for A10 and A13.

## Cards read
- docs/context/modules/cli.md (verified-at 99313fa3c1, stale: no)
- docs/context/modules/roles-skills.md (verified-at 99313fa3c1, stale: no)
- docs/context/modules/sync.md (verified-at 99313fa3c1, stale: no)
- docs/context/modules/config-kete.md (verified-at 99313fa3c1, stale: no; nothing to change, because no `kete.*` key is added)

## Design decisions (made by the planner, recorded in handoff.md)
- **The CLI must not import `@opencode/core`** (`packages/cli/test/import-boundaries.test.ts:6-13`), so core's `SkillFile.parse` can't be reused. Add a small YAML-only frontmatter check to util that applies the same rules: the front-matter language must be `""`/`yaml`/`yml` (core refuses others, GHSA-m7hc-g593-r9wg, `core/src/config/markdown.ts:4-26`); `name` and `description` are optional strings; the body follows. Parse with `Bun.YAML.parse` (Bun 1.4.2, so no new dependency). It is stricter than core: it doesn't do core's "unquoted colon" retry (`sanitize`). Mark it `shortcut: no colon-sanitize retry, add it if users report valid skills rejected`.
- **No hooks, no prompts, no LFS:** run every git call with `-c core.hooksPath=<an empty temp dir> -c submodule.recurse=false -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false` and the child env `GIT_TERMINAL_PROMPT=0`, `GIT_LFS_SKIP_SMUDGE=1`. `JobGit.run` today passes no env to the child (its `env` option is only read for job mode), so add an optional `childEnv` to `RunOptions` (`job-git.ts:24-29`), merged over `process.env`. Leave `core.symlinks` at its default so symlinks stay real and the `lstat` walk rejects them.
- **Fetch:** `git init <tmp>`, then `git -C <tmp> fetch --depth 1 --no-tags -- <url> <ref|HEAD>`, `git -C <tmp> checkout --detach FETCH_HEAD` and `git -C <tmp> rev-parse HEAD`. If a commit-SHA ref fails at depth 1, retry once with a full `fetch -- <url>` and then `checkout <sha>`. Timeout: 2 min per call; `signal` comes from the handler. For update, resolve with `git ls-remote -- <url> <ref|HEAD>` first, and skip the clone when the commit is unchanged. A ref matching `^[0-9a-f]{40}([0-9a-f]{24})?$` is **pinned**. Put `--` before every user-supplied URL or ref, and reject a ref or `--path` that starts with `-`.
- **Source kinds:** a tagged union `{kind:"git", url}` | `{kind:"local", path}`; a future `marketplace` kind can be added without reshaping `add`. `owner/repo` becomes `https://github.com/owner/repo`. Userinfo (`user:token@`) is stripped from every URL that is printed, stored or used as the policy resource; git output is passed through `KeteRedact.text` before it is shown. The **policy resource** is `host/path` (lower-case host, no scheme, userinfo, `.git` suffix or trailing `/`, e.g. `github.com/acme/skills`) for git sources and the absolute folder path for local ones.
- **Policy:** read the signed-in account (`KeteAccount.read(KeteAccount.defaults())`); if there is none, no policy applies. If signed in, read `KeteSyncCache.read(config, org)`: no cache forces an `ask` (with "Run `kete sync`"), as the sync guard does; a read or decode error refuses (exit 2). Call `KeteSyncPolicy.evaluate(policies, {action:"skill.install", resources:[resource], environment:"development"}, match)`. The match function is a copy of core's `Wildcard.match` (`core/src/util/wildcard.ts`, about 10 lines), because the CLI can't import core. `deny` refuses; `ask` forces the prompt even with `--yes`, and refuses in a non-interactive shell. `update` is evaluated the same way.
- **Org skills:** a slug that has `.kete-skill.json` under any `<global config>/managed/<org>/skills/` (iterate over `managed/*` with `KeteSyncCache.validOrganization` + `KeteSyncSkills.present`). `add` refuses such a name, and `update`/`remove` never resolve a path under `managed/`.
- **Walk rules:** use `lstat` on every entry. Skip a `.git` entry at any depth. A symlink or any other non-regular, non-directory entry refuses the whole install. Every relative path except the root `SKILL.md` goes through `KeteSyncSkills.safeRelative` (`util/src/kete/sync/skills.ts:49`). It returns undefined for a `.kete-skill.json`, so a source holding one is refused (it would impersonate an org skill). `--path` must be a safe relative path, and `realpath(subfolder)` must stay inside `realpath(clone)`. Limits: at most 256 files and 10 MiB in total. A script is a file with a `#!` first line, any `0o111` bit (POSIX), or an extension in `.sh .bash .zsh .fish .py .js .mjs .cjs .ts .rb .pl .ps1 .psm1 .bat .cmd .exe`. Every name, description and path shown passes through `KeteFolderTrustRules.safe` (it escapes control characters, so a hostile file name can't inject terminal escapes).
- **Name:** `--name`, else the frontmatter `name`, else the folder's basename. It must match `^[a-z0-9][a-z0-9._-]{0,63}$` (core derives the skill id from the folder name).
- **Install:** stage in `<scope>/.kete-skill-tmp-<random>/`, a sibling of `skills/`. It is outside the folder core scans with `**/SKILL.md`, so a running server never loads a half-written skill, and it is on the same filesystem, so the rename works. Write files with `0o600` and folders with `0o700`, then do the rename swap (old → `.kete-skill-old-<random>`, new → target, remove old, restore old if that fails, the same shape as `skills.ts:160-172`). Retry the rename on Windows (EPERM/EBUSY/EACCES, as in `cache.ts:70-76`). `<scope>` is `<cwd>/.kete` or the global config dir (`Global.Service` `.config`, as `mcp-preset-io.ts:103` does).
- **Lockfile** `<scope>/skills.lock.json`: `{version:1, skills:{[name]:{source, path?, ref?, commit?, files:{[rel]:sha256}, installedAt}}}`. It is decoded with an effect `Schema`, and an unknown version or invalid file refuses instead of being overwritten. Writes re-read the file just before writing, merge the one entry, and use a temp file + rename. Local sources have no `commit`; their update compares hashes.
- **Exit codes** follow `trust.ts:25`: 0 done, 1 failed (git or I/O), 2 refused or bad input (declined, non-interactive without `--yes`, policy, safety, org name). A refusal writes nothing. Every temp folder is removed in `finally`.

## Files
| File | Read / change | Why |
|---|---|---|
| packages/cli/src/index.ts | change (upstream, 1 marked block) | add `skill: { add, list, update, remove }` to `Handlers`, in the same shape as `trust` at the `:71-76` block |
| packages/cli/src/kete/commands.ts | change | `Spec.make("skill", {commands:[add, list, update, remove]})` next to `trust` (`:143-168`); flags per the spec (`--path`, `--ref`, `--name`, `--global`, `--yes`) |
| packages/cli/src/kete/trust.ts | read | the pattern for `Deps`, `EXIT`, `settle`, `realDeps` and the `Runtime.handler` exports |
| packages/cli/src/kete/terminal-setup.ts | read | the `interactive` + `@clack/prompts` `confirm` wiring (`:49-55`) |
| packages/cli/src/kete/mcp-preset-io.ts | read | how `Global.Service`, `KeteAccount.defaults/read` and `KeteSyncCache.read` are used from the CLI (`:100-140`) |
| packages/cli/src/kete/job-git.ts | change | add the optional `RunOptions.childEnv`, merged over `process.env` and passed to `execFile` |
| packages/cli/src/kete/skill-flow.ts | new | pure flows `add`/`list`/`update`/`remove` over injected `Deps` (git runner, fs root paths, confirm, interactive, out/err, policy reader, cwd, env). Fetch, walk, validate, review, policy, install, diff |
| packages/cli/src/kete/skill.ts | new | real `Deps` and `Runtime.handler` exports for the four subcommands |
| packages/util/src/kete/skill-source.ts | new | `parse(input, cwd)` → source union; `display` (credentials stripped); `policyResource`; `pinned(ref)`; `frontmatter(text)` (the YAML-only check above) |
| packages/util/src/kete/skill-lock.ts | new | the v1 schema, `read`, `upsert`/`delete` (re-read + temp + rename), `diff(oldFiles, newFiles)` → added/removed/changed |
| packages/util/src/kete/sync/skills.ts | read | `safeRelative` (`:49`), `present` (`:92`), the swap shape (`:160-172`) |
| packages/util/src/kete/sync/policy.ts | read | the `evaluate` signature (`:28-37`) |
| packages/util/src/kete/sync/cache.ts | read | `read`, `validOrganization`, the Windows rename retry (`:70-76`) |
| packages/util/src/kete/folder-trust.ts | read | `safe` (`:260`) |
| packages/util/src/kete/redact.ts | read | `text` (`:53`) for git stderr |
| packages/core/src/util/wildcard.ts | read | the matcher to copy into `skill-flow.ts` |
| packages/core/src/config/markdown.ts | read | the YAML-only front-matter rules to mirror (`:4-26`) |
| packages/cli/test/kete/trust.test.ts | read | the test style for a Deps-injected command |
| packages/cli/test/kete/skill.test.ts | new | AC1-AC11 against real `git` fixtures (a bare repo made in a temp dir) |
| packages/util/test/kete/skill-source.test.ts | new | source parsing, shorthand, credential stripping, policy resource, pinned, frontmatter (`---js` refused) |
| packages/util/test/kete/skill-lock.test.ts | new | the v1 round-trip, an invalid or unknown version refused, `diff` |
| README.md | change | a 3-line "Skills" note under `### Agents` (`:100`); the README has no command list today |
| CHANGELOG.md | change | an Unreleased entry (`:7`) |
| docs/upstream-patches.md | change | a new section "Skill commands (feature/kete-skill-commands)" listing the `index.ts` block and the README lines |

## Steps
1. **util `skill-source.ts`:** add the source union, `parse` (git URL forms `https://`, `ssh://`, `git@host:path`; the `owner/repo` shorthand only when it isn't an existing local path; otherwise a local folder that must exist and be a directory), `display`, `policyResource`, `pinned` and `frontmatter`. Write its tests.
2. **util `skill-lock.ts`:** add the schema, read (ENOENT → empty), atomic `upsert`/`remove` that re-reads before writing, and `diff`. Write its tests.
3. **`job-git.ts`:** add the `childEnv` option. Existing callers don't change.
4. **`skill-flow.ts`:** this holds the logic, in this order. Parse the source and refuse unsafe flags → policy → fetch to a temp dir (git) or use the folder (local) → resolve `--path` inside it → walk + limits + safeRelative → frontmatter → name check → org-name check → refuse an existing untracked folder with the same name (`add` only; it may be the person's own work) → review lines (name, description, source shown with credentials stripped, commit, each file with its size and `[script]`) → confirm rules (`--yes`, policy ask, interactive) → install + lockfile → print the result. `update`: run the local-edit check against the lockfile hashes and report it; a pinned ref prints "pinned" and stops; ls-remote and stop if unchanged; otherwise fetch, show the diff (scripts marked), and confirm (always required when there are local edits, even with `--yes`), then install. `list`: lockfile entries for project and global, untracked folders in `<scope>/skills` and `<scope>/skill` labelled "local", and org slugs labelled "org (read-only)". `remove`: only lockfile names, refusing anything else, including org names, and then removes the folder and the entry.
5. **`skill.ts` + `commands.ts` + `index.ts`:** wire them. In `index.ts`, add a `// kete_change start: kete skill (kete/skill.ts)` … `end` block.
6. **cli tests** in `test/kete/skill.test.ts`, one `describe` per AC. Build the fixtures with real `git` in `mkdtemp`. The hook fixture: a `GIT_CONFIG_GLOBAL` file sets `init.templateDir` to a template with a `post-checkout` hook that writes a marker; assert the marker is absent. Run the policy tests with a fake policy reader. For the timeout test, use a URL to a closed local port or a tiny `timeoutMs`. Assert no temp dir is left under `<scope>` and that a `https://user:secret@…` URL never appears in out, err or the lockfile.
7. **Docs:** add the README note, the CHANGELOG entry and the upstream-patches section.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | `bun test ./test/kete/skill.test.ts -t "add git"` (in packages/cli) |
| AC2 | `bun test ./test/kete/skill.test.ts -t "add local"` (cli) |
| AC3 | `bun test ./test/kete/skill.test.ts -t "review"` (cli) |
| AC4 | `bun test ./test/kete/skill.test.ts -t "safety"` (cli); `bun test ./test/kete/skill-source.test.ts` (in packages/util) |
| AC5 | `bun test ./test/kete/skill.test.ts -t "global"` (cli) |
| AC6 | `bun test ./test/kete/skill.test.ts -t "list"` (cli) |
| AC7 | `bun test ./test/kete/skill.test.ts -t "update"` (cli); `bun test ./test/kete/skill-lock.test.ts` (util) |
| AC8 | `bun test ./test/kete/skill.test.ts -t "remove"` (cli) |
| AC9 | `bun test ./test/kete/skill.test.ts -t "org"` (cli) |
| AC10 | `bun test ./test/kete/skill.test.ts -t "policy"` (cli) |
| AC11 | `bun test ./test/kete/skill.test.ts -t "errors"` (cli) |
| AC12 | `bun run typecheck` and `bun test ./test/kete` in packages/util and packages/cli; `bun test ./test/import-boundaries.test.ts` (cli); `bun run lint` (root); `bun run --cwd packages/kete-tools upstream:check` (root) |

## Cards to update after the build
- cli: the `kete skill` group, `skill-flow.ts`/`skill.ts`, `JobGit.run` `childEnv`, and the tests list
- roles-skills: user-installed skills (`.kete/skills`, `skills.lock.json`), the util frontmatter mirror of core's YAML-only rule
- sync: `skill.install` as a policy action evaluated by the CLI; org skill protection keyed on `.kete-skill.json`
- docs/context/contracts.md: `skills.lock.json` v1 and the `skill.install` action (runtime-side contracts)
- docs/context/pitfalls.md: the CLI can't import core (frontmatter and wildcard are mirrored, so keep them in step)
