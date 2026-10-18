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
    expect(KeteSkillSource.policyResource(source)).toBe("github.com/Acme/Skills")
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
