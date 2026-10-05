// Kete-owned. The entrypoint of the Kete Code Harness Plugin step image
// (packages/kete-harness-plugin/README.md): reads the `PLUGIN_*` settings, runs the mode, writes
// the output variables and exits 0 (success), 1 (failure) or 2 (refused: settings, policy, budget).
// It never prints a setting's value.

import { Cloud } from "./cloud.js"
import { Outputs } from "./outputs.js"
import { Run } from "./run.js"
import { Settings } from "./settings.js"
import { KeteRedact } from "@opencode/util/kete/redact"

export type MainDeps = {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly log?: (line: string) => void
  readonly kete?: string
  readonly fetch?: typeof fetch
  readonly cloud?: Partial<Omit<Cloud.Deps, "env" | "fetch" | "log">>
}

export async function main(deps: MainDeps): Promise<Outputs.ExitCode> {
  const log = deps.log ?? ((line: string) => process.stderr.write(`kete-harness-plugin: ${line}\n`))
  const write = (report: Run.Report) => {
    try {
      Outputs.write(deps.env, report.values)
    } catch (error) {
      log(`couldn't write the output variables: ${error instanceof Error ? error.message : String(error)}`)
      return 1 as const
    }
    return report.exit
  }
  let settings: Settings.Settings
  try {
    settings = Settings.parse(deps.env)
  } catch (error) {
    if (!(error instanceof Settings.SettingsError)) throw error
    log(`refused: ${error.message}`)
    return write({
      exit: 2,
      values: { KETE_OUTCOME: "refused", KETE_SUMMARY: error.message, KETE_BRANCH: "", KETE_JOB_URL: "" },
    })
  }
  try {
    const report =
      settings.mode === "run"
        ? await Run.run(settings, { env: deps.env, kete: deps.kete ?? deps.env.KETE_HARNESS_KETE_BIN ?? "kete", log })
        : await Cloud.run(settings, { ...deps.cloud, env: deps.env, fetch: deps.fetch ?? fetch, log })
    return write(report)
  } catch (error) {
    if (error instanceof Settings.SettingsError) {
      log(`refused: ${error.message}`)
      return write({
        exit: 2,
        values: { KETE_OUTCOME: "refused", KETE_SUMMARY: error.message, KETE_BRANCH: "", KETE_JOB_URL: "" },
      })
    }
    const message = KeteRedact.text(error instanceof Error ? error.message : String(error))
    log(`error: ${message}`)
    return write({
      exit: 1,
      values: { KETE_OUTCOME: "error", KETE_SUMMARY: message, KETE_BRANCH: "", KETE_JOB_URL: "" },
    })
  }
}

if (import.meta.main) {
  const code = await main({ env: process.env })
  process.exit(code)
}
