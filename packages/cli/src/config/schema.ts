import { Config } from "@opencode/tui/config"
import { Brand } from "@opencode/util/kete/brand" // kete_change
import { Schema } from "effect"

// kete_change: TODO(kete) undefined until the Kete Code schema is published; JSON.stringify then omits `$schema`.
export const SchemaURL = Brand.urls.configSchema // kete_change

export const Info = Schema.Struct({
  $schema: Schema.optional(Schema.String).annotate({ description: "JSON Schema for CLI configuration" }),
  ...Config.Info.fields,
})
export type Info = Schema.Schema.Type<typeof Info>

export function normalizeLegacyTabs(info: Info | undefined) {
  if (info?.tabs?.enabled === undefined) return info
  const tabs = { ...info.tabs }
  tabs.mode ??= tabs.enabled ? "on" : "off"
  delete tabs.enabled
  return { ...info, tabs }
}
