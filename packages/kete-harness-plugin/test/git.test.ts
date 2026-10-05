// The step's commit and push never read the repository config the agent could have changed, and
// push only to the `remote.origin.url` read before the run.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Git } from "../src/git"
import { Secrets } from "../src/secrets"

function sh(cwd: string, args: string[]) {
  const out = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } })
  if (out.status !== 0) throw new Error(`git ${args.join(" ")}: ${out.stderr}`)
  return out.stdout.trim()
}

function repo() {
  const dir = mkdtempSync(path.join(tmpdir(), "kete-harness-git-test-"))
  const home = path.join(dir, "home")
  mkdirSync(home)
  const remote = path.join(dir, "remote.git")
  const elsewhere = path.join(dir, "elsewhere.git")
  const seed = path.join(dir, "seed")
  const workspace = path.join(dir, "workspace")
  mkdirSync(seed)
  sh(dir, ["init", "-q", "--bare", "-b", "main", remote])
  sh(dir, ["init", "-q", "--bare", "-b", "main", elsewhere])
  sh(seed, ["init", "-q", "-b", "main"])
  writeFileSync(path.join(seed, "README.md"), "# shop\n")
  sh(seed, ["add", "."])
  sh(seed, ["-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-q", "-m", "init"])
  sh(seed, ["push", "-q", remote, "main"])
  sh(dir, ["clone", "-q", remote, workspace])
  const ctx: Git.Context = { env: { PATH: process.env.PATH, HOME: home }, redact: Secrets.shapes }
  return { dir, remote, elsewhere, workspace, ctx }
}

describe("git", () => {
  test("the push ignores config the agent changed: no command runs, nothing goes elsewhere", () => {
    const r = repo()
    // Read before the run, as Run does.
    const origin = Git.originURL(r.workspace, r.ctx)
    if (origin.kind !== "ok") throw new Error(origin.message)
    expect(origin.remote).toEqual({ url: r.remote, scheme: "file" })

    // kete job run's worktree, with the agent's change.
    const worktree = path.join(r.dir, "worktree")
    sh(r.workspace, ["worktree", "add", "-q", "-b", "kete/job/abc", worktree])
    writeFileSync(path.join(worktree, "FIXED.md"), "fixed\n")
    writeFileSync(path.join(worktree, ".gitattributes"), "* filter=evil\n")

    // What the agent could have done to the repository's config while it ran.
    const markers = path.join(r.dir, "markers")
    mkdirSync(markers)
    const script = (name: string) => {
      const file = path.join(r.dir, `${name}.sh`)
      writeFileSync(file, `#!/bin/sh\ntouch "${path.join(markers, name)}"\ncat\n`)
      chmodSync(file, 0o755)
      return file
    }
    const hooks = path.join(r.dir, "hooks")
    mkdirSync(hooks)
    for (const hook of ["pre-commit", "post-commit", "pre-push", "reference-transaction"]) {
      writeFileSync(path.join(hooks, hook), `#!/bin/sh\ntouch "${path.join(markers, hook)}"\n`)
      chmodSync(path.join(hooks, hook), 0o755)
    }
    const included = path.join(r.dir, "included.config")
    writeFileSync(included, `[core]\n\tpager = ${script("pager")}\n`)
    const config = (key: string, value: string) => sh(r.workspace, ["config", "--add", key, value])
    config(`url.${r.elsewhere}.insteadOf`, r.remote)
    config(`url.${r.elsewhere}.pushInsteadOf`, r.remote)
    config("remote.origin.pushurl", r.elsewhere)
    config("core.sshCommand", script("ssh"))
    config("credential.helper", `!${script("credential")}`)
    config("core.fsmonitor", script("fsmonitor"))
    config("core.hooksPath", hooks)
    config("filter.evil.clean", script("filter"))
    config("filter.evil.required", "true")
    config("include.path", included)

    const result = Git.publish(
      {
        worktree,
        branch: "kete/fix-1",
        remote: origin.remote,
        message: "kete: fix-build",
        author: { name: "Kete Code", email: "kete-code@users.noreply.invalid" },
        credentials: {},
      },
      r.ctx,
    )
    expect(result.kind).toBe("pushed")
    expect(readdirSync(markers)).toEqual([])
    expect(sh(r.remote, ["show", "kete/fix-1:FIXED.md"])).toBe("fixed")
    expect(sh(r.remote, ["log", "-1", "--format=%an <%ae> %s", "kete/fix-1"])).toBe(
      "Kete Code <kete-code@users.noreply.invalid> kete: fix-build",
    )
    expect(sh(r.elsewhere, ["for-each-ref"])).toBe("")

    // An existing branch is never overwritten.
    const again = Git.publish(
      {
        worktree,
        branch: "kete/fix-1",
        remote: origin.remote,
        message: "again",
        author: { name: "Kete Code", email: "kete-code@users.noreply.invalid" },
        credentials: {},
      },
      r.ctx,
    )
    expect(again.kind).toBe("exists")
    expect(readdirSync(markers)).toEqual([])
  })

  test("no changes means nothing is pushed", () => {
    const r = repo()
    const origin = Git.originURL(r.workspace, r.ctx)
    if (origin.kind !== "ok") throw new Error(origin.message)
    const worktree = path.join(r.dir, "worktree")
    sh(r.workspace, ["worktree", "add", "-q", "-b", "kete/job/def", worktree])
    const result = Git.publish(
      {
        worktree,
        branch: "kete/x",
        remote: origin.remote,
        message: "m",
        author: { name: "a", email: "a@b.c" },
        credentials: {},
      },
      r.ctx,
    )
    expect(result.kind).toBe("no_changes")
    expect(existsSync(path.join(r.remote, "refs/heads/kete/x"))).toBe(false)
  })

  test("only plain push targets are accepted for remote.origin.url", () => {
    expect(Git.validateRemote("https://github.com/acme/shop.git")).toEqual({
      url: "https://github.com/acme/shop.git",
      scheme: "https",
    })
    expect(Git.validateRemote("https://x-access-token@github.com/acme/shop.git")?.scheme).toBe("https")
    expect(Git.validateRemote("ssh://git@github.com/acme/shop.git")?.scheme).toBe("ssh")
    expect(Git.validateRemote("git@github.com:acme/shop.git")?.scheme).toBe("ssh")
    expect(Git.validateRemote("/srv/git/shop.git")?.scheme).toBe("file")
    expect(Git.validateRemote("file:///srv/git/shop.git")?.scheme).toBe("file")
    expect(Git.validateRemote("http://127.0.0.1:3000/acme/shop.git")?.scheme).toBe("http")
    for (const bad of [
      "ext::sh -c touch% /tmp/x",
      "fd::3",
      "-uhttps://github.com/x",
      "https://user:token@github.com/acme/shop.git",
      "http://git.example.com/acme/shop.git",
      "gopher://example.com/x",
      "relative/path",
      "https://github.com/acme/shop.git\nother",
      "",
    ])
      expect({ bad, accepted: Git.validateRemote(bad) }).toEqual({ bad, accepted: undefined })
  })

  test("a workspace with several or no origin URLs is refused, without echoing them", () => {
    const r = repo()
    sh(r.workspace, ["config", "--add", "remote.origin.url", "https://token-in-url@example.com/x.git"])
    const several = Git.originURL(r.workspace, r.ctx)
    expect(several).toEqual({ kind: "invalid", message: expect.stringContaining("several values") })
    sh(r.workspace, ["config", "--unset-all", "remote.origin.url"])
    expect(Git.originURL(r.workspace, r.ctx).kind).toBe("invalid")
  })

  test("protected branches compare case-insensitively", () => {
    const r = repo()
    const names = Git.protectedBranches(r.workspace, {
      ...r.ctx,
      env: { ...r.ctx.env, DRONE_TARGET_BRANCH: "Release/1.x" },
    })
    for (const branch of ["MAIN", "Master", "release/1.X", "main"]) expect(Git.isProtected(names, branch)).toBe(true)
    expect(Git.isProtected(names, "kete/fix")).toBe(false)
  })
})
