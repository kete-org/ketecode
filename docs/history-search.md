# Prompt history search

Press **Ctrl+R** in the prompt to search the prompts you sent before (the last 50, shared by every
session). A search bar opens above the prompt:

```text
history search: fix        fix the failing lint step
```

| Key | In the search bar |
| --- | --- |
| type | Search again from the newest prompt (case-insensitive; matches anywhere in the text) |
| Ctrl+R | The next older match. A prompt text already shown in this search is skipped; at the oldest the bar says `no older match` |
| Enter | Put the match in the prompt, with its mode (a `!` shell prompt comes back in shell mode). Nothing is sent: edit it or press Enter again |
| Esc, Ctrl+C | Close the bar. What you had typed is left exactly as it was |

Enter with no match closes the bar like Esc. The bar also closes when a permission or question prompt
appears. Ctrl+R searches only while the prompt has focus.

## Rename moved to `<leader>shift+r`

Ctrl+R used to rename the session. Rename is now **`<leader>shift+r`** (`ctrl+x` then `R` by default), and
it is still in the command palette ("Rename session") and `/rename`. `<leader>r` stays redo.

## Changing the keys

Keys are set in `keybinds` in `cli.json` (global config directory, e.g. `~/.config/kete/cli.json`).

Get Ctrl+R rename back:

```json
{ "keybinds": { "session.rename": "ctrl+r" } }
```

When you give rename a key and don't set `prompt.history.search` yourself, history search gives that key
up, so Ctrl+R renames even in the prompt. To keep searching, bind search to another key too:

```json
{ "keybinds": { "session.rename": "ctrl+r", "prompt.history.search": "alt+r" } }
```

`"prompt.history.search": "none"` turns history search off.
