# 0001. OpenCode upstream strategy

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

The Kete Code runtime is a fork of [OpenCode](https://github.com/anomalyco/opencode)
(MIT). OpenCode already provides the agent loop, sessions, tools, providers, MCP,
permissions and configuration, and it releases often. Kete Code has to keep receiving
those releases while adding its own identity, defaults and platform features. Every
Kete edit to an upstream file is a potential conflict on each sync.

## Decision

- OpenCode is upstream infrastructure. Kete Code extends it instead of replacing or
  restructuring it, and never renames, moves or reformats upstream packages.
- When behavior must change, prefer in order: configuration; upstream plugins,
  extension points and hooks; Kete-owned modules in `src/kete/` or `packages/kete-*`;
  dependency injection at an existing seam; and only then a minimal edit to the
  upstream file.
- Every edit to an upstream file carries a `kete_change` marker. Edits to files that
  can't hold comments are listed in `docs/upstream-patches.md`, which also explains
  what each persistent patch is for.
- Upstream releases are merged by tag on an `upstream/vX.Y.Z` branch, pinned in
  `.opencode-version`, and reviewed as a separate PR. Individual OpenCode files are
  never copied by hand. `packages/kete-tools` automates the sync and audits markers
  (`docs/upstream-sync.md`).
- OpenCode's license, copyright notices and attribution stay intact.

## Consequences

- Upstream fixes and features arrive through routine syncs, and most sync conflicts
  are single marked lines.
- Some Kete behavior is indirect, for example the `KETE_*` to `OPENCODE_*` environment
  bridge and the plugin that replaces upstream's built-in skills. That's the cost of
  not editing upstream files.
- Inherited internal identifiers (`@opencode/*` package names, `OPENCODE_*` variables
  after the bridge, the `opencode` tool namespace) stay as they are.
- Upstream features must be reviewed on each sync for defaults that conflict with Kete
  policy (see [0003](0003-hosted-services-opt-in.md)).
