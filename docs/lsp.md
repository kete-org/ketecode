# Language server diagnostics

After the agent edits a file, Kete Code asks the project's language server for errors in it and
adds any new ones to the edit's result, so the agent fixes a type error or a broken import before it
moves on — the way you would after seeing a red squiggle.

```text
Edit applied successfully.

Language server diagnostics for the edited files:
<diagnostics file="src/cart.ts">
ERROR [12:7] Type 'string' is not assignable to type 'number'. (typescript 2322)
</diagnostics>
```

## Languages

| Language | Server (must be on your `PATH`) | Install, for example |
| --- | --- | --- |
| TypeScript, JavaScript | `typescript-language-server` (with TypeScript 5.x installed beside it, else the project's) | `npm i -g typescript-language-server typescript` |
| Python | `pyright-langserver`, else `basedpyright-langserver` | `npm i -g pyright` or `pip install basedpyright` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |

Kete Code never downloads a language server. A language whose server isn't installed is skipped
quietly.

## What happens

- Servers start on the first edit of a file they handle — not when Kete Code starts — in the
  nearest folder with a project marker (`tsconfig.json`/`package.json`, `pyproject.toml`, `go.mod`,
  `Cargo.toml`, …), and keep running until the session's runtime stops. At most four run at once.
- After `edit`, `write` and `patch`, Kete Code sends the new text and waits up to 4 seconds for the
  server's diagnostics (the first time a server starts it also waits for it to initialize, up to
  20 seconds).
- Only **errors** are reported, at most 20 per file and 5 files per edit. An error already reported
  in the session isn't repeated while it persists: the result says how many earlier errors remain,
  or that they are fixed.
- A server that fails to start or crashes is skipped until Kete Code restarts; the edit itself
  never fails because of a language server.

## Safety

A language server runs code the repository controls. Known paths: `typescript-language-server`
loads the project's `node_modules/typescript` and any tsserver plugins its `tsconfig.json` names;
pyright runs the Python interpreter of a `venvPath`/`venv` set in the repository's
`pyrightconfig.json` or `pyproject.toml`; rust-analyzer runs cargo and rustc, which follow the
repository's `.cargo/config.toml` (`build.rustc`, rustc wrappers) and a `rust-toolchain.toml`
toolchain path, and it reads `rust-analyzer.toml`; gopls runs `go list`, which can run `pkg-config`
for cgo. So:

- Each server runs in Kete Code's [OS sandbox](sandbox.md) **without network** and with **nothing
  writable** except a private temp directory and the toolchain caches — not even the workspace. It
  can't read credentials.
- **No sandbox, no servers.** When the sandbox is turned off, unavailable (Linux without `bwrap`) or
  missing (Windows), language servers don't start. To run them anyway, set
  `"kete": { "lsp": { "unsandboxed": true } }` in your **global** config — they then run the
  project's code with your full access. A policy denying `sandbox_off` always wins: no unsandboxed
  servers (either form in [the sandbox docs](sandbox.md#organizations); the start passes the same
  `sandbox_off` permission check as an unsandboxed shell command). A sandbox that is `required` but unavailable
  never runs them.
- Programs are found only in **absolute** `PATH` entries: never the current directory (Windows'
  default), never relative entries, and never a file whose real path is inside the workspace — a
  repository can't plant its own `gopls.exe` or `typescript-language-server.cmd`. On Windows the
  servers also get `NoDefaultCurrentDirectoryInExePath=1`.
- Settings turn off what is cheap to turn off: rust-analyzer's build scripts, proc macros and
  check-on-save; cargo's rustc wrappers (`RUSTC_WRAPPER`, `CARGO_BUILD_RUSTC_WRAPPER`,
  `CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER` set empty) and network (`CARGO_NET_OFFLINE`); TypeScript's
  automatic type acquisition and probe-location plugins, and Kete Code uses a TypeScript installed
  next to `typescript-language-server` when there is one; Go toolchain and module downloads
  (`GOTOOLCHAIN=local`, `GOPROXY=off`). The rest (tsconfig plugins, a configured venv interpreter,
  `build.rustc`, toolchain paths, `pkg-config`) is contained by the sandbox, not prevented.
- A server's environment is an allowlist — `PATH`, `HOME`, user and locale variables, temp
  directories, the XDG and Windows system directories, and toolchain locations (`GOPATH`, `GOROOT`,
  `GOCACHE`, `GOMODCACHE`, `CARGO_HOME`, `RUSTUP_HOME`, `NODE_PATH`, `NVM_DIR`) — never a name that
  looks like a credential, plus the server's own `env`.
- A repository's configuration can only turn servers **off**. Commands, environment and settings
  for a server are read only from your global configuration (`~/.config/kete/`).
- Kete Code sets no memory or CPU limits on servers (at most four run at once).
- Never in jobs (cloud, self-hosted, review jobs): they start no processes beyond their tool runner.
  Not for locations in a remote workspace.

## Configuration

Kete Code reads the `lsp` key (the same key OpenCode uses):

```jsonc
// ~/.config/kete/kete.jsonc
{
  // false turns diagnostics off entirely (also allowed in a project's kete.json)
  "lsp": {
    "rust": { "disabled": true },                       // one server off
    "typescript": {                                     // override a built-in (global config only)
      "command": ["typescript-language-server", "--stdio"],
      "initialization": { "tsserver": { "path": "/usr/local/lib/node_modules/typescript/lib/tsserver.js" } }
    },
    "lua": { "command": ["lua-language-server"], "extensions": [".lua"] }  // a new server (global config only)
  }
}
```

`env` adds environment variables for a server; `initialization` is sent as its initialization
options and as its settings. Settings a repository's config gave that were ignored are logged.

## Limits

- Diagnostics are a snapshot shortly after the edit; a server that needs longer (a large project's
  first load) may report on a later edit instead.
- Hover, go-to-definition and references aren't offered to the agent.
- In VS Code and JetBrains the agent can also ask the editor for its diagnostics (VS Code's
  `editor_diagnostics` tool, JetBrains' `editor` → `diagnostics`); those are separate from this.
