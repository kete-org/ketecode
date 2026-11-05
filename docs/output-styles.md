# Output styles

An output style changes how the agent writes its replies, without changing what it can do. Pick one
with `kete.outputStyle` in `kete.json` / `kete.jsonc`:

```jsonc
// ~/.config/kete/kete.jsonc
{ "kete": { "outputStyle": "explanatory" } }
```

| Style | The agent… |
| --- | --- |
| `default` | works as usual (the same as leaving the setting out) |
| `explanatory` | explains the reasoning behind its choices and points out patterns and pitfalls as it works |
| `learning` | does the routine parts and leaves small, marked pieces for you to write, explaining what they should do |
| `reviewer` | leads with problems ranked by severity, with evidence, and doesn't change code unless you ask |

## Your own styles

Any other name is a custom style: a Markdown file `~/.config/kete/output-styles/<name>.md` (in your
global config folder) whose text is given to the agent as instructions. Names are lowercase letters,
digits, `-` and `_`. The first 16,384 characters of the file are used. If the file doesn't exist,
or the name isn't valid, the default style applies (and Kete Code logs a warning once); the rest of
that config file's `kete` settings still apply.

A project's config can choose a style, but styles themselves come only from your global folder or
the built-ins: a repository can't supply the instructions.

## Where it applies

- The style's text is added to the system prompt, after the agent's own prompt, of your session's
  requests, so changing the setting (or the style's file) takes effect on the next request — and
  starts a fresh prompt cache.
- Subagents, conversation summaries (compaction), titles and cloud or unattended jobs don't use it.
- Like other `kete` settings, the whole `kete` object of the highest-priority config file wins: a
  project `kete.json` with its own `kete` object replaces your global `outputStyle` unless it sets one.
