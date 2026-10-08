// macOS: a Seatbelt profile for `sandbox-exec` (ADR 0013). `sandbox-exec` is deprecated but still
// shipped (checked on macOS 26 / Darwin 25); Codex, Chromium and others use the same mechanism.
//
// The profile text is fixed: every path from the user's machine is passed as a `-D` parameter and
// referred to with `(param "Pn")`, so a workspace named `a") (allow file-write* (subpath "/` can't
// change the profile. Paths used inside regular expressions are passed already escaped.
//
// Shape: start from `(allow default)` so toolchains keep working, then take away
//   - writes everywhere except the writable roots and a few devices; inside them, Kete Code's
//     configuration (`.kete/` and `kete.json(c)` at any depth; `.claude/` and `.agents/` where
//     configuration is looked up, in `readOnly`), git's
//     internals that run code (`.git/config`, `.git/hooks/`, the `.git` entry itself, also in
//     submodules and linked worktrees) and the read-only paths stay unwritable. Seatbelt matches
//     paths the way the file system resolves them, so `.GIT/config` on a case-insensitive volume is
//     still `.git/config` (tested);
//   - reads of credential paths;
//   - Mach services except a short allowlist: without it `open`, AppleScript (`osascript`), the
//     pasteboard and the keychain reach processes outside the sandbox (tested: `open -a` launched
//     an app, AppleEvents reached Finder);
//   - AppleEvents and launchd job creation;
//   - outbound network when it isn't allowed, except loopback (unless `loopback: false`) and Unix
//     sockets in the workspace and the session's private temp directory — not the shared /tmp or
//     TMPDIR, where other programs' sockets live (DNS goes through a socket in /var/run: blocked).

export * as KeteSeatbelt from "./seatbelt.js"

import { checkPath, type Policy } from "./policy.js"

export const executable = "/usr/bin/sandbox-exec"

/** Mach services a sandboxed command may look up: user and group lookups (getpwuid), notifications,
 * logging, certificate trust (TLS in Go, Swift, curl), preferences and FSEvents (file watchers). */
export const machServices = [
  "com.apple.system.opendirectoryd.libinfo",
  "com.apple.system.opendirectoryd.membership",
  "com.apple.system.notification_center",
  "com.apple.system.logger",
  "com.apple.logd",
  "com.apple.trustd",
  "com.apple.trustd.agent",
  "com.apple.cfprefsd.daemon",
  "com.apple.cfprefsd.agent",
  "com.apple.FSEvents",
] as const

/** Escapes a literal for a Seatbelt regular expression (POSIX extended). */
export function escapeRegex(value: string) {
  return value.replace(/[\\^$.|?*+()[\]{}]/g, "\\$&")
}

const depth = (value: string) => value.split("/").filter((part) => part !== "").length
const within = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/")

const quote = (value: string) => `"${value.replace(/[\\"]/g, "\\$&")}"`

// Git internals that run commands when git reads them, relative to a git directory: the config (core.fsmonitor,
// core.hooksPath, aliases, filters), hooks, the files that point git at another git directory, attributes.
const GIT_INTERNALS = [
  "((modules|worktrees)/.+/)?(config|config\\.worktree|commondir|gitdir)$",
  // Renaming these away and back would let a command edit the files above under another name.
  "((modules|worktrees)/.+/)?(modules|worktrees)$",
  "((modules|worktrees)/.+/)?hooks(/|$)",
  "info/attributes$",
]

// Directories under a git directory that lead to protected files (see the rename rule in `profile`).
const GIT_DIRECTORIES = "(((modules|worktrees)/.+/)?info|(modules|worktrees)/.+)$"

export interface Profile {
  readonly profile: string
  readonly parameters: ReadonlyArray<readonly [string, string]>
}

export function profile(policy: Policy): Profile {
  const parameters: Array<readonly [string, string]> = []
  const param = (value: string) => {
    const name = `P${parameters.length}`
    parameters.push([name, value])
    return `(param ${quote(name)})`
  }
  const path = (value: string) => param(checkPath(value))
  const regex = (prefix: string, suffix: string) =>
    `(regex (string-append "^" ${param(escapeRegex(checkPath(prefix)))} ${quote(suffix)}))`
  const subpaths = (values: ReadonlyArray<string>) => values.map((value) => `(subpath ${path(value)})`)

  const workspace = policy.workspace
  // Path rules in depth order, parent first: Seatbelt applies the last matching rule, so a deeper
  // rule wins (a Kete worktree inside the read-only, hidden data directory is writable and readable;
  // a `denyWrite` path inside the workspace is not writable). Same depth: deny after allow.
  const ordered = (rules: ReadonlyArray<{ readonly path: string; readonly allow: boolean }>, operation: string) =>
    rules
      .map((rule, index) => ({ rule, index }))
      .sort(
        (a, b) =>
          depth(a.rule.path) - depth(b.rule.path) || Number(a.rule.allow === false) - Number(b.rule.allow === false) || a.index - b.index,
      )
      .map(({ rule }) => `(${rule.allow ? "allow" : "deny"} ${operation} (subpath ${path(rule.path)}))`)

  const lines = [
    "(version 1)",
    "(allow default)",
    "",
    "; Writes: only the writable roots and a few devices; read-only paths inside them.",
    "(deny file-write*)",
    `(allow file-write* ${[
      '(literal "/dev/null")',
      '(literal "/dev/zero")',
      '(literal "/dev/dtracehelper")',
      '(literal "/dev/ptmx")',
      '(regex "^/dev/tty")',
      '(regex "^/dev/fd/")',
      // The per-user temp and cache directories (DARWIN_USER_TEMP_DIR, DARWIN_USER_CACHE_DIR): Apple's
      // tools write there whatever TMPDIR says (the xcrun shims behind /usr/bin/git, clang's modules).
      '(regex "^/private/var/folders/[^/]+/[^/]+/[TC]/")',
    ].join(" ")})`,
    ...ordered(
      [
        ...policy.writable.map((value) => ({ path: value, allow: true })),
        ...policy.readOnly.map((value) => ({ path: value, allow: false })),
      ],
      "file-write*",
    ),
    "",
    "; Never writable, wherever: Kete Code's configuration, git internals.",
    `(deny file-write* ${[
      '(regex "/\\\\.kete(/|$)")',
      '(regex "/kete\\\\.jsonc?$")',
      regex(workspace, "(/.*)?/\\.git$"),
      ...GIT_INTERNALS.map((internal) => regex(workspace, `(/.*)?/\\.git/${internal}`)),
      ...policy.gitDirectories.flatMap((directory) => [
        regex(directory, "$"),
        ...GIT_INTERNALS.map((internal) => regex(directory, `/${internal}`)),
      ]),
    ].join(" ")})`,
    // Seatbelt checks a rename's source and destination paths only, so moving a directory that holds
    // protected files away, editing them and moving it back would get around the rules above
    // (`mv .git/modules/sub x; edit x/config; mv x .git/modules/sub`). Directories on the way to a
    // protected file can't be removed or renamed: `info`, and every directory under `modules` and
    // `worktrees` (a submodule's name may contain "/"). Files there (objects, refs, index) stay
    // writable, and new directories can still be created.
    // Filters listed in one rule are alternatives; `require-all` makes the directory test apply.
    `(deny file-write-unlink (require-all (vnode-type DIRECTORY) (require-any ${[
      regex(workspace, `(/.*)?/\\.git/${GIT_DIRECTORIES}`),
      ...policy.gitDirectories.map((directory) => regex(directory, `/${GIT_DIRECTORIES}`)),
    ].join(" ")})))`,
  ]

  if (policy.hidden.length > 0) {
    const hidden = policy.hidden.map((item) => item.path)
    const insideHidden = (value: string) => hidden.some((parent) => value !== parent && within(value, parent))
    lines.push(
      "",
      "; Credentials (and Kete Code's private directories), with exceptions.",
      ...ordered(
        [
          ...hidden.map((value) => ({ path: value, allow: false })),
          ...policy.visible.map((value) => ({ path: value, allow: true })),
          ...policy.writable.filter(insideHidden).map((value) => ({ path: value, allow: true })),
        ],
        "file-read*",
      ),
    )
  }

  lines.push(
    "",
    "; Other processes: no Mach services beyond the allowlist, no AppleEvents, no launchd jobs.",
    "(deny mach-lookup)",
    `(allow mach-lookup ${machServices.map((name) => `(global-name ${quote(name)})`).join(" ")})`,
    "(deny appleevent-send)",
    "(deny job-creation)",
  )

  if (!policy.network) {
    lines.push(
      "",
      policy.loopback ? "; Network: this machine only." : "; Network: none (Unix sockets in the workspace and private temp only).",
      "(deny network-outbound)",
      ...(policy.loopback ? ['(allow network-outbound (remote ip "localhost:*"))'] : []),
    )
    if (policy.sockets.length > 0) lines.push(`(allow network-outbound ${subpaths(policy.sockets).join(" ")})`)
  }

  return { profile: lines.join("\n") + "\n", parameters }
}

/** `sandbox-exec` arguments that run `file args…` under `policy`. */
export function command(policy: Policy, file: string, args: ReadonlyArray<string>) {
  const built = profile(policy)
  return {
    file: executable,
    args: ["-p", built.profile, ...built.parameters.flatMap(([name, value]) => ["-D", `${name}=${value}`]), "--", file, ...args],
  }
}
