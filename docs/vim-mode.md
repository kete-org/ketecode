# Vim keys in the prompt

Type `/vim` (or "Toggle vim keys in the prompt" in the command palette) to turn vim keys on or off. The
setting is saved as `"vim": true` in `cli.json` (e.g. `~/.config/kete/cli.json`). It's off by default.

With vim keys on, the prompt starts in **insert mode** and types as usual. **Esc** switches to **normal
mode**. The status line shows the mode first (`INSERT`, `NORMAL`, or the search you're typing), and the
cursor is a block in normal mode.

| Keys | Normal mode |
| --- | --- |
| `h` `j` `k` `l`, arrows | Left, down, up, right (`j`/`k` move between lines of the prompt) |
| `w` `b` `e` | Next word, previous word, end of word (punctuation runs count as words) |
| `0` `^` `$` | Start of line, first non-blank, end of line |
| `gg` `G` | First line, last line |
| `i` `a` `I` `A` `o` `O` | Insert before / after the cursor, at the line's start / end, on a new line below / above |
| `x` | Delete the character under the cursor |
| `d`, `c`, `y` + a motion | Delete, change (delete, then insert), copy: `dw`, `cw`, `y$`, `dj` |
| `dd` `cc` `yy` | Delete, change, copy the whole line |
| `d`/`c`/`y` + `iw` `aw` | Inner word, a word with the space after it |
| … + `i"` `a"` `i'` `a'` | Inside / including the quotes on the line |
| … + `i(` `a(` `i[` `i{` (`ib`, `iB`) | Inside / including the brackets around the cursor (nested ones count) |
| `p` `P` | Put what you deleted or copied after / before the cursor (a whole line goes below / above) |
| `u`, Ctrl+R | Undo, redo. A whole insert, or a `c` and what you typed, is one step |
| `/text` Enter, `?text` Enter | Search forward / backward in the prompt; `n` and `N` repeat it |

Enter sends the prompt in either mode, and Ctrl and Alt shortcuts (Ctrl+P for commands, Ctrl+R for history
search in insert mode) work as usual. In normal mode Esc cancels a half-typed command; with nothing pending it
does what it does without vim keys (it interrupts a running reply). While the `@` or `/` autocomplete is open,
Esc closes it.

Copies (`y`, `d`) stay inside the prompt; they don't touch the system clipboard. Not supported: counts (`3w`),
named registers, visual mode, `.`, `:` commands, `r`, `f` and `t`.
