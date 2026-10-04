// Terminal I/O for the Kete account commands: stdout/stderr, the real account store, and a reload of
// the background service (only if one is already running; signing in never starts one).

import { EOL } from "node:os"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { KeteAccount } from "@opencode/util/kete/account"
import { Effect } from "effect"
import { ServiceConfig } from "../services/service-config"
import type { AccountFlow } from "./account-flow"

const reloadService = Effect.fn("cli.kete.account.reload")(function* () {
  const options = yield* ServiceConfig.options()
  const endpoint = yield* Service.discover({ ...options, version: undefined })
  if (!endpoint) return false
  const client = OpenCode.make({ baseUrl: endpoint.url, headers: Service.headers(endpoint) })
  yield* Effect.tryPromise({
    try: (signal) => client.location.reload({ signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]) }),
    catch: (cause) => (cause instanceof Error ? cause : new Error("the service did not accept the reload")),
  })
  return true
})

export const make = Effect.fn("cli.kete.account.io")(function* () {
  const run = Effect.runPromiseWith(yield* Effect.context<Effect.Services<ReturnType<typeof reloadService>>>())
  return {
    print: (line: string) => process.stdout.write(line + EOL),
    warn: (line: string) => process.stderr.write(`Warning: ${line}${EOL}`),
    account: KeteAccount.defaults(),
    environment: process.env,
    reload: () => run(reloadService()),
  } satisfies AccountFlow.IO
})

export * as AccountIO from "./account-io"
