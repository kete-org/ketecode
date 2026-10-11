import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { changelogPath, checkChangelog } from "../src/changelog-check"

const text = "# Changelog\n\n## Unreleased\n\n- Next.\n\n## 0.2.7\n\n- Shipped.\n\n## 0.2.6\n\n## 0.2.5\n\n- Old.\n"

describe("changelog:check", () => {
  test("a stable tag needs its own non-empty section", () => {
    expect(checkChangelog("kete-v0.2.7", text).ok).toBe(true)
    expect(checkChangelog("kete-v0.2.5", text).ok).toBe(true)
    const missing = checkChangelog("kete-v0.2.8", text)
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('no "## 0.2.8" section')
    expect(checkChangelog("kete-v0.2.6", text)).toEqual({ ok: false, message: 'CHANGELOG.md\'s "## 0.2.6" section is empty' })
    expect(checkChangelog("kete-v0.2.7", undefined).ok).toBe(false)
  })

  test("a pre-release tag passes without a section", () => {
    expect(checkChangelog("kete-v0.3.0-rc.1", text).ok).toBe(true)
    expect(checkChangelog("kete-v0.3.0-rc.1", undefined).ok).toBe(true)
  })

  test("anything but a kete-vX.Y.Z tag fails", () => {
    for (const tag of ["v0.2.7", "0.2.7", "", "kete-v0.2"]) expect(checkChangelog(tag, text).ok).toBe(false)
  })

  test("the command exits non-zero for a stable tag without a section", () => {
    const script = path.join(import.meta.dir, "../src/changelog-check.ts")
    const fail = Bun.spawnSync(["bun", script, "kete-v99.0.0"], { stderr: "pipe", stdout: "pipe" })
    expect(fail.exitCode).toBe(1)
    expect(fail.stderr.toString()).toContain('no "## 99.0.0" section')
    const pre = Bun.spawnSync(["bun", script, "kete-v99.0.0-rc.1"], { stderr: "pipe", stdout: "pipe" })
    expect(pre.exitCode).toBe(0)
  })

  test("the repository's CHANGELOG.md has an Unreleased or versioned section to embed", () => {
    expect(changelogPath).toBe(path.resolve(import.meta.dir, "../../../CHANGELOG.md"))
    expect(fs.readFileSync(changelogPath, "utf8")).toMatch(/^## (Unreleased|\d+\.\d+\.\d+)$/m)
  })
})
