# 0003. Inherited hosted services are opt-in

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

Upstream OpenCode enables some of its own hosted services out of the box. The clearest
case is OpenCode Zen: with no credentials configured, upstream force-enables the
`opencode` provider with a shared "public" key, so its free models become the default
and prompts and code are sent to opencode.ai without the user choosing it. Upstream
also promotes Zen and Go first in login and onboarding.

Kete Code's privacy rule is that code leaves the machine only as model context to the
provider the user configured (`CLAUDE.md` §9).

## Decision

Hosted services inherited from OpenCode are off by default and available only through
an explicit opt-in: signing in (`kete auth login`), an API key in the environment, or
an explicit config entry. Kete Code doesn't promote them over other providers.

The switches live in `packages/core/src/kete/hosted.ts` (currently
`anonymousOpencodeZen = false`), and the upstream edits that read them are listed in
`docs/upstream-patches.md`.

## Consequences

- A fresh install has no working model until the user connects a provider. The TUI
  asks for one instead of falling back to free hosted models.
- Users who want Zen's free models can still enable them explicitly.
- Every upstream sync must be reviewed for new endpoints, telemetry or providers that
  are enabled by default, with a new switch in `hosted.ts` when one appears.
