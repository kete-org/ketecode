# Harness

Kete Code can read Harness (pipelines, executions, services, environments and more) from a
session, and act on it when you allow it, through Harness's official MCP server
([`harness-mcp-v2`](https://www.npmjs.com/package/harness-mcp-v2), MIT,
[github.com/harness/mcp-server](https://github.com/harness/mcp-server)).

```sh
kete mcp add harness                      # read-only; asks for your API key (hidden input)
kete mcp add harness --org default --project payments
kete mcp add harness --base-url https://harness.example.com   # self-managed Harness
kete mcp add harness --write              # allow create/update/delete/execute (each use still asks)
kete mcp add harness --global             # global config instead of the project's
```

`kete mcp presets` lists the built-in presets.

## What it sets up

- A local MCP server named `harness` that runs `npx -y harness-mcp-v2@3.2.32`: an **exact pinned
  version**, never `@latest`. It needs Node.js (`npx`) on your `PATH`.
- `HARNESS_READ_ONLY=true` unless you pass `--write`: the server itself then refuses to create,
  update, delete or execute anything.
- Permission rules in the same config file: `harness_list`, `harness_get`, `harness_describe`,
  `harness_schema`, `harness_search`, `harness_diagnose` and `harness_status` run without asking;
  `harness_create`, `harness_update`, `harness_delete` and `harness_execute` **always ask**, with or
  without `--write`; any other or future Harness tool asks too. Rules match on `harness_<tool>`
  (MCP tool permissions are `<server>_<tool>`). Running `kete mcp add harness` again replaces these
  rules instead of adding copies.
- Optional settings become the server's environment: `--org` → `HARNESS_ORG`, `--project` →
  `HARNESS_PROJECT`, `--base-url` → `HARNESS_BASE_URL` (always written; default
  `https://app.harness.io`). To change any of them, re-run `kete mcp add harness` with the new
  flags rather than editing the file: the stored key is bound to the exact definition (below).
- Running `kete mcp add harness` again keeps any stricter rule of yours on these tools (a `deny`, an
  `ask` where the preset allows, or a rule for a narrower resource) after the preset's rules, so it
  still wins. An `allow` of yours where the preset asks is replaced, with a warning.

## The API key

`kete mcp add harness` asks for the key with hidden input and stores it in your OS credential
store (macOS Keychain, Windows Credential Manager, or Secret Service on Linux; a file only you can
read when none is available, with a warning). The config gets only a reference:

```jsonc
"environment": { "HARNESS_API_KEY": "{kete-secret:mcp:harness}", "HARNESS_READ_ONLY": "true" }
```

The runtime looks the key up when it starts the server and passes it only to that process. It is
never written to config, printed or logged. Only `mcp:` entries can be referenced this way, so a
config can't hand your Kete account key to a server.

**The key is bound to the server definition it was stored for.** A repository you open can bring
its own `.kete/` config, so a reference alone doesn't release the key. Next to the key, the
credential store keeps a SHA-256 fingerprint of the server `kete mcp add harness` wrote: its name,
`type: "local"`, the exact `command`, its working directory, and every `environment` entry except
the key reference itself (`HARNESS_BASE_URL`, `HARNESS_ORG`, `HARNESS_PROJECT`, `HARNESS_READ_ONLY`,
`HARNESS_TOOLSETS`, ...). When the runtime starts a server it releases the key only if the server is
local, it is named `harness` (the reference must be `mcp:<its own name>`), and its current definition
has the stored fingerprint. Anything else — another server referring to `mcp:harness`, a changed
command, a different `HARNESS_BASE_URL`, an added variable, a `cwd` — refuses to start the server
with an error naming the server and the entry (never the key). If you changed the definition on
purpose, run `kete mcp add harness` again (with the flags you want) to re-bind the stored key.

The fingerprint is the guarantee: the runtime doesn't know at start-up which config file a server
came from, so it doesn't distinguish project from global config; it compares definitions. Because
one fingerprint is stored, only one `harness` definition works at a time (the last one you added).
A server that gets a stored key runs in a Kete-owned working directory
(`<data dir>/mcp-servers/harness`), not the project, so a repository's `.npmrc`, `node_modules` or
`.env` can't redirect `npx` or the server.

Re-running `kete mcp add harness` (for example with another `--org`) reuses the stored key without
asking for it again; `kete mcp add harness --new-key` asks for a new one.

Without a terminal (CI, scripts), set `HARNESS_API_KEY` in the environment the runtime starts with;
`kete mcp add harness` then writes `{env:HARNESS_API_KEY}` instead. Prefer the stored key where you
can: `{env:...}` is expanded when config loads, in **any** config file (upstream behaviour), so a
project config can put `{env:HARNESS_API_KEY}` in any server's environment, arguments or headers,
and the expanded value is visible through the config API. The stored key has neither problem.

To remove the key, delete the `harness` server from your config and the `kete-code` /
`mcp:harness` entry from your credential store.

### Create a key with least privilege

1. Prefer a **service account** in Harness (Account Settings → Access Control → Service Accounts)
   with a role that only has **view** permissions on the projects the agent should see. Add create,
   edit or execute permissions only for what you will let it do with `--write`.
2. Create an API key and token for it (or, for personal use, Profile → My API Keys → + API Key →
   + Token). Give the token an expiry.
3. Paste the token when `kete mcp add harness` asks.

Harness enforces the token's permissions; Kete Code's rules and read-only mode are a second layer,
not a replacement.

## Offline mode

The server reaches Harness over the internet, so offline mode (`--offline`, `KETE_OFFLINE`,
`kete.offline`) skips it: the runtime turns it off and logs
`Offline mode: skipped MCP server "harness" ...`. It comes back when offline mode is off.

## Upgrading the server

The pin is an exact version, but there is **no integrity hash**: `npx` trusts the npm registry (and
your npm configuration) to serve the published `harness-mcp-v2@3.2.32`, as it does for any package.

The version is pinned in `packages/schema/src/kete/mcp-presets.ts` (`harnessVersion`). To upgrade,
check the release notes and the package's diff, change the pin, run the preset tests
(`bun run test ./test/kete/mcp-presets.test.ts` in `packages/core`), and re-run
`kete mcp add harness` to update an existing config. Editing the version in the `command` by hand
changes the definition, so the stored key isn't released until you re-run `kete mcp add harness`.
