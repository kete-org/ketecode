// Offline mode in the CLI: the startup decision (flag, env, global config; fails closed), the switches
// it sets for models.dev and update checks, the server-connection rule (private server, no
// `--server`) and the refusal of commands that need the network.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { NodeServices } from "@effect/platform-node"
import { Global } from "@opencode/util/global"
import { Effect } from "effect"
import { Argument, Command } from "effect/unstable/cli"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { KeteCommands } from "../../src/kete/commands"
import { KeteCliOffline } from "../../src/kete/offline"
import { ServerConnection } from "../../src/services/server-connection"

const switches = (env: KeteCliOffline.Environment) => ({
  offline: env.OPENCODE_OFFLINE,
  models: env.OPENCODE_DISABLE_MODELS_FETCH,
  update: env.OPENCODE_DISABLE_AUTOUPDATE,
})

describe("offline startup", () => {
  test("off by default: nothing is set", () => {
    const env: KeteCliOffline.Environment = {}
    expect(KeteCliOffline.apply(env, ["run", "hello"], () => [undefined, '{"kete":{"offline":false}}'])).toBe(false)
    expect(env).toEqual({})
  })

  test("--offline sets the offline flag and turns off the models.dev fetch and update checks", () => {
    const env: KeteCliOffline.Environment = {}
    expect(KeteCliOffline.apply(env, ["--offline", "models"], () => [])).toBe(true)
    expect(switches(env)).toEqual({ offline: "1", models: "1", update: "1" })
  })

  test("--offline after `--` is an argument, not the flag", () => {
    expect(KeteCliOffline.flagged(["run", "--", "--offline"])).toBe(false)
    expect(KeteCliOffline.flagged(["run", "--offline", "--", "x"])).toBe(true)
  })

  // The startup check runs before the CLI parser, so it must read `--offline=<value>` and
  // `--offline <value>` exactly as the parser does: "false" never turns offline on, a truthy value
  // always does, and anything the parser would reject counts as on (fail closed).
  test("--offline=false and --offline false are off; truthy values are on; unknown values fail closed", () => {
    for (const value of KeteCliOffline.falsy) {
      expect(KeteCliOffline.flagged([`--offline=${value}`, "run"])).toBe(false)
      expect(KeteCliOffline.flagged(["--offline", value, "run"])).toBe(false)
    }
    for (const value of KeteCliOffline.truthy) {
      expect(KeteCliOffline.flagged([`--offline=${value}`])).toBe(true)
      expect(KeteCliOffline.flagged(["--offline", value])).toBe(true)
    }
    expect(KeteCliOffline.flagged(["--offline=maybe"])).toBe(true)
    expect(KeteCliOffline.flagged(["--offline=FALSE"])).toBe(true)
    expect(KeteCliOffline.flagged(["--offline", "hello"])).toBe(true)
    expect(KeteCliOffline.flagged(["--offline=false", "--offline"])).toBe(true)
    const env: KeteCliOffline.Environment = {}
    expect(KeteCliOffline.apply(env, ["--offline=false", "models"], () => [])).toBe(false)
    expect(env).toEqual({})
  })

  test("the startup check agrees with the CLI parser's reading of --offline", async () => {
    const cases = [
      ["--offline"],
      ["--offline=true"],
      ["--offline=false"],
      ["--offline", "false"],
      ["--offline", "true"],
      ["--offline=0"],
      ["--offline=no"],
      ["--offline=off"],
      ["--offline=yes"],
      ["--offline=1"],
      ["--offline", "0"],
      ["--offline", "hello"],
      ["hello"],
    ]
    for (const argv of cases) {
      const parsed = await Effect.runPromise(
        Effect.gen(function* () {
          const seen: { offline?: boolean } = {}
          const command = Command.make("probe", { rest: Argument.string("rest").pipe(Argument.variadic()) }, () =>
            Effect.gen(function* () {
              seen.offline = yield* KeteCommands.Offline
            }),
          ).pipe(Command.withGlobalFlags([KeteCommands.Offline]))
          yield* Command.runWith(command, { version: "0", renderErrors: false })(argv)
          return seen.offline
        }).pipe(Effect.provide(NodeServices.layer)),
      )
      expect({ argv, offline: KeteCliOffline.flagged(argv) }).toEqual({ argv, offline: parsed === true })
    }
  })

  test("KETE_OFFLINE (bridged): on, and an invalid value fails closed and is kept as it is", () => {
    const on: KeteCliOffline.Environment = { OPENCODE_OFFLINE: "true" }
    expect(KeteCliOffline.apply(on, [], () => [])).toBe(true)
    expect(switches(on)).toEqual({ offline: "true", models: "1", update: "1" })
    const typo: KeteCliOffline.Environment = { OPENCODE_OFFLINE: "yes please" }
    expect(KeteCliOffline.apply(typo, [], () => [])).toBe(true)
    expect(switches(typo)).toEqual({ offline: "yes please", models: "1", update: "1" })
  })

  test("global config kete.offline: the last file that sets it decides; a non-boolean value fails closed", () => {
    expect(KeteCliOffline.fromConfig([undefined, '{ "kete": { "offline": true } }'])).toBe(true)
    expect(KeteCliOffline.fromConfig(['{"kete":{"offline":true}}', '// jsonc\n{"kete":{"offline":false},}'])).toBe(false)
    expect(KeteCliOffline.fromConfig(['{"kete":{"offline":false}}', '{"kete":{"platform":{}}}'])).toBe(false)
    expect(KeteCliOffline.fromConfig(['{"kete":{"offline":"yes"}}'])).toBe(true)
    expect(KeteCliOffline.fromConfig(["{ not json", '{"kete":null}', "[]"])).toBe(false)
    const env: KeteCliOffline.Environment = {}
    expect(KeteCliOffline.apply(env, [], () => ['{"kete":{"offline":true}}'])).toBe(true)
    expect(switches(env)).toEqual({ offline: "1", models: "1", update: "1" })
  })

  test("the entry-point module reads --offline and the global config before anything else", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "kete-offline-"))
    try {
      const script = path.join(root, "probe.ts")
      const module = path.resolve(import.meta.dir, "../../src/kete/offline-startup.ts")
      await fs.writeFile(
        script,
        `await import(${JSON.stringify(module)})\nconsole.log(JSON.stringify([process.env.OPENCODE_OFFLINE, process.env.OPENCODE_DISABLE_MODELS_FETCH, process.env.OPENCODE_DISABLE_AUTOUPDATE]))\n`,
      )
      const run = async (args: string[], config?: string) => {
        const directory = path.join(root, `config-${Math.random().toString(36).slice(2)}`)
        await fs.mkdir(directory)
        if (config !== undefined) await fs.writeFile(path.join(directory, "kete.jsonc"), config)
        const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: root, OPENCODE_CONFIG_DIR: directory }
        const child = Bun.spawn([process.execPath, script, ...args], { env, stdout: "pipe", stderr: "pipe" })
        const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited])
        expect(code).toBe(0)
        return JSON.parse(out.trim()) as unknown
      }
      expect(await run([])).toEqual([null, null, null])
      expect(await run(["--offline"])).toEqual(["1", "1", "1"])
      expect(await run([], '{ "kete": { "offline": true } }')).toEqual(["1", "1", "1"])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

describe("offline server connection", () => {
  test("offline forces a private server", () => {
    const result = KeteCliOffline.connection({ standalone: false }, { OPENCODE_OFFLINE: "1" })
    expect(result).toEqual({ ok: true, args: { standalone: true } })
  })

  test("offline refuses --server", () => {
    const result = KeteCliOffline.connection({ server: "http://10.0.0.5:4096" }, { OPENCODE_OFFLINE: "1" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--server can't be used")
  })

  test("online: arguments pass through unchanged", () => {
    const args = { server: "http://127.0.0.1:4096", standalone: false }
    expect(KeteCliOffline.connection(args, {})).toEqual({ ok: true, args })
  })

  describe("ServerConnection.resolve", () => {
    const previous = process.env.OPENCODE_OFFLINE
    afterEach(() => {
      if (previous === undefined) delete process.env.OPENCODE_OFFLINE
      else process.env.OPENCODE_OFFLINE = previous
    })

    test("offline with --server fails before contacting the server", async () => {
      process.env.OPENCODE_OFFLINE = "1"
      let contacted = false
      const server = Bun.serve({
        port: 0,
        fetch: () => {
          contacted = true
          return new Response("{}")
        },
      })
      try {
        const error = await Effect.runPromise(
          Effect.flip(ServerConnection.resolve({ server: `http://127.0.0.1:${server.port}` })).pipe(
            Effect.provide(Global.layerWith({ config: os.tmpdir() })),
            Effect.provide(NodeServices.layer),
            Effect.scoped,
          ),
        )
        expect(String(error)).toContain("Offline mode is on, so --server can't be used")
        expect(contacted).toBe(false)
      } finally {
        server.stop(true)
      }
    })
  })
})

describe("offline refusals", () => {
  // Restore like the upstream run tests do (`?? 0`): later suites expect exit code 0, not undefined.
  let exitCode: typeof process.exitCode
  beforeEach(() => {
    exitCode = process.exitCode
  })
  afterEach(() => {
    process.exitCode = exitCode ?? 0
  })

  test("a command that needs the network is refused with exit code 2", () => {
    const written: string[] = []
    expect(KeteCliOffline.refused("kete login", { OPENCODE_OFFLINE: "1" }, (text) => written.push(text))).toBe(true)
    expect(written.join("")).toStartWith(
      "Offline mode is on (--offline, KETE_OFFLINE or kete.offline): `kete login` needs the network.",
    )
    expect(process.exitCode).toBe(2)
  })

  test("online: not refused, nothing written", () => {
    const written: string[] = []
    expect(KeteCliOffline.refused("kete sync", {}, (text) => written.push(text))).toBe(false)
    expect(written).toEqual([])
  })
})
