// A coordinator turn's own record (orchestration-turn.json in kete's state directory): the proposal
// the platform accepted and the decision. The entrypoint reads it after the run to choose the bundle
// rule (kete-job-entrypoint internal/job/orchestration.go `bundleRule`): a plan bundle only with a
// standing proposal, checked against its plan_digest. It lives in kete's home, which the job's tools
// (another user) can't write, so a plan file written by hand into the working tree never makes a
// plan bundle.

export * as KeteOrchestrationTurnState from "./turn-state.js"

import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"

export const fileName = "orchestration-turn.json"

export interface State {
  readonly orchestrationID: string
  readonly turn: number
  readonly proposed?: { readonly rev: number; readonly digest: string }
  readonly decided?: "integrated" | "abandon"
}

/** The file's bytes (version 1). */
export function encode(state: State): string {
  return JSON.stringify({
    version: 1,
    orchestration_id: state.orchestrationID,
    turn: state.turn,
    proposed: state.proposed ? { rev: state.proposed.rev, plan_digest: state.proposed.digest } : null,
    decision: state.decided ?? null,
  })
}

/** Writes the record atomically (a temporary file, then rename), private to kete's user. */
export async function write(directory: string, state: State): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const target = path.join(directory, fileName)
  const temporary = `${target}.${process.pid}.tmp`
  await writeFile(temporary, encode(state), { mode: 0o600 })
  await rename(temporary, target)
}
