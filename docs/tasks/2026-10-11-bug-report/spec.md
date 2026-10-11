# Spec: /feedback and kete bug (A11)

- Task: `docs/tasks/2026-10-11-bug-report` · Size: medium · Created: 2026-10-11
- Status: agreed (Milestone A, approved 2026-10-10 with merge-when-green; plan item A11)

## Goal
Reporting a problem takes one command and produces a useful, privacy-safe report the person reviews before
anything leaves the machine.

## Today (verified 2026-10-11)
Only the TUI crash screen has "Copy report" (`tui/src/component/error-component.tsx:49-61`, copies plain text
because there was "no Kete tracker yet"). `Brand.urls.issues` is undefined with `TODO(kete): set … once it is
public` (`util/src/kete/brand.ts`). The repository is now public with issues enabled and a
`.github/ISSUE_TEMPLATE/bug-report.yml`. Secret redaction exists in `util/src/kete/redact.ts`.

## Scope
Modules: `cli`, `ui-branding` (TUI), `account-login` (brand URLs).
1. **Issue tracker URL:** set `Brand.urls.issues` to `https://github.com/kete-org/ketecode/issues` (the TODO's
   condition is met). Crash screen "Copy report" keeps copying the text and also offers "Open issue".
2. **Report builder (Kete-owned, util or cli):** version and channel, OS/arch, terminal (`TERM`,
   `TERM_PROGRAM`), shell, install method if known, whether signed in (yes/no only), model provider IDs in use
   (no keys), permission mode, sandbox state, offline flag, MCP server count and states (names only), the
   last N (e.g. 200) lines of the current log file. Everything passes through `redact.ts`; home directory paths
   become `~`; no prompts, file contents, session messages, emails, org IDs, tokens or env values.
   Capped size (fits a GitHub issue URL body limit; full report saved to a file when longer).
3. **`kete bug [description]`** (CLI): builds the report, prints it, asks "Open a GitHub issue with this?
   (y/N)"; yes opens the browser to the issue form pre-filled (bug-report template fields where the template
   allows URL pre-fill, else `title`/`body`), and always writes the full report to a file in the temp dir and
   prints its path. `--print` prints only (no prompt, no browser) for scripts. Non-interactive (no TTY): print
   + file, never open a browser.
4. **`/feedback`** (TUI, also `/bug`) and the palette: the same report shown in a dialog (scrollable) with
   Open issue / Copy / Save / Cancel. Never sends anything itself.
5. **Security reports:** both say plainly: "Security problem? Don't open a public issue; report it privately:"
   with the private advisory link (`…/security/advisories/new`) from `.github/SECURITY.md`.
6. **Docs:** README "Reporting a problem" section.

## Out of scope
Uploading reports to the Kete platform; attaching session transcripts.

## Acceptance criteria
- [ ] AC1: the report contains the listed fields and none of the excluded data (test with a fake env and log
  containing an API key, an email, a home path, a prompt and a bearer token: all redacted or absent).
- [ ] AC2: `kete bug --print` prints the report and exits 0 without prompting or opening anything; with no TTY
  the same; the full report file is written with mode 0600.
- [ ] AC3: the issue URL is `https://github.com/kete-org/ketecode/issues/new?…` with the report URL-encoded and
  within the length cap; over the cap it says the full report is in the file.
- [ ] AC4: `/feedback` opens the dialog; Cancel sends nothing; Open issue calls the platform opener with the URL
  (TUI test with a fake opener).
- [ ] AC5: crash screen still copies the report and now offers Open issue.
- [ ] AC6: typecheck/tests in util, cli, tui; root lint; upstream:check; built binary: `kete bug --print`
  output reviewed by eye for leaks.

## Risks and constraints
- Privacy (§9): the report is the person's to review; nothing is uploaded automatically; redaction tested.
- Contracts: new `kete bug` command and `/feedback` command.
- Upstream edits (crash screen, command registration) marked and minimal.
