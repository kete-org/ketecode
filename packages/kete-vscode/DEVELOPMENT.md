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
- End-to-end check in a real VS Code window (isolated profile and Kete state; local only):
  `bun run e2e <path/to/kete-code-…-<target>.vsix>`

The extension is not published to the VS Code Marketplace or Open VSX yet.
