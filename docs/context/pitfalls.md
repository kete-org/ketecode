# Pitfalls

Mistakes to avoid, grouped. Each item cites where the rule lives or where it bit before.

## Upstream & markers

- **Upstream-first, not edit-first:** before adding any new engine/manager/config
  system, find the upstream equivalent and extend it (`CLAUDE.md:93-106`,
  `docs/adr/0001-opencode-upstream-strategy.md:14-21`). Editing an upstream file is the
  *last* resort, not the default.
- **Every upstream-file edit needs a `kete_change` marker** (`CLAUDE.md:108-116`);
  files that can't hold comments (`.json`, lockfiles, `.md`) are recorded in
  `docs/upstream-patches.md` instead (e.g. its "Merge notes" section at
  `docs/upstream-patches.md:545-553`). Run
  `bun run --cwd packages/kete-tools upstream:check` before opening a PR
  (`CLAUDE.md:196-198`, `docs/upstream-sync.md:49-58`) — it isn't run in CI on this
  branch's history, so don't rely on CI to catch a missing marker.
- **Never reformat or refactor upstream code you aren't changing**
  (`CLAUDE.md:118-119`) — including running a formatter over an upstream file that
  wasn't already clean; a stray reformat turns a one-line logical diff into a
  file-wide diff that conflicts on every future sync.
- **Never copy individual OpenCode files by hand** (`CLAUDE.md:123-124`,
  `docs/upstream-sync.md:10-11`); syncs merge a tagged upstream release on its own
  `upstream/vX.Y.Z` branch, never directly on `main`.
- **After a sync, re-check for new upstream leaks:** `docs/upstream-patches.md:547-553`
  — grep for new `.opencode`/`opencode.json` literals and new user-facing "OpenCode"
  strings; `upstream:check`'s "leaks" step only catches what it already knows to look
  for.

## Branding

- **Never hard-code "opencode"/"kete" names** — import from
  `packages/util/src/kete/brand.ts` (`CLAUDE.md:53-55`). Inherited internal identifiers
  (`@opencode/*` package names, `OPENCODE_*` env names post-bridge, the `opencode` tool
  namespace) are left as-is on purpose — don't "fix" them
  (`docs/adr/0001-opencode-upstream-strategy.md:38-39`).
- User-facing text says "Kete Code"/`kete`, never "OpenCode" or "Kilo"
  (`CLAUDE.md:137-138`).

## Config

- The `kete` section doesn't deep-merge across config files: it's an atomic field (`packages/core/src/config/normalize.ts:214`) and readers take the last file's whole `kete` object (`Config.latest`, `packages/core/src/config.ts:23-26`). `kete.budget` in the global config and `kete.subagents` in the project config don't combine — the project's `kete` replaces the global one. Put all `kete` settings a project needs in one file.
- No fallback to `.opencode`; config is `~/.config/kete/` and `./.kete/` only
  (`CLAUDE.md:136`).
- Never hard-code endpoints, credentials, org IDs, model names, or deployment URLs —
  typed configuration only (`CLAUDE.md:141-142`).
- Config precedence is platform policy → organization → project → user → workspace, and
  for security policy the *more restrictive* setting wins, not the closer one
  (`CLAUDE.md:139-140`).

## Tests

- **Never run tests from the repo root** — run `bun run test` inside each package
  (`CLAUDE.md:189-190`).
- **`core` and `server` have isolating test scripts** (`packages/core/script/test.ts`,
  `packages/server/script/kete/isolated-test.ts`) that set HOME/XDG to a temp
  directory so tests don't read the developer's real Kete account; don't bypass them
  with a bare `bun test` in those two packages (`CLAUDE.md:190-191`).
- The **30 machine-dependent core failures** (23 ripgrep-related, 7 shell-syntax) exist
  on `main` too — they're environment-dependent, not a regression you introduced;
  `bun run --cwd packages/kete-tools verify --base main` reports only *new* failures
  for exactly this reason (`docs/status/2026-09-25-runtime-status.md` item 6).
- The **full core suite** (no path filter) can show flaky pty-related timeouts under
  load; a narrower `bun run test ./test/path/to/file.test.ts` or a re-run is usually
  the fix, not a real regression — don't chase it as one.

## SDK / protocol generation

- After changing `packages/server/src/` endpoints, the protocol, or exposed schema
  types: regenerate `packages/protocol/openapi.json` (`bun run generate` in
  `packages/protocol`) **then** `packages/client/src/*/generated/` (`bun run generate`
  in `packages/client`) — order matters, protocol first (`CLAUDE.md:214-217`).
- **Never hand-edit generated files** — `packages/sdk/` and `packages/client/src/*/generated/`
  are generated; hand edits get silently overwritten on the next `bun run generate`
  (`CLAUDE.md:56`, `CLAUDE.md:217`).
- Commit both regenerated outputs together, not just the one you happened to touch.

## Permissions and sessions

- **Session hooks can't fail** (`packages/core/src/plugin/hooks.ts:23-30` — only the `tool`
  `execute.before` hook may fail); a refusal that needs to happen on a session-level action
  (metadata update, a prompt starting) has to be a plain guard function called directly from the
  service/runner, not a hook. `KeteUnattendedPolicy.guardMetadata`/`guardPermissions`
  (`session/session.ts:76-91`) and `KeteRunChecks`/`KeteUnattended.check` at the runner step
  (`session/runner/llm.ts:229`, `budget`/`unattended` cards) are the two examples so far.
- **An `evaluate` hook that loosens must run before the hooks that tighten**, not after: hook
  order is plugin registration order (`packages/core/src/permission.ts:179`), and nothing lets a
  later hook "undo" an earlier tightening. `KeteUnattended.PolicyPlugin` (loosens an unattended
  run's policy-allowed `ask` to `allow`) is deliberately the first `pre` hook to touch `evaluate`;
  `KeteUnattended.Plugin` (denies any `ask` still standing) is deliberately the last `post` hook —
  see the `permissions` and `unattended` cards.
- **Not every "wait on a person" path goes through the permission system** — the unattended-runs
  task (2026-09-28) only closes the permission-`ask` path. `Form` in the question tool
  (`tool/plugin/question.ts:75`, gated by the `question` permission, which the unattended policy
  can never allow) is covered; websearch provider choice (`tool/plugin/websearch.ts:76,109`) and
  MCP elicitation (`mcp/index.ts:235,263`) are not — in an unattended run today they'd wait
  indefinitely, bounded only by the run's own time limit, not refused outright. No card owns this
  yet; treat it as open before relying on those two paths inside a job.
- **Session hooks can't fail, so a model-request enforcement rule can't live in `model.request`/
  `http.request`.** Job mode (2026-09-29) needed to *refuse* certain outgoing model requests before
  any bytes reached the network (function-tools-only, inline-content-only, an output-token ceiling
  — ADR 0020 rules 8/16/17); it enforces them in a Kete `RequestExecutor` layer
  (`packages/core/src/kete/job-request.ts`) that replaces `LayerNodePlatform.requestExecutor`
  (`core/src/effect/app-node-platform.ts:7`) instead, because that's the one chokepoint every model
  HTTP request goes through — including `core/src/generate.ts`'s `Generate`, which bypasses session
  hooks entirely — and the only one whose caller can fail with a typed error. See the `job-mode`
  card.

## Tests (additions)

- A JS default parameter applies to an explicit `undefined`: a test helper `setup(name, undefined)` for "no agent" got the default `"developer"` and ran a real job (`cli/test/kete/job-socket.subprocess.test.ts`). Use `null` as the "none" sentinel.
- Internal plugins activate lazily in a forked fiber (`core/src/plugin/supervisor.ts:225-236`); `agent.list`/`agent.get`/`session.create` don't await activation, only prompt/LLM/shell/command do.

## Security

- Released contracts (CLI login v1, sync v1, runtime registration, gateway) change
  **additively only**; the platform's copy is the source of truth — re-copy and diff
  before assuming a field is safe to remove (`docs/context/contracts.md`).
- Never store a long-lived credential in plaintext config — real regression fixed at
  `3e15338eeb` ("fix(vscode): drop the plaintext gateway API key command"): a VS Code
  command wrote the gateway key to a file referenced from `kete.json`, breaking the
  OS-native-storage rule (`CLAUDE.md:239-240`); `kete login` now stores it in the OS
  credential store instead.
- Validate every external input, including a pasted platform URL — real regression
  fixed at `77631e9bd6` ("fix(cli): refuse a platform URL whose host has stray
  characters (a pasted trailing comma)").
- Subagents must never exceed their parent's permissions — real regression fixed at
  `44f9946d5b` ("fix(runtime): subagents can't exceed their parent; guard session_move
  and worktree names").
- Redact secrets from tool output, logs, telemetry and errors before they reach a model
  or a log line (`CLAUDE.md:237-239`); the CLI-login client explicitly never lets the
  PKCE verifier, code, or key reach an error message (`packages/cli/src/kete/cli-login.ts:5-6`).
- **A generic redactor exists — use it, don't write a new one:** `KeteRedact`
  (`packages/util/src/kete/redact.ts`, `text`/`deep`/`truncate`; first user: the `audit-log` card).
  Redact **before** truncating, and only after bounding a very large string to a pre-redact window
  first — a truncation cut must never land inside a secret the redactor hasn't scanned yet. It's
  pattern-based and best-effort: a bare secret-looking key name like `pass`/`PASS` also matches
  ordinary short values (e.g. a `pass: 42`/`PASS=1` count), so some non-secret fields get redacted
  too — a deliberate over-redaction trade-off, not a bug to "fix" by narrowing the pattern
  (`audit-log` card).
- **A non-dumpable process's `/proc/<pid>/{environ,fd,mem}` are root-owned, and even root needs
  `CAP_SYS_PTRACE` to read them** (Docker drops it). Job-mode `kete` processes are non-dumpable
  (`packages/cli/src/kete/dumpable.ts`), so a leak scan that treats EACCES as "nothing there" passes
  without looking — record it as a failure. `/proc/<pid>/status` has no `Dumpable:` field; use
  `PR_GET_DUMPABLE`. `environ` is the exec-time env: deleting from `process.env` doesn't rewrite it
  (`job-mode` card).
- **`O_DIRECTORY`/`O_NOFOLLOW` differ between x86_64 and arm64** (and so do syscall numbers).
  `util/src/kete/linux-ffi.ts` keeps a per-arch table; a hand-copied Linux constant that passes on
  one machine breaks `openat2` on the other. A test compares the table to `fs.constants`.
- **FSUtil's derived helpers call the inner FileSystem**, so wrapping or replacing a primitive does
  not cover `scan`/`glob`/`globUp` and the like; a wrapper (`util/src/kete/job-fs-util.ts`) must
  override each one itself (`job-mode` card).
- **A job-mode `kete serve` can't start on macOS** (or kernel < 5.6): confinement needs `openat2`
  and fails closed. Tests that build a job-mode server pass a fake `Confine`; subprocess tests branch
  by platform (`job-mode` card).
- **A spawned child's pipe can't be closed from the parent through effect's spawner**: the handle
  exposes a PassThrough, not the socket (`job-standalone.ts` fd 4; `job-mode` card).
- **`HTTP_PROXY` turns a Bun `fetch` over a unix socket into an absolute-form request.** Keep proxy
  variables out of any env whose process talks to a local socket server over `http://` (the job's
  `kete` has `HTTPS_PROXY` only; `server-sdk` card).

## VS Code

- Bundle the CLI binary and spawn `kete serve`; use only public extension APIs so the
  extension keeps working in VS Code forks (Cursor, Windsurf, VSCodium)
  (`CLAUDE.md:148-150`).
- A bundled dependency's build target matters: real regression fixed at `296831e3cc`
  ("fix(vscode): bundle jsonc-parser's ESM build so the extension activates") — the
  wrong build of a bundled package kept the extension from activating at all.
- Don't read a VS Code enum at module load time if the API might not be ready yet —
  real regression fixed at `aa89d2ed4b` ("fix(vscode): don't read VS Code's
  DiagnosticSeverity enum at module load").
- lint for `kete-vscode` is the **root** `bun run lint`, not a package-local script
  (`CLAUDE.md:218-219`).

## Releases

- Kete tags are `kete-vX.Y.Z`; bare `vX.Y.Z` tags belong to upstream OpenCode — real
  regression fixed twice at `fdcfc506bf`/`0135da3d8a` ("tag Kete releases kete-vX.Y.Z,
  apart from upstream's tags") after a collision risk was found. Never push upstream's
  tags to `origin` (`CLAUDE.md:211`).
- Only a maintainer tags a release; never run upstream's
  `packages/cli/script/publish*.ts` or enable `publish.yml` — they publish to
  OpenCode's own npm/Homebrew/image registry (`CLAUDE.md:211-213`).
- Pre-release detection needs care: real regression fixed at `4a3a5cfe94`/`f4efe33a66`
  ("mark only version suffixes as pre-releases").

## Git / process

- **`gh` defaults to the upstream repo** (`anomalyco/opencode`), not this fork —
  always pass `--repo kete-org/ketecode` (user memory: `gh-repo-flag.md`).
- **Don't `git add -A` (or similar broad adds) across `docs/`** — untracked
  user-authored files live there that aren't meant for every commit; this session's own
  `git status` shows `docs/status/`, `docs/tasks/` and `scripts/` untracked at HEAD
  (`bfd6c66db1`) for exactly this reason. Stage the specific files you changed.
- **Stacked PRs close when their base branch is deleted.** This repo's recent history
  merges feature branches in sequence (e.g. PRs #46–#49 on `main`, per `git log
  --oneline -10`); if a later branch is based on an earlier feature branch rather than
  `main`, merge the base PR first and retarget (or rebase) the dependent branch before
  its base branch disappears — otherwise GitHub closes the dependent PR instead of
  retargeting it.
- Conventional commit messages, focused PRs — don't mix features, refactors, dependency
  bumps and formatting in one PR (`CLAUDE.md:322-324`).
- Branch names follow `feature/*`, `fix/*`, `chore/*`, `docs/*`, `upstream/*`
  (`CLAUDE.md:322`); default branch and PR target is `main`, not `v2`
  (`CLAUDE.md:17-18`, overriding `AGENTS.md`).
