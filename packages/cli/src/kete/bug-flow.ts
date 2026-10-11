// `kete bug [description]`: builds a privacy-safe problem report (@opencode/util/kete/bug-report),
// prints it, saves it to a file only its owner can read, and, in a terminal, asks before opening the
// issue tracker's bug-report form pre-filled with it. The browser opens only on a "yes". Opening the
// form sends the report to GitHub in the link; it becomes public only when the person submits the issue. `--print`, or no terminal, never
// asks and never opens anything. Every side effect is in `Deps`, so tests run it without a terminal,
// a browser or a runtime.

export * as KeteBugFlow from "./bug-flow"

import { Brand } from "@opencode/util/kete/brand"
import { KeteBugReport } from "@opencode/util/kete/bug-report"

/** What the runtime answered; each part is `undefined` when that question failed. */
export type Runtime = {
  readonly providers?: readonly string[]
  readonly mcp?: readonly KeteBugReport.McpState[]
  readonly sandbox?: KeteBugReport.Sandbox
}

export interface Deps {
  readonly version: string
  readonly channel: string
  readonly os: KeteBugReport.Facts["os"]
  readonly env: KeteBugReport.Environment
  readonly home: KeteBugReport.Home
  readonly offline: boolean
  readonly install: () => Promise<string | undefined>
  /** Whether a Kete account is signed in, from account.json only (never the key). */
  readonly signedIn: () => Promise<boolean>
  readonly runtime: () => Promise<Runtime | undefined>
  /** The end of the current log file; `undefined` when there is none. */
  readonly log: () => Promise<string | undefined>
  /** Saves the full report (mode 0600) and returns its path. */
  readonly save: (text: string) => Promise<string>
  /** stdin and stdout are both terminals. */
  readonly interactive: boolean
  readonly confirm: (message: string) => Promise<boolean>
  readonly open: (url: string) => Promise<void>
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}

export const QUESTION = "Open a GitHub issue with this?"
/** The CLI has no session: this is what a new session starts in. */
export const PERMISSION_MODE = "default for new sessions (--permission-mode changes it)"

const settle = <A>(run: () => Promise<A>) => run().catch(() => undefined)

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function collect(deps: Deps, description: string | undefined): Promise<KeteBugReport.Facts> {
  const [install, signedIn, runtime, log] = await Promise.all([
    settle(deps.install),
    deps.signedIn().then(
      (value) => (value ? ("yes" as const) : ("no" as const)),
      () => "unknown" as const,
    ),
    settle(deps.runtime),
    settle(deps.log),
  ])
  return {
    source: "cli",
    version: deps.version,
    channel: deps.channel,
    os: deps.os,
    env: deps.env,
    install,
    signedIn,
    providers: runtime?.providers,
    permissionMode: PERMISSION_MODE,
    sandbox: runtime?.sandbox,
    offline: deps.offline,
    mcp: runtime?.mcp,
    log,
    description,
  }
}

/** Runs `kete bug`; returns the exit code. */
export async function run(deps: Deps, input: { readonly description: string; readonly print: boolean }): Promise<number> {
  const report = KeteBugReport.build(await collect(deps, input.description.trim() || undefined), deps.home)
  let code = 0
  const file = await deps.save(report.text).catch((error: unknown) => {
    deps.err(`Couldn't save the report to a file: ${KeteBugReport.scrub(message(error), deps.home)}`)
    code = 1
    return undefined
  })
  deps.out(report.text)
  deps.err("")
  if (file) deps.err(`Full report saved to ${file} (only you can read it).`)
  deps.err(KeteBugReport.SECURITY_NOTICE)
  if (input.print) return code
  if (!deps.interactive) {
    deps.err(`Not a terminal, so nothing was opened. To report it, open ${Brand.urls.issues}/new and paste the report.`)
    return code
  }
  deps.err(KeteBugReport.LINK_NOTICE)
  if (!(await deps.confirm(QUESTION))) return code
  const issue = KeteBugReport.issueURL(report, file)
  if (!issue.complete)
    deps.err(
      file
        ? `The report is too long for a link: the oldest log lines were left out. Attach ${file} to the issue.`
        : "The report is too long for a link: the oldest log lines were left out.",
    )
  await deps.open(issue.url).catch(() => {
    deps.err("Couldn't open a browser. Open this link yourself:")
    deps.err(issue.url)
  })
  return code
}
