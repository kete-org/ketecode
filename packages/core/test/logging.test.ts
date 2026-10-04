import { describe, expect, test } from "bun:test"
import { Brand } from "@opencode/util/kete/brand" // kete_change
import path from "path"
import { Global } from "@opencode/util/global"
import { Logging } from "@opencode/util/observability/logging"

describe("Logging", () => {
  test("uses a local-specific log file for local installs", () => {
    expect(Logging.file(true, "local")).toBe(path.join(Global.Path.log, `${Brand.filePrefix}-local.log`)) // kete_change
  })

  test("keeps non-local installs on the default log file", () => {
    expect(Logging.file(false, "next")).toBe(path.join(Global.Path.log, `${Brand.filePrefix}.log`)) // kete_change
  })
})
