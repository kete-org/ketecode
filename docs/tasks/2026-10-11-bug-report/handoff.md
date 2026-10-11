# Handoff: /feedback and kete bug (A11)

<!-- Append only. Each entry: `## <date> <agent>` then done / decisions / open questions. Never rewrite earlier entries. -->

## 2026-10-11 planner + implementer

**Cards:** `cli`, `ui-branding` and `account-login` were already stale (`stale-cards.mjs`: A12/A14/home-notices
files changed since their `verified-at`). The task was planned from the code anyway; the librarian should refresh
all three and add `kete bug` / `/feedback`. Docs enough: no. Missing:
- how the TUI opens URLs (it imports `open` directly; the plugin API has no opener)
- the provider and MCP list endpoints (`client.provider.list` and `client.mcp.list` return `{location, data}`)
- the log file name (`Logging.file(channel === "local", channel)`)
- that `core/test/kete/job-fs-sites.test.ts` must classify every new util file that touches the filesystem

**Done** (plan.md steps 1–6):
- `util/src/kete/bug-report.ts`, the pure builder:
  - `scrub` removes ANSI and control characters, URL query strings and fragments, and the secrets KeteRedact knows. It
    also masks emails, UUIDs and long opaque tokens, and replaces the home directory with `~`.
  - `logLines` keeps the last 200 logfmt lines and only the allowlisted fields (no `args`, `event.data`, `command`,
    paths, URLs or ids).
  - `providerIds` and `mcpStates` decode the runtime's answers.
  - `issueURL` builds the pre-filled bug-report form, at most 6000 characters. It drops the oldest log lines and adds
    a note naming the saved file.
- `bug-report-file.ts`: `tail`, and `save` (`wx`, mode 0600).
- `kete bug [description…] [--print] [--server] [--standalone]` (`cli/src/kete/bug.ts`, `bug-flow.ts`). The report goes
  to stdout; the saved path and the security line go to stderr. "Open a GitHub issue with this?" (default No) is
  asked only when stdin and stdout are TTYs and `--print` is off.
- `/feedback` (also `/bug`, and palette "Report a problem"): `tui/src/kete/feedback.tsx`, with its side effects in
  `feedback-deps.ts`. The dialog has o Open issue, c Copy, s Save and esc Cancel, plus the security line.
- Crash screen (`error-component.tsx`): base URL is now Kete's tracker, message and stack are scrubbed, and there's an
  "Open issue" action (key o).
- `Brand.urls.issues` is set, and `Brand.urls.securityReport` is new.
- Test updates:
  - `core/test/kete/skill.test.ts` now expects the report skill to name the tracker.
  - `core/test/kete/job-fs-sites.test.ts` classifies `bug-report-file.ts` as not-worktree (used by the CLI and TUI only).
- README "Reporting a problem"; `docs/upstream-patches.md` "Problem reports".

**Decisions:**
- The CLI asks the runtime through `ServerConnection.resolve`, like `kete sandbox`, so it starts the background
  service if none is running. Every runtime field falls back to "unavailable", so a report still works when the
  runtime is the problem.
- The CLI's permission mode reads "default for new sessions", because a command has no session. The TUI reports the
  current session's mode. The TUI reports install as "unknown"; only the CLI runs the updater's `detect`.
- Tests fake every side effect: `mock.module` on `feedback-deps` (TUI) and on `open` (crash screen). The CLI
  subprocess test uses scratch HOME/XDG/TMPDIR, `--server` pointed at a closed port, and pipes, so there's no TTY.
- I didn't add emails to `KeteRedact` itself, because that would change the audit log. The extra masking lives in
  `bug-report.ts`.

**Checks:**

| Check | Result |
|---|---|
| util: typecheck, tests | PASS (364 pass) |
| cli: typecheck, `bun test test/kete` | PASS (329 pass) |
| tui: typecheck, full `bun run test` | PASS (1482 pass) |
| kete-tools: typecheck, tests | PASS (64) |
| core: `skill.test.ts`, `job-fs-sites.test.ts` | PASS |
| root lint | PASS (0 warnings) |
| `upstream:check` | PASS |
| `verify --base main`, first run | FAIL: one new failure, `job-fs-sites` (the new util file wasn't classified yet). Fixed; re-run result is in my report to the caller. |

**Built binary: `kete bug --print`.** I ran it once against this machine (exit 0) and reviewed the output by eye.
There are no keys, tokens, emails, org IDs, env values, prompts, file contents, session messages or home paths in it.
The log's `cause` fields show the platform host and path (`<platform-host>/api/v1/models`). The next build
also masks URL query strings; this run had none. stderr held the saved path in the macOS temp dir and the security
line. The file's mode was `-rw-------`, and I deleted it afterwards. The log block is abridged below:

````text
## Description

_What happened, what you expected, and how to reproduce it._

## Environment

- Kete Code: 0.0.0-feature-bug-report-202610111023 (channel feature-bug-report)
- OS: macOS 25.6.0 (arm64)
- Terminal: Apple_Terminal 470.2, TERM xterm-256color
- Shell: zsh
- Install: source
- Signed in: yes
- Model providers: none
- Permission mode: default for new sessions (--permission-mode changes it)
- Sandbox: on (seatbelt; mode auto; network approved)
- Offline mode: off
- MCP servers: none

## Log (last 200 lines, only diagnostic fields)

```
timestamp=2026-10-11T09:18:10.306Z level=INFO message="watcher started" type=file backend=node role=server
timestamp=2026-10-11T09:18:10.306Z level=INFO message="watcher subscribe" type=file
… (190 more lines of the same watcher / event / "prices unavailable" / "balance unavailable" kinds) …
timestamp=2026-10-11T10:18:38.533Z level=WARN message="Kete Code platform prices unavailable" cause="HttpClientError: StatusCode: non 2xx status code (500 GET https://<platform-host>/api/v1/models)"
timestamp=2026-10-11T10:18:38.791Z level=INFO message="location services evicted" role=server
timestamp=2026-10-11T10:18:38.837Z level=INFO message="watcher stopped" type=directory role=server
```

_Made with `kete bug`._
````

**pty test** (built binary, scratch `XDG_STATE_HOME`): `/feedback` opened "Report a problem". It went from
"Collecting…" to the report, showing:
- Signed in: yes
- Model providers: kete
- Sandbox: on (seatbelt; …)
- MCP servers: none
- the action row and the security line

Esc closed it back to the home screen. Afterwards I ran the `pkill` and `rm` cleanup for the service file.

The first pty attempt hung on "Starting background server...". After the rebuild, the earlier build's service still
held port 30606; the cleanup fixed it.

**Open items:**
- The CLI run said "Model providers: none", while the TUI a minute later said "kete". `kete bug` had just started the
  service, and the provider list fills in asynchronously. A report made right after a service start can under-report
  providers. Possible follow-ups: retry once when the list is empty, or print "none yet". I didn't re-run the real
  `kete bug` to confirm, because the run-once instruction applies.
- Cards for the librarian: cli, ui-branding, account-login.
- A custom platform host can appear in log `cause` values. Only host and path show; query strings are masked.

## 2026-10-11: privacy review fixes (implementer)

**Fixes:**

1. (MEDIUM) Free-text log fields. The new `KeteBugReport.scrubLine(text, home, maxBytes)` handles `message`, `error`,
   `cause` and `reason` (`FREE_TEXT` in `logLines`), and the crash-screen message. It does these steps:
   - replaces JSON-looking payloads (`{…}`, or a `[…]` of objects, strings or arrays, including truncated ones) with
     `<data>`
   - applies `scrub`
   - keeps only the first line
   - replaces absolute paths outside home with `<path>`: POSIX with two or more segments, `X:\` or `X:/`,
     `\\server\…`, and `file://…`. A path must start at a boundary, so URL paths such as
     `https://host/api/v1` are kept.
   - caps the result: 120 bytes for error, cause and reason, 300 bytes for message, then appends `…`.

   I updated the allowlist comment, the module header and the README.
2. (LOW-MED) Crash screen: the message goes through `scrubLine(message, home, 200)` (`MAX_MESSAGE`) before the
   title and body are built. The stack is still scrubbed with `scrub`.
3. (LOW-MED) Wording: `KeteBugReport.LINK_NOTICE` = "Opening the form sends this report to GitHub in the link; it
   becomes public only when you submit the issue." It appears in:
   - the feedback dialog hint and its status after opening
   - the crash-screen footer
   - `kete bug` stderr, just before the confirm question. The confirm gating is unchanged.

   I also updated the header comments in bug-flow.ts and feedback.tsx, the README and docs/upstream-patches.md.
4. (LOW) Home to `~`:
   - The new type `KeteBugReport.Home = string | readonly string[]` is accepted by `scrub`, `logLines`, `build` and
     `Report.home`.
   - Each spelling is also matched with the other separator and URL-encoded.
   - Matching is case-insensitive when the spelling is a Windows path.
   - A left boundary `(?<![\w.%~-])` stops `/private/home/bob` from being rewritten.
   - The new `KeteBugReportFile.homes(home, tmp?, platform?)` returns the home as given, `realpathSync.native(home)`,
     and the profile prefix of the temp directory's spelling when the real temp directory is under the real home.
   - The callers use it: bug.ts, feedback.tsx and error-component.tsx.
5. (LOW) `scrub` strips C1 controls (`\x80-\x9f`) and `\u200b-\u200f \u202a-\u202e \u2060-\u2069 \ufeff`.
6. (LOW) URL query and fragment masking now applies to any `scheme://`, not only http(s).

**Tests:**
- util bug-report.test.ts has new describes: free text in log fields, home directory spellings, and characters and
  URLs. It also has a `homes` test that uses a real symlink alias.
- tui crash-report.test.tsx: a 50k-character multi-line message gives a URL of at most 6000 characters, a title of at
  most 200 bytes, `<path>`, no PLANTED, and the footer notice.
- cli bug.test.ts: the notice is printed before confirm.
- tui feedback.test.tsx: the notice is shown.

**Mutation checks:** each one failed at least one test, and each source file was restored afterwards:
- payload masking, first-line, path masking, the left boundary, Windows case folding, encodeURI, the C1 range, the
  bidi ranges, any scheme, `FREE_TEXT` routing and the 120-byte cap (all util)
- the crash-screen `scrubLine` swapped back to `scrub` (tui)

**Checks:**
- PASS: typecheck in util, cli and tui
- PASS: util `bun run test` (377 pass)
- PASS: cli `bun test test/kete` (329 pass)
- PASS: tui `bun run test` (1483 pass)
- PASS: root lint
- PASS: upstream:check

**Open:**
- The crash screen still shows the full, unscrubbed message on the local screen. That is upstream behaviour, and it
  is never sent.
- Paths in crash stack frames outside home (for example `/$bunfs/…`) are still kept in the issue body. Only
  `scrub` applies there, by design, because frames are the diagnostic.
- A non-JSON MCP error that echoes a prompt is only bounded by the 120-byte cap.
