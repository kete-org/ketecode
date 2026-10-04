// Job mode's Environment driver (job mode piece A3, kete-code-platform docs/jobs.md §8 item 3):
// the read/write/edit/patch tools, the read tool's directory listing and glob/grep's type checks all
// reach the working tree through `Environment.files`. In a job that service is this driver, which
// does every operation through KeteConfinedFs (openat2 beneath the working tree's root, no symlinks,
// no magic links), never `node:fs`. It is injected by replacing `Environment.node`
// (server/src/kete/job-server.ts); outside job mode nothing changes.
//
// It supplies all seven `FilesImpl` methods, so the process-backed `execDefaults` is never reached,
// and maps KeteConfinedFs outcomes to the local driver's error channels (environment/local.ts):
// missing → `NotFound` where the contract has it, else `Failed`; a refusal → `Failed` whose cause is
// `KeteConfinedFs.Refused` (the message names the relative path only).

export * as KeteJobFiles from "./job-files.js"

import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { KeteConfinedFs } from "@opencode/util/kete/confined-fs"
import { Effect, Layer } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Environment } from "../environment/index.js"
import { Location } from "../location.js"

const toFailed = (root: KeteConfinedFs.Root, value: string, failure: KeteConfinedFs.Failure) => {
  const rel = KeteConfinedFs.describe(root, value)
  if (failure.kind === "refused") return new Environment.Failed({ path: value, cause: new KeteConfinedFs.Refused(rel) })
  if (failure.kind === "missing") return new Environment.Failed({ path: value, cause: new Error(`Job mode: ${rel}: ENOENT`) })
  if (failure.kind === "wrongKind") return new Environment.Failed({ path: value, cause: new Error(`Job mode: ${rel}: is a ${failure.actual}`) })
  return new Environment.Failed({ path: value, cause: new Error(`Job mode: ${rel}: ${failure.reason}`) })
}

type Missing = "notFound" | "failed"

/** Lifts an outcome into the contract's channels: `missing` becomes `NotFound` (or `Failed` where
 * the method has no `NotFound`), `wrongKind` becomes `WrongKind` where allowed. */
function lift<A>(root: KeteConfinedFs.Root, value: string, promise: () => Promise<KeteConfinedFs.Outcome<A>>, missing: "notFound", wrongKind: true): Effect.Effect<A, Environment.NotFound | Environment.WrongKind | Environment.Failed>
function lift<A>(root: KeteConfinedFs.Root, value: string, promise: () => Promise<KeteConfinedFs.Outcome<A>>, missing: "notFound"): Effect.Effect<A, Environment.NotFound | Environment.Failed>
function lift<A>(root: KeteConfinedFs.Root, value: string, promise: () => Promise<KeteConfinedFs.Outcome<A>>, missing: "failed"): Effect.Effect<A, Environment.Failed>
function lift<A>(root: KeteConfinedFs.Root, value: string, promise: () => Promise<KeteConfinedFs.Outcome<A>>, missing: Missing, wrongKind = false) {
  return Effect.promise(promise).pipe(
    Effect.flatMap((result): Effect.Effect<A, Environment.NotFound | Environment.WrongKind | Environment.Failed> => {
      if (result.kind === "ok") return Effect.succeed(result.value)
      if (result.kind === "missing" && missing === "notFound") return Effect.fail(new Environment.NotFound({ path: value }))
      if (result.kind === "wrongKind" && wrongKind) return Effect.fail(new Environment.WrongKind({ path: value, actual: result.actual }))
      return Effect.fail(toFailed(root, value, result))
    }),
  )
}

/** The driver over an opened root. Pure adaptation; every syscall is in KeteConfinedFs. */
export function driver(root: KeteConfinedFs.Root, spawner: ChildProcessSpawner["Service"]): Environment.Driver {
  const ops = KeteConfinedFs.ops(root)
  const overrides: Environment.FilesImpl = {
    read: (value, range) => lift(root, value, () => ops.read(value, range), "notFound", true),
    write: (value, bytes) => lift(root, value, () => ops.write(value, bytes), "failed"),
    stat: (value) => lift(root, value, () => ops.stat(value), "notFound"),
    list: (value) => lift(root, value, () => ops.list(value), "notFound", true),
    remove: (value) => lift(root, value, () => ops.remove(value), "failed"),
    move: (from, to) => lift(root, from, () => ops.move(from, to), "notFound"),
    mkdir: (value) => lift(root, value, () => ops.mkdir(value), "failed"),
  }
  return { spawner, overrides }
}

/** The Environment layer for job mode: the confined driver for the job's own location; a
 * workspace-placed location never happens in a job and is a defect, never a fallback to the local
 * driver. */
export const layer = (root: KeteConfinedFs.Root) =>
  Layer.effect(
    Environment.Service,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner
      const location = yield* Location.Service
      if (location.workspaceID)
        return yield* Effect.die(new Error(`Job mode: a workspace-placed location (${location.workspaceID}) is not supported`))
      const bound = driver(root, spawner)
      return Environment.Service.of({ files: Environment.makeFiles(bound), spawner: bound.spawner })
    }),
  )

/** The location node that replaces `Environment.node` in job mode. */
export const node = (root: KeteConfinedFs.Root) =>
  makeLocationNode({ service: Environment.Service, layer: layer(root), deps: [CrossSpawnSpawner.node, Location.node] })
