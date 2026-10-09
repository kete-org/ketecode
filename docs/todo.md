# The session task list

For work with several steps, Kete Code keeps a task list for the session: the agent writes the
steps down, marks the one it is working on, and ticks each off as it finishes. You see the list
while it works, in every client:

| Client | Where |
| --- | --- |
| Terminal UI | the session sidebar (every item), and the prompt footer (`Todo 1/3 · <current item>`) while work is open |
| Web UI, VS Code, JetBrains | a **Tasks** card above the message box; click its header to fold it to one line |
| SDK and other clients | the `kete.todo` plugin RPC (below) |

The agent decides when a list helps: Kete Code tells it to use one for tasks with three or more
steps and to skip it for single, simple requests. It doesn't need a prompt from you; you can
still ask ("make a todo list first").

## How it works

- The agent calls the `todowrite` tool with the whole list each time. Each item has `content`, a
  `status` (`pending`, `in_progress`, `completed`) and an optional `priority`
  (`high`/`medium`/`low`). At most one item may be in progress; a list breaking that rule is
  refused with a message the agent can act on. Limits: 50 items, 500 characters per item.
- Each session has its own list (a subagent's session has its own). It is stored with Kete Code's
  local data (SQLite), so it survives a restart and a compacted conversation, and it is deleted with
  the session. It never leaves your machine except as part of the conversation with your model.
- Permission action: `todowrite`. Every agent may use it by default, Plan mode included (it changes
  no files). An organization policy or an agent's permissions can deny it, which also removes the
  tool. The read-only Explore subagent can't use it.
- Unattended runs and jobs can use it like any other tool; review jobs can't (they only read and
  review).

## Reading the list from your own client

The list is served through the runtime's plugin RPC route, so no separate endpoint exists:

```http
POST /api/rpc/kete.todo/get
{ "input": { "sessionID": "ses_…" } }
→ { "output": { "sessionID": "ses_…", "todos": [ { "content": "…", "status": "in_progress" } ] } }
```

Every change is also published on the event stream as `rpc.kete.todo.updated` with the same
`{ sessionID, todos }` data. The shape is defined in `packages/schema/src/kete/todo.ts`
(`KeteTodoRpc`); decode it against that schema rather than trusting it as is.

## Limits

- The current list isn't repeated in every request to the model (that would change the system
  prompt on each update and defeat prompt caching). After a long conversation is compacted, the
  agent knows the list from the compaction summary and its next `todowrite` call.
- There is no combined view of a parent session's and its subagents' lists.
