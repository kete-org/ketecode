import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteSkillLock } from "@opencode/util/kete/skill-lock"

let scope: string
beforeEach(async () => {
  scope = await mkdtemp(path.join(os.tmpdir(), "kete-skill-lock-"))
})
afterEach(() => rm(scope, { recursive: true, force: true }))

const entry = (hash: string): KeteSkillLock.Entry => ({ source: "https://x/y", files: { "SKILL.md": hash }, installedAt: "2026-10-17T00:00:00.000Z" })

describe("KeteSkillLock", () => {
  test("empty, round-trip, remove; no temp file left", async () => {
    expect(await KeteSkillLock.read(scope)).toEqual({ version: 1, skills: {} })
    await KeteSkillLock.upsert(scope, "a", entry("1"))
    await KeteSkillLock.upsert(scope, "b", entry("2"))
    expect(Object.keys((await KeteSkillLock.read(scope)).skills)).toEqual(["a", "b"])
    await KeteSkillLock.remove(scope, "a")
    expect(Object.keys((await KeteSkillLock.read(scope)).skills)).toEqual(["b"])
    expect(await readdir(scope)).toEqual(["skills.lock.json"])
  })

  test("an unknown version or invalid file is refused and left alone", async () => {
    const text = JSON.stringify({ version: 2, skills: {} })
    await writeFile(KeteSkillLock.file(scope), text)
    await expect(KeteSkillLock.upsert(scope, "a", entry("1"))).rejects.toThrow("not a version 1")
    expect(await Bun.file(KeteSkillLock.file(scope)).text()).toBe(text)
    await writeFile(KeteSkillLock.file(scope), "{nope")
    await expect(KeteSkillLock.read(scope)).rejects.toThrow()
  })

  test("diff", () => {
    expect(KeteSkillLock.diff({ a: "1", b: "1", c: "1" }, { a: "1", b: "2", d: "1" })).toEqual({ added: ["d"], removed: ["c"], changed: ["b"] })
  })
})
