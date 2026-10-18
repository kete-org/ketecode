import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteSkillSource } from "@opencode/util/kete/skill-source"

describe("KeteSkillSource", () => {
  test("parse: git URL forms, owner/repo, local folder, junk", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "kete-skill-src-"))
    try {
      expect(await KeteSkillSource.parse("https://example.com/a/b.git", dir)).toEqual({ kind: "git", url: "https://example.com/a/b.git" })
      expect(await KeteSkillSource.parse("git@example.com:a/b.git", dir)).toEqual({ kind: "git", url: "git@example.com:a/b.git" })
      expect(await KeteSkillSource.parse("acme/skills", dir)).toEqual({ kind: "git", url: "https://github.com/acme/skills" })
      expect(await KeteSkillSource.parse(".", dir)).toEqual({ kind: "local", path: path.resolve(dir) })
      await expect(KeteSkillSource.parse("--upload-pack=x", dir)).rejects.toThrow()
      await expect(KeteSkillSource.parse("./missing", dir)).rejects.toThrow()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  test("display and policyResource drop credentials", () => {
    const source = { kind: "git", url: "https://user:secret@GitHub.com/Acme/Skills.git/" } as const
    expect(KeteSkillSource.display(source)).not.toContain("secret")
    expect(KeteSkillSource.policyResource(source)).toBe("github.com/acme/skills")
    expect(KeteSkillSource.policyResource({ kind: "git", url: "git@GitHub.com:acme/skills.git" })).toBe("github.com/acme/skills")
    expect(KeteSkillSource.policyResource({ kind: "local", path: "/x/y" })).toBe("/x/y")
  })

  test("pinned: only a full commit id", () => {
    expect(KeteSkillSource.pinned("a".repeat(40))).toBe(true)
    expect(KeteSkillSource.pinned("main")).toBe(false)
    expect(KeteSkillSource.pinned("abc1234")).toBe(false)
    expect(KeteSkillSource.pinned(undefined)).toBe(false)
  })

  test("frontmatter: YAML only, string fields", () => {
    expect(KeteSkillSource.frontmatter("---\nname: a\ndescription: b\n---\nbody")).toEqual({ name: "a", description: "b" })
    expect(KeteSkillSource.frontmatter("# no front matter")).toEqual({})
    expect(KeteSkillSource.frontmatter("---\n---\nbody")).toEqual({})
    expect(() => KeteSkillSource.frontmatter("---js\n{name: process.exit()}\n---\nbody")).toThrow("must be YAML")
    expect(() => KeteSkillSource.frontmatter("---\nname: 3\n---\n")).toThrow("string")
    expect(() => KeteSkillSource.frontmatter("---\nname: a\n")).toThrow("not closed")
    expect(() => KeteSkillSource.frontmatter("---\n- a\n---\n")).toThrow("mapping")
  })
})

describe("review fixes", () => {
  test("gitUrl refuses parser-confusing characters, dot segments and other transports", () => {
    for (const bad of ["https://github.com\\@evil.example/x", "https://h/a%2e%2e/b", "https://h/a#b", "https://h/a b", "git@h:a/../b", "ext::sh", "file:///x", "foo::bar"])
      expect(() => KeteSkillSource.gitUrl(bad)).toThrow(KeteSkillSource.SourceError)
    expect(KeteSkillSource.gitUrl("https://GitHub.com/acme/skills")).toBe("https://github.com/acme/skills")
    expect(KeteSkillSource.gitUrl("git@github.com:acme/skills.git")).toBe("git@github.com:acme/skills.git")
  })
  test("the policy resource ignores case and folds www. aliases", () => {
    const resource = (url: string) => KeteSkillSource.policyResource({ kind: "git", url })
    expect(resource("https://www.github.com/Evil/Repo.git")).toBe("github.com/evil/repo")
    expect(resource("git@GitHub.com:Evil/Repo")).toBe("github.com/evil/repo")
    expect(resource("git@github.com.:evil/x")).toBe("github.com/evil/x")
    expect(resource("ssh://git@ssh.github.com:443/evil/x")).toBe("github.com/evil/x")
  })
  test("names Windows can't hold are refused", () => {
    for (const name of ["con", "nul.md", "com1", "lpt9.x", "foo."]) expect(KeteSkillSource.validName(name)).toBe(false)
    expect(KeteSkillSource.validName("console")).toBe(true)
  })
})
