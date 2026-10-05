# Developing the Kete Code extension

The terminal commands derive from upstream OpenCode's `sdks/vscode` extension. The chat frames the
web UI that `kete serve` serves (upstream's `packages/app`); `packages/app/src/kete/vscode-host.tsx`
is its side of the editor bridge.

From `packages/kete-vscode/`:

- Typecheck: `bun run typecheck`; unit tests: `bun run test`
- Build: `bun run build` → `dist/extension.js`
- Run from source: build `kete` (`bun run build --single` in `packages/cli`), set `kete.cliPath` to
  it, then `code --extensionDevelopmentPath="$PWD"`
- Packages: `bun run --cwd packages/kete-tools release kete-vX.Y.Z` builds one `.vsix` per platform,
  each with its binary in `bin/` (`--single` for this machine only)
- End-to-end check in a real editor window (isolated profile and Kete state):
  `bun run e2e <path/to/kete-code-…-<target>.vsix> [--code <editor CLI>] [--assert]`. VS Code by
  default; pass a fork's CLI for another editor (e.g. VSCodium's `bin/codium`, or on macOS
  `VSCodium.app/Contents/Resources/app/bin/codium`). `--assert` fails the run unless every check in
  `script/e2e-check.ts` holds. CI runs it on the linux-x64 package in VS Code and VSCodium
  (`kete-release.yml`, `extension-e2e`).

The extension is not published to the VS Code Marketplace or Open VSX yet.
