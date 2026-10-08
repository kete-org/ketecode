// KetePermissionMode.realTarget against a real directory: symlinks, including dangling ones whose
// target doesn't exist yet, are followed so an edit through them is checked where it really writes.
import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { KetePermissionMode } from "@opencode/core/kete/permission-mode"
import { KeteShellRisk } from "@opencode/core/kete/shell-risk"

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kete-realpath-")))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

// The FSUtil calls realTarget uses, backed by node's fs (FSUtil itself is wrapped in job mode).
const files = {
  existsSafe: (value: string) => Effect.sync(() => fs.existsSync(value)),
  resolve: (value: string) => Effect.sync(() => (fs.existsSync(value) ? fs.realpathSync(value) : path.resolve(value))),
  readLink: (value: string) => Effect.try({ try: () => fs.readlinkSync(value), catch: (error) => error as Error }),
} as unknown as Parameters<typeof KetePermissionMode.realTarget>[0] // only the three calls realTarget makes

const real = (value: string) => Effect.runPromise(KetePermissionMode.realTarget(files, dir, value))

fs.mkdirSync(path.join(dir, ".kete"))
fs.mkdirSync(path.join(dir, ".git"))
fs.mkdirSync(path.join(dir, "src"))
fs.symlinkSync(".git", path.join(dir, "cfg"))
fs.symlinkSync(".kete/kete.jsonc", path.join(dir, "notes.json")) // dangling: .kete/kete.jsonc doesn't exist
fs.symlinkSync("notes.json", path.join(dir, "chain.json")) // a link to the dangling link
fs.symlinkSync("loop-b", path.join(dir, "loop-a"))
fs.symlinkSync("loop-a", path.join(dir, "loop-b"))
fs.symlinkSync("../.kete/agent", path.join(dir, "src", "agents")) // dangling directory link

describe("realTarget", () => {
  test("an ordinary file is itself", async () => {
    expect(await real("src/a.ts")).toBe("src/a.ts")
  })
  test("a directory link (cfg -> .git)", async () => {
    expect(await real("cfg/config")).toBe(".git/config")
    expect(KeteShellRisk.protectedPath((await real("cfg/config"))!)).toBe(true)
  })
  test("a dangling leaf link (notes.json -> .kete/kete.jsonc) resolves to its would-be target", async () => {
    expect(await real("notes.json")).toBe(".kete/kete.jsonc")
    expect(await real("chain.json")).toBe(".kete/kete.jsonc")
  })
  test("a dangling directory link in the middle of the path", async () => {
    expect(await real("src/agents/x.md")).toBe(".kete/agent/x.md")
  })
  test("a symlink loop is unresolved, which counts as protected", async () => {
    expect(await real("loop-a")).toBe(KetePermissionMode.UNRESOLVED)
    expect(KeteShellRisk.protectedPath(KetePermissionMode.UNRESOLVED)).toBe(true)
  })
})
