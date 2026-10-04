// Job mode's FSUtil wrapper (job mode piece A3, decision N4; kete-code-platform docs/jobs.md §8
// item 3). FSUtil is the global file service behind the read tool's AGENTS.md discovery and
// missing-file suggestions, instruction loading, project/VCS detection, snapshots and the server's
// `/fs` routes. It serves `kete`'s data and config dirs as well as the working tree, so it can't be
// replaced outright; instead, **for paths inside the working tree only**:
//
// - content and listing reads and canonicalisation are routed through KeteConfinedFs (openat2, no
//   symlinks, no magic links) — a symlinked AGENTS.md is skipped, never followed;
// - every mutation is refused (`kete` changes the working tree only through its file tools, which
//   go through the job-mode Environment driver, core/src/kete/job-files.ts);
// - directory walks (`scan`, `globUp`, `glob`) are confined too: a walk rooted in the working tree
//   lists it through KeteConfinedFs and never enters or reports a symlink, and any result of a walk
//   rooted elsewhere that lands in the working tree is kept only if it's reachable without a symlink
//   — so a planted link to `/` or `kete`'s data dir can't enumerate names outside the tree;
// - metadata calls (stat, exists, access, readLink, watch, up/findUp) pass through unchanged: they
//   reveal a link target's existence, type or size, never its content.
//
// Paths outside the working tree delegate to the real FSUtil. Every key of the real service is in
// exactly one of the three exported lists; a test fails when upstream adds a method.

export * as KeteJobFsUtil from "./job-fs-util.js"

import path from "node:path"
import { Minimatch } from "minimatch"
import { Effect, Layer, Sink, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import { systemError } from "effect/PlatformError"
import { FSUtil } from "../fs-util.js"
import type { Glob } from "../glob.js"
import { KeteConfinedFs } from "./confined-fs.js"

/** Reads and canonicalisation routed through openat2 inside the working tree. */
export const routed = [
  "readFile",
  "readFileString",
  "readFileStringSafe",
  "readJson",
  "readDirectory",
  "readDirectoryEntries",
  "realPath",
  "resolve",
  "scan",
  "globUp",
  "glob",
] as const

/** Mutations (and raw handles/streams), refused inside the working tree. */
export const refused = [
  "copy",
  "copyFile",
  "chmod",
  "chown",
  "link",
  "makeDirectory",
  "makeTempDirectory",
  "makeTempDirectoryScoped",
  "makeTempFile",
  "makeTempFileScoped",
  "open",
  "remove",
  "rename",
  "sink",
  "stream",
  "symlink",
  "truncate",
  "utimes",
  "writeFile",
  "writeFileString",
  "writeJson",
  "ensureDir",
  "writeWithDirs",
] as const

/** Metadata and pure helpers, passed through unchanged. */
export const delegated = [
  "access",
  "exists",
  "existsSafe",
  "isDir",
  "isFile",
  "readLink",
  "stat",
  "watch",
  "up",
  "findUp",
  "globMatch",
] as const

export const refusedDescription = "Job mode: kete changes the working tree only through its file tools"

/** Bounds of a confined directory walk: entries visited and directory depth. Past them the walk
 * fails (it never returns a silently truncated list). */
export const MAX_WALK_ENTRIES = 200_000
export const MAX_WALK_DEPTH = 64

const permissionDenied = (method: string, value: string, description: string) =>
  systemError({ _tag: "PermissionDenied", module: "FileSystem", method, pathOrDescriptor: value, description })

function toPlatformError(root: KeteConfinedFs.Root, method: string, value: string, failure: KeteConfinedFs.Failure): PlatformError {
  const rel = KeteConfinedFs.describe(root, value)
  if (failure.kind === "missing") return systemError({ _tag: "NotFound", module: "FileSystem", method, pathOrDescriptor: value })
  if (failure.kind === "refused") return permissionDenied(method, value, KeteConfinedFs.refusedMessage(rel))
  if (failure.kind === "wrongKind")
    return systemError({ _tag: "BadResource", module: "FileSystem", method, pathOrDescriptor: value, description: `is a ${failure.actual}` })
  return systemError({ _tag: "Unknown", module: "FileSystem", method, pathOrDescriptor: value, description: failure.reason })
}

/** The wrapper over a real FSUtil service. Exported for tests; `layer` builds it in the graph. */
export function wrap(real: FSUtil.Interface, root: KeteConfinedFs.Root): FSUtil.Interface {
  const ops = KeteConfinedFs.ops(root)
  const inside = (value: string) => KeteConfinedFs.contains(root, FSUtil.windowsPath(value))

  const lift = <A>(method: string, value: string, run: () => Promise<KeteConfinedFs.Outcome<A>>): Effect.Effect<A, PlatformError> =>
    Effect.promise(run).pipe(
      Effect.flatMap((result) => (result.kind === "ok" ? Effect.succeed(result.value) : Effect.fail(toPlatformError(root, method, value, result)))),
    )

  const readFile = (value: string) =>
    inside(value) ? lift("readFile", value, () => ops.read(value)).pipe(Effect.map((result) => result.bytes)) : real.readFile(value)

  const readFileString = (value: string, encoding?: string) => {
    if (!inside(value)) return real.readFileString(value, encoding)
    if (encoding !== undefined && !/^utf-?8$/i.test(encoding))
      return Effect.fail(permissionDenied("readFileString", value, "Job mode: only UTF-8 reads are supported in the working tree"))
    return readFile(value).pipe(Effect.map((bytes) => new TextDecoder().decode(bytes)))
  }

  const readDirectoryNames = (value: string) =>
    lift("readDirectory", value, () => ops.list(value)).pipe(Effect.map((entries) => entries.map((entry) => entry.name)))

  const realPath = (value: string) =>
    inside(value) ? lift("realPath", value, () => ops.realPath(value)) : real.realPath(value)

  const refuse =
    <Args extends readonly unknown[], A, E, R>(
      method: string,
      original: (...args: Args) => Effect.Effect<A, E, R>,
      paths: (...args: Args) => ReadonlyArray<string | undefined>,
    ) =>
    (...args: Args): Effect.Effect<A, E | PlatformError, R> => {
      const hit = paths(...args).find((value) => value !== undefined && inside(value))
      if (hit === undefined) return original(...args)
      return Effect.fail(permissionDenied(method, hit, refusedDescription))
    }

  const first = (value: string) => [value]
  const both = (a: string, b: string) => [a, b]
  const temp = (options?: { readonly directory?: string | undefined }) => [options?.directory]

  /** A glob walk of the working tree from `cwd` over the confined listing: symlinks are neither
   * entered nor reported, directories that can't match are pruned. */
  const walk = async (pattern: string, options: Glob.Options, cwd: string): Promise<string[]> => {
    const matcher = new Minimatch(pattern, { dot: options.dot ?? false })
    const out: string[] = []
    const stack: Array<{ readonly absolute: string; readonly relative: string; readonly depth: number }> = [
      { absolute: cwd, relative: "", depth: 0 },
    ]
    let visited = 0
    while (stack.length > 0) {
      const dir = stack.pop()!
      const listed = await ops.list(dir.absolute)
      if (listed.kind !== "ok") {
        // A missing start is an empty result, like glob's; anything else at the start fails; a
        // subdirectory that vanished or turned into a link mid-walk is skipped.
        if (dir.depth === 0 && listed.kind !== "missing") throw toPlatformError(root, "scan", dir.absolute, listed)
        continue
      }
      for (const entry of listed.value) {
        if (++visited > MAX_WALK_ENTRIES) throw new Error(`Job mode: a scan visited more than ${MAX_WALK_ENTRIES} entries`)
        if (entry.type === "symlink") continue
        const relative = dir.relative === "" ? entry.name : `${dir.relative}/${entry.name}`
        const absolute = path.join(dir.absolute, entry.name)
        const result = options.absolute ? absolute : relative
        if (entry.type === "directory") {
          if (options.include === "all" && matcher.match(relative)) out.push(result)
          if (!matcher.match(relative, true)) continue
          if (dir.depth + 1 >= MAX_WALK_DEPTH) throw new Error(`Job mode: a scan went deeper than ${MAX_WALK_DEPTH} directories`)
          stack.push({ absolute, relative, depth: dir.depth + 1 })
        } else if (matcher.match(relative)) out.push(result)
      }
    }
    return out.sort()
  }

  /** Keeps a walk result outside the working tree; inside it, only one reachable without a symlink. */
  const reachable = async (results: ReadonlyArray<string>, base: string): Promise<string[]> => {
    const kept: string[] = []
    for (const result of results) {
      const absolute = path.resolve(base, result)
      if (!inside(absolute)) {
        kept.push(result)
        continue
      }
      const real = await ops.realPath(absolute)
      if (real.kind === "ok") kept.push(result)
    }
    return kept
  }

  const scan = (pattern: string, options?: Glob.Options): Effect.Effect<string[], FSUtil.Error> => {
    const cwd = path.resolve(options?.cwd ?? root.lexical)
    if (!path.isAbsolute(pattern) && inside(cwd))
      return Effect.tryPromise({ try: () => walk(pattern, options ?? {}, cwd), catch: (cause) => new FSUtil.FileSystemError({ method: "glob", cause }) })
    // Rooted elsewhere (or an absolute pattern): the real glob, never following links, filtered.
    return real
      .scan(pattern, { ...options, symlink: false })
      .pipe(Effect.flatMap((results) => Effect.promise(() => reachable(results, cwd))))
  }

  const overrides: Partial<FSUtil.Interface> = {
    readFile,
    readFileString,
    readFileStringSafe: (value) =>
      inside(value)
        ? readFileString(value).pipe(
            Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
            Effect.catchReason("PlatformError", "PermissionDenied", () => Effect.undefined),
          )
        : real.readFileStringSafe(value),
    readJson: (value) =>
      inside(value)
        ? readFileString(value).pipe(
            Effect.flatMap((text) =>
              Effect.try({ try: () => JSON.parse(text) as unknown, catch: (cause) => new FSUtil.FileSystemError({ method: "readJson", cause }) }),
            ),
          )
        : real.readJson(value),
    readDirectory: (value, options) => {
      if (!inside(value)) return real.readDirectory(value, options)
      if (options?.recursive) return Effect.fail(permissionDenied("readDirectory", value, "Job mode: recursive listings of the working tree are not supported"))
      return readDirectoryNames(value)
    },
    readDirectoryEntries: (value) =>
      inside(value) ? lift("readDirectoryEntries", value, () => ops.list(value)) : real.readDirectoryEntries(value),
    realPath,
    scan,
    // Upstream's globUp calls the inner scan: re-implemented over the confined one.
    globUp: (pattern, start, stop) =>
      Effect.gen(function* () {
        const result: string[] = []
        let current = start
        while (true) {
          const matches = yield* scan(pattern, { cwd: current, absolute: true, include: "file", dot: true }).pipe(
            Effect.orElseSucceed(() => [] as string[]),
          )
          result.push(...matches)
          if (stop === current) break
          const parent = path.dirname(current)
          if (parent === current) break
          current = parent
        }
        return result
      }),
    glob: (pattern, options) => {
      const base = path.resolve(options?.root ?? root.lexical)
      return real.glob(pattern, options).pipe(Effect.flatMap((results) => Effect.promise(() => reachable(results, base))))
    },
    resolve: (input) => {
      const resolved = path.resolve(FSUtil.windowsPath(input))
      if (!inside(resolved)) return real.resolve(input)
      return realPath(resolved).pipe(
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(resolved)),
        Effect.orDie,
      )
    },

    copy: refuse("copy", real.copy, both),
    copyFile: refuse("copyFile", real.copyFile, both),
    chmod: refuse("chmod", real.chmod, first),
    chown: refuse("chown", real.chown, first),
    link: refuse("link", real.link, both),
    makeDirectory: refuse("makeDirectory", real.makeDirectory, first),
    makeTempDirectory: refuse("makeTempDirectory", real.makeTempDirectory, temp),
    makeTempDirectoryScoped: refuse("makeTempDirectoryScoped", real.makeTempDirectoryScoped, temp),
    makeTempFile: refuse("makeTempFile", real.makeTempFile, temp),
    makeTempFileScoped: refuse("makeTempFileScoped", real.makeTempFileScoped, temp),
    open: refuse("open", real.open, first),
    remove: refuse("remove", real.remove, first),
    rename: refuse("rename", real.rename, both),
    sink: (value, options) =>
      inside(value) ? Sink.fail(permissionDenied("sink", value, refusedDescription)) : real.sink(value, options),
    stream: (value, options) =>
      inside(value) ? Stream.fail(permissionDenied("stream", value, refusedDescription)) : real.stream(value, options),
    // The link's own location is what's written; its target is just a string.
    symlink: refuse("symlink", real.symlink, (_target: string, link: string) => [link]),
    truncate: refuse("truncate", real.truncate, first),
    utimes: refuse("utimes", real.utimes, first),
    writeFile: refuse("writeFile", real.writeFile, first),
    writeFileString: refuse("writeFileString", real.writeFileString, first),
    writeJson: refuse("writeJson", real.writeJson, first),
    ensureDir: refuse("ensureDir", real.ensureDir, first),
    writeWithDirs: refuse("writeWithDirs", real.writeWithDirs, first),
  }
  return { ...real, ...overrides } as FSUtil.Interface
}

/** The FSUtil layer for job mode: the real FSUtil (over the platform FileSystem), wrapped. */
export const layer = (root: KeteConfinedFs.Root) =>
  Layer.effect(
    FSUtil.Service,
    Effect.gen(function* () {
      const real = yield* FSUtil.Service
      return FSUtil.Service.of(wrap(real, root))
    }),
  ).pipe(Layer.provide(FSUtil.layer))
