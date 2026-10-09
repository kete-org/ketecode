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
| TypeScript, JavaScript | `typescript-language-server` (uses the project's `typescript` 5.x) | `npm i -g typescript-language-server typescript` |
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

A language server reads your project and can run parts of it (TypeScript loads the project's
`typescript`; rust-analyzer can run build scripts). So:

- Each server runs in Kete Code's [OS sandbox](sandbox.md) **without network** and with **nothing
  writable** except a private temp directory and the toolchain caches — not even the workspace. It
  can't read credentials. If you turned the sandbox off, or your platform has none (Windows, Linux
  without `bwrap`), servers run unsandboxed like formatters and MCP servers; if the sandbox is
  `required` and unavailable, no server starts.
- Built-in settings turn off features that run project code or use the network: rust-analyzer's
  build scripts, proc macros and check-on-save; TypeScript's automatic type acquisition; Go
  toolchain and module downloads (`GOTOOLCHAIN=local`, `GOPROXY=off`); cargo's network
  (`CARGO_NET_OFFLINE`).
- Kete Code's own credentials are removed from a server's environment.
- A repository's configuration can only turn servers **off**. Commands, environment and settings
  for a server are read only from your global configuration (`~/.config/kete/`), because a
  repository's config would otherwise name a program that runs on the first edit, without asking.
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
