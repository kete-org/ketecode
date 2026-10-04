# Contributing to Kete Code

Thanks for your interest. Kete Code is developed in the open, but the project is young and run by
a small team, so please read this before investing time.

## Issues

- **Bugs:** open an issue with steps to reproduce, `kete --version` and your platform.
- **Feature ideas:** open an issue to discuss before writing code.
- **Security problems:** never in an issue; see [SECURITY.md](SECURITY.md).
- **Questions about your account, billing or the gateway:** email support@ketecode.ai.

## Pull requests

Pull requests are welcome, but we can't promise to review or merge every one. Small, focused fixes
with tests are the most likely to land. For anything larger, open an issue first so we can agree on
the approach.

- Branch names follow `feature/*`, `fix/*`, `chore/*`, `docs/*`; commit messages are conventional
  (`fix(runtime): …`).
- Follow [`CLAUDE.md`](../CLAUDE.md): it is the rulebook for this repository (architecture,
  security rules, checks). In short:
  - Kete code lives in `src/kete/` or `packages/kete-*`. Edits to upstream OpenCode files are a
    last resort, carry a `kete_change` marker and are recorded in `docs/upstream-patches.md`.
  - Never weaken permission checks, workspace boundaries, secret handling or verification to make
    something work.
  - Run the checks for what you touched (typecheck and tests per package; `bun run lint`;
    `bun run --cwd packages/kete-tools upstream:check`).
- Workflows on pull requests from forks run after a maintainer approves them.

Changes that belong to OpenCode itself (not Kete-specific) are best contributed
[upstream](https://github.com/anomalyco/opencode); we pick them up on the next sync.

By contributing you agree that your contribution is licensed under the MIT License.
