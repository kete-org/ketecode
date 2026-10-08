// `kete sandbox`: whether the shell commands the agent runs go through the local OS sandbox (ADR 0013,
// docs/sandbox.md), as the runtime sees it: its `kete.sandbox` status RPC, decoded against the shared
// schema (the server's answer is external input). Exit codes: 0 sandboxed (or a job, which has its
// own sandbox), 1 unsandboxed (off or unavailable), 2 the runtime couldn't be asked.

export * as KeteCliSandbox from "./sandbox"

import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { KeteSandboxRpc } from "@opencode/schema/kete/sandbox"
import { Brand } from "@opencode/util/kete/brand"
import { Effect, Option, Schema } from "effect"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { ServerConnection } from "../services/server-connection"

export const EXIT = { sandboxed: 0, unsandboxed: 1, failed: 2 } as const

const MECHANISM: Record<KeteSandboxRpc.Mechanism, string> = {
  seatbelt: "macOS sandbox-exec (Seatbelt)",
  bubblewrap: "bubblewrap (bwrap)",
}

const NETWORK: Record<KeteSandboxRpc.Network, string> = {
  approved: "only for commands a person approved",
  none: "never",
  all: "always",
}

/** The lines `kete sandbox` prints, and its exit code. */
export function describe(status: KeteSandboxRpc.Status): { readonly lines: string[]; readonly code: number } {
  const lines: string[] = []
  const settings = `mode ${status.mode}; network ${NETWORK[status.network]}`
  switch (status.state) {
    case "on":
      lines.push(`Sandboxed: agent commands run in ${status.mechanism ? MECHANISM[status.mechanism] : "the OS sandbox"}.`)
      lines.push(`Settings: ${settings}.`)
      break
    case "job":
      lines.push("Job mode: commands run in the job's own sandbox.")
      break
    case "off":
      lines.push(`NOT SANDBOXED: the OS sandbox is ${status.reason ?? "turned off"}. Agent commands run with your full access.`)
      lines.push(`Turn it back on: unset KETE_SANDBOX or remove kete.sandbox.mode "off" from the global config.`)
      break
    case "unavailable":
      lines.push(`NOT SANDBOXED: no OS sandbox on this machine (${status.reason ?? "unknown"}).`)
      lines.push(
        status.mode === "required"
          ? "The sandbox is required, so agent commands are refused."
          : "Agent commands run with your full access; only the permission prompts protect you.",
      )
      if (status.platform === "linux") lines.push("Install bubblewrap (e.g. apt install bubblewrap) and allow unprivileged user namespaces.")
      break
  }
  if (status.ignored.length > 0)
    lines.push(`Ignored project settings that would loosen the sandbox: ${status.ignored.join(", ")}.`)
  const code = status.state === "on" || status.state === "job" ? EXIT.sandboxed : EXIT.unsandboxed
  return { lines, code }
}

export default Runtime.handler(
  Commands.commands.sandbox,
  Effect.fn("cli.kete.sandbox")(function* (input: Runtime.Input<typeof Commands.commands.sandbox>) {
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
    })
    const client = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    const decode = Schema.decodeUnknownPromise(KeteSandboxRpc.Status)
    const status = yield* Effect.tryPromise({
      try: () =>
        client.rpc
          .call(
            { rpcID: KeteSandboxRpc.ID, method: "status", input: {}, location: { directory: process.cwd() } },
            { signal: AbortSignal.timeout(15_000) },
          )
          .then((response) => decode(response.output)),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    }).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          process.stderr.write(`${Brand.cliName} sandbox: couldn't ask the runtime: ${error.message}\n`)
          return undefined
        }),
      ),
    )
    if (status === undefined) {
      process.exitCode = EXIT.failed
      return
    }
    if (input.format === "json") process.stdout.write(JSON.stringify(status) + "\n")
    else {
      const described = describe(status)
      process.stdout.write(described.lines.join("\n") + "\n")
    }
    process.exitCode = describe(status).code
  }),
)
