export * as App from "./app.js"

import { Context, Layer } from "effect"
import { Brand } from "@opencode/util/kete/brand" // kete_change
import { makeGlobalNode } from "@opencode/util/effect/app-node"

export interface Info {
  readonly name: string
  readonly version: string
  readonly channel: string
}

export const Metadata = Context.Reference<Info>("@opencode/App", {
  defaultValue: () => make(),
})

export function make(input: Partial<Info> = {}): Info {
  return {
    name: input.name ?? Brand.cliName, // kete_change
    version: input.version ?? "unknown",
    channel: input.channel ?? "unknown",
  }
}

export function useragent(app: Info) {
  return `${Brand.cliName}/${app.channel}/${app.version}/${app.name}` // kete_change
}

export const layer = (input?: Partial<Info>) => Layer.succeed(Metadata, make(input))

export const configured = (input?: Partial<Info>) =>
  makeGlobalNode({ service: Metadata, layer: layer(input), deps: [] })

export const node = configured()
