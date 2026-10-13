// `kete doctor`: gathers the facts (@opencode/util/kete/doctor) from the runtime and this machine,
// prints the checks, and exits 1 when one failed. Read-only and offline: it asks only the local
// runtime. Every side effect is in `Deps`, so tests run it without a runtime or a terminal.

export * as KeteDoctorFlow from "./doctor-flow"

import { KeteDoctor } from "@opencode/util/kete/doctor"

/** What the runtime answered; each part is `undefined` when that question failed. */
export type Runtime = {
  readonly providers?: readonly string[]
  readonly defaultModel?: KeteDoctor.Facts["defaultModel"]
  readonly mcp?: KeteDoctor.Facts["mcp"]
  readonly sandbox?: KeteDoctor.Sandbox
  readonly report?: KeteDoctor.RuntimeReport
}

export interface Deps {
  readonly version: string
  readonly channel: string
  readonly platform: string
  readonly env: KeteDoctor.Environment
  readonly home: string
  readonly offline: boolean
  readonly interactive: boolean
  readonly install: () => Promise<string | undefined>
  readonly binaries: () => Promise<KeteDoctor.Facts["binaries"]>
  /** Whether a Kete account is signed in, from account.json only (never the key). */
  readonly signedIn: () => Promise<boolean>
  /** `undefined` when the runtime couldn't be reached. */
  readonly runtime: () => Promise<Runtime | undefined>
  readonly out: (text: string) => void
}

const settle = <A>(run: () => Promise<A>) => run().catch(() => undefined)

export async function collect(deps: Deps): Promise<KeteDoctor.Facts> {
  const [install, binaries, signedIn, runtime] = await Promise.all([
    settle(deps.install),
    settle(deps.binaries),
    deps.signedIn().then(
      (value) => (value ? ("yes" as const) : ("no" as const)),
      () => "unknown" as const,
    ),
    settle(deps.runtime),
  ])
  return {
    version: deps.version,
    channel: deps.channel,
    install,
    platform: deps.platform,
    env: deps.env,
    interactive: deps.interactive,
    binaries,
    offline: deps.offline,
    signedIn,
    runtime: runtime !== undefined,
    providers: runtime?.providers,
    defaultModel: runtime?.defaultModel,
    mcp: runtime?.mcp,
    sandbox: runtime?.sandbox,
    report: runtime?.report,
    home: deps.home,
  }
}

/** Runs `kete doctor`; returns the exit code. */
export async function run(deps: Deps, input: { readonly format: "default" | "json" }): Promise<number> {
  const checks = KeteDoctor.checks(await collect(deps))
  if (input.format === "json")
    deps.out(JSON.stringify({ checks, summary: KeteDoctor.summary(checks), ...KeteDoctor.counts(checks) }, null, 2))
  else deps.out(KeteDoctor.render(checks))
  return KeteDoctor.exitCode(checks)
}
