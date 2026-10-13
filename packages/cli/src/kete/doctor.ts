// `kete doctor`: the real dependencies for ./doctor-flow.ts.
import fs from "node:fs/promises"
import path from "node:path"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { KeteDoctorRpc } from "@opencode/schema/kete/doctor"
import { KeteSandboxRpc } from "@opencode/schema/kete/sandbox"
import { Global } from "@opencode/util/global"
import { KeteAccount } from "@opencode/util/kete/account"
import { Brand } from "@opencode/util/kete/brand"
import { KeteBugReport } from "@opencode/util/kete/bug-report"
import { KeteOffline } from "@opencode/util/kete/offline"
import { Effect, Option, Schema } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { ServerConnection } from "../services/server-connection"
import { OPENCODE_CHANNEL, OPENCODE_VERSION } from "../version"
import { KeteDoctorFlow } from "./doctor-flow"
import { KeteUpdater } from "./updater"

const TIMEOUT = 10_000
const decodeSandbox = Schema.decodeUnknownPromise(KeteSandboxRpc.Status)
const decodeReport = Schema.decodeUnknownPromise(KeteDoctorRpc.Report)

/** Every `kete` executable on PATH, in PATH order (real paths, each once), and the running one. */
async function binaries(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const real = (file: string) => fs.realpath(file).catch(() => path.resolve(file))
  // Windows finds `kete` by trying each PATHEXT extension, and compares paths without case.
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
  const names = platform === "win32" ? extensions.map((extension) => Brand.cliName + extension.toLowerCase()) : [Brand.cliName]
  const key = (file: string) => (platform === "win32" ? file.toLowerCase() : file)
  const found: string[] = []
  for (const directory of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
    if (!directory) continue
    for (const name of names) {
      const file = path.join(directory, name)
      const stat = await fs.stat(file).catch(() => undefined)
      if (!stat?.isFile()) continue
      if (platform !== "win32" && (stat.mode & 0o111) === 0) continue
      const resolved = await real(file)
      if (!found.some((item) => key(item) === key(resolved))) found.push(resolved)
      break
    }
  }
  const running = await real(process.execPath)
  return { onPath: found, running: found.find((item) => key(item) === key(running)) ?? running }
}

export default Runtime.handler(
  Commands.commands.doctor,
  Effect.fn("cli.kete.doctor")(function* (input: Runtime.Input<typeof Commands.commands.doctor>) {
    // The runtime's view. If it can't be reached the doctor says so: it must work when the runtime is
    // the problem.
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    }).pipe(Effect.timeout("20 seconds"), Effect.option)

    const runtime = async (): Promise<KeteDoctorFlow.Runtime | undefined> => {
      if (Option.isNone(server)) return undefined
      const endpoint = server.value.endpoint
      const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
      const location = { directory: process.cwd() }
      const signal = () => AbortSignal.timeout(TIMEOUT)
      const rpc = (rpcID: string, method: string) =>
        client.rpc.call({ rpcID, method, input: {}, location }, { signal: signal() }).then((response) => response.output)
      const [providers, defaultModel, mcp, sandbox, report] = await Promise.all([
        client.provider
          .list({ location }, { signal: signal() })
          .then((response) => KeteBugReport.providerIds(response.data))
          .catch(() => undefined),
        client.model
          .default({ location }, { signal: signal() })
          .then((response) => (response.data ? { provider: response.data.providerID, model: response.data.modelID } : null))
          .catch(() => undefined),
        client.mcp
          .list({ location }, { signal: signal() })
          .then((response) => KeteBugReport.mcpStates(response.data))
          .catch(() => undefined),
        rpc(KeteSandboxRpc.ID, "status")
          .then(decodeSandbox)
          .catch(() => undefined),
        rpc(KeteDoctorRpc.ID, "check")
          .then(decodeReport)
          .catch(() => undefined),
      ])
      // Nothing answered: the runtime is there in name only.
      if ([providers, defaultModel, mcp, sandbox, report].every((value) => value === undefined)) return undefined
      return { providers, defaultModel, mcp, sandbox, report }
    }

    const code = yield* Effect.promise(() =>
      KeteDoctorFlow.run(
        {
          version: OPENCODE_VERSION,
          channel: OPENCODE_CHANNEL,
          platform: process.platform,
          env: process.env,
          home: Global.Path.home,
          offline: KeteOffline.enabled(),
          interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
          install: () =>
            KeteUpdater.detect({ channel: OPENCODE_CHANNEL, version: OPENCODE_VERSION, execPath: process.execPath }).then(
              (installed) => installed.kind,
            ),
          binaries: () => binaries(process.env, process.platform),
          signedIn: () => KeteAccount.read({ config: Global.Path.config }).then((account) => account !== undefined),
          runtime,
          out: (text) => process.stdout.write(text + "\n"),
        },
        { format: input.format },
      ),
    )
    process.exitCode = code
  }),
)
