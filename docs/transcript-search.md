# Search a session and copy a code block

## Search this session

Press **`<leader>/`** (`ctrl+x` then `/` by default), or type `/find`, to search the open session. A bar opens
above the prompt:

```text
find: needle               3/7  ↑ older · ↓ newer · Enter then n/N · Esc close
```

| Key | What it does |
| --- | --- |
| type | Search again: the newest match is highlighted and scrolled into view (case-insensitive) |
| ↑ / ↓ | The older / newer match; past the first or last it wraps around |
| Enter | Walk matches with letters: **n** older, **N** newer, **/** back to typing the query |
| Esc | Close the bar and clear the highlight |

It searches the text as the session shows it: every loaded message, including code blocks and tool
summaries. Collapsed tool output, hidden thinking and older messages that haven't been loaded yet aren't
searched; scroll up to load them. Only the current match is highlighted.

## Copy one code block

`/copy` (or `<leader>y`, "Copy message") asks what to copy from the latest reply:

- **Response**: the whole reply, as before;
- **Code block 1 · ts**, **Code block 2 · bash**, …: just that block's code, without the fences;
- **Transcript**: the whole session as Markdown (the same as "Copy session transcript").

Type to filter the list, then Enter. In a message's actions (click a message), **Copy** on a reply that has
code blocks opens the same choice, without the transcript.

Change the search key in `keybinds` in `cli.json`: `{ "keybinds": { "session.search": "<leader>f" } }`.
