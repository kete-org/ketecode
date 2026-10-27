// `kete bug`: the real dependencies for ./bug-flow.ts.
import os from "node:os"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { KeteSandboxRpc } from "@opencode/schema/kete/sandbox"
import { Global } from "@opencode/util/global"
import { KeteAccount } from "@opencode/util/kete/account"
import { Brand } from "@opencode/util/kete/brand"
import { KeteBugReport } from "@opencode/util/kete/bug-report"
import { KeteBugReportFile } from "@opencode/util/kete/bug-report-file"
import { KeteOffline } from "@opencode/util/kete/offline"
import { Logging } from "@opencode/util/observability/logging"
import { Effect, Option, Schema } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { ServerConnection } from "../services/server-connection"
import { OPENCODE_CHANNEL, OPENCODE_VERSION } from "../version"
import { KeteBugFlow } from "./bug-flow"
import { KeteUpdater } from "./updater"

const TIMEOUT = 10_000
const decodeSandbox = Schema.decodeUnknownPromise(KeteSandboxRpc.Status)

export default Runtime.handler(
  Commands.commands.bug,
  Effect.fn("cli.kete.bug")(function* (input: Runtime.Input<typeof Commands.commands.bug>) {
    // The runtime's view (providers, MCP servers, sandbox). If it can't be reached the report says
    // so: a problem report must work when the runtime is the problem.
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    }).pipe(Effect.timeout("20 seconds"), Effect.option)

    const runtime = async (): Promise<KeteBugFlow.Runtime | undefined> => {
      if (Option.isNone(server)) return undefined
      const endpoint = server.value.endpoint
      const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
      const location = { directory: process.cwd() }
      const signal = () => AbortSignal.timeout(TIMEOUT)
      const [providers, mcp, sandbox] = await Promise.all([
        client.provider
          .list({ location }, { signal: signal() })
          .then((response) => KeteBugReport.providerIds(response.data))
          .catch(() => undefined),
        client.mcp
          .list({ location }, { signal: signal() })
          .then((response) => KeteBugReport.mcpStates(response.data))
          .catch(() => undefined),
        client.rpc
          .call({ rpcID: KeteSandboxRpc.ID, method: "status", input: {}, location }, { signal: signal() })
          .then((response) => decodeSandbox(response.output))
          .then((status) => ({ state: status.state, mechanism: status.mechanism, mode: status.mode, network: status.network }))
          .catch(() => undefined),
      ])
      return { providers, mcp, sandbox }
    }

    const code = yield* Effect.promise(() =>
      KeteBugFlow.run(
        {
          version: OPENCODE_VERSION,
          channel: OPENCODE_CHANNEL,
          os: { platform: process.platform, release: os.release(), arch: process.arch },
          env: process.env,
          home: KeteBugReportFile.homes(Global.Path.home),
          offline: KeteOffline.enabled(),
          install: () =>
            KeteUpdater.detect({ channel: OPENCODE_CHANNEL, version: OPENCODE_VERSION, execPath: process.execPath }).then(
              (installed) => installed.kind,
            ),
          signedIn: () => KeteAccount.read({ config: Global.Path.config }).then((account) => account !== undefined),
          runtime,
          log: () => KeteBugReportFile.tail(Logging.file(OPENCODE_CHANNEL === "local", OPENCODE_CHANNEL)),
          save: (text) => KeteBugReportFile.save(os.tmpdir(), Brand.filePrefix, text),
          interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
          confirm: async (message) => {
            const { confirm, isCancel } = await import("@clack/prompts")
            const answer = await confirm({ message, initialValue: false })
            return !isCancel(answer) && answer === true
          },
          open: async (url) => {
            const { openUrl } = await import("@opencode/util/open")
            await openUrl(url)
          },
          out: (text) => process.stdout.write(text + "\n"),
          err: (text) => process.stderr.write(text + "\n"),
        },
        { description: input.description.join(" "), print: input.print },
      ),
    )
    process.exitCode = code
  }),
)
