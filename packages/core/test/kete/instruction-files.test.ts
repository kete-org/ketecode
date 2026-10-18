import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { NodeFileSystem } from "@effect/platform-node"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Layer } from "effect"
import { KeteInstructionFiles } from "@opencode/core/kete/instruction-files"

const run = <A>(effect: Effect.Effect<A, unknown, FSUtil.Service>) =>
  Effect.runPromise(
    Effect.provide(effect, FSUtil.layer.pipe(Layer.provide(NodeFileSystem.layer))) as Effect.Effect<A, unknown, never>,
  )

async function world() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kete-instr-")))
  const home = path.join(base, "home")
  const repo = path.join(home, "repo")
  await fs.mkdir(path.join(home, ".ssh"), { recursive: true })
  await fs.writeFile(path.join(home, ".ssh", "id_rsa"), "PRIVATE KEY")
  await fs.mkdir(path.join(home, ".aws"), { recursive: true })
  await fs.writeFile(path.join(home, ".aws", "credentials"), "SECRET")
  await fs.mkdir(path.join(home, "other"), { recursive: true })
  await fs.writeFile(path.join(home, "other", "AGENTS.md"), "OTHER REPO")
  await fs.mkdir(path.join(repo, "docs"), { recursive: true })
  await fs.mkdir(path.join(repo, "sub"), { recursive: true })
  await fs.writeFile(path.join(repo, "CLAUDE.md"), "rules")
  await fs.writeFile(path.join(repo, "docs", "agents.md"), "doc rules")
  return { base, home, repo }
}

const allowed = (file: string, root: string, home: string) =>
  run(Effect.gen(function* () {
    return yield* KeteInstructionFiles.allowed(yield* FSUtil.Service, file, root, home)
  }))

describe.skipIf(process.platform === "win32")("KeteInstructionFiles.allowed", () => {
  test("an AGENTS.md linked to a key, credentials or another repository is refused", async () => {
    const { base, home, repo } = await world()
    try {
      await fs.symlink("../.ssh/id_rsa", path.join(repo, "AGENTS.md"))
      expect(await allowed(path.join(repo, "AGENTS.md"), repo, home)).toBeUndefined()
      await fs.symlink("../../.aws/credentials", path.join(repo, "sub", "AGENTS.md"))
      expect(await allowed(path.join(repo, "sub", "AGENTS.md"), repo, home)).toBeUndefined()
      await fs.rm(path.join(repo, "AGENTS.md"))
      await fs.symlink("../other/AGENTS.md", path.join(repo, "AGENTS.md"))
      expect(await allowed(path.join(repo, "AGENTS.md"), repo, home)).toBeUndefined()
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  test("a plain AGENTS.md, and one linked to markdown inside the repository, still load", async () => {
    const { base, home, repo } = await world()
    try {
      await fs.writeFile(path.join(repo, "sub", "AGENTS.md"), "plain")
      expect(await allowed(path.join(repo, "sub", "AGENTS.md"), repo, home)).toBe(path.join(repo, "sub", "AGENTS.md"))
      await fs.symlink("CLAUDE.md", path.join(repo, "AGENTS.md"))
      expect(await allowed(path.join(repo, "AGENTS.md"), repo, home)).toBe(path.join(repo, "CLAUDE.md"))
      await fs.rm(path.join(repo, "AGENTS.md"))
      await fs.symlink("docs/agents.md", path.join(repo, "AGENTS.md"))
      expect(await allowed(path.join(repo, "AGENTS.md"), repo, home)).toBe(path.join(repo, "docs", "agents.md"))
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })

  test("a folder above the repository may only link inside itself", async () => {
    const { base, home, repo } = await world()
    try {
      await fs.writeFile(path.join(home, "notes.md"), "home notes")
      await fs.symlink("notes.md", path.join(home, "AGENTS.md"))
      expect(await allowed(path.join(home, "AGENTS.md"), repo, home)).toBe(path.join(home, "notes.md"))
      await fs.rm(path.join(home, "AGENTS.md"))
      await fs.symlink(".ssh/id_rsa", path.join(home, "AGENTS.md"))
      expect(await allowed(path.join(home, "AGENTS.md"), repo, home)).toBeUndefined()
    } finally {
      await fs.rm(base, { recursive: true, force: true })
    }
  })
})
