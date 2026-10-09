# Result: Wave 1a — todo list, LSP diagnostics, config shell hooks

Status: built; three PRs open, CI green at the time of writing, not merged.

| PR | Branch | Scope |
| --- | --- | --- |
| #29 | `feature/wave1a-todo` | `todowrite` tool, `kete.todo` RPC, TUI sidebar/footer, web dock |
| #30 | `feature/wave1a-lsp` | language server diagnostics behind the upstream `lsp` key |
| (hooks PR) | `feature/wave1a-hooks` | `kete.hooks` config shell hooks with trust |

Each branch contains the previous one's commits and targets `main`.

## Acceptance criteria
- AC1 todo tool, persistence, RPC/event, restart, Plan mode — `core/test/kete/todo.test.ts`.
- AC2 TUI and web rendering helpers — `tui/test/kete/todo.test.tsx`, `app/src/kete/todo.test.ts`.
- AC3 LSP with a fake server, dedupe, bounds, `lsp: false`, missing binary, crash, job mode, credentials, real sandbox — `core/test/kete/lsp.test.ts`; manual real `typescript-language-server` smoke (env-gated test) passed.
- AC4 hooks: deny (exit 2, JSON), fail closed (error, timeout), context, SessionStart/Stop/Notification, trust (asked once, remembered, re-asked on change, declined), unattended, policy, job mode — `core/test/kete/hooks.test.ts`; `kete job run` guard — `cli/test/kete/job-project-config.test.ts`.
- AC5 docs: `docs/todo.md`, `docs/lsp.md`, `docs/hooks.md`, cards `todo`/`lsp`/`hooks`, INDEX, `upstream-patches.md`, `.github/README.md`, VS Code/JetBrains READMEs.

## Verification
- `verify --base main`: todo branch 0 new failures (after fixing 46 found by the first run: a TUI fixture route and an upstream test's tool list); LSP branch 1 new failure (job-mode file-access classification), fixed; hooks branch (all three) 0 new failures. Core's 30 failures are the machine-dependent ones `main` has too.
- Root lint, `upstream:check`, card-check, protocol/client `check:generated` (hooks): clean.

## Decisions and deviations
- Hooks live under `kete.hooks` (Kete's namespace), not a new top-level key, to avoid an upstream schema edit.
- UserPromptSubmit can add context but can't block (session hooks can't fail).
- `kete job run --trust-project-config` lets a repository with `kete.hooks` run, but untrusted project hooks are still skipped in the unattended session; they run only if the user trusted those exact hooks interactively before. (Passing the flag's trust to the server would need a new field in the versioned unattended metadata.)
- Hooks run outside the OS sandbox (documented); language servers run inside it without network.
