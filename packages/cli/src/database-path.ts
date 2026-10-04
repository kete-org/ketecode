import path from "node:path"
import { OPENCODE_CHANNEL } from "./version"
import { Brand } from "@opencode/util/kete/brand" // kete_change

export function databasePath(data: string) {
  const filename =
    process.env.OPENCODE_DB ??
    (["latest", "dev", "beta", "next", "prod"].includes(OPENCODE_CHANNEL) ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "1" ||
    process.env.OPENCODE_DISABLE_CHANNEL_DB === "true"
      // kete_change start
      ? `${Brand.filePrefix}.db`
      : `${Brand.filePrefix}-${OPENCODE_CHANNEL.replace(/[^a-zA-Z0-9._-]/g, "-")}.db`)
  // kete_change end
  return filename === ":memory:" ? filename : path.resolve(data, filename)
}
