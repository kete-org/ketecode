// `--add-dir <path>` for `kete` and `kete run`: extra working directories for the session, kept in the
// session's `kete.dirs` metadata and enforced by the runtime (core/src/kete/add-dir.ts, docs/permissions.md).
// The client normalizes the paths, asks the runtime's `kete.add-dir` RPC why a folder can't be added
// (a refusal by the metadata guard alone reaches a client only as a generic error), and writes the
// accepted real paths with a GET-merge-PATCH, as `--permission-mode` does.

export * as KeteAddDirCli from "./add-dir"

import os from "node:os"
import path from "node:path"
import type { OpenCodeClient } from "@opencode/client/promise"
import { KeteAddDirRpc } from "@opencode/schema/kete/add-dir"
import { KeteJobMode } from "@opencode/util/kete/job-mode"
import { Schema } from "effect"

export const metadataKey = "kete.dirs"

const decode = Schema.decodeUnknownPromise(KeteAddDirRpc.CheckOutput)

/** Absolute paths: `~` expanded, relative ones resolved from `cwd`. */
export function normalize(cwd: string, home: string, values: readonly string[]): string[] {
  return values.map((value) =>
    path.resolve(cwd, value === "~" ? home : value.startsWith("~/") || value.startsWith("~\\") ? path.join(home, value.slice(2)) : value),
  )
}

/**
 * The folders the flag asks for, as absolute paths. A job has one workspace, so the flag is refused
 * there (before anything starts).
 */
export function prepare(values: readonly string[], env: Record<string, string | undefined> = process.env): string[] {
  if (values.length === 0) return []
  if (KeteJobMode.enabled(env)) throw new Error("--add-dir isn't available in a job: a job has one workspace")
  return normalize(process.cwd(), os.homedir(), values)
}

type Location = { readonly directory: string }

/** Asks the runtime which of `paths` can be added; a verdict per path, in order. */
export async function check(client: Pick<OpenCodeClient, "rpc">, location: Location, paths: readonly string[]) {
  const response = await client.rpc.call(
    { rpcID: KeteAddDirRpc.ID, method: "check", input: { paths: [...paths] }, location },
    { signal: AbortSignal.timeout(15_000) },
  )
  return (await decode(response.output)).verdicts
}

/** The refusals among `verdicts`, one line each. */
export const refusals = (verdicts: readonly KeteAddDirRpc.Verdict[]) =>
  verdicts.flatMap((verdict) => (verdict.real === undefined ? [`${verdict.path}: ${verdict.reason ?? "can't be added"}`] : []))

type Sessions = Pick<OpenCodeClient["session"], "get" | "update">

/**
 * Adds `reals` to a session's folders, keeping its other metadata (the server replaces metadata whole).
 * Reads the result back and fails if the runtime didn't keep every folder.
 */
export async function apply(sessions: Sessions, sessionID: string, reals: readonly string[]) {
  const session = await sessions.get({ sessionID })
  const metadata = session.metadata ?? {}
  const stored = Array.isArray(metadata[metadataKey]) ? (metadata[metadataKey] as unknown[]).filter((item): item is string => typeof item === "string") : []
  const next = [...stored, ...reals.filter((real) => !stored.includes(real))]
  if (next.length === stored.length) return
  await sessions.update({ sessionID, metadata: { ...metadata, [metadataKey]: next } })
  const kept = (await sessions.get({ sessionID })).metadata?.[metadataKey]
  if (!Array.isArray(kept) || !reals.every((real) => kept.includes(real)))
    throw new Error(`the runtime didn't keep the extra folders for session ${sessionID}`)
}

/** Checks `paths` with the runtime, then adds them to the session; throws with every reason when any is refused. */
export async function addAll(client: Pick<OpenCodeClient, "rpc" | "session">, location: Location, sessionID: string, paths: readonly string[]) {
  if (paths.length === 0) return
  const verdicts = await check(client, location, paths)
  const refused = refusals(verdicts)
  if (refused.length > 0) throw new Error(`couldn't add folders:\n  ${refused.join("\n  ")}`)
  await apply(client.session, sessionID, verdicts.flatMap((verdict) => (verdict.real === undefined ? [] : [verdict.real])))
}
