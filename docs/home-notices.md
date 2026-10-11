# Home screen notices and tips

When you start `kete` without a session, the home screen can show short notices and a tip under the
logo, above the prompt.

## Notices

The notices have the same text as the ones in the VS Code chat panel. Each one shows only when it
applies:

| Notice | Shows when |
| --- | --- |
| **Agents from your portal** | You're signed in (`kete login`), your organization's agents have synced to this machine, and offline mode is off. Pick one with `/agents`. |
| **Kete reads your AGENTS.md** | The folder you started `kete` in has an `AGENTS.md`. |

If Kete can't check a condition (for example, the server doesn't answer within 15 seconds), that notice
doesn't show. After `kete logout` the portal notice stops showing the next time the home screen opens.

To dismiss a notice, click its **✕**, or open the command palette (Ctrl+P) and run **Dismiss home
notices**, which dismisses every notice on screen. Dismissals are saved and stay dismissed after a
restart. They're kept in the TUI's state folder (`kete-notices.json`), separately from the VS Code
panel's dismissals.

## Tips

When no notice is showing, one line starts with `Tip:`, for example
`Tip: Press Ctrl+R in the prompt to search your prompt history.` A tip is picked each time `kete` starts.

To turn tips off, set `tips` to `false` in `cli.json` in the global config directory (for example
`~/.config/kete/cli.json`):

```json
{ "tips": false }
```

## Small terminals

Below 12 rows, neither notices nor the tip show. On a short terminal, only the notices that fit whole
show, so the prompt always keeps its space.
