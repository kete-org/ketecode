// Classifies a shell command line for Kete Code's safe permission defaults (kete/permission-mode.ts).
// The shell tool asks permission once per parsed command (`core/src/shell/parse.ts`); each of those
// command texts comes here. The classifier is deliberately conservative and only ever used to
// tighten a decision: it can make an allowed command ask (or, in Plan mode, be denied), never the
// other way round.
//
//   read  — looks only: ls, cat, grep, git status/diff/log, find without -delete/-exec, …
//   build — the project's own test/build/lint/typecheck invocations: npm test, cargo test, tsc, …
//   other — anything else that may change something: git commit, mkdir, node script.js, …
//   high  — high-risk (CLAUDE.md §9): git push, reset --hard, clean, deletes, force flags, package
//           installs, network clients, containers/infra/cloud/deploy, databases and migrations,
//           sudo, credential access, writes outside the workspace — and anything the classifier
//           can't parse (command substitution, subshells, heredocs, unknown command names).
//
// Command lines are tokenised here (quotes, escapes, `;`, `&&`, `||`, `|`, `&`, redirections,
// `NAME=value` prefixes); wrappers such as `sudo`, `env`, `xargs`, `timeout`, `sh -c "…"`,
// `bash -c`, `eval` and `find -exec` are unwrapped and their inner command classified too. The
// whole line is as risky as its riskiest part. This is a best-effort guard, not a sandbox: a
// project script (`npm test`, `make build`) runs whatever the project defines.

export * as KeteShellRisk from "./shell-risk.js"

export const risks = ["read", "build", "other", "high"] as const
export type Risk = (typeof risks)[number]

export interface Classification {
  readonly risk: Risk
  /** Why, for the permission prompt; empty for "read". */
  readonly reason: string
}

const rank: Record<Risk, number> = { read: 0, build: 1, other: 2, high: 3 }

export function max(a: Classification, b: Classification): Classification {
  return rank[b.risk] > rank[a.risk] ? b : a
}

const READ: Classification = { risk: "read", reason: "" }
const BUILD: Classification = { risk: "build", reason: "runs a project test, build or check" }
const other = (reason = "may change files or state"): Classification => ({ risk: "other", reason })
const high = (reason: string): Classification => ({ risk: "high", reason })

const MAX_DEPTH = 4

// ---------------------------------------------------------------------------------------------
// Tokeniser

interface Word {
  /** The word with quotes and escapes removed. */
  readonly value: string
  /** True when part of the word was a `$name`/`${…}` expansion outside single quotes. */
  readonly expands: boolean
  /** True when any part of the word was quoted or escaped. */
  readonly quoted: boolean
}

interface Redirect {
  readonly op: string
  readonly target?: Word
}

interface Segment {
  readonly words: Word[]
  readonly redirects: Redirect[]
}

type Parsed = { ok: true; segments: Segment[] } | { ok: false; reason: string }

const ESCAPABLE = new Set([..." \t'\"`$\\;&|<>()*?[]#~!{}=%"])

const UNPARSEABLE = "can't be checked safely (command substitution, subshell, heredoc or unbalanced quotes)"

export function tokenize(input: string): Parsed {
  const text = input.replace(/\\\r?\n/g, " ")
  const segments: Segment[] = []
  let words: Word[] = []
  let redirects: Redirect[] = []
  let value = ""
  let started = false
  let expands = false
  let quoted = false
  let pendingRedirect: string | undefined

  const endWord = () => {
    if (!started) return
    const word: Word = { value, expands, quoted }
    if (pendingRedirect !== undefined) {
      redirects.push({ op: pendingRedirect, target: word })
      pendingRedirect = undefined
    } else words.push(word)
    value = ""
    started = false
    expands = false
    quoted = false
  }
  const endSegment = () => {
    endWord()
    if (pendingRedirect !== undefined) return false
    if (words.length > 0 || redirects.length > 0) segments.push({ words, redirects })
    words = []
    redirects = []
    return true
  }
  const fail = (): Parsed => ({ ok: false, reason: UNPARSEABLE })

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    const next = text[i + 1]
    if (c === "\\") {
      if (i + 1 >= text.length) return fail()
      // A backslash before an ordinary character is kept (`C:\Users` on Windows shells); before a
      // shell-special one it escapes it, as in POSIX shells.
      if (ESCAPABLE.has(text[i + 1]!)) {
        value += text[i + 1]
        quoted = true
        i++
      } else value += c
      started = true
      continue
    }
    if (c === "'") {
      const end = text.indexOf("'", i + 1)
      if (end === -1) return fail()
      value += text.slice(i + 1, end)
      started = true
      quoted = true
      i = end
      continue
    }
    if (c === '"') {
      let j = i + 1
      for (; j < text.length; j++) {
        const d = text[j]!
        if (d === '"') break
        if (d === "\\" && j + 1 < text.length) {
          value += text[j + 1]
          j++
          continue
        }
        if (d === "`" || (d === "$" && text[j + 1] === "(")) return fail()
        if (d === "$" && /[A-Za-z_{0-9@*#?!$-]/.test(text[j + 1] ?? "")) expands = true
        value += d
      }
      if (j >= text.length) return fail()
      started = true
      quoted = true
      i = j
      continue
    }
    if (c === "`") return fail()
    if (c === "$") {
      if (next === "(" || next === "'") return fail()
      if (next !== undefined && /[A-Za-z_{0-9@*#?!$-]/.test(next)) expands = true
      value += c
      started = true
      continue
    }
    if (c === "#" && !started) {
      const end = text.indexOf("\n", i)
      if (end === -1) break
      i = end - 1
      continue
    }
    if (c === "(" || c === ")") return fail()
    if (c === " " || c === "\t") {
      endWord()
      continue
    }
    if (c === "\n" || c === ";") {
      if (!endSegment()) return fail()
      continue
    }
    if (c === "&") {
      if (next === ">") {
        endWord()
        if (pendingRedirect !== undefined) return fail()
        pendingRedirect = text[i + 2] === ">" ? "&>>" : "&>"
        i += pendingRedirect.length - 1
        continue
      }
      if (!endSegment()) return fail()
      if (next === "&") i++
      continue
    }
    if (c === "|") {
      if (!endSegment()) return fail()
      if (next === "|" || next === "&") i++
      continue
    }
    if (c === ">" || c === "<") {
      // A preceding all-digit word is the file descriptor: `2>`, `2>&1`.
      const fd = started && !quoted && /^\d+$/.test(value) ? value : ""
      if (fd) {
        value = ""
        started = false
      } else endWord()
      if (pendingRedirect !== undefined) return fail()
      if (c === "<" && next === "<") return fail() // heredoc / herestring
      if (c === "<" && next === "(") return fail()
      if (c === ">" && next === "(") return fail()
      let op = fd + c
      if (c === ">" && (next === ">" || next === "|")) {
        op += next
        i++
      }
      if (text[i + 1] === "&") {
        // `>&2`, `2>&1`, `<&0`: duplicates a descriptor, no file.
        const m = /^&(\d+|-)/.exec(text.slice(i + 1))
        if (!m) return fail()
        redirects.push({ op: op + m[0] })
        i += m[0].length
        continue
      }
      pendingRedirect = op
      continue
    }
    if ((c === "{" || c === "}") && !started && (next === undefined || /\s/.test(next))) return fail()
    value += c
    started = true
  }
  if (!endSegment()) return fail()
  return { ok: true, segments }
}

// ---------------------------------------------------------------------------------------------
// Paths

const CREDENTIAL = [
  /(^|[\\/])\.env(\.(?!example$|sample$|template$|dist$)[^\\/]*)?$/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.azure([\\/]|$)/i,
  /(^|[\\/])\.config[\\/]gcloud([\\/]|$)/i,
  /(^|[\\/])\.kube([\\/]|$)/i,
  /(^|[\\/])\.gnupg([\\/]|$)/i,
  /(^|[\\/])\.docker[\\/]config\.json$/i,
  /(^|[\\/])\.(netrc|npmrc|pypirc|pgpass|git-credentials)$/i,
  /(^|[\\/])\.config[\\/]kete([\\/]|$)/i,
  /(^|[\\/])\.local[\\/]share[\\/]kete([\\/]|$)/i,
]

/** Whether `value` names a credential or secret file (`.env`, `~/.ssh`, keys, cloud credentials, …). */
export function credential(value: string) {
  return CREDENTIAL.some((pattern) => pattern.test(value))
}

const SAFE_DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "nul", "NUL"])

/** Whether `value` points outside the workspace: absolute, home-relative, `..`, or a Windows drive. */
export function outside(value: string) {
  if (SAFE_DEVICES.has(value)) return false
  if (value.startsWith("/") || value.startsWith("~") || value.startsWith("\\")) return true
  if (/^[A-Za-z]:/.test(value)) return true
  if (/^\$(HOME|USERPROFILE|TMPDIR|\{HOME\})/.test(value)) return true
  return value.split(/[\\/]/).includes("..")
}

// ---------------------------------------------------------------------------------------------
// Command tables

const lower = (value: string) => value.toLowerCase()

/** Commands that only read (subject to the argument checks in `classifyWords`). */
const READ_COMMANDS = new Set([
  "ls", "ll", "la", "dir", "cat", "bat", "head", "tail", "wc", "pwd", "echo", "printf", "grep", "egrep",
  "fgrep", "rg", "ag", "ack", "tree", "stat", "file", "du", "df", "which", "whereis", "type", "basename",
  "dirname", "realpath", "readlink", "true", "false", "test", "[", "date", "whoami", "id", "hostname",
  "uname", "cut", "tr", "nl", "diff", "cmp", "comm", "jq", "column", "seq", "expr", "sleep", "md5sum",
  "sha1sum", "sha256sum", "sha512sum", "shasum", "md5", "cksum", "xxd", "hexdump", "od", "strings",
  "tac", "rev", "fold", "fmt", "paste", "join", "nproc", "arch", "uptime", "ps", "lsof", "pgrep",
  "cd", "pushd", "popd", "command", "get-childitem", "gci", "get-content", "gc", "get-item", "gi",
  "get-location", "gl", "select-string", "sls", "test-path", "resolve-path", "get-command", "gcm",
  "measure-object", "write-output", "write-host", "get-date", "findstr", "where",
])

/** Commands whose arguments aren't file paths, or whose first positional argument is a pattern. */
const NO_PATH_ARGS = new Set([
  "echo", "printf", "write-output", "write-host", "expr", "seq", "sleep", "date", "test", "[", "true",
  "false", "which", "whereis", "type", "command", "get-command", "gcm", "uname", "hostname", "whoami", "id",
  "nproc", "arch", "uptime", "ps", "pgrep",
])
const PATTERN_FIRST = new Set(["grep", "egrep", "fgrep", "rg", "ag", "ack", "sed", "select-string", "sls", "findstr"])

/** Read commands that take an output-file option. */
const WRITES_WITH = {
  sort: ["-o", "--output"],
  uniq: [],
} as const

const NETWORK = new Set([
  "curl", "wget", "ssh", "scp", "sftp", "rsync", "ftp", "tftp", "telnet", "nc", "ncat", "netcat", "socat",
  "nmap", "http", "https", "xh", "httpie", "aria2c", "mosh", "lftp", "smbclient", "invoke-webrequest",
  "iwr", "invoke-restmethod", "irm", "start-bitstransfer", "new-pssession", "enter-pssession",
  "invoke-command", "bitsadmin",
])

const INFRA = new Set([
  "docker", "docker-compose", "podman", "podman-compose", "buildah", "nerdctl", "colima", "kubectl", "k9s",
  "helm", "terraform", "tofu", "terragrunt", "pulumi", "aws", "gcloud", "gsutil", "bq", "az", "doctl",
  "fly", "flyctl", "vercel", "netlify", "heroku", "firebase", "wrangler", "serverless", "sls", "cdk",
  "cdktf", "sam", "sst", "amplify", "eb", "ansible", "ansible-playbook", "vagrant", "packer", "eksctl",
  "kind", "minikube", "k3d", "skaffold", "tilt", "gh", "glab", "hub", "railway", "render", "supabase",
  "nomad", "consul", "vault", "oc", "linode-cli", "hcloud", "kubectx", "kubens", "twine",
])

const DATABASE = new Set([
  "psql", "pg_dump", "pg_dumpall", "pg_restore", "dropdb", "createdb", "mysql", "mysqldump", "mysqladmin",
  "mariadb", "mongo", "mongosh", "mongodump", "mongorestore", "redis-cli", "sqlcmd", "cqlsh", "cockroach",
  "clickhouse-client", "influx", "flyway", "liquibase", "dbmate", "goose", "migrate", "atlas",
])

const DELETE = new Set([
  "rm", "rmdir", "unlink", "shred", "srm", "trash", "del", "erase", "rd", "remove-item", "ri",
  "clear-content", "wipefs", "dd", "fdisk", "diskutil", "format", "truncate", "mv", "move", "move-item",
  "mi", "ren", "rename", "rename-item",
])

const PRIVILEGE = new Set(["sudo", "su", "doas", "pkexec", "runas", "gsudo"])

const SYSTEM = new Set([
  "systemctl", "service", "launchctl", "crontab", "at", "mount", "umount", "iptables", "ip6tables", "nft",
  "ufw", "pfctl", "firewall-cmd", "sysctl", "scutil", "networksetup", "reboot", "shutdown", "halt",
  "poweroff", "reg", "setx", "set-itemproperty", "set-executionpolicy", "install-module", "install-package",
  "install-script", "uninstall-module", "uninstall-package", "start-process", "osascript", "csrutil",
  "spctl", "nvram", "bcdedit", "chsh", "useradd", "userdel", "usermod", "passwd", "visudo",
])

const CREDENTIAL_TOOLS = new Set([
  "security", "ssh-keygen", "ssh-add", "ssh-agent", "ssh-copy-id", "gpg", "gpg2", "pass", "op", "bw",
  "keyring", "secret-tool", "cmdkey", "certutil", "printenv", "get-credential",
])

const SYSTEM_PACKAGE_MANAGERS = new Set([
  "brew", "apt", "apt-get", "aptitude", "dpkg", "yum", "dnf", "apk", "pacman", "zypper", "port", "choco",
  "winget", "scoop", "snap", "flatpak", "nix-env", "nix", "rpm", "emerge", "pkg", "mas", "softwareupdate",
  "pipx", "conda", "mamba", "micromamba", "gem", "cpan", "cpanm", "luarocks", "opam", "stack", "cabal",
])

const VERSION_MANAGERS = new Set(["rustup", "nvm", "volta", "pyenv", "rbenv", "asdf", "mise", "fnm", "sdk", "n", "corepack"])

const INTERPRETERS = new Set([
  "node", "python", "python3", "py", "ruby", "perl", "php", "java", "lua", "rscript", "julia", "bun",
  "deno", "tsx", "ts-node", "awk", "gawk", "mawk", "sed", "pwsh", "powershell",
])

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish", "csh", "tcsh", "ash"])

/** Wrappers whose arguments end at the wrapped command: options to skip, and options that take a value. */
const WRAPPERS: Record<string, { readonly valued: ReadonlySet<string>; readonly positional?: number }> = {
  command: { valued: new Set() },
  builtin: { valued: new Set() },
  exec: { valued: new Set(["-a"]) },
  nohup: { valued: new Set() },
  time: { valued: new Set(["-f", "-o", "--format", "--output"]) },
  nice: { valued: new Set(["-n", "--adjustment"]) },
  ionice: { valued: new Set(["-c", "-n", "-p", "--class", "--classdata"]) },
  timeout: { valued: new Set(["-s", "-k", "--signal", "--kill-after"]), positional: 1 },
  stdbuf: { valued: new Set(["-i", "-o", "-e"]) },
  caffeinate: { valued: new Set(["-t", "-w"]) },
  chronic: { valued: new Set() },
}

/** Build/test tools run directly (not through a package manager). */
const BUILD_TOOLS = new Set([
  "tsc", "vitest", "jest", "mocha", "ava", "pytest", "py.test", "eslint", "prettier", "ruff", "mypy",
  "pyright", "black", "flake8", "pylint", "isort", "rubocop", "rspec", "phpunit", "golangci-lint",
  "ctest", "tox", "nox", "biome", "oxlint", "stylelint", "tsgo", "vue-tsc", "svelte-check", "playwright",
  "cypress", "gofmt", "rustfmt", "clang-format", "shellcheck", "hadolint", "markdownlint", "swiftlint",
  "ktlint", "detekt",
])

/** Script and target names treated as the project's test/build/check loop. */
const BUILD_NAME = /^(test|tests|unit|e2e|lint|build|typecheck|type-check|types|check|checks|compile|verify|format|fmt|tsc|vitest|jest|coverage)([:\-_.].*)?$/i
const RISKY_NAME = /(deploy|publish|release|push|migrat|seed|db[:\-_]|install|upload|prod|clean|reset|drop|destroy|nuke)/i

function buildName(name: string | undefined) {
  return name !== undefined && BUILD_NAME.test(name) && !RISKY_NAME.test(name)
}

// ---------------------------------------------------------------------------------------------
// Classification

const flags = (args: Word[]) => args.filter((arg) => arg.value.startsWith("-")).map((arg) => arg.value)
const positional = (args: Word[]) => args.filter((arg) => !arg.value.startsWith("-"))

/** Classifies a whole command line: as risky as its riskiest part. */
export function classify(command: string, depth = 0): Classification {
  if (depth > MAX_DEPTH) return high("nests shells too deeply to check safely")
  const parsed = tokenize(command)
  if (!parsed.ok) return high(parsed.reason)
  let result = READ
  for (const segment of parsed.segments) {
    result = max(result, classifySegment(segment, depth))
    if (result.risk === "high") return result
  }
  return result
}

function classifySegment(segment: Segment, depth: number): Classification {
  let result = READ
  for (const redirect of segment.redirects) {
    if (redirect.target === undefined) continue // descriptor duplication
    const target = redirect.target
    if (redirect.op.includes("<")) {
      if (credential(target.value)) return high("reads a credential or secret file")
      if (outside(target.value) || target.expands) result = max(result, other("reads a file outside the workspace"))
      continue
    }
    if (SAFE_DEVICES.has(target.value)) continue
    if (credential(target.value)) return high("writes a credential or secret file")
    if (outside(target.value) || target.expands) return high("writes a file outside the workspace")
    result = max(result, other("writes a file"))
  }
  const words = [...segment.words]
  let assigned = false
  while (words.length > 0 && !words[0]!.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!.value)) {
    if (/^(LD_PRELOAD|LD_LIBRARY_PATH|DYLD_[A-Z_]+|PATH|GIT_SSH_COMMAND|GIT_SSH|GIT_EXEC_PATH|BASH_ENV|ENV|PROMPT_COMMAND|NODE_OPTIONS|PYTHONSTARTUP)=/.test(words[0]!.value))
      result = max(result, other("changes how the command is loaded"))
    words.shift()
    assigned = true
  }
  if (words.length === 0) return max(result, assigned ? other("sets a shell variable") : READ)
  const inner = classifyWords(words, depth)
  const combined = max(result, inner)
  // `NAME=value cmd`: a variable can change what even a read-only command does.
  if (assigned && rank[combined.risk] < rank.other) return other("runs with changed environment variables")
  return combined
}

function classifyWords(words: Word[], depth: number): Classification {
  const head = words[0]!
  if (head.expands) return high("runs a command named by a variable")
  const pathy = /[\\/]/.test(head.value)
  const base = lower(head.value.split(/[\\/]/).at(-1) ?? head.value).replace(/\.(exe|cmd|bat|ps1)$/, "")
  const args = words.slice(1)
  const result = classifyCommand(base, args, depth, pathy)
  if (result.risk === "high") return result
  // Credential files and paths outside the workspace, whatever the command.
  for (const arg of args) {
    const value = arg.value.replace(/^--?[A-Za-z-]+=/, "")
    if (credential(value)) return high("touches a credential or secret file")
  }
  if (rank[result.risk] <= rank.build) {
    if (pathy && !/^\.[\\/](gradlew|mvnw)$/.test(head.value)) return other("runs a program by path")
    if (pathArgs(base, args).some((arg) => outside(arg.value.replace(/^--?[A-Za-z-]+=/, ""))))
      return other("reads outside the workspace")
    if (result.risk === "read" && args.some((arg) => arg.expands)) return other("uses variables in its arguments")
  }
  return result
}

function pathArgs(base: string, args: Word[]) {
  if (NO_PATH_ARGS.has(base)) return []
  if (!PATTERN_FIRST.has(base)) return args
  if (args.some((arg) => /^(-e|--regexp|-f|--file|--expression)/.test(arg.value))) return args
  const index = args.findIndex((arg) => !arg.value.startsWith("-"))
  return index === -1 ? args : args.filter((_, i) => i !== index)
}

function classifyCommand(base: string, args: Word[], depth: number, pathy: boolean): Classification {
  const values = args.map((arg) => arg.value)
  const first = values[0]

  if (PRIVILEGE.has(base)) return high("runs with elevated privileges")
  if (NETWORK.has(base)) return high("makes network requests")
  if (INFRA.has(base)) return high("manages containers, cloud infrastructure or deployments")
  if (DATABASE.has(base)) return high("connects to or migrates a database")
  if (DELETE.has(base)) return high(base === "mv" || base.includes("move") || base.startsWith("ren") ? "moves or renames files, which can overwrite them" : "deletes files")
  if (SYSTEM.has(base)) return high("changes system settings, services or other programs")
  if (CREDENTIAL_TOOLS.has(base)) return high("accesses credentials or secrets")
  if (SYSTEM_PACKAGE_MANAGERS.has(base)) {
    if (values.length === 1 && /^(--version|-v|-V|version)$/.test(first!)) return READ
    return high("installs or changes packages")
  }
  if (VERSION_MANAGERS.has(base)) {
    if (first !== undefined && /^(install|uninstall|add|remove|global|default|update|self|toolchain|plugin|enable|disable|prepare|use)$/.test(first))
      return high("installs or changes toolchains")
    return other("changes the active toolchain")
  }

  // `x --version`, `x --help`
  if (values.length === 1 && /^(--version|-v|-V|version|--help|-h|help)$/.test(first!) && !pathy) return READ

  const wrapper = WRAPPERS[base]
  if (wrapper) return unwrap(args, wrapper, depth) ?? (base === "command" ? READ : other())

  if (base === "env") {
    let rest = args
    while (rest.length > 0 && (rest[0]!.value.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!.value))) {
      if (/^(-u|--unset|-C|--chdir|-S|--split-string)$/.test(rest[0]!.value)) {
        if (/^(-S|--split-string)$/.test(rest[0]!.value)) return high("can't be checked safely (env -S)")
        rest = rest.slice(1)
      }
      rest = rest.slice(1)
    }
    if (rest.length === 0) return high("prints environment variables, which can hold secrets")
    const inner = classifyWords(rest, depth)
    return rest.length === args.length || rank[inner.risk] >= rank.other ? inner : other("runs with changed environment variables")
  }
  if (base === "set" || base === "export" || base === "declare" || base === "typeset")
    return values.length === 0 || values.every((value) => /^-[pxA-Za-z]*$/.test(value))
      ? high("prints environment variables, which can hold secrets")
      : other("sets shell variables")
  if (base === "xargs") {
    const valued = new Set(["-I", "-i", "-n", "-P", "-L", "-l", "-d", "-E", "-e", "-s", "-a", "--arg-file", "--delimiter", "--max-args", "--max-procs", "--replace"])
    let rest = args
    while (rest.length > 0 && rest[0]!.value.startsWith("-")) {
      const flag = rest[0]!.value
      rest = rest.slice(valued.has(flag) ? 2 : 1)
    }
    if (rest.length === 0) return READ // xargs echo
    return classifyWords(rest, depth)
  }
  if (SHELLS.has(base) || base === "pwsh" || base === "powershell" || base === "cmd") {
    const index = values.findIndex((value) => /^(-c|-lc|-ic|-command|\/c|\/k|-encodedcommand|-e)$/i.test(value))
    if (index === -1) {
      if (base === "pwsh" || base === "powershell") return other("runs a PowerShell script")
      return values.length === 0 ? high("starts an interactive shell") : other("runs a shell script")
    }
    if (/^-(encodedcommand|e)$/i.test(values[index]!)) return high("runs an encoded command that can't be checked")
    const script = base === "cmd" || /^-command$/i.test(values[index]!) ? values.slice(index + 1).join(" ") : values[index + 1]
    if (script === undefined) return high("can't be checked safely (missing script)")
    return max(other("runs a nested shell"), classify(script, depth + 1))
  }
  if (base === "eval") return max(other("evaluates a string as a command"), classify(values.join(" "), depth + 1))
  if (base === "source" || base === "." || base === "invoke-expression" || base === "iex")
    return base === "invoke-expression" || base === "iex" ? high("evaluates a string that can't be checked") : other("runs a shell script")

  if (base === "git") return git(args)
  if (["npm", "pnpm", "yarn", "bun", "cnpm"].includes(base)) return nodePackageManager(base, args, depth)
  if (["npx", "bunx", "pnpx"].includes(base)) {
    if (values.some((value) => value === "--no-install" || value === "--no")) {
      const tool = positional(args)[0]?.value
      return tool !== undefined && BUILD_TOOLS.has(lower(tool)) ? BUILD : other("runs a package binary")
    }
    return high("downloads and runs a package")
  }
  if (["pip", "pip3", "uv", "poetry", "pipenv", "pdm", "hatch", "rye"].includes(base)) return pythonPackages(base, args, depth)
  if (base === "cargo") return cargo(args)
  if (base === "go") return golang(args)
  if (base === "composer") return /^(install|require|remove|update|upgrade|global|create-project|self-update)$/.test(first ?? "install")
    ? high("installs or changes packages")
    : first === "test" || buildName(first) ? BUILD : other()
  if (base === "bundle") {
    if (first === "exec") return classifyWords(args.slice(1), depth)
    return high("installs or changes packages")
  }
  if (base === "dotnet") {
    if (first === "add" || first === "remove" || first === "tool" || first === "nuget" || first === "workload" || first === "new")
      return high("installs or changes packages")
    return first !== undefined && /^(test|build|format)$/.test(first) ? BUILD : other()
  }
  if (base === "mvn" || base === "mvnw" || base === "gradle" || base === "gradlew") {
    const goals = positional(args).map((arg) => lower(arg.value))
    if (goals.some((goal) => /(deploy|publish|release|upload|install)/.test(goal))) return high("publishes or installs artifacts")
    const known = /^(test|build|check|compile|verify|package|assemble|lint|clean|validate|test-compile|spotlesscheck|ktlintcheck|detekt)$/
    return goals.length > 0 && goals.every((goal) => known.test(goal.split(":").at(-1) ?? goal)) ? BUILD : other()
  }
  if (base === "make" || base === "gmake" || base === "just" || base === "task" || base === "rake") {
    const targets = positional(args).filter((arg) => !arg.value.includes("="))
    if (targets.some((target) => /(^db:|migrat)/i.test(target.value))) return high("connects to or migrates a database")
    if (targets.some((target) => RISKY_NAME.test(target.value))) return high(`runs the "${targets.find((target) => RISKY_NAME.test(target.value))!.value}" target`)
    if (targets.length === 0) return base === "make" ? BUILD : other()
    return targets.every((target) => buildName(target.value) || target.value === "all") ? BUILD : other()
  }
  if (base === "turbo" || base === "nx" || base === "lerna") {
    const names = positional(args).map((arg) => arg.value).filter((value) => value !== "run" && value !== "run-many" && value !== "affected")
    return names.length > 0 && names.every((name) => buildName(name)) ? BUILD : other()
  }
  if (base === "deno") {
    if (/^(install|add|remove|uninstall|upgrade|publish|compile)$/.test(first ?? "")) return high("installs or changes packages")
    return /^(test|check|lint|bench)$/.test(first ?? "") || (first === "fmt" && values.includes("--check")) ? BUILD : other("runs a program")
  }
  if (base === "swift") return /^(build|test)$/.test(first ?? "") ? BUILD : other()
  if (base === "prisma") return /^(migrate|db)$/.test(first ?? "") ? high("migrates or changes a database") : /^(validate|format|generate|--version|version)$/.test(first ?? "") ? BUILD : other()
  if (base === "drizzle-kit") return /^(push|migrate|drop|up)/.test(first ?? "") ? high("migrates or changes a database") : other()
  if (base === "knex" || base === "sequelize" || base === "typeorm" || base === "alembic" || base === "rails") {
    if (values.some((value) => /(migrat|seed|db:|schema:|upgrade|downgrade|stamp)/.test(value))) return high("migrates or changes a database")
    return other()
  }
  if (base === "python" || base === "python3" || base === "py") {
    if (first === "-m") {
      const module = values[1]
      if (module === "pip") return pythonPackages("pip", args.slice(2), depth)
      if (module !== undefined && /^(pytest|unittest|mypy|ruff|black|flake8|pyright|pylint|isort|compileall|tox|nox|doctest)$/.test(module)) return BUILD
      if (module === "http.server" || module === "venv" || module === "ensurepip") return other()
      return other("runs a Python module")
    }
    if (values.some((value) => /(^|[\\/])manage\.py$/.test(value)) && values.some((value) => /^(migrate|flush|sqlflush|dbshell|loaddata|createsuperuser|reset_db)$/.test(value)))
      return high("migrates or changes a database")
    return other("runs a program")
  }
  if (base === "find" || base === "fd" || base === "fdfind") return find(base, args, depth)
  if (base === "sed") {
    if (values.some((value) => /^(-i|--in-place)/.test(value) || /^-[a-zA-Z]*i/.test(value))) return other("edits files in place")
    const scripts = values.filter((value) => !value.startsWith("-"))
    if (scripts.some((script) => /(^|[;{}\n]|\/[a-zA-Z0-9]*)\s*[wWe](\s|$)|[0-9$]\s*[ewW](\s|$)/.test(script))) return other("may write files or run commands")
    return READ
  }
  if (base === "awk" || base === "gawk" || base === "mawk") return other("runs an awk program")
  if (base === "sort") return values.some((value) => WRITES_WITH.sort.some((flag) => value === flag || value.startsWith(flag + "="))) ? other("writes a file") : READ
  if (base === "uniq") return positional(args).length > 1 ? other("writes a file") : READ
  if (base === "tee" || base === "tee-object") {
    const targets = positional(args)
    if (targets.some((target) => outside(target.value))) return high("writes a file outside the workspace")
    return targets.length === 0 ? READ : other("writes a file")
  }
  if (["cp", "copy", "copy-item", "ln", "touch", "mkdir", "md", "install", "new-item", "ni", "set-content", "add-content", "out-file", "tar", "zip", "unzip", "gzip", "gunzip", "patch", "chmod", "chown", "chgrp", "chattr", "setfacl", "icacls", "takeown", "attrib"].includes(base)) {
    if (["chmod", "chown", "chgrp", "chattr", "setfacl", "icacls", "takeown"].includes(base) && flags(args).some((flag) => /^(-[a-zA-Z]*R|--recursive|\/t)$/i.test(flag)))
      return high("changes permissions or ownership recursively")
    if (positional(args).some((arg) => outside(arg.value))) return high("writes outside the workspace")
    return other("changes files")
  }
  if (base === "kill" || base === "killall" || base === "pkill" || base === "taskkill" || base === "stop-process") return other("stops processes")
  if (base === "yq") return values.some((value) => /^(-i|--inplace)/.test(value)) ? other("edits files in place") : READ
  if (BUILD_TOOLS.has(base)) {
    if (base === "playwright" && first === "install") return high("downloads browsers")
    return BUILD
  }
  if (INTERPRETERS.has(base)) return other("runs a program")
  if (READ_COMMANDS.has(base)) return READ
  return other("runs a program the classifier doesn't know")
}

function unwrap(args: Word[], wrapper: { readonly valued: ReadonlySet<string>; readonly positional?: number }, depth: number) {
  let rest = args
  while (rest.length > 0 && rest[0]!.value.startsWith("-")) {
    const flag = rest[0]!.value
    rest = rest.slice(wrapper.valued.has(flag) ? 2 : 1)
  }
  rest = rest.slice(wrapper.positional ?? 0)
  if (rest.length === 0) return undefined
  return classifyWords(rest, depth)
}

function find(base: string, args: Word[], depth: number): Classification {
  const values = args.map((arg) => arg.value)
  if (values.some((value) => value === "-delete")) return high("deletes files")
  if (values.some((value) => /^-f(print|print0|printf|ls)$/.test(value))) return other("writes a file")
  const exec = values.findIndex((value) =>
    base === "find" ? /^-(exec|execdir|ok|okdir)$/.test(value) : /^(-x|--exec|-X|--exec-batch)$/.test(value),
  )
  if (exec === -1) return READ
  let end = values.findIndex((value, index) => index > exec && (value === ";" || value === "+"))
  if (end === -1) end = values.length
  const inner = args.slice(exec + 1, end)
  if (inner.length === 0) return high("can't be checked safely (empty -exec)")
  return max(classifyWords(inner, depth), find(base, args.slice(end + 1), depth))
}

function git(args: Word[]): Classification {
  let rest = args
  let configured = false
  // Global options before the subcommand.
  while (rest.length > 0 && rest[0]!.value.startsWith("-")) {
    const flag = rest[0]!.value
    if (flag === "-c" || flag === "--config-env") configured = true
    if (flag === "-C" || flag === "-c" || flag === "--git-dir" || flag === "--work-tree" || flag === "--namespace" || flag === "--config-env") rest = rest.slice(2)
    else {
      if (flag.startsWith("--git-dir=") || flag.startsWith("--work-tree=")) configured = true
      rest = rest.slice(1)
    }
  }
  const sub = rest[0]?.value
  const subArgs = rest.slice(1)
  const values = subArgs.map((arg) => arg.value)
  const has = (...names: string[]) => values.some((value) => names.includes(value) || names.some((name) => name.startsWith("--") && value.startsWith(name + "=")))
  const force = values.some((value) => value === "--force" || value.startsWith("--force-") || value === "--force-with-lease" || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(value))
  const result = ((): Classification => {
    if (sub === undefined) return READ
    switch (sub) {
      case "push":
        return high("pushes to a remote")
      case "send-email":
      case "request-pull":
        return high("sends changes over the network")
      case "clean":
        return high("deletes untracked files")
      case "rm":
        return high("deletes files")
      case "filter-branch":
      case "filter-repo":
        return high("rewrites history")
      case "reset":
        return has("--hard", "--merge", "--keep") ? high("discards uncommitted work (reset --hard)") : other()
      case "checkout":
        if (force) return high("discards uncommitted work (checkout --force)")
        if (values.includes("--") || values.includes(".") || has("-p", "--patch", "--ours", "--theirs"))
          return high("discards uncommitted changes to files")
        return other("switches branches")
      case "restore":
        if (has("--staged", "-S") && !has("--worktree", "-W")) return other("unstages files")
        return high("discards uncommitted changes to files")
      case "switch":
        return force || has("--discard-changes") ? high("discards uncommitted work") : other("switches branches")
      case "branch": {
        if (has("-D", "-d", "--delete") || force || has("-M", "-C")) return high("deletes or overwrites a branch")
        const listing = new Set(["-a", "--all", "-r", "--remotes", "-l", "--list", "-v", "-vv", "--verbose", "--show-current", "--merged", "--no-merged", "--contains", "--no-contains", "--no-color", "--color", "--points-at", "--column", "--no-column", "-i", "--ignore-case", "--omit-empty"])
        const listingOnly = values.every((value) => listing.has(value) || /^--(sort|format|color|column|merged|no-merged|contains|no-contains|points-at)=/.test(value))
        if (listingOnly) return READ
        if (has("-l", "--list")) return READ
        return other("creates or changes a branch")
      }
      case "stash":
        if (values[0] === undefined || values[0] === "push" || values[0] === "save") return other("stashes changes")
        if (values[0] === "list" || values[0] === "show") return READ
        if (values[0] === "drop" || values[0] === "clear") return high("deletes stashed work")
        return other()
      case "tag":
        if (has("-d", "--delete") || force) return high("deletes or overwrites a tag")
        return values.length === 0 || has("-l", "--list", "-n") ? READ : other("creates a tag")
      case "remote":
        return values.length === 0 || (values.length === 1 && (values[0] === "-v" || values[0] === "--verbose")) || values[0] === "get-url" ? READ : other("changes remotes")
      case "worktree":
        return values[0] === "list" ? READ : values[0] === "remove" || values[0] === "prune" ? high("deletes a worktree") : other()
      case "reflog":
        return values[0] === undefined || values[0] === "show" ? READ : high("rewrites the reflog")
      case "update-ref":
        return has("-d", "--stdin") ? high("deletes or rewrites refs") : other()
      case "config":
        return has("--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin") && !has("--global", "--system") ? other("reads git configuration") : other("changes git configuration")
      case "status":
      case "diff":
      case "log":
      case "show":
      case "rev-parse":
      case "ls-files":
      case "ls-tree":
      case "blame":
      case "describe":
      case "shortlog":
      case "cat-file":
      case "merge-base":
      case "rev-list":
      case "grep":
      case "show-ref":
      case "name-rev":
      case "whatchanged":
      case "for-each-ref":
      case "check-ignore":
      case "count-objects":
      case "var":
      case "help":
      case "version":
      case "--version":
        return values.some((value) => value.startsWith("--output") || value === "--ext-diff") ? other("writes a file or runs an external tool") : READ
      default:
        return force ? high("uses a force flag") : other()
    }
  })()
  if (result.risk === "high") return result
  if (force) return high("uses a force flag")
  return configured ? max(result, other("overrides git configuration")) : result
}

const NODE_INSTALL = new Set([
  "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isntall", "add", "ci", "remove", "rm", "r",
  "un", "uninstall", "unlink", "update", "up", "upgrade", "link", "ln", "publish", "unpublish", "deprecate",
  "dist-tag", "owner", "access", "token", "adduser", "login", "logout", "dlx", "x", "exec", "create", "init",
  "dedupe", "prune", "rebuild", "import", "patch-commit", "global", "set-script", "pack", "version",
])

function nodePackageManager(base: string, args: Word[], depth: number): Classification {
  const values = args.map((arg) => arg.value)
  if (values.some((value) => value === "-g" || value === "--global" || value === "--location=global"))
    return high("installs or changes global packages")
  // Global options before the command (`pnpm -C dir test`, `npm --prefix x run build`).
  let rest = args
  while (rest.length > 0 && rest[0]!.value.startsWith("-")) {
    const flag = rest[0]!.value
    rest = rest.slice(/^(-C|--dir|--prefix|--cwd|-w|--workspace|--filter|-F)$/.test(flag) ? 2 : 1)
  }
  const sub = rest[0]?.value
  const after = rest.slice(1)
  if (sub === undefined) return base === "yarn" ? high("installs packages") : READ
  if (NODE_INSTALL.has(sub)) return high("installs, removes or publishes packages")
  if (sub === "audit") return after.some((arg) => arg.value === "fix") ? high("installs packages") : other("contacts the registry")
  if (sub === "test" || sub === "t" || sub === "tst") return BUILD
  if (sub === "ls" || sub === "list" || sub === "why" || sub === "explain" || sub === "ll" || sub === "la") return READ
  if (base === "bun" && sub === "build") return BUILD
  if (sub === "run" || sub === "run-script" || sub === "rs") {
    const script = firstPositional(after, /^(--cwd|--filter|-F|--dir|-C|--prefix|-w|--workspace)$/)
    return buildName(script) ? BUILD : other("runs a project script")
  }
  if (base === "bun" || base === "pnpm" || base === "yarn") {
    // `bun <script|file>`, `pnpm <script>`, `yarn <script>`
    if (buildName(sub)) return BUILD
    if (base === "yarn" && sub === "workspace") return nodePackageManager(base, after.slice(1), depth)
    return other("runs a project script or program")
  }
  return other()
}

function firstPositional(args: Word[], valued: RegExp) {
  for (let i = 0; i < args.length; i++) {
    const value = args[i]!.value
    if (!value.startsWith("-")) return value
    if (valued.test(value)) i++
  }
  return undefined
}

function pythonPackages(base: string, args: Word[], depth: number): Classification {
  const values = args.map((arg) => arg.value)
  const sub = values[0]
  if (base === "pip" || base === "pip3") {
    if (sub === "list" || sub === "show" || sub === "freeze" || sub === "check") return READ
    return high("installs or changes packages")
  }
  if (sub === "run") {
    const inner = args.slice(1)
    // Options to `uv run`/`poetry run` (`--with pkg`, …) can add packages: not checked further.
    if (inner.length === 0 || inner[0]!.value.startsWith("-")) return other("runs a program")
    return classifyWords(inner, depth)
  }
  if (sub === "pip") return pythonPackages("pip", args.slice(1), depth)
  if (sub !== undefined && /^(add|remove|install|sync|lock|update|upgrade|publish|tool|self|python|venv|init|build|new|uninstall)$/.test(sub))
    return high("installs, removes or publishes packages")
  if (sub === "show" || sub === "tree" || sub === "check" || sub === "--version") return READ
  return other()
}

function cargo(args: Word[]): Classification {
  const sub = positional(args).find((arg) => !arg.value.startsWith("+"))?.value
  if (sub === undefined) return READ
  if (/^(add|install|remove|rm|uninstall|publish|yank|login|logout|owner|update)$/.test(sub)) return high("installs, removes or publishes packages")
  if (/^(test|t|build|b|check|c|clippy|fmt|doc|bench|nextest|tree|metadata|verify-project)$/.test(sub)) return BUILD
  return other()
}

function golang(args: Word[]): Classification {
  const sub = args[0]?.value
  if (sub === "get" || sub === "install") return high("installs packages")
  if (sub === "test" || sub === "build" || sub === "vet") return BUILD
  if (sub === "list" || sub === "version" || (sub === "env" && args.length > 1)) return READ
  if (sub === "env") return other("prints the Go environment")
  return other()
}
