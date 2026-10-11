# Plan: /feedback and kete bug (A11)

<!-- Written by the planner from spec.md and the module cards. This file list is the implementer's reading list. -->

Upstream edits (all minimal, marked, recorded in `docs/upstream-patches.md`): `tui/src/component/error-component.tsx`
(crash screen), `tui/src/plugin/builtins.ts` (plugin registration), `cli/src/index.ts` (handler). No shared
contract or config schema change; new user contracts `kete bug` and `/feedback` (spec-approved).

## Cards read
- docs/context/modules/cli.md (verified-at f85913ed4a, **stale**: 14 files since; the "Adding a flat command"
  recipe still matches `completion` from A12)
- docs/context/modules/ui-branding.md (verified-at a6f140247e, **stale**: home-notices/home-tips only)
- docs/context/modules/account-login.md (verified-at a6f140247e, **stale**: commands.ts only)
- docs/context/pitfalls.md

## Design
- **One pure builder** `util/src/kete/bug-report.ts` (no Node imports): `Facts` → markdown report; `scrub`
  (home → `~`, emails, `KeteRedact.text`, control/ANSI chars); `logLines` (logfmt, last 200 lines, field
  allowlist: timestamp, level, message, role, component, type, backend, durationMs, http.method, http.status,
  version, channel, attempt, reason, error, cause; `args`, `event.data`, `command`, paths, URLs and ids
  dropped); `providerIds`/`mcpStates` decode unknown runtime responses (ids, names and status only); `issueURL`
  (`Brand.urls.issues/new?template=bug-report.yml` with `title`, `description`, `opencode-version`, `os`,
  `terminal`; ≤ 6000 chars, oldest log lines dropped to fit, with a note naming the saved file).
  Defence in depth: the whole rendered report goes through `scrub` again.
- **File helpers** `util/src/kete/bug-report-file.ts`: `tail(file, maxBytes)` and `save(dir, text)` (random
  name, `wx`, mode 0600).
- **CLI** `kete bug [description] [--print] [--server] [--standalone]`: `cli/src/kete/bug-flow.ts` (collect +
  run over injected `Deps`: env, home, account read, install detection, runtime queries, log tail, save, TTY,
  confirm, open, out/err) and `cli/src/kete/bug.ts` (handler, real deps). Report → stdout; saved path and the
  security line → stderr; prompt only when stdin and stdout are TTYs and `--print` is off.
- **TUI** builtin plugin `tui/src/kete/feedback.tsx`: `/feedback` (alias `/bug`, palette "Report a problem"),
  dialog with the report (scrollable) and o Open issue / c Copy / s Save / esc Cancel, plus the security line.
  Real side effects (open, account read, log tail, save dir) in `tui/src/kete/feedback-deps.ts` so the test
  replaces them with `mock.module`.
- **Crash screen**: `Brand.urls.issues` instead of OpenCode's repo, message and stack scrubbed, "Open issue"
  action (key `o`) through `open`.
- `Brand.urls.issues` = `https://github.com/kete-org/ketecode/issues`; new `Brand.urls.securityReport`.

## Files
| File | Read / change | Why |
|---|---|---|
| packages/util/src/kete/brand.ts | change | issues URL, securityReport URL |
| packages/util/src/kete/redact.ts | read | redactor reused |
| packages/util/src/observability/logging.ts | read | `file(local, channel)` log path |
| packages/util/src/kete/account.ts | read | `read` → signed in yes/no |
| packages/util/src/kete/offline.ts | read | `enabled` |
| packages/util/src/kete/bug-report.ts | new | builder |
| packages/util/src/kete/bug-report-file.ts | new | tail + save |
| packages/util/test/kete/bug-report.test.ts | new | AC1, AC3, planted secrets, file mode |
| packages/cli/src/kete/commands.ts | change | `bug` spec |
| packages/cli/src/index.ts | change (upstream, marked) | handler |
| packages/cli/src/kete/bug-flow.ts, bug.ts | new | flow + handler |
| packages/cli/src/kete/updater.ts, sandbox.ts, ui/prompt.ts, version.ts, services/server-connection.ts | read | detect, sandbox RPC, open/confirm, version, connection |
| packages/cli/test/kete/bug.test.ts | new | AC1/AC2 flow + subprocess `--print` and no-TTY |
| packages/tui/src/kete/feedback.tsx, feedback-deps.ts | new | `/feedback` |
| packages/tui/src/plugin/builtins.ts | change (upstream, marked) | register |
| packages/tui/src/component/error-component.tsx | change (upstream, marked) | AC5 |
| packages/tui/src/kete/release-notes.tsx, sandbox-status.tsx, permission-mode.tsx | read | dialog/command/RPC patterns |
| packages/tui/test/kete/feedback.test.tsx, crash-report.test.tsx | new | AC4, AC5 |
| packages/core/src/kete/skill.ts, core/test/kete/skill.test.ts | read / change | report skill now names the tracker |
| .github/README.md | change | "Reporting a problem" |
| docs/upstream-patches.md | append | three upstream edits |

## Steps
1. Brand URLs; update `core/test/kete/skill.test.ts` expectation. Check: core `bun run test ./test/kete/skill.test.ts`.
2. util builder + file helpers + tests. Check: util `bun test ./test/kete/bug-report.test.ts`, typecheck.
3. CLI spec, flow, handler, index entry, tests. Check: cli `bun test ./test/kete/bug.test.ts ./test/kete/completion.test.ts`, typecheck.
4. TUI plugin + deps + builtins; crash screen; tests. Check: tui `bun test ./test/kete/feedback.test.tsx ./test/kete/crash-report.test.tsx`, typecheck.
5. README, upstream-patches.
6. Full checks, binary build, `kete bug --print` reviewed by eye, pty `/feedback` + Cancel with scratch XDG.

## Verification
| Criterion | Command (narrowest first) |
|---|---|
| AC1 | util `bun test ./test/kete/bug-report.test.ts`; cli `bun test ./test/kete/bug.test.ts` |
| AC2 | cli `bun test ./test/kete/bug.test.ts` (subprocess `--print`, piped = no TTY, mode 0600) |
| AC3 | util `bun test ./test/kete/bug-report.test.ts` (URL prefix, cap, over-cap note) |
| AC4 | tui `bun test ./test/kete/feedback.test.tsx` |
| AC5 | tui `bun test ./test/kete/crash-report.test.tsx` |
| AC6 | typecheck/test in util, cli (`bun test test/kete`), tui (`bun run test`), kete-tools; root `bun run lint`; `upstream:check`; `verify --base main`; built binary `kete bug --print` |

## Cards to update after the build
- cli (new `kete bug`), ui-branding (`/feedback`, crash screen Open issue), account-login (Brand.urls.issues /
  securityReport); all three were already stale.
