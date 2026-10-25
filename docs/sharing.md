# Sharing a session

`/share` uploads a redacted copy of the current session to the Kete Code portal, where members of
your organization (or, if your organization allows it, anyone with the link) can read it. `/unshare`
deletes it. Sharing goes only to the Kete portal you signed in to; nothing is sent to OpenCode or to
any other service.

```
/share            in the terminal UI: shows what will be sent, then asks
/unshare          deletes the shared copy
kete share [session-id] [--link] [--yes]
kete unshare [session-id]
```

In VS Code: "Kete Code: Share Session" and "Kete Code: Unshare Session", from the Command Palette or
the sessions list.

## Needed

- A Kete Code account (`kete login`). A session that only uses your own API keys can't be shared.
- A network connection: sharing is refused in offline mode and in job mode.
- Your organization hasn't turned sharing off, and `share` in your config isn't `"disabled"`.

## Nothing is sent without a yes

Every client first asks the runtime for a preview (the number of messages, tool calls and changed
files, the size, how many secrets were removed, who can read it, and when it expires) and uploads only
after you confirm. What is uploaded is exactly what you previewed: if the session changed in between
(the agent was still working), the share is refused with "The session changed since the preview;
review it again." `kete share --yes` skips the question (and uploads the session as it is then);
without `--yes` and without a terminal it refuses (exit code 2). `kete share` is also refused, with or
without `--yes`, when it runs in a shell the agent started (those shells carry `KETE_AGENT_SHELL=1`):
sharing must be started by you, not from an agent's shell. The config setting `share: "auto"` does not upload on its own: it behaves like
`"manual"`.

## What is sent

- Your prompts and the assistant's replies.
- Each tool call's name, status, input and output (inputs cut to 2 KB, outputs to 4 KB).
- Commands you ran with `!`, their exit code and output (cut to 4 KB).
- The session's file changes as patches (each cut to 16 KB), with paths relative to the workspace.
  A file outside the workspace shows only its name.
- The title, the model name, the Kete Code version and the time.

In all of it, an absolute path inside the workspace is shown starting with `.` and one inside your
home folder starting with `~`, so your user name and folder layout are not sent.

## What is not sent

Reasoning, system and synthetic messages, skill bodies, the summary of a compacted conversation,
attached file contents (only their names), instructions (`AGENTS.md`, `CLAUDE.md`), memory notes, the
system prompt and your environment. The contents of secret files (`.env`, `.env.*` other than
examples and templates, keys, certificates and other credential files) are never sent: their changes,
what the agent read or searched in them, the output of shell commands that name one (`cat .env`),
and the content of edits, writes and patches to one show "[contents not shared: secret file]" (an
edit keeps only its path), and the share is marked truncated.

## Secrets

Every piece of text is passed through the same redactor as the audit log before it is cut to size, so
a secret is masked even where a cut would have split it. The preview shows how many were masked. This
is a best effort: it recognizes common key formats (including Kete Code's own `kete_live_` and `kete_test_` keys) and secret-looking names (`password`, `token`,
`api_key`, ...), and it over-redacts on purpose (a value like `pass: 42` is masked too). Read the
transcript of a sensitive session before sharing it.

## Who can read it, and for how long

A share is visible to members of your organization. If the organization allows link sharing,
`kete share --link` (or the "anyone with the link" choice) also lets anyone who has the link read it.
Shares expire (30 days by default; your organization can set the limit). Run `/share` again to update a
share: the same share is replaced and its link and expiry stay. To change who can read it, `/unshare`
first.

An organization administrator can delete any share. If your organization turns sharing off, new
shares are refused, and you can still delete your own.

## Turning it off

```jsonc
// ~/.config/kete/kete.json
{ "share": "disabled" }
```

`"disabled"` in any config file (global or project) wins: a project can't turn back on what you
turned off.

## Large sessions

A snapshot is at most 2 MiB. If a session is larger, the oldest tool outputs and then the oldest
patches are dropped first and the share is marked as truncated. If it still doesn't fit, nothing is
shared. A share with file changes covers the whole session; if the changes can't be read (for example
after a folder change inside the session), the share is marked truncated and has none.

The wire format is `docs/platform/session-shares-v1.md`.
