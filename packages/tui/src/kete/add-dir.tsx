// Extra working directories in the TUI (`kete --add-dir <path>`; core/src/kete/add-dir.ts enforces them):
// - `useKeteAddDir().createMetadata()`: the `kete.dirs` metadata a new session is created with, so the
//   folders are in force before the first tool call. The runtime validates it (a refusal fails the
//   create), and stores real paths.
// - `useKeteAddDir()` (called once from app.tsx): asks the runtime's `kete.add-dir` RPC once at start and
//   shows every refusal with its reason in one toast (a refused create alone is a generic error), and
//   adds the folders to the session `--continue`/`--session` resumes with a GET-merge-PATCH.
// `/add-dir` is a server-side command and needs nothing here.

import type { OpenCodeClient } from "@opencode/client/promise"
import { KeteAddDirRpc } from "@opencode/schema/kete/add-dir"
import { Schema } from "effect"
import { createEffect } from "solid-js"
import { useArgs } from "../context/args"
import { useClient } from "../context/client"
import { useLocation } from "../context/location"
import { useRoute } from "../context/route"
import { useToast } from "../ui/toast"

export const metadataKey = "kete.dirs"

const decode = Schema.decodeUnknownPromise(KeteAddDirRpc.CheckOutput)

/** `session.create`'s metadata for the folders, or undefined when there are none. */
export const metadataFor = (dirs: readonly string[] | undefined): Record<string, unknown> | undefined =>
  dirs === undefined || dirs.length === 0 ? undefined : { [metadataKey]: [...dirs] }

/** The refusals among `verdicts`, one line each. */
export const refusals = (verdicts: readonly KeteAddDirRpc.Verdict[]) =>
  verdicts.flatMap((verdict) => (verdict.real === undefined ? [`${verdict.path}: ${verdict.reason ?? "can't be added"}`] : []))

/** `metadata` with `reals` added to its folders; undefined when nothing is new. */
export function withFolders(metadata: Record<string, unknown> | undefined, reals: readonly string[]) {
  const stored = Array.isArray(metadata?.[metadataKey]) ? (metadata[metadataKey] as unknown[]).filter((item): item is string => typeof item === "string") : []
  const added = reals.filter((real) => !stored.includes(real))
  return added.length === 0 ? undefined : { ...metadata, [metadataKey]: [...stored, ...added] }
}

type Api = Pick<OpenCodeClient, "rpc" | "session">

/** Checks `dirs` with the runtime; a verdict per folder. */
export async function check(api: Pick<OpenCodeClient, "rpc">, location: { readonly directory: string } | undefined, dirs: readonly string[]) {
  const response = await api.rpc.call(
    { rpcID: KeteAddDirRpc.ID, method: "check", input: { paths: [...dirs] }, location },
    { signal: AbortSignal.timeout(15_000) },
  )
  return (await decode(response.output)).verdicts
}

/** Adds `reals` to a session, keeping its other metadata (the server replaces metadata whole). */
export async function apply(api: Pick<OpenCodeClient, "session">, sessionID: string, reals: readonly string[]) {
  const session = await api.session.get({ sessionID })
  const next = withFolders(session.metadata, reals)
  if (next) await api.session.update({ sessionID, metadata: next })
}

/** Merges the metadata objects a new session is created with (undefined ones are skipped). */
export function mergeKeteMetadata(...parts: Array<Record<string, unknown> | undefined>) {
  const present = parts.filter((part): part is Record<string, unknown> => part !== undefined)
  return present.length === 0 ? undefined : Object.assign({}, ...present)
}

/** The prompt's side: the metadata a new session is created with (no startup work). */
export function useKeteAddDirMetadata() {
  const args = useArgs()
  return { createMetadata: () => metadataFor(args.addDirs) }
}

/** Called once from app.tsx: the startup check and the resumed session's folders. */
export function useKeteAddDir() {
  const args = useArgs()
  const client = useClient()
  const toast = useToast()
  const route = useRoute()
  const location = useLocation()
  const api = (): Api => client.api
  const dirs = args.addDirs ?? []
  // The runtime's verdict, asked once when the location is known; resolves to the accepted real paths
  // (nothing when any folder was refused, which is shown).
  let verdict: Promise<string[]> | undefined
  // `kete --continue --add-dir ../lib`: the resumed session gets the folders once, at startup.
  let applying = dirs.length === 0 || !(args.continue || args.sessionID)
  createEffect(() => {
    const ref = location.ref
    const id = route.data.type === "session" ? route.data.sessionID : undefined
    if (dirs.length === 0 || !ref) return
    if (!verdict) {
      verdict = check(api(), ref, dirs).then((verdicts) => {
        const refused = refusals(verdicts)
        if (refused.length > 0) {
          toast.show({ title: "Couldn't add folders", message: refused.join("\n"), variant: "error" })
          return []
        }
        return verdicts.flatMap((item) => (item.real === undefined ? [] : [item.real]))
      })
      verdict.catch((error) => toast.error(error))
    }
    if (applying || !id) return
    applying = true
    verdict
      .then((reals) => (reals.length > 0 ? apply(api(), id, reals) : undefined))
      .catch((error) => toast.error(error))
  })
}
