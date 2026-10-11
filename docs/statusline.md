# Status line

The row under the prompt shows the items you choose. Change it with `/statusline` (or "Configure status line" in
the command palette), or edit `statusline` in `cli.json` (global config directory).

```json
{
  "statusline": {
    "items": ["directory", "branch", "mode", "context", "cost"],
    "colors": true
  }
}
```

## Items

| ID | Shows |
| --- | --- |
| `directory` | Working directory (click for copy / open / workspaces) |
| `branch` | Current git branch |
| `mode` | Permission mode: Default, Accept edits, Auto, Ask, Plan |
| `context` | Share of the context window still free, e.g. `85% left` |
| `model` | Model and reasoning variant |
| `sandbox` | Warning when commands run without the OS sandbox |
| `balance` | Kete credit balance |
| `todo` | Progress of the session task list |
| `local-model` | `Offline` while offline mode is on |
| `cost` | Spend so far in this session |

Default: `directory`, `branch`, `mode`, `context`. Items show in the order listed, an item with nothing to show is
hidden, and duplicates are ignored. `[]` shows no items. `directory` and `branch` hide while the agent is working.

## Narrow terminals

The row always fits on one line. The directory shortens first (down to about 12 columns, keeping the last
folder name), then items drop from the end, the directory last. On the home screen the row shares the line with
the shortcut hints, so it has less room than in a session.

## Sandbox warning

The `Unsandboxed` warning always shows when it applies, even if `sandbox` is not in the list (then it goes last).
It is never dropped for width. Hiding a security signal by default would be unsafe. If the runtime can't report
the sandbox status (the call fails or times out), the row shows `Sandbox status unknown` rather than nothing.

## Colours

`colors: true` (default): Plan and Ask in the warning colour, Auto in the accent colour, context in the warning
colour at 20% left or less and the error colour at 5% or less, the branch in the accent colour. `colors: false`
makes everything muted except the sandbox warning glyph.

## Unknown items

An ID that is not an item is reported in a warning toast and otherwise ignored. It is kept in the file when
`/statusline` saves.

## Changed in this release

Todo progress and `Offline` no longer show on the prompt row by default. Add `todo` or `local-model` to `items`.
(`Offline` still shows on the home screen footer.)
