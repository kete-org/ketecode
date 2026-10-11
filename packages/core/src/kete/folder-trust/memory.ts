// Folder trust's per-process memory (kete/folder-trust.ts): one global node, so every location under
// the same trust root shares it. It holds the folders answered "Not now" (held back until the runtime
// restarts), the questions currently open (one per trust root and fingerprint, however many locations
// ask), the warnings already logged, and a feed of trust roots that were just trusted, which every
// location's Config reloads on. Per process, never module state.

export * as KeteFolderTrustMemory from "./memory.js"

import { makeGlobalNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, PubSub, Stream } from "effect"

export interface Interface {
  /** Root key + fingerprint answered "Not now" (or cancelled) in this process. */
  readonly declined: Set<string>
  /** Root key + fingerprint with a question open. */
  readonly pending: Set<string>
  /** Root key + fingerprint whose warning was logged. */
  readonly warned: Set<string>
  /** Announces that a trust root (store key) was just trusted. */
  readonly publish: (key: string) => Effect.Effect<void>
  /** Trust roots (store keys) as they are trusted. */
  readonly trusted: () => Stream.Stream<string>
}

export class Service extends Context.Service<Service, Interface>()("@kete/FolderTrustMemory") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const roots = yield* PubSub.unbounded<string>()
    return Service.of({
      declined: new Set(),
      pending: new Set(),
      warned: new Set(),
      publish: (key) => PubSub.publish(roots, key).pipe(Effect.asVoid),
      trusted: () => Stream.fromPubSub(roots),
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
