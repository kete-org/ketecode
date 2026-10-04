# Report a Kete Code Issue

Use this skill when the user wants to report a Kete Code bug. Turn the user's
problem into a useful bug report with standard diagnostics plus the context
needed to reproduce and fix it.

Kete Code is built on OpenCode, but Kete Code bugs are not OpenCode bugs.
**Never file a Kete Code issue in the OpenCode repository
(`anomalyco/opencode`)**, and never publish anywhere without the user's
confirmation. Where to send the report is given under "Where the report goes"
at the end of this skill.

## Workflow

1. Collect the standard diagnostics below.
2. Ask only for missing details that are necessary to reproduce the problem or
   understand its impact.
3. Draft the report in the format below.
4. Deliver it as described under "Where the report goes".

## Standard diagnostics

Collect these values when possible:

- Kete Code version: run `kete --version`.
- Operating system: `uname -a` on Unix-like systems, or `ver` on Windows.
- Terminal: `$TERM`, `$TERM_PROGRAM`, `$COLORTERM`, and any terminal app the
  user mentions.
- Shell: `$SHELL` on Unix-like systems, or `%COMSPEC%`/`$ComSpec` on Windows.
- Install/channel: local, dev, beta, or release, if the version output shows it.
- Active plugins: check `kete.json`, `kete.jsonc`, `.kete/kete.json(c)`, and
  `~/.config/kete/kete.json(c)` for configured plugins, and `.kete/plugins/` and
  `~/.config/kete/plugins/` for local plugin files. Note if plugin status could
  not be determined.

If a diagnostic command fails, record `Unavailable` with the reason instead of
guessing.

## User-specific context

- What the user was trying to do, what happened, and what they expected.
- Reproduction steps, minimal and numbered.
- Relevant logs (`~/.local/share/kete/log/`), errors, screenshots, or config
  snippets.
- Whether it happens every time, sometimes, or once.
- Recent changes: updating Kete Code, changing config, installing a plugin,
  changing terminal or workspace.
- Workarounds tried and whether they helped.

Do not paste secrets. Redact tokens, API keys, private URLs, usernames, and
confidential project data unless the user explicitly says it is safe.

## Report format

```markdown
## Summary

<!-- One or two sentences describing the bug and its impact. -->

## Environment

- Kete Code version: <!-- value or Unavailable: reason -->
- OS: <!-- value or Unavailable: reason -->
- Terminal: <!-- value or Unavailable: reason -->
- Shell: <!-- value or Unavailable: reason -->
- Install/channel: <!-- value or Unavailable: reason -->
- Active plugins: <!-- list, none found, or Unavailable: reason -->

## Reproduction

1. <!-- step -->

## Expected Behavior

## Actual Behavior

<!-- Include exact errors when available. -->

## Additional Context
```

Keep the title short and searchable, in the form `<area>: <specific failure>`,
for example `tui: skills dialog crashes outside location provider`.
