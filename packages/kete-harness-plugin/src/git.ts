// Kete-owned. The git the step itself runs (never the agent): committing the run's worktree and
// pushing it to a NEW branch.
//
// The agent could have changed the repository's config while it ran (`core.fsmonitor`,
// `core.sshCommand`, `credential.helper`, `url.*.insteadOf`, `remote.origin.pushurl`, filter
// drivers, `include.path`, hooks), so the commit and the push never read it: the push target is the
// `remote.origin.url` read and validated BEFORE the run (`originURL`), and the commit is built in a
// fresh temporary repository that borrows the worktree's objects (`GIT_ALTERNATE_OBJECT_DIRECTORIES`)
// and reads the worktree's files (`GIT_WORK_TREE`) but has its own empty config, with system and
// global config off (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=<null device>`). Every call also
// pins the risky keys on the command line (hooks, fsmonitor, pager, credential helpers, ssh command,
// `ext::`) and only the validated remote's protocol is allowed. The push is refused unless the branch
// doesn't exist on the remote yet (`--force-with-lease=<ref>:` with an empty expectation is git's
// atomic "must not exist"), and the target and default branches are refused before the run starts.
// Git's output is redacted before it's printed.

import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { devNull, tmpdir } from "node:os"
import path from "node:path"
import type { Secrets } from "./secrets.js"
import { Settings } from "./settings.js"

export * as Git from "./git.js"

export type Env = Readonly<Record<string, string | undefined>>

export type Context = {
  /** The step's environment without secrets (`Run.sanitize`); git's own variables are dropped. */
  readonly env: Env
  readonly redact: Secrets.Redactor
}

export const timeoutMs = 120_000

/** The protocols a validated `remote.origin.url` can use. */
export type Scheme = "https" | "http" | "ssh" | "file"

export type Remote = { readonly url: string; readonly scheme: Scheme }

/** Pinned on every call: whatever config is read, none of these can run a command or a hook. */
const pinned = [
  // The workspace is usually cloned by another user (the image's /etc/gitconfig said the same, but
  // system config is off); this only lets git read it, and nothing here runs the repository's config.
  ["safe.directory", "*"],
  ["core.hooksPath", devNull],
  ["core.fsmonitor", "false"],
  ["core.pager", "cat"],
  ["core.sshCommand", "ssh"],
  ["core.askPass", ""],
  ["credential.helper", ""],
  ["commit.gpgSign", "false"],
  ["tag.gpgSign", "false"],
  ["protocol.ext.allow", "never"],
  ["protocol.fd.allow", "never"],
].flatMap(([key, value]) => ["-c", `${key}=${value}`])

/** The environment every git call gets: the step's, without git's own variables, system and global config off. */
export function environment(env: Env, extra: Record<string, string> = {}): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name.startsWith("GIT_")) continue
    out[name] = value
  }
  return {
    ...out,
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: devNull,
    GIT_PAGER: "cat",
    ...extra,
  }
}

export type Result = { readonly ok: boolean; readonly stdout: string; readonly stderr: string }

export function git(cwd: string, args: readonly string[], ctx: Context, extra: Record<string, string> = {}): Result {
  const out = spawnSync("git", [...pinned, ...args], {
    cwd,
    env: environment(ctx.env, extra),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  })
  return {
    ok: out.status === 0,
    stdout: out.stdout ?? "",
    stderr: ctx.redact(out.error ? `${out.error.message}\n${out.stderr ?? ""}` : (out.stderr ?? "")),
  }
}

/**
 * Branches a push must never go to: the pipeline's target, default and current branches, the
 * remote's default branch, and main/master. Lower-cased: compare with `isProtected`.
 */
export function protectedBranches(workspace: string, ctx: Context): Set<string> {
  const names = new Set(["main", "master"])
  for (const name of ["DRONE_TARGET_BRANCH", "DRONE_REPO_BRANCH", "DRONE_COMMIT_BRANCH", "DRONE_BRANCH"]) {
    const v = ctx.env[name]?.trim()
    if (v) names.add(v.replace(/^refs\/heads\//, "").toLowerCase())
  }
  const head = git(workspace, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], ctx)
  if (head.ok && head.stdout.trim())
    names.add(
      head.stdout
        .trim()
        .replace(/^origin\//, "")
        .toLowerCase(),
    )
  const current = git(workspace, ["symbolic-ref", "--quiet", "--short", "HEAD"], ctx)
  if (current.ok && current.stdout.trim()) names.add(current.stdout.trim().toLowerCase())
  return names
}

/** Case-insensitive: hosts like GitHub on case-insensitive file systems treat `Main` as `main`. */
export function isProtected(names: ReadonlySet<string>, branch: string): boolean {
  return names.has(branch.toLowerCase())
}

/** The workspace's latest tag, when it has one with a conservative name. */
export function latestTag(workspace: string, ctx: Context): string | undefined {
  const out = git(workspace, ["describe", "--tags", "--abbrev=0"], ctx)
  const tag = out.stdout.trim()
  return out.ok && Settings.isBranchName(tag) ? tag : undefined
}

/**
 * What a push may go to: `https://` (http only to this machine), `ssh://` or scp-like `host:path`,
 * and a local path or `file://`. Never a `<transport>::` helper, an option-looking value, or a
 * password in the URL.
 */
export function validateRemote(raw: string): Remote | undefined {
  const url = raw.trim()
  if (url === "" || url.length > 2048 || /[\s\x00-\x1f\x7f]/.test(url) || url.startsWith("-")) return undefined
  if (url.includes("::")) return undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    if (!URL.canParse(url)) return undefined
    const parsed = new URL(url)
    if (parsed.password !== "") return undefined
    const scheme = parsed.protocol.slice(0, -1).toLowerCase()
    if (scheme === "https" || scheme === "ssh") return { url, scheme }
    if (scheme === "http")
      return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ? { url, scheme } : undefined
    if (scheme === "file") return { url, scheme }
    return undefined
  }
  if (path.isAbsolute(url)) return { url, scheme: "file" }
  // scp-like: [user@]host:path (git treats it as ssh when the colon comes before any slash).
  const scp = /^(?:[A-Za-z0-9._-]+@)?([A-Za-z0-9.-]+):(?!\/\/)(.+)$/.exec(url)
  if (scp && !scp[1]!.startsWith("-") && !scp[2]!.startsWith("-")) return { url, scheme: "ssh" }
  return undefined
}

export type Origin =
  | { readonly kind: "ok"; readonly remote: Remote }
  | { readonly kind: "invalid"; readonly message: string }

/** `remote.origin.url` of the workspace, read before the agent runs; exactly one, validated. Never echoed. */
export function originURL(workspace: string, ctx: Context): Origin {
  const out = git(workspace, ["config", "--get-all", "remote.origin.url"], ctx)
  const urls = out.ok ? out.stdout.split("\n").filter((l) => l.trim() !== "") : []
  if (urls.length === 0) return { kind: "invalid", message: "the workspace has no remote.origin.url to push to." }
  if (urls.length > 1) return { kind: "invalid", message: "the workspace's remote.origin.url has several values." }
  const remote = validateRemote(urls[0]!)
  if (!remote)
    return {
      kind: "invalid",
      message:
        "the workspace's remote.origin.url isn't a URL the step pushes to (https, ssh, or a local path; no password, no transport helper).",
    }
  return { kind: "ok", remote }
}

export type Publish =
  | { readonly kind: "pushed"; readonly sha: string }
  | { readonly kind: "no_changes" }
  | { readonly kind: "exists" }
  | { readonly kind: "failed"; readonly message: string }

export type PublishInput = {
  readonly worktree: string
  readonly branch: string
  readonly remote: Remote
  readonly message: string
  readonly author: { readonly name: string; readonly email: string }
  /** Where `DRONE_NETRC_*` come from (the step's full environment). */
  readonly credentials: Env
}

/**
 * Commits everything in `worktree` on top of its HEAD and pushes the commit to
 * `refs/heads/<branch>` at `remote`, only if that branch doesn't exist there. The repository's own
 * config is never read (see the file comment). Drone/Harness clone credentials (`DRONE_NETRC_*`) go
 * to a private `.netrc` in a temporary HOME that only the push sees, deleted afterwards.
 */
export function publish(input: PublishInput, ctx: Context): Publish {
  const head = git(input.worktree, ["rev-parse", "--verify", "HEAD^{commit}"], ctx)
  if (!head.ok) return { kind: "failed", message: `git rev-parse failed: ${head.stderr.trim()}` }
  const base = head.stdout.trim()
  const common = git(input.worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], ctx)
  if (!common.ok) return { kind: "failed", message: `git rev-parse failed: ${common.stderr.trim()}` }
  const commonDir = common.stdout.trim()

  const temp = mkdtempSync(path.join(tmpdir(), "kete-harness-git-"))
  try {
    const repo = path.join(temp, "repo")
    mkdirSync(repo, { mode: 0o700 })
    // No template: no hooks, no info/exclude; the repository's config is git init's defaults only.
    const init = git(repo, ["init", "-q", "--template=", "."], ctx)
    if (!init.ok) return { kind: "failed", message: `git init failed: ${init.stderr.trim()}` }
    const gitDir = path.join(repo, ".git")
    // A shallow clone's boundary, so the push doesn't walk into history the workspace doesn't have.
    if (existsSync(path.join(commonDir, "shallow")))
      copyFileSync(path.join(commonDir, "shallow"), path.join(gitDir, "shallow"))
    const scratch = {
      GIT_DIR: gitDir,
      GIT_WORK_TREE: input.worktree,
      GIT_INDEX_FILE: path.join(temp, "index"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(commonDir, "objects"),
    }
    // In the worktree, so paths resolve there; GIT_DIR keeps git from finding the worktree's own repository.
    const run = (args: string[], extra: Record<string, string> = {}) =>
      git(input.worktree, args, ctx, { ...scratch, ...extra })

    const read = run(["read-tree", base])
    if (!read.ok) return { kind: "failed", message: `git read-tree failed: ${read.stderr.trim()}` }
    const add = run(["add", "-A"])
    if (!add.ok) return { kind: "failed", message: `git add failed: ${add.stderr.trim()}` }
    const tree = run(["write-tree"])
    if (!tree.ok) return { kind: "failed", message: `git write-tree failed: ${tree.stderr.trim()}` }
    const baseTree = run(["rev-parse", `${base}^{tree}`])
    if (baseTree.ok && baseTree.stdout.trim() === tree.stdout.trim()) return { kind: "no_changes" }
    const commit = run(["commit-tree", tree.stdout.trim(), "-p", base, "-m", input.message], {
      GIT_AUTHOR_NAME: input.author.name,
      GIT_AUTHOR_EMAIL: input.author.email,
      GIT_COMMITTER_NAME: input.author.name,
      GIT_COMMITTER_EMAIL: input.author.email,
    })
    if (!commit.ok) return { kind: "failed", message: `git commit-tree failed: ${commit.stderr.trim()}` }
    const sha = commit.stdout.trim()

    const ref = `refs/heads/${input.branch}`
    const home = netrcHome(input.credentials, temp)
    const out = run(
      [
        "-c",
        "protocol.allow=never",
        "-c",
        `protocol.${input.remote.scheme}.allow=always`,
        "push",
        "--porcelain",
        "--no-verify",
        `--force-with-lease=${ref}:`,
        input.remote.url,
        `${sha}:${ref}`,
      ],
      home ? { HOME: home } : {},
    )
    if (out.ok) return { kind: "pushed", sha }
    const text = `${out.stdout}\n${out.stderr}`
    if (/stale info|already exists|\[rejected\]|fetch first|non-fast-forward/i.test(text)) return { kind: "exists" }
    return { kind: "failed", message: `git push failed: ${ctx.redact(text).trim().slice(0, 2000)}` }
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}

function netrcHome(env: Env, temp: string): string | undefined {
  const machine = env.DRONE_NETRC_MACHINE?.trim()
  const login = env.DRONE_NETRC_USERNAME?.trim()
  const password = env.DRONE_NETRC_PASSWORD?.trim()
  if (!machine || !login || !password) return undefined
  if ([machine, login, password].some((v) => /\s/.test(v))) return undefined
  const home = path.join(temp, "home")
  mkdirSync(home, { mode: 0o700 })
  writeFileSync(path.join(home, ".netrc"), `machine ${machine}\nlogin ${login}\npassword ${password}\n`, {
    mode: 0o600,
  })
  return home
}
