import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { KeteToolRunner } from "../../src/kete/tool-runner.js"

describe("KeteToolRunner.unavailable", () => {
  test("refuses to spawn, and the command never runs", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kete-tool-runner-"))
    try {
      const marker = path.join(dir, "marker")
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) => svc.spawn(ChildProcess.make("touch", [marker]))),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolRunner.unavailable)))

      const error = await Effect.runPromise(Effect.flip(program))
      expect(error.message).toContain(
        "Job mode: tools run only through the job's tool runner; refused to start `touch`.",
      )

      const exists = await fs
        .access(marker)
        .then(() => true)
        .catch(() => false)
      expect(exists).toBe(false)
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })

  test("refuses a piped command, naming its first stage", async () => {
    const program = Effect.scoped(
      ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
        svc.spawn(ChildProcess.pipeTo(ChildProcess.make("ls", []), ChildProcess.make("grep", ["x"]))),
      ),
    ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolRunner.unavailable)))

    const error = await Effect.runPromise(Effect.flip(program))
    expect(error.message).toContain("refused to start `ls`")
  })
})
