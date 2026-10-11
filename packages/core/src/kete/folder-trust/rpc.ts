// The `kete.folder.trust` RPC (schema/src/kete/folder-trust.ts) for clients that load project code of
// their own: the TUI loads a project's `.kete/plugins/` TUI plugins only when `status` says the folder
// is trusted (fail closed: an error, an older runtime or any other state means no). `changed` is
// emitted with the current status after every config reload, so a client reloads its plugins once the
// person trusts the folder.

export * as KeteFolderTrustRpcPlugin from "./rpc.js"

import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { KeteFolderTrustRpc } from "@opencode/schema/kete/folder-trust"
import { Effect, Stream } from "effect"
import { Config } from "../../config.js"
import { KeteFolderTrust } from "../folder-trust.js"

export const Plugin = {
  id: "kete.folder.trust",
  effect: Effect.fn("KeteFolderTrust.RpcPlugin")(function* (ctx: PluginContext) {
    const config = yield* Config.Service
    const trust = yield* KeteFolderTrust.Service
    // The config is loaded (and so trust decided) before the status is read.
    const current = () =>
      config.entries().pipe(
        Effect.andThen(trust.status()),
        Effect.map((status): KeteFolderTrustRpc.Status => ({ trusted: status.kind === "trusted" })),
      )
    const registration = yield* ctx.rpc.register(KeteFolderTrustRpc.Definition, { status: current }).pipe(Effect.orDie)
    yield* ctx.event.subscribe().pipe(
      Stream.filter((event) => event.type === "config.updated"),
      Stream.runForEach(() =>
        current().pipe(
          Effect.flatMap((status) => registration.events.emit("changed", status)),
          Effect.catchCause((cause) => Effect.logWarning("failed to announce the folder trust status", { cause })),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  }),
}
