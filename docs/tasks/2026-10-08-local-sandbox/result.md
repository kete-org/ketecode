# Result: Local OS sandbox for agent shell commands (Wave 0b)

## What changed
- New Kete-owned runtime: `core/src/kete/sandbox.ts` (decision, notice, escape hook, status RPC,
  guarded plugin) and `core/src/kete/sandbox/` (`settings`, `policy`, `seatbelt`, `bubblewrap`,
  `resolve`, `probe`, `actions`, `plans`). Schema: `kete.sandbox` config, `kete.sandbox` RPC.
- Approval marks in `permission-mode.ts` and `unattended.ts`; sandbox actions bypass
  permission-mode's Plan rule (decided by the sandbox hook).
- Clients: `kete sandbox` (cli), TUI footer "⚠ Unsandboxed", prompt text for `sandbox_off` /
  `sandbox_network` in the TUI and web UI.
- Upstream edits (marked, recorded in `docs/upstream-patches.md`): `core/src/shell.ts`,
  `core/src/tool/plugin/shell.ts`, `core/src/plugin/internal.ts`, `tui/src/util/permission.ts`,
  `app/src/runtime/i18n/en.ts`, `core/test/tool-shell.test.ts`, TUI test client fixture.
- CI: `kete-checks` installs bubblewrap, allows unprivileged user namespaces, runs the sandbox
  tests with `KETE_SANDBOX_TESTS=required`.
- Docs: ADR 0013, `docs/sandbox.md`, `docs/permissions.md`, the `sandbox` card, permissions card, INDEX.

## Platform support
| Platform | Mechanism | Status |
| --- | --- | --- |
| macOS 26 (Darwin 25.6) | sandbox-exec | tested locally (integration tests) |
| Linux + bubblewrap | bwrap | tested in CI (ubuntu-latest, non-root, userns allowed) and in Docker (root) |
| Linux without bwrap / userns | none | unsandboxed, visible; `required` refuses |
| Windows | none | unsandboxed, visible |
| Job mode | job sandbox | untouched |

## Checks
| Check | Result |
| --- | --- |
| core typecheck, `bun run test ./test/kete` (macOS) | pass (1184 / 0) |
| sandbox unit + integration tests, macOS | 38 pass |
| sandbox integration tests + harness run mode, Linux Docker (root) | 38 + 5 pass |
| cli, tui, app, schema, kete-tools typecheck; cli/tui kete tests | pass |
| root `bun run lint` | 0 warnings, 0 errors |
| `upstream:check` | passed |
| card-check | clean |
| CI (build, kete-checks, e2e) on the final commit | pass |
| `verify --base main` (macOS) | 0 new failures (core 30 failing on main too: ripgrep/search-tool and bash 3.2 tests) |

## Found while building
- Seatbelt with only `(allow default)` let `open -a` launch an app and AppleEvents reach Finder;
  Mach default-deny fixes both.
- Apple's xcrun shims write to the per-user temp dir regardless of TMPDIR.
- Kete worktrees live in the (hidden) data directory: rules now apply parent-first.
- `git add -A` fails on character devices and on unreadable files: Linux placeholders are excluded
  through a bound copy of `info/exclude`.
