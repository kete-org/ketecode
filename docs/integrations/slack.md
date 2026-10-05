# Slack

Kete Code can search and read Slack from a session, and post when you approve it, through Slack's
official remote MCP server (`https://mcp.slack.com/mcp`). This page covers the runtime side; Slack
notifications, commands and approvals from the platform are separate.

```sh
kete mcp add slack --client-id 1234567890.1234567890123
```

## Slack app requirement

Slack's MCP server only accepts **Slack Marketplace apps or apps internal to your workspace**
("unlisted" apps are refused), and a **workspace admin must approve** the app. You need such an app's
client ID before you can connect. Kete Code finds it in this order:

1. `--client-id <id>`
2. `kete.integrations.slack.clientId` in your project or global config
3. your organization's Slack app from the Kete platform, when it provides one (`integrations.slack`
   in the synced data; until then this step finds nothing)

Without any of these, `kete mcp add slack` explains what is needed and changes nothing.

Before it writes anything or opens the sign-in, `kete mcp add slack` prints the client ID and where
it came from (`--client-id`, project config, global config, or synced from your organization). Check
it: a repository's own config can set the client ID, and signing in grants that app access to your
Slack.

For an internal app: create it at api.slack.com/apps in your workspace, add the redirect URL
`http://127.0.0.1:34561/callback` (the preset pins this loopback address and port), add the user
scopes the tools need (for example `search:read.public`, `channels:history`, `chat:write`,
`canvases:write`), turn on PKCE for public clients if your app settings offer it, and have an admin
approve it.

## What it sets up

- A remote MCP server named `slack` with `oauth.client_id` set to your app's ID and
  `oauth.redirect_uri` set to `http://127.0.0.1:34561/callback`. No client secret is written to
  config. If that port is taken on your machine, change `redirect_uri` in the config and in the app.
- Permission rules: searching and reading (`slack_search_*`, `slack_read_channel`,
  `slack_read_thread`, `slack_read_canvas`, `slack_read_user_profile`) run without asking; sending,
  scheduling and drafting messages, creating or updating canvases and uploading files **ask**; every
  other or future Slack tool (reactions, creating channels, lists, ...) asks too. Running the command
  again replaces these rules instead of adding copies.
- Then it signs you in: the browser opens Slack's consent page (OAuth v2 user flow with PKCE) and the
  token is kept in Kete Code's credential store, not in config. Retry or re-authenticate with
  `kete mcp auth slack`; sign out with `kete mcp logout slack`.

## Known limitation: the client secret

Slack's authorization server currently advertises only `client_secret_post` for its token endpoint.
Kete Code signs in as a public client (PKCE, client ID only) and never stores a client secret in
config, so if Slack rejects the token exchange, the app needs PKCE enabled for public clients. A
server-side token exchange through the Kete platform (which can hold the secret) is planned as the
fallback. Upstream's MCP config does accept `oauth.client_secret`, but a secret in a config file is
plaintext, which Kete Code doesn't do on your behalf.

## Offline mode

Offline mode turns remote MCP servers off, Slack included, and `kete mcp add slack` then writes the
config without signing in (sign in later with `kete mcp auth slack`).
