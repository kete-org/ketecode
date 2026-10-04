import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { KeteToolHelper } from "../../src/kete/tool-helper.js"
import { KeteToolRunner } from "../../src/kete/tool-runner.js"
import { startFakeHelper, type FakeHelper } from "./fixture/fake-tool-helper.js"

const withHelper = (options: Parameters<typeof startFakeHelper>[0], run: (helper: FakeHelper) => Promise<void>) =>
  Effect.runPromise(
    Effect.acquireUseRelease(
      Effect.promise(() => startFakeHelper(options)),
      (helper) => Effect.promise(() => run(helper)),
      (helper) => Effect.promise(() => helper.close()),
    ),
  )

const runCommand = (socket: string, command: ChildProcess.Command) =>
  Effect.scoped(ChildProcessSpawner.ChildProcessSpawner.use((svc) => svc.spawn(command))).pipe(
    Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket }))),
  )

describe("KeteToolHelper handle contract", () => {
  test("pid, exitCode, and a bare command works end to end", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.gen(function* () {
            const handle = yield* svc.spawn(ChildProcess.make("true", [], { env: { PATH: process.env.PATH } }))
            expect(handle.pid).toBeGreaterThan(0)
            const code = yield* handle.exitCode
            expect(Number(code)).toBe(0)
          }),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      await Effect.runPromise(program)
      expect(helper.requests).toHaveLength(1)
      expect(helper.requests[0]!.argv[0]).toBe("true")
    })
  })

  test("exitCode fails on a signal, with upstream's own wording", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.gen(function* () {
            const handle = yield* svc.spawn(ChildProcess.make("/bin/sleep", ["30"], { env: { PATH: process.env.PATH } }))
            yield* handle.kill({ killSignal: "SIGTERM" })
            return yield* Effect.flip(handle.exitCode)
          }),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      const error = await Effect.runPromise(program)
      expect(error.message).toContain("Process interrupted due to receipt of signal: 'SIGTERM'")
    })
  })

  test("isRunning is true before exit and false after", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.gen(function* () {
            const handle = yield* svc.spawn(ChildProcess.make("/bin/sh", ["-c", "sleep 0.2"], { env: { PATH: process.env.PATH } }))
            expect(yield* handle.isRunning).toBe(true)
            yield* handle.exitCode
            expect(yield* handle.isRunning).toBe(false)
          }),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      await Effect.runPromise(program)
    })
  })

  test("stdout/stderr/all capture output", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.gen(function* () {
            const handle = yield* svc.spawn(
              ChildProcess.make("/bin/sh", ["-c", "echo out; echo err 1>&2"], { env: { PATH: process.env.PATH } }),
            )
            const [out, err] = yield* Effect.all([Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr))])
            expect(out).toBe("out\n")
            expect(err).toBe("err\n")
          }),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      await Effect.runPromise(program)
    })
  })

  test("large output through a slow consumer never exceeds granted credit", async () => {
    await withHelper({ envAllow: ["PATH"], assertCreditNeverExceeded: true }, async (helper) => {
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.gen(function* () {
            const handle = yield* svc.spawn(
              ChildProcess.make("/bin/sh", ["-c", "head -c 500000 /dev/urandom | base64"], { env: { PATH: process.env.PATH } }),
            )
            let total = 0
            yield* Stream.runForEach(handle.stdout, (chunk) =>
              Effect.gen(function* () {
                total += chunk.length
                yield* Effect.sleep("2 millis") // a slow consumer
              }),
            )
            expect(total).toBeGreaterThan(0)
            expect(Number(yield* handle.exitCode)).toBe(0)
          }),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      await Effect.runPromise(program)
    })
  }, 20000)

  test("stdin sink round trip, including binary data", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      const input = new Uint8Array(300000)
      for (let i = 0; i < input.length; i++) input[i] = i % 256
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.gen(function* () {
            const handle = yield* svc.spawn(ChildProcess.make("/bin/cat", [], { env: { PATH: process.env.PATH } }))
            yield* Stream.run(Stream.fromIterable([input]), handle.stdin)
            const chunks = yield* Stream.runCollect(handle.stdout)
            const total = chunks.reduce((n, c) => n + c.length, 0)
            expect(total).toBe(input.length)
            expect(Number(yield* handle.exitCode)).toBe(0)
          }),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      await Effect.runPromise(program)
    })
  }, 20000)

  test("a Stream stdin option is forked and drives the sink", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.gen(function* () {
            const handle = yield* svc.spawn(
              ChildProcess.make("/bin/cat", [], {
                env: { PATH: process.env.PATH },
                stdin: Stream.map(Stream.make("hello "), (s) => new TextEncoder().encode(s)).pipe(
                  Stream.concat(Stream.make(new TextEncoder().encode("world"))),
                ),
              }),
            )
            const out = yield* Stream.mkString(Stream.decodeText(handle.stdout))
            expect(out).toBe("hello world")
          }),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      await Effect.runPromise(program)
    })
  })

  test("additionalFds are refused", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      const program = runCommand(
        helper.socketPath,
        ChildProcess.make("true", [], { env: { PATH: process.env.PATH }, additionalFds: { fd3: { type: "output" } } }),
      )
      const error = await Effect.runPromise(Effect.flip(program))
      expect(error.message).toContain("refused")
    })
  })

  test('stdio "inherit" is refused', async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      const program = runCommand(helper.socketPath, ChildProcess.make("true", [], { env: { PATH: process.env.PATH }, stdout: "inherit" }))
      const error = await Effect.runPromise(Effect.flip(program))
      expect(error.message).toContain("refused")
    })
  })

  test("unref is refused in job mode", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.gen(function* () {
            const handle = yield* svc.spawn(ChildProcess.make("true", [], { env: { PATH: process.env.PATH } }))
            return yield* Effect.flip(handle.unref)
          }),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      const error = await Effect.runPromise(program)
      expect(error.message).toContain("refused")
    })
  })

  test("a fd-targeted pipe is refused", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      const program = runCommand(
        helper.socketPath,
        ChildProcess.pipeTo(ChildProcess.make("true", [], { env: { PATH: process.env.PATH } }), ChildProcess.make("cat", []), {
          to: "fd3",
        }),
      )
      const error = await Effect.runPromise(Effect.flip(program))
      expect(error.message).toContain("refused")
    })
  })

  test('shell: true runs via /bin/sh -c', async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.gen(function* () {
            const handle = yield* svc.spawn(ChildProcess.make("echo hi", [], { env: { PATH: process.env.PATH }, shell: true }))
            const out = yield* Stream.mkString(Stream.decodeText(handle.stdout))
            expect(out).toBe("hi\n")
          }),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      await Effect.runPromise(program)
      expect(helper.requests[0]!.argv).toEqual(["/bin/sh", "-c", "echo hi"])
    })
  })

  test("env is filtered to the HELLO env list", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      // Await the exit inside the spawn's scope: closing the scope first would (correctly) kill
      // the still-running child, and `exitCode` would then report SIGTERM.
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.flatMap(
            svc.spawn(ChildProcess.make("true", [], { env: { PATH: process.env.PATH, SECRET: "shh" }, extendEnv: false })),
            (h) => h.exitCode,
          ),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      await Effect.runPromise(program)
      const names = helper.requests[0]!.env.map(([name]) => name)
      expect(names).toContain("PATH")
      expect(names).not.toContain("SECRET")
    })
  })

  test("piped command: printf | wc -c", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.gen(function* () {
            const handle = yield* svc.spawn(
              ChildProcess.pipeTo(
                ChildProcess.make("printf", ["hello"], { env: { PATH: process.env.PATH } }),
                ChildProcess.make("wc", ["-c"], { env: { PATH: process.env.PATH } }),
              ),
            )
            const out = yield* Stream.mkString(Stream.decodeText(handle.stdout))
            expect(out.trim()).toBe("5")
          }),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      await Effect.runPromise(program)
      expect(helper.requests).toHaveLength(2)
    })
  })

  test("a helper ERROR maps to a PlatformError whose description has no argv/env values", async () => {
    await withHelper(
      { envAllow: ["PATH"], onSpawn: () => ({ code: "cwd", message: "outside worktree root" }) },
      async (helper) => {
        const program = runCommand(helper.socketPath, ChildProcess.make("secret-tool", ["--flag", "topsecret"], { env: { PATH: process.env.PATH } }))
        const error = await Effect.runPromise(Effect.flip(program))
        expect(error.message).toContain("secret-tool")
        expect(error.message).not.toContain("topsecret")
        expect(error.message).not.toContain("--flag")
      },
    )
  })

  test("protocol version mismatch fails the connection", async () => {
    await withHelper({ envAllow: ["PATH"], protocolVersion: 99 }, async (helper) => {
      const program = runCommand(helper.socketPath, ChildProcess.make("true", [], { env: { PATH: process.env.PATH } }))
      const error = await Effect.runPromise(Effect.flip(program))
      expect(error.message).toContain("version")
    })
  })

  test("connection drop mid-stream fails the stream and exitCode", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.gen(function* () {
            const handle = yield* svc.spawn(ChildProcess.make("/bin/sh", ["-c", "sleep 5"], { env: { PATH: process.env.PATH } }))
            yield* Effect.sleep("100 millis")
            yield* Effect.promise(() => helper.close())
            return yield* Effect.flip(handle.exitCode)
          }),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      const error = await Effect.runPromise(program)
      expect(error).toBeDefined()
    })
  })

  // The kill-signal tests run last in this file: their SIGTERM/SIGKILL delivery and the
  // fake helper's own child-process reaping are the most timing-sensitive things here, and
  // grouping them at the end keeps any of that asynchronous cleanup from overlapping with an
  // unrelated assertion in a different test.
  test("kill with the default signal (SIGTERM)", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.gen(function* () {
            const handle = yield* svc.spawn(ChildProcess.make("/bin/sleep", ["30"], { env: { PATH: process.env.PATH } }))
            yield* handle.kill()
            const result = yield* Effect.flip(handle.exitCode)
            expect(result.message).toContain("SIGTERM")
          }),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      await Effect.runPromise(program)
    })
  })

  test("kill with forceKillAfter sends SIGKILL if the process doesn't stop in time", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      // A shell that ignores SIGTERM, so forceKillAfter's SIGKILL is what actually ends it.
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.gen(function* () {
            const handle = yield* svc.spawn(
              ChildProcess.make("/bin/sh", ["-c", "trap '' TERM; sleep 30"], { env: { PATH: process.env.PATH } }),
            )
            // Give the shell time to actually register its trap before signalling it — sending
            // SIGTERM immediately after spawn can arrive before "trap '' TERM" has run, in which
            // case the shell's *default* SIGTERM handling (terminate) applies instead.
            yield* Effect.sleep("200 millis")
            yield* handle.kill({ forceKillAfter: "300 millis" })
            const result = yield* Effect.flip(handle.exitCode)
            expect(result.message).toContain("SIGKILL")
          }),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      await Effect.runPromise(program)
    }, )
  }, 10000)

  test("scope release before exit sends KILL then closes", async () => {
    await withHelper({ envAllow: ["PATH"] }, async (helper) => {
      // The scope closes when this Effect.scoped block finishes, without exitCode ever being
      // awaited — the acquireRelease finalizer must still send KILL (the running process would
      // otherwise be orphaned).
      const program = Effect.scoped(
        ChildProcessSpawner.ChildProcessSpawner.use((svc) =>
          Effect.gen(function* () {
            const handle = yield* svc.spawn(ChildProcess.make("/bin/sleep", ["30"], { env: { PATH: process.env.PATH } }))
            expect(handle.pid).toBeGreaterThan(0)
          }),
        ),
      ).pipe(Effect.provide(KeteToolRunner.layer(KeteToolHelper.runner({ socket: helper.socketPath }))))
      await Effect.runPromise(program)
    })
  })
})
