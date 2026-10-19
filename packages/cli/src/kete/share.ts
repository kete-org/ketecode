// `kete share` and `kete unshare`: the real dependencies for ./share-flow.ts (see there for the rules).

export * as KeteShareCommand from "./share"

import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { KeteShareRpc } from "@opencode/schema/kete/share"
import { Brand } from "@opencode/util/kete/brand"
import { KeteEnv } from "@opencode/util/kete/env"
import { KeteShareClient } from "@opencode/util/kete/share"
import { Effect, Option } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { ServerConnection } from "../services/server-connection"
import { KeteShareFlow } from "./share-flow"

// The runtime builds the snapshot and uploads it (15 s): allow a little more.
const TIMEOUT = 30_000

type Client = ReturnType<typeof OpenCode.make>

const deps = (client: Client): KeteShareFlow.Deps => ({
  interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
  agentShell: KeteEnv.inAgentShell(process.env),
  confirm: async (message) => {
    const { confirm, isCancel } = await import("@clack/prompts")
    const answer = await confirm({ message, initialValue: false })
    return !isCancel(answer) && answer === true
  },
  out: (text) => {
    process.stdout.write(text)
  },
  err: (text) => {
    process.stderr.write(text)
  },
  resolve: async (sessionID) => {
    if (sessionID) {
      const session = await client.session.get({ sessionID })
      return { id: session.id, directory: session.location.directory }
    }
    const directory = process.cwd()
    const page = await client.session.list({ directory, parentID: null, limit: 20, order: "desc" })
    const found = page.data.find((session) => session.location.directory === directory)
    return found && { id: found.id, directory }
  },
  call: (directory, method, input) =>
    client.rpc
      .call({ rpcID: KeteShareRpc.ID, method, input, location: { directory } }, { signal: AbortSignal.timeout(TIMEOUT) })
      .then((response) => response.output),
})

const run = (name: string, work: () => Promise<number>) =>
  Effect.promise(() =>
    work().catch((error: unknown) => {
      process.stderr.write(`${Brand.cliName} ${name}: ${KeteShareClient.printable(error instanceof Error ? error.message : String(error))}\n`)
      return KeteShareFlow.EXIT.failed
    }),
  ).pipe(Effect.map((code) => void (process.exitCode = code)))

const connect = (input: { readonly server: Option.Option<string>; readonly standalone: boolean }) =>
  Effect.gen(function* () {
    const server = yield* ServerConnection.resolve({ server: Option.getOrUndefined(input.server), standalone: input.standalone })
    return OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
  })

export default Runtime.handler(
  Commands.commands.share,
  Effect.fn("cli.kete.share")(function* (input: Runtime.Input<typeof Commands.commands.share>) {
    const client = yield* connect(input)
    yield* run("share", () =>
      KeteShareFlow.share(deps(client), { sessionID: Option.getOrUndefined(input.sessionID), link: input.link, yes: input.yes }),
    )
  }),
)

export const unshareCommand = Runtime.handler(
  Commands.commands.unshare,
  Effect.fn("cli.kete.unshare")(function* (input: Runtime.Input<typeof Commands.commands.unshare>) {
    const client = yield* connect(input)
    yield* run("unshare", () => KeteShareFlow.unshare(deps(client), { sessionID: Option.getOrUndefined(input.sessionID) }))
  }),
)
