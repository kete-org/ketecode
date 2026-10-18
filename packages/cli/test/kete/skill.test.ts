// `kete skill add|list|update|remove` (cli/src/kete/skill-flow.ts, AC1-AC11): real flows on temporary
// folders, and a real bare git repository as the source (reached through a git `insteadOf` rule, so
// the https URL under test is the one that is used and no network is touched).
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { chmod, link, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteSkillLock } from "@opencode/util/kete/skill-lock"
import type { SyncedPolicy } from "@opencode/util/kete/sync/contract"
import { JobGit } from "../../src/kete/job-git"
import { KeteSkillFlow } from "../../src/kete/skill-flow"

const URL_PLAIN = "https://example.test/acme/skills"
const URL_SECRET = "https://user:secret@example.test/acme/skills"
const posix = process.platform !== "win32"

let tmp: string
let project: string
let globalDir: string
let src: string
let bare: string
let config: string
let out: string[]
let err: string[]
let asked: string[]
let answer: boolean
let interactive: boolean
let org: Set<string>
let policies: KeteSkillFlow.PolicyInput
let git: typeof JobGit.run | undefined

const gitEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  GIT_CONFIG_GLOBAL: os.devNull,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  ...extra,
})
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env: gitEnv(), stdio: "pipe", encoding: "utf8" }).trim()

async function commit(files: Record<string, string | null>, message = "c") {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(src, name)
    if (content === null) await rm(file, { force: true })
    else {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, content)
    }
  }
  sh(src, "add", "-A")
  sh(src, "commit", "-q", "-m", message)
  sh(src, "push", "-q", bare, "main")
  return sh(src, "rev-parse", "HEAD")
}

const skillMd = (name: string, body = "do things") => `---\nname: ${name}\ndescription: A ${name} skill\n---\n${body}\n`

const deps = (): KeteSkillFlow.Deps => ({
  cwd: project,
  globalDir,
  tmp: path.join(tmp, "work"),
  interactive,
  confirm: async (message) => {
    asked.push(message)
    return answer
  },
  out: (text) => out.push(text),
  err: (text) => err.push(text),
  policies: async () => policies,
  orgSkills: async () => org,
  // The fixtures reach the bare repo through `insteadOf`, a file path: allow that one protocol here only.
  gitEnv: { GIT_CONFIG_GLOBAL: config, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "protocol.file.allow", GIT_CONFIG_VALUE_0: "always" },
  git,
  now: () => new Date("2026-10-17T00:00:00Z"),
})

const yes = { global: false, yes: true }
const text = () => out.join("") + err.join("")
const projectScope = () => path.join(project, ".kete")

beforeEach(async () => {
  tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), "kete-skill-")))
  project = path.join(tmp, "project")
  globalDir = path.join(tmp, "global")
  src = path.join(tmp, "src")
  bare = path.join(tmp, "bare.git")
  config = path.join(tmp, "gitconfig")
  for (const dir of [project, globalDir, src, path.join(tmp, "work")]) await mkdir(dir, { recursive: true })
  sh(src, "init", "-q", "-b", "main")
  sh(tmp, "init", "-q", "--bare", "-b", "main", bare)
  await writeFile(
    config,
    [URL_PLAIN, URL_SECRET].map((url) => `[url "${bare.replaceAll("\\", "/")}"]\n\tinsteadOf = ${url}\n`).join(""),
  )
  out = []
  err = []
  asked = []
  answer = true
  interactive = true
  org = new Set()
  policies = undefined
  git = undefined
})

afterEach(() => rm(tmp, { recursive: true, force: true }))

/** First commit: skills/demo (SKILL.md, a script, a note) and an unrelated folder; then the bare repo. */
async function fixture() {
  await commit({
    "skills/demo/SKILL.md": skillMd("demo"),
    "skills/demo/run.sh": "#!/bin/sh\necho hi\n",
    "skills/demo/notes/a.txt": "a",
    "other/x.txt": "x",
  })
  return sh(src, "rev-parse", "HEAD")
}

async function localSkill(name = "local-skill", files: Record<string, string> = {}) {
  const dir = path.join(tmp, name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, "SKILL.md"), skillMd(name))
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), content)
  }
  return dir
}

const nothingWritten = async () => {
  expect(await readdir(projectScope()).catch(() => [])).toEqual([])
  expect(await readdir(path.join(tmp, "work"))).toEqual([])
}

describe("kete skill add git", () => {
  test("installs a subfolder at a ref and records the commit and hashes", async () => {
    const commitId = await fixture()
    const code = await KeteSkillFlow.add(deps(), { source: URL_PLAIN, path: "skills/demo", ref: "main" }, yes)
    expect(code).toBe(0)
    const folder = path.join(projectScope(), "skills", "demo")
    expect((await readdir(folder)).toSorted()).toEqual(["SKILL.md", "notes", "run.sh"])
    const lock = (await KeteSkillLock.read(projectScope())).skills.demo!
    expect(lock).toMatchObject({ source: URL_PLAIN, path: "skills/demo", ref: "main", commit: commitId, installedAt: "2026-10-17T00:00:00.000Z" })
    expect(Object.keys(lock.files).toSorted()).toEqual(["SKILL.md", "notes/a.txt", "run.sh"])
    expect(lock.files["SKILL.md"]).toBe(new Bun.CryptoHasher("sha256").update(skillMd("demo")).digest("hex"))
    expect(await readdir(path.join(tmp, "work"))).toEqual([])
    expect((await readdir(projectScope())).toSorted()).toEqual(["skills", "skills.lock.json"])
  })

  test("without --ref it installs the default branch", async () => {
    const commitId = await fixture()
    expect(await KeteSkillFlow.add(deps(), { source: URL_PLAIN, path: "skills/demo" }, yes)).toBe(0)
    const entry = (await KeteSkillLock.read(projectScope())).skills.demo!
    expect(entry.commit).toBe(commitId)
    expect(entry.ref).toBeUndefined()
  })
})

describe("kete skill add local", () => {
  test("installs a folder and records its path, with no commit", async () => {
    const dir = await localSkill("mine", { "scripts/go.py": "print(1)" })
    expect(await KeteSkillFlow.add(deps(), { source: dir }, yes)).toBe(0)
    const entry = (await KeteSkillLock.read(projectScope())).skills.mine!
    expect(entry.source).toBe(dir)
    expect(entry.commit).toBeUndefined()
    expect(Object.keys(entry.files).toSorted()).toEqual(["SKILL.md", "scripts/go.py"])
    expect(await readFile(path.join(projectScope(), "skills", "mine", "scripts", "go.py"), "utf8")).toBe("print(1)")
  })

  test("--name overrides the name; a taken name is refused", async () => {
    const dir = await localSkill("mine")
    expect(await KeteSkillFlow.add(deps(), { source: dir, name: "other" }, yes)).toBe(0)
    expect(Object.keys((await KeteSkillLock.read(projectScope())).skills)).toEqual(["other"])
    expect(await KeteSkillFlow.add(deps(), { source: dir, name: "other" }, yes)).toBe(2)
    expect(await KeteSkillFlow.add(deps(), { source: dir, name: "Bad Name" }, yes)).toBe(2)
  })

  test("an untracked folder of the same name is never overwritten", async () => {
    const dir = await localSkill("mine")
    await mkdir(path.join(projectScope(), "skills", "mine"), { recursive: true })
    await writeFile(path.join(projectScope(), "skills", "mine", "SKILL.md"), "mine!")
    expect(await KeteSkillFlow.add(deps(), { source: dir }, yes)).toBe(2)
    expect(await readFile(path.join(projectScope(), "skills", "mine", "SKILL.md"), "utf8")).toBe("mine!")
  })
})

describe("kete skill add review", () => {
  test("lists every file with its size and marks scripts; a no writes nothing", async () => {
    const dir = await localSkill("rv", { "a.txt": "abc", "tool.sh": "echo", "bin/x": "#!/usr/bin/env node\n" })
    answer = false
    expect(await KeteSkillFlow.add(deps(), { source: dir }, { global: false, yes: false })).toBe(2)
    expect(asked).toEqual(["Install skill rv?"])
    const shown = out.join("")
    expect(shown).toContain("a.txt  3 bytes\n")
    expect(shown).toContain("tool.sh  4 bytes  [script]")
    expect(shown).toContain("bin/x")
    expect(shown.split("\n").find((line) => line.includes("bin/x"))).toContain("[script]")
    expect(shown.split("\n").find((line) => line.includes("a.txt"))).not.toContain("[script]")
    await nothingWritten()
  })

  test("a non-interactive shell without --yes installs nothing", async () => {
    const dir = await localSkill("rv")
    interactive = false
    expect(await KeteSkillFlow.add(deps(), { source: dir }, { global: false, yes: false })).toBe(2)
    expect(asked).toEqual([])
    expect(err.join("")).toContain("--yes")
    await nothingWritten()
  })

  test("a yes installs after asking", async () => {
    const dir = await localSkill("rv")
    expect(await KeteSkillFlow.add(deps(), { source: dir }, { global: false, yes: false })).toBe(0)
    expect(asked).toEqual(["Install skill rv?"])
  })
})

describe("kete skill add safety", () => {
  const refused = async (dir: string, input: Partial<Parameters<typeof KeteSkillFlow.add>[1]> = {}) => {
    expect(await KeteSkillFlow.add(deps(), { source: dir, ...input }, yes)).toBe(2)
    await nothingWritten()
  }

  test.skipIf(!posix)("a symlink, even one inside a subfolder, is refused", async () => {
    const dir = await localSkill("sym")
    await writeFile(path.join(tmp, "secret.txt"), "secret")
    await mkdir(path.join(dir, "sub"))
    await symlink(path.join(tmp, "secret.txt"), path.join(dir, "sub", "link.txt"))
    await refused(dir)
    expect(err.join("")).toContain("symlink")
  })

  test("a missing SKILL.md, a front matter that isn't YAML, and a bad one are refused", async () => {
    const none = path.join(tmp, "none")
    await mkdir(none)
    await writeFile(path.join(none, "readme.md"), "x")
    await refused(none)
    const js = await localSkill("js")
    await writeFile(path.join(js, "SKILL.md"), "---js\n{name: 'x'}\n---\nbody")
    await refused(js)
    expect(err.join("")).toContain("must be YAML")
    const bad = await localSkill("bad")
    await writeFile(path.join(bad, "SKILL.md"), "---\nname: [1\n---\n")
    await refused(bad)
  })

  test("a .kete-skill.json (it would pose as an org skill) and a backslash name are refused", async () => {
    const manifest = await localSkill("man", { ".kete-skill.json": "{}" })
    await refused(manifest)
    if (posix) {
      const slash = await localSkill("bs")
      await writeFile(path.join(slash, "a\\..\\b"), "x")
      await refused(slash)
    }
  })

  test("--path that escapes, and --path/--ref that look like options, are refused", async () => {
    await fixture()
    await refused(URL_PLAIN, { path: "../other" })
    await refused(URL_PLAIN, { path: "-x" })
    await refused(URL_PLAIN, { ref: "--upload-pack=touch pwned" })
    await refused(URL_PLAIN, { path: "other" })
    expect(err.join("")).toContain("no SKILL.md")
  })

  test("too many files, and an oversize source, are refused", async () => {
    const many = await localSkill("many")
    for (let index = 0; index < 256; index++) await writeFile(path.join(many, `f${index}.txt`), "x")
    await refused(many)
    expect(err.join("")).toContain("more than 256 files")
    const big = await localSkill("big")
    await writeFile(path.join(big, "blob.bin"), Buffer.alloc(11 * 1024 * 1024))
    await refused(big)
    expect(err.join("")).toContain("larger than")
  })

  test.skipIf(!posix)("installed files have no executable bit", async () => {
    const dir = await localSkill("exec", { "run.sh": "#!/bin/sh\n" })
    await chmod(path.join(dir, "run.sh"), 0o755)
    expect(await KeteSkillFlow.add(deps(), { source: dir }, yes)).toBe(0)
    expect(out.join("")).toContain("[script]")
    for (const file of ["SKILL.md", "run.sh"])
      expect((await stat(path.join(projectScope(), "skills", "exec", file))).mode & 0o111).toBe(0)
  })

  test.skipIf(!posix)("the source repository's hooks do not run during the fetch", async () => {
    const marker = path.join(tmp, "hook-ran")
    const template = path.join(tmp, "template")
    await mkdir(path.join(template, "hooks"), { recursive: true })
    const hook = path.join(template, "hooks", "post-checkout")
    await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`)
    await chmod(hook, 0o755)
    await writeFile(config, (await readFile(config, "utf8")) + `[init]\n\ttemplateDir = ${template}\n`)
    await commit({ "SKILL.md": skillMd("hooked") })
    // Control: a plain clone with this config does run the hook, so the fixture can catch a regression.
    execFileSync("git", ["clone", "-q", URL_PLAIN, path.join(tmp, "control")], { env: gitEnv({ GIT_CONFIG_GLOBAL: config }), stdio: "pipe" })
    expect(await stat(marker).then(() => true, () => false)).toBe(true)
    await rm(marker)
    expect(await KeteSkillFlow.add(deps(), { source: URL_PLAIN }, yes)).toBe(0)
    expect(await stat(marker).then(() => true, () => false)).toBe(false)
  })
})

describe("kete skill add global", () => {
  test("installs into the global config folder with its own lockfile", async () => {
    const dir = await localSkill("glob")
    expect(await KeteSkillFlow.add(deps(), { source: dir }, { global: true, yes: true })).toBe(0)
    expect(await stat(path.join(globalDir, "skills", "glob", "SKILL.md")).then(() => true)).toBe(true)
    expect(Object.keys((await KeteSkillLock.read(globalDir)).skills)).toEqual(["glob"])
    expect(await readdir(projectScope()).catch(() => [])).toEqual([])
  })
})

describe("kete skill list", () => {
  test("shows installed, local and org skills with their labels", async () => {
    const commitId = await fixture()
    await KeteSkillFlow.add(deps(), { source: URL_PLAIN, path: "skills/demo" }, yes)
    await mkdir(path.join(projectScope(), "skills", "mine"), { recursive: true })
    await mkdir(path.join(projectScope(), "skill", "legacy"), { recursive: true })
    org = new Set(["corp"])
    out = []
    expect(await KeteSkillFlow.list(deps(), { global: false })).toBe(0)
    const lines = out.join("").split("\n")
    expect(lines.find((line) => line.startsWith("demo"))).toContain(`${URL_PLAIN} (skills/demo) @ ${commitId.slice(0, 12)}`)
    expect(lines).toContain("mine  local (not tracked)")
    expect(lines).toContain("legacy  local (not tracked)")
    expect(lines).toContain("corp  org (read-only)")
  })

  test("says so when there are none", async () => {
    expect(await KeteSkillFlow.list(deps(), { global: false })).toBe(0)
    expect(out.join("")).toContain("No skills found")
  })
})

describe("kete skill update", () => {
  test("shows added, removed and changed files, then reinstalls and updates the lockfile", async () => {
    await fixture()
    await KeteSkillFlow.add(deps(), { source: URL_PLAIN, path: "skills/demo", ref: "main" }, yes)
    const next = await commit({
      "skills/demo/SKILL.md": skillMd("demo", "new body"),
      "skills/demo/run.sh": null,
      "skills/demo/extra.py": "print(1)",
    })
    out = []
    expect(await KeteSkillFlow.update(deps(), undefined, yes)).toBe(0)
    const shown = out.join("")
    expect(shown).toContain("added:\n    extra.py  8 bytes  [script]")
    expect(shown).toContain("changed:\n    SKILL.md")
    expect(shown).toContain("removed:\n    run.sh")
    const entry = (await KeteSkillLock.read(projectScope())).skills.demo!
    expect(entry.commit).toBe(next)
    expect(Object.keys(entry.files).toSorted()).toEqual(["SKILL.md", "extra.py", "notes/a.txt"])
    expect(await readFile(path.join(projectScope(), "skills", "demo", "SKILL.md"), "utf8")).toContain("new body")
    expect(await stat(path.join(projectScope(), "skills", "demo", "run.sh")).then(() => true, () => false)).toBe(false)
    out = []
    await KeteSkillFlow.update(deps(), "demo", yes)
    expect(out.join("")).toContain("up to date")
    expect(await readdir(path.join(tmp, "work"))).toEqual([])
  })

  test("a skill pinned to a commit says it is pinned", async () => {
    const first = await fixture()
    await KeteSkillFlow.add(deps(), { source: URL_PLAIN, path: "skills/demo", ref: first }, yes)
    await commit({ "skills/demo/new.txt": "n" })
    out = []
    expect(await KeteSkillFlow.update(deps(), undefined, yes)).toBe(0)
    expect(out.join("")).toContain("pinned")
    expect(Object.keys((await KeteSkillLock.read(projectScope())).skills.demo!.files)).not.toContain("new.txt")
  })

  test("a file edited locally is reported and needs a confirmation even with --yes", async () => {
    await fixture()
    await KeteSkillFlow.add(deps(), { source: URL_PLAIN, path: "skills/demo" }, yes)
    await commit({ "skills/demo/SKILL.md": skillMd("demo", "v2") })
    const installed = path.join(projectScope(), "skills", "demo", "SKILL.md")
    await writeFile(installed, "my edit")
    interactive = false
    expect(await KeteSkillFlow.update(deps(), "demo", yes)).toBe(2)
    expect(out.join("")).toContain("Edited since install")
    expect(await readFile(installed, "utf8")).toBe("my edit")
    interactive = true
    answer = false
    expect(await KeteSkillFlow.update(deps(), "demo", yes)).toBe(2)
    expect(await readFile(installed, "utf8")).toBe("my edit")
    answer = true
    expect(await KeteSkillFlow.update(deps(), "demo", yes)).toBe(0)
    expect(await readFile(installed, "utf8")).toContain("v2")
  })

  test("a local source is compared by its files; an unknown or org name is refused", async () => {
    const dir = await localSkill("lcl")
    await KeteSkillFlow.add(deps(), { source: dir }, yes)
    out = []
    await KeteSkillFlow.update(deps(), undefined, yes)
    expect(out.join("")).toContain("up to date")
    await writeFile(path.join(dir, "more.md"), "m")
    await KeteSkillFlow.update(deps(), "lcl", yes)
    expect(await stat(path.join(projectScope(), "skills", "lcl", "more.md")).then(() => true)).toBe(true)
    expect(await KeteSkillFlow.update(deps(), "nope", yes)).toBe(2)
    org = new Set(["corp"])
    expect(await KeteSkillFlow.update(deps(), "corp", yes)).toBe(2)
    expect(err.join("")).toContain("managed by your organization")
  })
})

describe("kete skill remove", () => {
  test("removes a tracked skill and its lockfile entry, and refuses untracked and org skills", async () => {
    const dir = await localSkill("gone")
    await KeteSkillFlow.add(deps(), { source: dir }, yes)
    await mkdir(path.join(projectScope(), "skills", "mine"), { recursive: true })
    org = new Set(["corp"])
    expect(await KeteSkillFlow.remove(deps(), "mine", yes)).toBe(2)
    expect(await KeteSkillFlow.remove(deps(), "corp", yes)).toBe(2)
    expect(await KeteSkillFlow.remove(deps(), "../x", yes)).toBe(2)
    expect(await stat(path.join(projectScope(), "skills", "mine")).then(() => true)).toBe(true)
    answer = false
    expect(await KeteSkillFlow.remove(deps(), "gone", { global: false, yes: false })).toBe(2)
    expect(await stat(path.join(projectScope(), "skills", "gone")).then(() => true)).toBe(true)
    expect(await KeteSkillFlow.remove(deps(), "gone", yes)).toBe(0)
    expect(await stat(path.join(projectScope(), "skills", "gone")).then(() => true, () => false)).toBe(false)
    expect((await KeteSkillLock.read(projectScope())).skills).toEqual({})
  })
})

describe("kete skill org protection", () => {
  test("add refuses a name an org-synced skill uses and changes nothing", async () => {
    const dir = await localSkill("corp")
    org = new Set(["corp"])
    expect(await KeteSkillFlow.add(deps(), { source: dir }, yes)).toBe(2)
    expect(err.join("")).toContain("your organization manages")
    await nothingWritten()
  })
})

describe("kete skill policy", () => {
  const policy = (effect: "allow" | "ask" | "deny", resource = "example.test/acme/*"): SyncedPolicy => ({
    id: "00000000-0000-4000-8000-000000000001",
    name: "Skill sources",
    description: "",
    category: "skills",
    enforcement: "enforced",
    environment_kinds: [],
    agents: null,
    rules: [{ action: "skill.install", resource, effect, description: "" }],
    updated_at: "2026-10-01T00:00:00Z",
  })

  test("deny blocks the source before anything is fetched", async () => {
    await fixture()
    policies = [policy("deny")]
    let called = 0
    git = (...args) => {
      called++
      return JobGit.run(...args)
    }
    expect(await KeteSkillFlow.add(deps(), { source: URL_PLAIN, path: "skills/demo" }, yes)).toBe(2)
    expect(called).toBe(0)
    expect(err.join("")).toContain("Skill sources")
    await nothingWritten()
  })

  test("ask forces the question even with --yes, and a non-interactive shell cannot install", async () => {
    await fixture()
    policies = [policy("ask")]
    interactive = false
    expect(await KeteSkillFlow.add(deps(), { source: URL_PLAIN, path: "skills/demo" }, yes)).toBe(2)
    await nothingWritten()
    interactive = true
    answer = false
    expect(await KeteSkillFlow.add(deps(), { source: URL_PLAIN, path: "skills/demo" }, yes)).toBe(2)
    expect(asked).toHaveLength(1)
    answer = true
    expect(await KeteSkillFlow.add(deps(), { source: URL_PLAIN, path: "skills/demo" }, yes)).toBe(0)
  })

  test("a rule for another source does not block", async () => {
    await fixture()
    policies = [policy("deny", "github.com/*")]
    expect(await KeteSkillFlow.add(deps(), { source: URL_PLAIN, path: "skills/demo" }, yes)).toBe(0)
  })

  test.skipIf(!posix)("a local folder rule keeps the file system's case", async () => {
    const dir = await localSkill("cased")
    policies = [policy("deny", dir.toUpperCase())]
    expect(await KeteSkillFlow.add(deps(), { source: dir }, yes)).toBe(0)
  })

  test("a deny can't be dodged by changing the case of the owner", async () => {
    await fixture()
    policies = [policy("deny", "example.test/acme/*")]
    expect(await KeteSkillFlow.add(deps(), { source: "https://example.test/ACME/skills", path: "skills/demo" }, yes)).toBe(2)
    await nothingWritten()
  })

  test("a policy that is not synced yet asks; one that cannot be read refuses", async () => {
    const dir = await localSkill("pol")
    policies = "no-cache"
    interactive = false
    expect(await KeteSkillFlow.add(deps(), { source: dir }, yes)).toBe(2)
    expect(out.join("")).toContain("kete sync")
    const broken = { ...deps(), policies: async () => Promise.reject(new Error("corrupt cache")) }
    expect(await KeteSkillFlow.add(broken, { source: dir }, yes)).toBe(2)
    expect(err.join("")).toContain("corrupt cache")
    await nothingWritten()
  })

  test("a local source is matched by its folder path", async () => {
    const dir = await localSkill("pol")
    policies = [policy("deny", dir.replaceAll("\\", "/"))]
    expect(await KeteSkillFlow.add(deps(), { source: dir }, yes)).toBe(2)
  })
})

describe("kete skill errors", () => {
  test("an unreachable repository fails with a message, a non-zero exit and no temp folder", async () => {
    const code = await KeteSkillFlow.add({ ...deps(), gitEnv: { GIT_CONFIG_GLOBAL: os.devNull } }, { source: "https://127.0.0.1:1/acme/skills" }, yes)
    expect(code).toBe(1)
    expect(err.join("")).toContain("git fetch failed")
    await nothingWritten()
  })

  test("a timeout is reported as one", async () => {
    git = async (cwd, args, options) =>
      args.includes("fetch") ? { exitCode: -1, stdout: "", stderr: "", timedOut: true } : JobGit.run(cwd, args, options)
    expect(await KeteSkillFlow.add(deps(), { source: URL_PLAIN }, yes)).toBe(1)
    expect(err.join("")).toContain("timed out")
    await nothingWritten()
  })

  test("credentials in a URL never appear in output, errors or the lockfile", async () => {
    const commitId = await fixture()
    expect(await KeteSkillFlow.add(deps(), { source: URL_SECRET, path: "skills/demo" }, yes)).toBe(0)
    expect(text()).not.toContain("secret")
    expect(await readFile(KeteSkillLock.file(projectScope()), "utf8")).not.toContain("secret")
    expect((await KeteSkillLock.read(projectScope())).skills.demo!.commit).toBe(commitId)
    out = []
    err = []
    expect(await KeteSkillFlow.add({ ...deps(), gitEnv: { GIT_CONFIG_GLOBAL: os.devNull } }, { source: "https://user:secret@127.0.0.1:1/a/b" }, yes)).toBe(1)
    expect(text()).not.toContain("secret")
  })

  test("an unreadable lockfile is refused and left alone", async () => {
    const dir = await localSkill("lk")
    await mkdir(projectScope(), { recursive: true })
    await writeFile(KeteSkillLock.file(projectScope()), JSON.stringify({ version: 9, skills: {} }))
    expect(await KeteSkillFlow.add(deps(), { source: dir }, yes)).toBe(2)
    expect(await readFile(KeteSkillLock.file(projectScope()), "utf8")).toBe(JSON.stringify({ version: 9, skills: {} }))
    expect(await stat(path.join(projectScope(), "skills", "lk")).then(() => true, () => false)).toBe(false)
  })
})

describe("kete skill security review", () => {
  const lockfile = (skills: Record<string, unknown>) =>
    mkdir(projectScope(), { recursive: true }).then(() =>
      writeFile(KeteSkillLock.file(projectScope()), JSON.stringify({ version: 1, skills })),
    )

  test.skipIf(!posix)("a symlinked .kete/skills is refused by add, update and remove; nothing outside is touched", async () => {
    const outside = path.join(tmp, "victim")
    await mkdir(path.join(outside, "gh"), { recursive: true })
    await writeFile(path.join(outside, "gh", "hosts.yml"), "keep me")
    await mkdir(projectScope(), { recursive: true })
    await symlink(path.relative(projectScope(), outside), path.join(projectScope(), "skills"))
    await lockfile({ gh: { source: await localSkill("gh"), files: {}, installedAt: "x" } })
    expect(await KeteSkillFlow.remove(deps(), "gh", yes)).toBe(2)
    expect(await KeteSkillFlow.update(deps(), "gh", yes)).toBe(2)
    expect(await KeteSkillFlow.add(deps(), { source: await localSkill("fresh") }, yes)).toBe(2)
    expect(await readFile(path.join(outside, "gh", "hosts.yml"), "utf8")).toBe("keep me")
    expect(await readdir(outside)).toEqual(["gh"])
    expect(text()).toContain("symlink")
  })

  test.skipIf(!posix)("a symlinked .kete or lockfile is refused", async () => {
    const elsewhere = path.join(tmp, "elsewhere")
    await mkdir(elsewhere)
    await symlink(elsewhere, projectScope())
    expect(await KeteSkillFlow.add(deps(), { source: await localSkill() }, yes)).toBe(2)
    await rm(projectScope())
    await mkdir(projectScope())
    await writeFile(path.join(elsewhere, "lock.json"), JSON.stringify({ version: 1, skills: {} }))
    await symlink(path.join(elsewhere, "lock.json"), KeteSkillLock.file(projectScope()))
    expect(await KeteSkillFlow.list(deps(), { global: false })).toBe(2)
    expect(await readdir(elsewhere)).toEqual(["lock.json"])
  })

  test("a URL that git and the URL parser read differently is refused", async () => {
    for (const source of ["https://example.test\\@evil.example/skill", "https://example.test/a%2F..%2Fb", "https://example.test/a?x", "git@host:acme/../evil"]) {
      expect(await KeteSkillFlow.add(deps(), { source }, yes)).toBe(2)
    }
    await nothingWritten()
  })

  test("a lockfile source that isn't an https, ssh or scp git URL is refused before git runs", async () => {
    let called = 0
    git = (...args) => {
      called++
      return JobGit.run(...args)
    }
    const commitId = "a".repeat(40)
    for (const source of ["ext::sh -c touch% /tmp/pwned", "foo::bar", "file:///etc"]) {
      await lockfile({ bad: { source, commit: commitId, files: {}, installedAt: "x" } })
      expect(await KeteSkillFlow.update(deps(), "bad", yes)).toBe(2)
    }
    expect(called).toBe(0)
  })

  test("a lockfile file path outside the skill, or a commit that isn't an id, is refused", async () => {
    await mkdir(path.join(projectScope(), "skills", "bad"), { recursive: true })
    await lockfile({ bad: { source: URL_PLAIN, commit: "a".repeat(40), files: { "../../../../etc/hosts": "x" }, installedAt: "x" } })
    expect(await KeteSkillFlow.update(deps(), "bad", yes)).toBe(2)
    await lockfile({ bad: { source: URL_PLAIN, commit: "\u001b[2J", files: {}, installedAt: "x" } })
    expect(await KeteSkillFlow.update(deps(), "bad", yes)).toBe(2)
    expect(await KeteSkillFlow.list(deps(), { global: false })).toBe(0)
    expect(text()).not.toContain("\u001b[2J")
  })

  test("a local source outside the project in a project lockfile always asks, even with --yes", async () => {
    const dir = await localSkill("away")
    expect(await KeteSkillFlow.add(deps(), { source: dir }, yes)).toBe(0)
    await writeFile(path.join(dir, "extra.md"), "new")
    interactive = false
    expect(await KeteSkillFlow.update(deps(), "away", yes)).toBe(2)
    interactive = true
    expect(await KeteSkillFlow.update(deps(), "away", yes)).toBe(0)
    expect(asked).toEqual(["Update skill away?"])
  })

  test.skipIf(!posix)("a hard link in a local source is refused", async () => {
    const dir = await localSkill("linked")
    await writeFile(path.join(tmp, "secret"), "secret")
    await link(path.join(tmp, "secret"), path.join(dir, "copy.txt"))
    expect(await KeteSkillFlow.add(deps(), { source: dir }, yes)).toBe(2)
    expect(text()).toContain("hard link")
    await nothingWritten()
  })
})
