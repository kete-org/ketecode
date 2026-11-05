# Mentioning MCP resources

MCP servers can expose resources: documents, records, schemas, tickets — anything with a URI. In the
terminal you can attach one to a prompt the same way as a file: type `@` and pick it from the list.
Resources show up as `@<server>:<name>`, next to files, agents and skills.

```text
> Summarise the open questions in @docs:architecture and draft replies
```

When you send the prompt, Kete Code reads each mentioned resource from its server and gives the
agent its content with the prompt, so it doesn't have to look it up first.

- **Text** resources are attached as text, **images and PDFs** as media. Other binary content
  can't be read by the model and isn't attached.
- A resource larger than 5 MiB isn't attached.
- Mentioning a resource is your own choice, like mentioning a file, so you aren't asked for
  permission. A rule that **denies** reading it (`opencode_read_mcp_resource`, the permission the
  agent's own `read_mcp_resource` tool uses, with `<server>:<uri>` as the resource) still wins, and so
  do organization policy, Plan mode and unattended-run rules.
- The content reaches the agent labelled as the server's (`MCP resource <server>:<uri>`), not as
  your own words; treat a server you don't trust like any other untrusted input.
- If a resource can't be attached — denied, the server isn't connected, it failed, it's too big or
  empty — the prompt is sent without it and says so at the end, e.g.
  `[MCP resource docs:docs://architecture was not attached: …]`.
- Editing or resending a prompt reads the resource again (once), so the agent gets its current content.
- `UserPromptSubmit` [hooks](hooks.md) run first: they see your prompt text, not the resource's
  content, and their context comes before any "not attached" note.
- Resource templates (resources addressed by a parameter) aren't listed; the agent can still fill
  them in with `list_mcp_resources` and `read_mcp_resource`.

The list comes from the MCP servers connected in the current project; only the terminal UI offers
these mentions so far.
