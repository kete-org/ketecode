// The sandbox's policy (resolve.ts) and the generated sandbox-exec profile / bwrap arguments, run for
// real on this machine (ADR 0013): writes, protected paths, credentials, a linked worktree, the hooks
// path, and a workspace whose name tries to inject rules into the Seatbelt profile. Skipped where no
// sandbox works; CI installs bubblewrap.
import path from "path"
import fs from "fs/promises"
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { KeteSandboxProbe } from "@opencode/core/kete/sandbox/probe"
import { KeteSandboxResolve } from "@opencode/core/kete/sandbox/resolve"
import { KeteSandboxSettings } from "@opencode/core/kete/sandbox/settings"
import { KeteSandboxPlans } from "@opencode/core/kete/sandbox/plans"
import { tmpdir } from "../fixture/tmpdir"

const probe = await KeteSandboxProbe.probe()
// CI sets KETE_SANDBOX_TESTS=required, so a broken bwrap fails there instead of skipping quietly.
if (!probe.available && process.env.KETE_SANDBOX_TESTS === "required")
  throw new Error(`sandbox-policy.test.ts: the sandbox is required here but unavailable: ${probe.reason}`)
if (!probe.available) console.log(`sandbox-policy.test.ts skipped: ${probe.reason}`)

// Somewhere the test can write but the sandbox can't: macOS's shared folder (the isolated home sits
// in the per-user temp directory, which the sandbox may write), on Linux the test folder of this
// checkout (the test runner points $HOME into /tmp, which the sandbox may write).
const outsideDir = process.platform === "darwin" ? "/Users/Shared" : path.join(import.meta.dir, "..")

const settings = KeteSandboxSettings.resolve({ documents: [], globalDirectory: "/nonexistent", env: {} })

let root: Awaited<ReturnType<typeof tmpdir>>
let privateDir: string | undefined
const privateTmp = async () => (privateDir ??= await fs.mkdtemp(path.join(base, "private-tmp-")))
let base: string

beforeAll(async () => {
  root = await tmpdir()
  base = await fs.realpath(root.path)
})
afterAll(async () => {
  await root?.[Symbol.asyncDispose]()
})

function git(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

async function setup(name: string) {
  const home = path.join(base, `${name}-home`)
  const workspace = path.join(base, name)
  const kete = path.join(base, `${name}-kete`)
  await fs.mkdir(path.join(home, ".ssh"), { recursive: true })
  await fs.writeFile(path.join(home, ".ssh", "id_test"), "PRIVATE\n")
  await fs.writeFile(path.join(home, ".ssh", "known_hosts"), "github.com ssh-ed25519 AAAA\n")
  await fs.mkdir(workspace, { recursive: true })
  git(workspace, "init", "-q")
  git(workspace, "commit", "-q", "--allow-empty", "-m", "init")
  return { home, workspace, kete }
}

async function sandboxed(
  input: { home: string; workspace: string; kete: string; directory?: string; network?: boolean },
  command: string,
  cwd = input.workspace,
) {
  if (!probe.available) throw new Error("no sandbox")
  const kete = input.kete
  const resolved = await KeteSandboxResolve.resolve(
    {
      platform: probe.mechanism === "seatbelt" ? "darwin" : "linux",
      home: input.home,
      workspace: input.workspace,
      directory: input.directory ?? input.workspace,
      kete: {
        config: path.join(kete, "config"),
        data: path.join(kete, "data"),
        cache: path.join(kete, "cache"),
        state: path.join(kete, "state"),
        log: path.join(kete, "log"),
        bin: path.join(kete, "bin"),
        tmp: path.join(kete, "tmp"),
        repos: path.join(kete, "repos"),
      },
      shellOutput: path.join(kete, "data", "shell", "project"),
      settings,
      network: input.network ?? false,
      privateTmp: await privateTmp(),
      env: { TMPDIR: process.env.TMPDIR },
    },
    KeteSandboxResolve.shared,
  )
  try {
    const invocation = {}
    KeteSandboxPlans.attach(invocation, {
      mechanism: probe.mechanism,
      executable: probe.executable,
      policy: resolved.policy,
      cwd,
    })
    const spawn = KeteSandboxPlans.wrap(invocation, "/bin/sh", ["-c", command])
    const result = Bun.spawnSync([spawn.file, ...spawn.args], {
      cwd,
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: input.home },
    })
    return { exit: result.exitCode, out: result.stdout.toString() + result.stderr.toString(), policy: resolved.policy }
  } finally {
    await resolved.release()
  }
}

const exists = (value: string) =>
  fs.lstat(value).then(
    () => true,
    () => false,
  )

describe.skipIf(!probe.available)("sandbox policy, run for real", () => {
  test("workspace writes work; git internals, Kete configuration and the outside don't", async () => {
    const env = await setup("basic")
    const ok = await sandboxed(env, "echo hi > a.txt && mkdir -p d && echo x > d/b.txt && cat a.txt")
    expect(ok.out).toContain("hi")
    expect(ok.exit).toBe(0)

    for (const command of [
      "echo x >> .git/config",
      "echo x > .git/hooks/post-checkout",
      "echo /tmp/evil > .git/commondir",
      "echo x > .git/config.worktree",
      "mkdir -p .git/info && echo '* filter=x' > .git/info/attributes",
      "mv .git .git2",
      "echo {} > kete.jsonc",
      "echo {} > kete.json",
      "mkdir -p .kete/agents && echo x > .kete/agents/a.md",
      "mkdir -p .claude && echo x > .claude/settings.json",
      "mkdir -p .agents/skills",
      // Linux protects Kete configuration only where it is looked up (the workspace and its parents).
      ...(probe.available && probe.mechanism === "seatbelt" ? ["mkdir -p sub/.kete && echo x > sub/.kete/kete.jsonc"] : []),
      `echo x > "${outsideDir}/outside-basic.txt"`,
    ]) {
      const result = await sandboxed(env, command)
      expect(result.exit, command).not.toBe(0)
    }
    expect(await exists(path.join(env.workspace, ".git2"))).toBe(false)
    expect(await exists(path.join(outsideDir, "outside-basic.txt"))).toBe(false)
    // No placeholder (Linux) or stray file is left behind.
    for (const name of ["kete.json", "kete.jsonc", ".kete", ".claude", ".agents"])
      expect(await exists(path.join(env.workspace, name)), name).toBe(false)
    if (probe.available && probe.mechanism === "seatbelt") expect(await exists(path.join(env.workspace, "sub", ".kete", "kete.jsonc"))).toBe(false)

    // `git add -A` must not trip over Linux placeholders (they are masked with /dev/null, which git ignores).
    const commit = await sandboxed(env, "git add -A && git -c user.email=t@example.com -c user.name=t commit -q -m two && git status --porcelain && git log --oneline | wc -l")
    expect(commit.exit, commit.out).toBe(0)
    expect(commit.out.trim(), commit.out).toBe("2")
  })

  test("credentials are hidden, except SSH host keys", async () => {
    const env = await setup("creds")
    const key = await sandboxed(env, `cat "${env.home}/.ssh/id_test"`)
    expect(key.exit).not.toBe(0)
    expect(key.out).not.toContain("PRIVATE")
    const hosts = await sandboxed(env, `cat "${env.home}/.ssh/known_hosts"`)
    expect(hosts.out).toContain("github.com")
  })

  test("Kete Code's own directories: not writable; config and data not readable, except this project's shell output", async () => {
    const env = await setup("kete-dirs")
    await fs.mkdir(path.join(env.kete, "config"), { recursive: true })
    await fs.writeFile(path.join(env.kete, "config", "kete.jsonc"), '{"secret":"CONFIG-SECRET"}')
    await fs.mkdir(path.join(env.kete, "data", "shell", "project"), { recursive: true })
    await fs.writeFile(path.join(env.kete, "data", "shell", "project", "sh_1.out"), "LONG-OUTPUT")
    await fs.writeFile(path.join(env.kete, "data", "auth.json"), "DATA-SECRET")
    const config = await sandboxed(env, `cat "${env.kete}/config/kete.jsonc"`)
    expect(config.out).not.toContain("CONFIG-SECRET")
    const auth = await sandboxed(env, `cat "${env.kete}/data/auth.json"`)
    expect(auth.out).not.toContain("DATA-SECRET")
    const output = await sandboxed(env, `cat "${env.kete}/data/shell/project/sh_1.out"`)
    expect(output.out).toContain("LONG-OUTPUT")
  })

  test("core.hooksPath is protected", async () => {
    const env = await setup("hookspath")
    await fs.mkdir(path.join(env.workspace, ".husky", "_"), { recursive: true })
    git(env.workspace, "config", "core.hooksPath", ".husky/_")
    const result = await sandboxed(env, "echo 'echo pwned' > .husky/_/pre-commit")
    expect(result.exit).not.toBe(0)
    expect(await exists(path.join(env.workspace, ".husky", "_", "pre-commit"))).toBe(false)
    const other = await sandboxed(env, "echo ok > .husky/notes.txt")
    expect(other.exit).toBe(0)
  })

  test("a linked worktree commits into the shared git directory, whose config and hooks stay protected", async () => {
    const env = await setup("main-repo")
    const worktree = path.join(base, "linked-wt")
    git(env.workspace, "worktree", "add", "-q", "-b", "wt", worktree)
    const linked = { ...env, workspace: worktree }
    const commit = await sandboxed(linked, "git -c user.email=t@example.com -c user.name=t commit -q --allow-empty -m wt && echo committed")
    expect(commit.out).toContain("committed")
    const common = path.join(env.workspace, ".git")
    for (const command of [`echo x >> "${common}/config"`, `echo x > "${common}/hooks/pre-commit"`, "echo 'gitdir: /tmp/evil' > .git"]) {
      const result = await sandboxed(linked, command)
      expect(result.exit, command).not.toBe(0)
    }
    expect(await fs.readFile(path.join(worktree, ".git"), "utf8")).toStartWith("gitdir:")
  })

  test("a Kete worktree inside Kete Code's (hidden, read-only) data directory is a normal workspace", async () => {
    const env = await setup("data-main")
    const worktree = path.join(env.kete, "data", "worktree", "abc", "job-1")
    await fs.mkdir(path.dirname(worktree), { recursive: true })
    await fs.writeFile(path.join(env.kete, "data", "auth.json"), "DATA-SECRET")
    git(env.workspace, "worktree", "add", "-q", "-b", "job", worktree)
    const inside = { ...env, workspace: worktree }
    const ok = await sandboxed(
      inside,
      "echo hi > a.txt && cat a.txt && git add -A && git -c user.email=t@example.com -c user.name=t commit -q -m job && echo committed",
    )
    expect(ok.out, ok.out).toContain("committed")
    const secret = await sandboxed(inside, `cat "${env.kete}/data/auth.json"`)
    expect(secret.out).not.toContain("DATA-SECRET")
    const config = await sandboxed(inside, `echo x >> "${env.workspace}/.git/config"`)
    expect(config.exit).not.toBe(0)
    const sibling = await sandboxed(inside, `echo x > "${env.kete}/data/worktree/abc/other.txt"`)
    expect(sibling.exit).not.toBe(0)
  })

  test("git still works with the placeholders, and they are gone afterwards", async () => {
    const env = await setup("git-placeholders")
    const result = await sandboxed(env, "git status --porcelain && git rev-parse --git-common-dir && git worktree list && echo ok")
    expect(result.out, result.out).toContain("ok")
    for (const name of ["commondir", "gitdir", "config.worktree"]) expect(await exists(path.join(env.workspace, ".git", name)), name).toBe(false)
  })

  test("renaming a nested repository's parent doesn't free its git config", async () => {
    const env = await setup("nested")
    const nested = path.join(env.workspace, "sub", "inner")
    await fs.mkdir(nested, { recursive: true })
    git(nested, "init", "-q")
    const moved = await sandboxed(env, "mv sub sub2 && echo moved")
    // macOS: the move works and the config is still protected; Linux protects only the workspace's own .git.
    if (probe.available && probe.mechanism === "seatbelt") {
      expect(moved.out).toContain("moved")
      const config = await sandboxed(env, "echo x >> sub2/inner/.git/config")
      expect(config.exit).not.toBe(0)
      const rename = await sandboxed(env, "mv sub2/inner/.git/worktrees x 2>/dev/null; mkdir -p sub2/inner/.git/worktrees && echo made")
      expect(rename.out).not.toContain("made")
    }
  })

  test("a workspace name can't inject rules into the profile", async () => {
    const name = `inj a") (allow file-write* (subpath "/")) ; [x]*+?{}|^$\\ 'q'`
    const env = await setup(name)
    const ok = await sandboxed(env, "echo hi > inside.txt && cat inside.txt")
    expect(ok.out).toContain("hi")
    const outside = await sandboxed(env, `echo x > "${outsideDir}/escaped.txt"`)
    expect(outside.exit).not.toBe(0)
    expect(await exists(path.join(outsideDir, "escaped.txt"))).toBe(false)
    const config = await sandboxed(env, "echo x >> .git/config")
    expect(config.exit).not.toBe(0)
  })

  test("paths with control characters are refused before anything runs", async () => {
    const env = await setup("ctl")
    const weird = path.join(base, "bad\nname")
    await fs.mkdir(weird, { recursive: true })
    await expect(sandboxed({ ...env, workspace: weird }, "true", env.workspace)).rejects.toThrow(/can't use this path/)
  })
})
