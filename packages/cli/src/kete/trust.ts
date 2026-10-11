// `kete trust` (docs/folder-trust.md): the folders whose project config the person trusts.
//
// - `kete trust` / `kete trust list [--format json]`: every trusted folder, when, and what it held back.
// - `kete trust add [path]`: trusts the folder's trust root (the git repository containing it, else
//   the folder) for its current project config; refuses the home directory, the filesystem root, and a
//   folder too large to fingerprint.
// - `kete trust remove [path]`: forgets it, and the trust in its project hooks.
//
// Paths default to the current directory. A running server applies a change the next time that
// folder's config loads. Exit codes: 0 done, 1 failed, 2 refused or bad input. Reads and writes only
// the trust stores in Kete Code's state directory; no server is started.

export * as KeteTrustCommand from "./trust"

import path from "node:path"
import { Effect, Option } from "effect"
import { Brand } from "@opencode/util/kete/brand"
import { KeteFolderTrustRules } from "@opencode/util/kete/folder-trust"
import { KeteFolderTrustStore } from "@opencode/util/kete/folder-trust-store"
import { KeteTrustStore } from "@opencode/util/kete/trust-store"
import { Commands } from "../commands/commands"
import { Runtime } from "../framework/runtime"
import { KeteFolderTrustCli } from "./folder-trust"

export const EXIT = { ok: 0, failed: 1, refused: 2 } as const

export interface Deps {
  readonly paths: KeteFolderTrustCli.Paths
  readonly cwd: string
  readonly fs?: KeteFolderTrustRules.Fs
  readonly out: (text: string) => void
  readonly err: (text: string) => void
}

const applies = `A running ${Brand.displayName} applies this the next time that folder's config loads.`

export async function list(deps: Deps, format: "default" | "json"): Promise<number> {
  const folders = Object.entries(await KeteFolderTrustStore.make(deps.paths.state).list()).sort(([, a], [, b]) => b.trusted - a.trusted)
  if (format === "json") {
    deps.out(
      JSON.stringify(
        folders.map(([folder, entry]) => ({ folder, trusted: new Date(entry.trusted).toISOString(), held: entry.held })),
      ) + "\n",
    )
    return EXIT.ok
  }
  if (folders.length === 0) {
    deps.out(`No trusted folders. Trust one with \`${Brand.cliName} trust add [path]\`.\n`)
    return EXIT.ok
  }
  for (const [folder, entry] of folders) {
    deps.out(`${KeteFolderTrustRules.safe(folder)}\n  trusted ${new Date(entry.trusted).toISOString()}\n`)
    for (const item of entry.held) deps.out(`  - ${KeteFolderTrustRules.safe(item)}\n`)
  }
  return EXIT.ok
}

export async function add(deps: Deps, target: string | undefined): Promise<number> {
  const directory = path.resolve(deps.cwd, target ?? ".")
  const inspection = await KeteFolderTrustCli.inspect(directory, deps.paths, deps.fs)
  if (inspection.root.kind !== "ok" || inspection.key === undefined) {
    deps.err(`Can't trust ${KeteFolderTrustRules.shown(directory)}: ${KeteFolderTrustRules.safe(inspection.refusal ?? "its path can't be resolved")}.\n`)
    return EXIT.refused
  }
  if (inspection.refusal !== undefined || inspection.fingerprint.kind !== "ok") {
    deps.err(`Can't trust ${KeteFolderTrustRules.shown(inspection.root.root)}: ${KeteFolderTrustRules.safe(inspection.refusal ?? "it can't be fingerprinted")}.\n`)
    return EXIT.refused
  }
  await KeteFolderTrustStore.make(deps.paths.state).trust(inspection.key, inspection.fingerprint.value, inspection.held)
  deps.out(`Trusted ${KeteFolderTrustRules.shown(inspection.root.root)}.\n`)
  if (inspection.held.length === 0) deps.out("Its project config has nothing that was held back right now.\n")
  else for (const item of inspection.held) deps.out(`  - ${KeteFolderTrustRules.safe(item)}\n`)
  deps.out(`You'll be asked again if these settings change. ${applies}\n`)
  return EXIT.ok
}

export async function remove(deps: Deps, target: string | undefined): Promise<number> {
  const directory = path.resolve(deps.cwd, target ?? ".")
  const fs = deps.fs ?? KeteFolderTrustRules.nodeFs
  const root = await KeteFolderTrustRules.trustRoot(directory, fs)
  if (root.kind !== "ok") {
    deps.err(`Can't resolve ${KeteFolderTrustRules.shown(directory)}: ${KeteFolderTrustRules.safe(root.reason)}.\n`)
    return EXIT.refused
  }
  const key = KeteFolderTrustRules.storeKey(root.root)
  const folders = KeteFolderTrustStore.make(deps.paths.state)
  const known = (await folders.get(key)) !== undefined
  await folders.remove(key)
  // The hooks store keys a repository by its real path (core/src/kete/hooks/settings.ts repositoryKeyOf).
  const hooks = KeteTrustStore.hooks(deps.paths.state)
  for (const repository of new Set([root.root, root.top])) await hooks.remove(repository)
  deps.out(
    known
      ? `${KeteFolderTrustRules.shown(root.root)} is no longer trusted. ${applies}\n`
      : `${KeteFolderTrustRules.shown(root.root)} wasn't trusted; its project hooks aren't either now.\n`,
  )
  return EXIT.ok
}

const realDeps = (): Deps => ({
  paths: KeteFolderTrustCli.defaultPaths(),
  cwd: process.env.PWD ?? process.cwd(),
  out: (text) => {
    process.stdout.write(text)
  },
  err: (text) => {
    process.stderr.write(text)
  },
})

const settle = (work: () => Promise<number>) =>
  Effect.promise(() =>
    work().catch((error: unknown) => {
      process.stderr.write(`${Brand.cliName} trust: ${error instanceof Error ? error.message : String(error)}\n`)
      return EXIT.failed
    }),
  ).pipe(Effect.map((code) => void (process.exitCode = code)))

export const listDefault = Runtime.handler(Commands.commands.trust, (input) => settle(() => list(realDeps(), input.format)))
export const listCommand = Runtime.handler(Commands.commands.trust.commands.list, (input) =>
  settle(() => list(realDeps(), input.format)),
)
export const addCommand = Runtime.handler(Commands.commands.trust.commands.add, (input) =>
  settle(() => add(realDeps(), Option.getOrUndefined(input.path))),
)
export const removeCommand = Runtime.handler(Commands.commands.trust.commands.remove, (input) =>
  settle(() => remove(realDeps(), Option.getOrUndefined(input.path))),
)

export default listDefault
