// End-to-end tests for the upstream sync and checks, using throwaway git repositories:
// an "upstream" repo with release tags, and a "kete" clone with Kete commits on main.
import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { runChecks } from "../src/check"
import { git, SyncError } from "../src/lib"
import { abort, readState, resolveVersionHunks, sync, type SyncOptions } from "../src/sync"

const roots: string[] = []

beforeAll(() => {
  // Isolate from the developer's git config (signing, hooks, default branch).
  const config = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kete-sync-gitconfig-")), "config")
  fs.writeFileSync(config, "[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n")
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  })
})

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function write(dir: string, files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true })
    fs.writeFileSync(path.join(dir, file), text)
  }
}

function commit(dir: string, message: string, files: Record<string, string>) {
  write(dir, files)
  git(dir, "add", "-A")
  git(dir, "commit", "-q", "-m", message)
}

const config = (value: string) => `export const configDir = "${value}"\nexport const retries = 3\n`

/**
 * upstream: v1.0.0 → v1.1.0 (upstreamChange applied in v1.1.0)
 * kete:     clone of v1.0.0 on main, plus a marked Kete edit, NOTICE and .opencode-version.
 */
function fixture(
  upstreamChange: Record<string, string> = { "packages/core/src/other.ts": "export const other = 2\n" },
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kete-sync-"))
  roots.push(root)
  const upstream = path.join(root, "upstream")
  const kete = path.join(root, "kete")
  fs.mkdirSync(upstream)
  git(upstream, "init", "-q")
  commit(upstream, "v1.0.0", {
    LICENSE: "MIT License\nCopyright (c) opencode\n",
    "packages/core/src/config.ts": config(".opencode"),
    "packages/core/src/other.ts": "export const other = 1\n",
  })
  git(upstream, "tag", "v1.0.0")
  commit(upstream, "v1.1.0", upstreamChange)
  git(upstream, "tag", "v1.1.0")

  git(root, "clone", "-q", "--no-tags", upstream, kete)
  git(kete, "remote", "rename", "origin", "upstream")
  git(kete, "remote", "set-url", "--push", "upstream", "no_push")
  git(kete, "fetch", "-q", "upstream", "refs/tags/v1.0.0:refs/tags/v1.0.0")
  git(kete, "reset", "-q", "--hard", "v1.0.0")
  commit(kete, "kete", {
    "packages/core/src/config.ts":
      "export const configDir = Brand.projectDirectory // kete_change\nexport const retries = 3\n",
    NOTICE: "Derived from OpenCode (MIT)\n",
    ".opencode-version": "v1.0.0\n",
  })
  return { upstream, kete }
}

const quiet: Pick<SyncOptions, "log"> = { log: () => {} }

describe("sync", () => {
  test("merges a release, pins it, and passes the checks", () => {
    const { kete } = fixture()
    const outcome = sync({ cwd: kete, version: "v1.1.0", ...quiet })
    expect(outcome.type).toBe("done")
    if (outcome.type !== "done") return
    expect(git(kete, "branch", "--show-current")).toBe("upstream/v1.1.0")
    expect(fs.readFileSync(path.join(kete, ".opencode-version"), "utf8").trim()).toBe("v1.1.0")
    expect(fs.readFileSync(path.join(kete, "packages/core/src/other.ts"), "utf8")).toContain("other = 2")
    expect(outcome.checks.failures).toEqual([])
    expect(outcome.report).toContain("OpenCode v1.0.0 → v1.1.0")
    expect(readState(kete)).toBeUndefined()
    // main is untouched
    expect(git(kete, "show", "main:.opencode-version").trim()).toBe("v1.0.0")
  })

  test("stops on conflicts, classifies files with Kete edits, and resumes", () => {
    const { kete } = fixture({ "packages/core/src/config.ts": config(".opencode-v2") })
    const outcome = sync({ cwd: kete, version: "v1.1.0", ...quiet })
    expect(outcome.type).toBe("conflicts")
    if (outcome.type !== "conflicts") return
    expect(outcome.conflicts).toEqual({ kete: ["packages/core/src/config.ts"], other: [], autoResolved: [] })
    expect(readState(kete)?.version).toBe("v1.1.0")

    // --continue refuses while conflicts remain
    expect(() => sync({ cwd: kete, resume: true, ...quiet })).toThrow(SyncError)

    // Resolve: keep the Kete edit, then continue.
    write(kete, {
      "packages/core/src/config.ts":
        "export const configDir = Brand.projectDirectory // kete_change\nexport const retries = 3\n",
    })
    git(kete, "add", "packages/core/src/config.ts")
    const resumed = sync({ cwd: kete, resume: true, ...quiet })
    expect(resumed.type).toBe("done")
    if (resumed.type === "done") expect(resumed.checks.failures).toEqual([])
    expect(git(kete, "log", "-1", "--format=%s")).toBe("chore(upstream): pin OpenCode v1.1.0")
  })

  test("refuses when pushing to upstream is enabled", () => {
    const { kete, upstream } = fixture()
    git(kete, "remote", "set-url", "--push", "upstream", upstream)
    expect(() => sync({ cwd: kete, version: "v1.1.0", ...quiet })).toThrow(/pushing to "upstream" is enabled/)
  })

  test("refuses a release that is not newer than the pin", () => {
    const { kete } = fixture()
    expect(() => sync({ cwd: kete, version: "v1.0.0", ...quiet })).toThrow(/not newer/)
    expect(() => sync({ cwd: kete, version: "1.1.0", ...quiet })).toThrow(/release tag/)
  })

  test("refuses to start with uncommitted changes", () => {
    const { kete } = fixture()
    write(kete, { "packages/core/src/other.ts": "dirty\n" })
    expect(() => sync({ cwd: kete, version: "v1.1.0", ...quiet })).toThrow(/uncommitted/)
  })

  test("lists workflows that upstream added, which start enabled", () => {
    const { kete } = fixture({ ".github/workflows/new-bot.yml": "on: push\n" })
    const outcome = sync({ cwd: kete, version: "v1.1.0", ...quiet })
    expect(outcome.type === "done" && outcome.report).toContain("gh workflow disable new-bot.yml")
  })

  test("abort returns to the base branch and removes the sync branch", () => {
    const { kete } = fixture({ "packages/core/src/config.ts": config(".opencode-v2") })
    expect(sync({ cwd: kete, version: "v1.1.0", ...quiet }).type).toBe("conflicts")
    abort(kete)
    expect(git(kete, "branch", "--show-current")).toBe("main")
    expect(git(kete, "branch", "--list", "upstream/v1.1.0")).toBe("")
    expect(readState(kete)).toBeUndefined()
  })
})

describe("checks", () => {
  test("flag an unmarked edit to an upstream file", () => {
    const { kete } = fixture()
    commit(kete, "unmarked", { "packages/core/src/other.ts": "export const other = 42\n" })
    const result = runChecks({ cwd: kete, base: "HEAD" })
    expect(result.failures).toEqual(["markers: unmarked edit in packages/core/src/other.ts: export const other = 42"])
  })

  test("flag an unmarked edit that is not committed yet", () => {
    const { kete } = fixture()
    fs.writeFileSync(path.join(kete, "packages/core/src/other.ts"), "export const other = 42\n")
    const result = runChecks({ cwd: kete, base: "HEAD" })
    expect(result.failures).toEqual(["markers: unmarked edit in packages/core/src/other.ts: export const other = 42"])
  })

  test("flag an edited LICENSE and a missing NOTICE", () => {
    const { kete } = fixture()
    fs.rmSync(path.join(kete, "NOTICE"))
    commit(kete, "license", { LICENSE: "changed\n" })
    const failures = runChecks({ cwd: kete, base: "HEAD" }).failures
    expect(failures.some((f) => f.startsWith("license: LICENSE differs"))).toBe(true)
    expect(failures.some((f) => f.startsWith("license: NOTICE"))).toBe(true)
  })

  test("flag new OpenCode literals brought in by a sync, unless allowlisted", () => {
    const { kete } = fixture({ "packages/core/src/banner.ts": 'export const banner = "Welcome to OpenCode"\n' })
    const outcome = sync({ cwd: kete, version: "v1.1.0", ...quiet })
    expect(outcome.type === "done" && outcome.checks.failures).toEqual([
      expect.stringContaining("leaks: packages/core/src/banner.ts"),
    ])
    commit(kete, "allow", { "packages/kete-tools/leak-allowlist.txt": "packages/core/src/banner.ts:display-name\n" })
    expect(runChecks({ cwd: kete, base: "main" }).failures).toEqual([])
  })

  test("flag a pin that HEAD does not contain", () => {
    const { kete } = fixture()
    commit(kete, "bad pin", { ".opencode-version": "v1.1.0\n" })
    git(kete, "fetch", "-q", "upstream", "refs/tags/v1.1.0:refs/tags/v1.1.0")
    expect(runChecks({ cwd: kete, base: "HEAD" }).failures).toContain(
      "pin: HEAD does not contain upstream v1.1.0; .opencode-version and the merged release disagree",
    )
  })
})

describe("upstream release tags off the main line", () => {
  // Mirrors upstream: each release is a version-bump commit on top of the main line,
  // and is not an ancestor of the next release.
  function offLineFixture() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "kete-sync-"))
    roots.push(root)
    const upstream = path.join(root, "upstream")
    const kete = path.join(root, "kete")
    fs.mkdirSync(upstream)
    git(upstream, "init", "-q")
    // Like the real packages/cli/package.json, Kete's "bin" edit sits well away from "version".
    const pkg = (version: string, extra = "") =>
      `{\n  "version": "${version}",\n  "name": "@opencode/cli",\n  "type": "module",\n  "license": "MIT",\n  "private": false${extra}\n}\n`
    commit(upstream, "base", {
      LICENSE: "MIT\n",
      "packages/cli/package.json": pkg("0.0.0"),
      "bun.lock": "lock 0\n",
      "src/a.ts": "a = 1\n",
    })
    git(upstream, "switch", "-q", "-c", "release-1")
    commit(upstream, "release: v1.0.0", { "packages/cli/package.json": pkg("1.0.0"), "bun.lock": "lock 1.0.0\n" })
    git(upstream, "tag", "v1.0.0")
    git(upstream, "switch", "-q", "main")
    commit(upstream, "feature", { "src/a.ts": "a = 2\n" })
    git(upstream, "switch", "-q", "-c", "release-2")
    commit(upstream, "release: v1.1.0", { "packages/cli/package.json": pkg("1.1.0"), "bun.lock": "lock 1.1.0\n" })
    git(upstream, "tag", "v1.1.0")
    git(upstream, "switch", "-q", "main")

    git(root, "clone", "-q", "--no-tags", upstream, kete)
    git(kete, "remote", "rename", "origin", "upstream")
    git(kete, "remote", "set-url", "--push", "upstream", "no_push")
    git(kete, "fetch", "-q", "upstream", "refs/tags/v1.0.0:refs/tags/v1.0.0")
    git(kete, "reset", "-q", "--hard", "v1.0.0")
    commit(kete, "kete", {
      "packages/cli/package.json": pkg("1.0.0", ',\n  "bin": { "kete": "./bin/kete" }'),
      "bun.lock": "lock 1.0.0 + kete\n",
      NOTICE: "Derived from OpenCode (MIT)\n",
      ".opencode-version": "v1.0.0\n",
    })
    return { kete, pkg }
  }

  test("version-only conflicts and bun.lock resolve automatically, keeping Kete's edits", () => {
    const { kete } = offLineFixture()
    const installs: string[] = []
    const outcome = sync({
      cwd: kete,
      version: "v1.1.0",
      ...quiet,
      install: (dir) => {
        installs.push(dir)
        fs.writeFileSync(path.join(dir, "bun.lock"), "lock 1.1.0 + kete\n")
        return { code: 0, stderr: "" }
      },
    })
    expect(outcome.type).toBe("done")
    if (outcome.type !== "done") return
    const pkg = JSON.parse(fs.readFileSync(path.join(kete, "packages/cli/package.json"), "utf8"))
    expect(pkg).toEqual({
      version: "1.1.0",
      name: "@opencode/cli",
      type: "module",
      license: "MIT",
      private: false,
      bin: { kete: "./bin/kete" },
    })
    expect(fs.readFileSync(path.join(kete, "src/a.ts"), "utf8")).toBe("a = 2\n")
    expect(installs).toEqual([kete])
    expect(git(kete, "show", "HEAD~1:bun.lock")).toBe("lock 1.1.0 + kete")
    expect(outcome.state.autoResolved).toEqual(["bun.lock", "packages/cli/package.json"])
    expect(outcome.report).toContain("`bun.lock`: upstream's copy, regenerated")
  })

  test("a Kete edit next to the version line is left for a human", () => {
    const { kete, pkg } = offLineFixture()
    commit(kete, "adjacent", {
      "packages/cli/package.json": pkg("1.0.0", ',\n  "bin": { "kete": "./bin/kete" }').replace(
        '"name": "@opencode/cli"',
        '"name": "@ketecode/cli"',
      ),
    })
    const outcome = sync({ cwd: kete, version: "v1.1.0", ...quiet, install: () => ({ code: 0, stderr: "" }) })
    expect(outcome.type === "conflicts" && outcome.conflicts).toEqual({
      kete: ["packages/cli/package.json"],
      other: [],
      autoResolved: ["bun.lock"],
    })
  })

  test("a failed lockfile regeneration stops the sync without committing", () => {
    const { kete } = offLineFixture()
    expect(() =>
      sync({ cwd: kete, version: "v1.1.0", ...quiet, install: () => ({ code: 1, stderr: "network down" }) }),
    ).toThrow(/bun install failed: network down/)
    expect(gitMergeInProgress(kete)).toBe(true)
  })
})

function gitMergeInProgress(dir: string) {
  return fs.existsSync(path.join(git(dir, "rev-parse", "--absolute-git-dir"), "MERGE_HEAD"))
}

describe("resolveVersionHunks", () => {
  const conflict = (ours: string, theirs: string, base?: string) =>
    [
      "{",
      "<<<<<<< HEAD",
      ours,
      ...(base ? ["||||||| base", base] : []),
      "=======",
      theirs,
      ">>>>>>> v1.1.0",
      '  "name": "x"',
      "}",
    ].join("\n")

  test("takes upstream's side of a version-only hunk (merge and diff3 styles)", () => {
    const expected = ["{", '  "version": "1.1.0",', '  "name": "x"', "}"].join("\n")
    expect(resolveVersionHunks(conflict('  "version": "1.0.0",', '  "version": "1.1.0",'))).toEqual({
      text: expected,
      remaining: 0,
      resolved: 1,
    })
    expect(
      resolveVersionHunks(conflict('  "version": "1.0.0",', '  "version": "1.1.0",', '  "version": "0.9.0",')).text,
    ).toBe(expected)
  })

  test("leaves any other hunk for a human", () => {
    const text = conflict('  "version": "1.0.0",\n  "bin": "a"', '  "version": "1.1.0",')
    expect(resolveVersionHunks(text)).toEqual({ text, remaining: 1, resolved: 0 })
  })
})
