// Kete-owned. The entrypoint of the Kete Code Harness Plugin step image
// (packages/kete-harness-plugin/README.md): reads the `PLUGIN_*` settings, runs the mode, writes
// the output variables and exits 0 (success), 1 (failure) or 2 (refused: settings, policy, budget).
// It never prints a setting's value: every line it prints and every output goes through one
// redactor that knows the step's secret values (`Secrets`).

import { Cloud } from "./cloud.js"
import { Dumpable } from "./dumpable.js"
import { Outputs } from "./outputs.js"
import { Run } from "./run.js"
import { Secrets } from "./secrets.js"
import { Settings } from "./settings.js"

export type MainDeps = {
  readonly env: Readonly<Record<string, string | undefined>>
  readonly log?: (line: string) => void
  readonly kete?: string
  readonly fetch?: typeof fetch
  readonly cloud?: Partial<Omit<Cloud.Deps, "env" | "fetch" | "log" | "redact">>
}

export async function main(deps: MainDeps): Promise<Outputs.ExitCode> {
  const redact = Secrets.redactor(deps.env)
  const print = deps.log ?? ((line: string) => process.stderr.write(`kete-harness-plugin: ${line}\n`))
  const log = (line: string) => print(redact(line))
  const write = (report: Run.Report) => {
    try {
      Outputs.write(deps.env, report.values, redact)
    } catch (error) {
      log(`couldn't write the output variables: ${error instanceof Error ? error.message : String(error)}`)
      return 1 as const
    }
    return report.exit
  }
  const refused = (message: string) => {
    log(`refused: ${message}`)
    return write({
      exit: 2,
      values: { KETE_OUTCOME: "refused", KETE_SUMMARY: message, KETE_BRANCH: "", KETE_JOB_URL: "" },
    })
  }
  let settings: Settings.Settings
  try {
    settings = Settings.parse(deps.env)
  } catch (error) {
    if (!(error instanceof Settings.SettingsError)) throw error
    return refused(error.message)
  }
  try {
    const report =
      settings.mode === "run"
        ? await Run.run(settings, {
            env: deps.env,
            kete: deps.kete ?? deps.env.KETE_HARNESS_KETE_BIN ?? "kete",
            log,
            redact,
          })
        : await Cloud.run(settings, { ...deps.cloud, env: deps.env, fetch: deps.fetch ?? fetch, log, redact })
    return write(report)
  } catch (error) {
    if (error instanceof Settings.SettingsError) return refused(error.message)
    const message = error instanceof Error ? error.message : String(error)
    log(`error: ${message}`)
    return write({
      exit: 1,
      values: { KETE_OUTCOME: "error", KETE_SUMMARY: message, KETE_BRANCH: "", KETE_JOB_URL: "" },
    })
  }
}

if (import.meta.main) {
  // Before anything else: the agent's processes run as this user and must not read our environment.
  const dumpable = Dumpable.disable()
  if (dumpable.kind === "failed")
    process.stderr.write(
      `kete-harness-plugin: warning: couldn't make the step non-dumpable (${dumpable.reason}); processes of the same user can read its environment.\n`,
    )
  // Cloud mode: a cancelled step (SIGTERM from the runner, or Ctrl-C) cancels its job before exiting.
  // Run mode handles the signals itself (it stops `kete`, which writes its result).
  const abort = new AbortController()
  if ((process.env.PLUGIN_MODE ?? "").trim().toLowerCase() === "cloud") {
    process.once("SIGTERM", () => abort.abort())
    process.once("SIGINT", () => abort.abort())
  }
  const code = await main({ env: process.env, cloud: { abort: abort.signal } })
  process.exit(code)
}
