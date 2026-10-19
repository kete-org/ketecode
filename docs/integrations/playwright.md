# Playwright (browser automation)

Kete Code can open and drive a web browser from a session (load your app, click through it, fill
forms, read the console and network requests, take screenshots) through Microsoft's Playwright MCP
server ([`@playwright/mcp`](https://www.npmjs.com/package/@playwright/mcp), Apache-2.0,
[github.com/microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)).

```sh
kete mcp add playwright            # project config
kete mcp add playwright --global   # global config instead of the project's
```

`kete mcp presets` lists the built-in presets.

## What it sets up

- A local MCP server named `playwright` that runs `npx -y @playwright/mcp@0.0.83 --isolated`: an
  **exact pinned version**, never `@latest`. It needs Node.js (`npx`) on your `PATH` and, by
  default, Google Chrome installed.
- `--isolated`: the browser profile lives in memory. Each session starts logged out, and nothing
  (cookies, logins, local storage) is kept afterwards.
- The server runs in the project directory. Files it saves (screenshots, snapshots, response
  bodies) go into the project, or Playwright's output folder; `file://` pages are blocked.
- Permission rules in the same config file:
  - Only `browser_wait_for` runs without asking.
  - Everything else asks first, including the tools that only read the page (`browser_snapshot`,
    `browser_take_screenshot`, `browser_console_messages`, `browser_network_requests`,
    `browser_network_request`, `browser_find`): each can save its result to a file name the model
    picks anywhere in the project, so a hostile page could get one to overwrite your config or a
    script. Allow them yourself if you accept that, for example
    `{ "action": "playwright_browser_snapshot", "resource": "*", "effect": "allow" }`.
  - `browser_navigate`, `browser_evaluate`, `browser_run_code_unsafe` and `browser_file_upload` are
    listed explicitly, so they still ask under a broader `allow` rule of your own placed before
    them.
  - Rules match on `playwright_<tool>` (MCP tool permissions are `<server>_<tool>`).

Running `kete mcp add playwright` again replaces these rules instead of adding copies, keeps any
stricter rule of yours, and warns when it replaces an `allow` of yours.

## Things to know

- **Web pages are untrusted input.** What a page says reaches the model, and a page can contain
  instructions aimed at it. That is why navigating to a new address, running scripts and uploading
  files ask first. Approve navigation only to sites you meant to visit.
- **Headless or another browser:** add Playwright's own options to the server's `command` in your
  config, for example `"--headless"` or `"--browser", "firefox"` (the full list is in Playwright's
  README). Re-running `kete mcp add playwright` resets the command to the preset's.
- **Upgrading:** a new Kete Code release may move the pin. Re-run `kete mcp add playwright` to pick
  it up.

## Offline mode

The browser needs the network, so offline mode (`--offline`, `KETE_OFFLINE`, `kete.offline`)
skips the server: the runtime turns it off and logs `Offline mode: skipped MCP server
"playwright" ...`. It comes back when offline mode is off.
