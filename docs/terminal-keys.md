# Terminal keys: reasoning effort and key debugging

## Raise or lower the model variant

Many models have variants, usually reasoning effort (`low`, `medium`, `high`). The prompt shows the
current one after the model name (`Build · Claude Sonnet Anthropic · high`); nothing is shown for the
model's default.

| Key | What it does |
| --- | --- |
| **Alt+.** | One step up: default → the first variant → … → the last. Stops at the last |
| **Alt+,** | One step down, back to the model's default. Stops there |
| Ctrl+T | Cycles through the variants and wraps around (unchanged) |

Both are also in the command palette ("Raise model variant", "Lower model variant"). The keys do nothing
when the model has no variants. On macOS, Alt keys reach the terminal only when Option sends Meta
(iTerm2: Profiles → Keys → Left Option key: Esc+; Terminal.app: Profiles → Keyboard → Use Option as
Meta key). `/keymap debug` shows whether they arrive.

Change the keys in `keybinds` in `cli.json` (e.g. `~/.config/kete/cli.json`). A comma separates
alternative keys in a key string, so write a comma key as an object:

```json
{ "keybinds": { "variant.next": "alt+]", "variant.previous": { "name": ",", "meta": true } } }
```

## `/keymap debug`

`/keymap debug` turns key debugging on: each key you press then shows a short notice with

- the key as Kete read it, written the way `keybinds` takes it (`ctrl+t`, `alt+.`);
- what it did: the command it ran (`runs variant.cycle (Variant cycle)`), the start of a key sequence
  (the leader key), a binding that's disabled where the focus is, or no binding (the key went to the
  prompt as text);
- the raw bytes the terminal sent, with control bytes escaped (`\x1b.` is Alt+. as Esc then `.`).

Keys keep working while it's on, so what you see is what really happens where the focus is.
Run `/keymap debug` again (or "Debug key presses" in the command palette) to turn it off. Nothing
is logged or sent anywhere.

Use it when a key does nothing: if no notice appears, the terminal didn't send the key at all (check
the terminal's keyboard settings); if it shows a different key than you pressed, bind that one.
