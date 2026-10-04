# 0010. Open-source the runtime

- **Status:** Accepted
- **Date:** 2026-10-04

## Context

ADR 0009 distributed the `kete` CLI publicly while `kete-org/ketecode` stayed private. That left
the installers and the code that runs on users' machines unreadable to them, npm provenance
unavailable (npm refuses it for private repositories), and CI limited by the private-repository
minutes allowance, so the engine packages' full suites run only locally. Kete Code is a fork of
OpenCode (MIT), and its users are developers who expect to be able to read an agent that edits
their code and runs commands.

The user decided (2026-10-04) to make this repository public, after a readiness audit (secrets in
history, workflows, public-facing files) first done on 2026-09-25.

## Decision

1. **Scope:** `kete-org/ketecode` (the execution plane) only. The control plane
   (`kete-code-platform`: portal, gateway, billing) and the website stay private.
2. **License:** MIT for Kete Code's own code, the same license as upstream. OpenCode's `LICENSE`
   and copyright stay unchanged; the Kete grant is in `NOTICE` ("The Kete Code authors", to be
   replaced by the registered entity name when there is one).
3. **Public-facing files are Kete's and live in `.github/`** (`README.md`, `SECURITY.md`,
   `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`), which GitHub shows in preference to the root files,
   so upstream's root `README.md`, `SECURITY.md` and `CONTRIBUTING.md` stay untouched for syncs.
   Upstream's `.github/CODEOWNERS` and issue templates get minimal `kete_change` edits.
4. **Security reports** go to GitHub private vulnerability reporting and `security@ketecode.ai`.
5. **Read-only start:** issues on, pull requests welcome without a promise of review,
   Discussions off, workflows from fork pull requests need a maintainer's approval.
6. **History is kept as is** (rewriting would change every commit and the signed release tags);
   future commits use the maintainer's GitHub noreply address.
7. **Before the flip:** a secret scan of every Kete-only commit reachable on GitHub (gitleaks,
   2026-10-04: 24 findings, all test fixtures and contract test vectors), every inherited upstream
   workflow disabled (three use `pull_request_target`), and no Kete workflow triggered by
   `pull_request` reads secrets. Changing the visibility is the maintainer's own action.

## Consequences

- Free CI minutes; the full engine suites can move into CI later. npm provenance turns on by
  itself (the publish job already switches it on for public repositories).
- `kete-org/kete-releases` stays the download location: install URLs, `kete upgrade` and the
  Homebrew formula point at it (ADR 0009); nothing has to move.
- New Kete workflows must stay safe for fork pull requests: no secrets or environments on
  `pull_request`, never `pull_request_target` or self-hosted runners for untrusted code.
- Anything committed is public, permanently: secrets, customer data and private infrastructure
  details never belong in this repository (CLAUDE.md §9 already says so).
- Upstream workflows must stay disabled after every sync (`upstream:check` doesn't enforce the
  GitHub setting; `docs/upstream-sync.md` should say to check it).
