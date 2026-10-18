// Memory files beyond upstream's AGENTS.md: CLAUDE.md compatibility, `@path` imports and nested files.
//
// - Where a folder has no AGENTS.md, its CLAUDE.md (or .claude/CLAUDE.md) is loaded instead, and
//   ~/.claude/CLAUDE.md joins the global instructions. `kete.memory.claudeMd: false` turns this off.
// - `@path` tokens in AGENTS.md and CLAUDE.md pull the named file into context right after the file
//   that names it (up to 5 levels deep, 64 KiB per file, 256 KiB per memory file). A token that can't be
//   read is left as written and a note line is appended to the file that names it.
//   `kete.memory.imports: false` turns this off.
// - Reading a file also loads the CLAUDE.md files of its folders (and their imports), as upstream does
//   for AGENTS.md. This uses the tool `execute.after` hook, so tool/plugin/read.ts stays unedited.
//
// This plugin runs after upstream's ConfigInstructionPlugin and rewrites the InstructionDiscovery entries
// it produced: upstream's AGENTS.md entries keep their content, CLAUDE.md entries and imports are added
// in render order, and entries from other contributors stay where they were.
//
// Security: an import reads a file into model context, so what may be read is decided in
// memory-imports.ts (allowed folders only, no credential files, only *.md from ~/.claude and the global
// config folder). A refused path is never read. Known gap: the nested half hands paths to
// SessionInstructions.load, which reads them again; a file swapped between the check and that read
// (inside an allowed folder) is not re-checked.

export * as KeteMemoryFiles from "./memory-files.js"

import { dirname, join } from "path"
import { define } from "@opencode/plugin/effect/plugin"
import type { Context as PluginContext } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { Effect, Predicate, PubSub, Semaphore, Stream } from "effect"
import { Config } from "../config.js"
import { Watcher } from "../filesystem/watcher.js"
import { FileAccess } from "../file-access.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Location } from "../location.js"
import { AbsolutePath } from "../schema.js"
import { SessionInstructions } from "../session/instructions.js"
import { KeteMemoryImports } from "./memory-imports.js"

export interface Memory {
  readonly path: string
  readonly content: string
}

export interface Expanded extends Memory {
  /** Imported files in render order (each directly after the file that names it), notes included. */
  readonly imports: readonly Memory[]
  /** One line per import that was refused; already appended to `content` and the importing file. */
  readonly notes: readonly string[]
}

interface Pending {
  readonly path: string
  readonly content: string
  readonly notes: string[]
}

const withNotes = (item: Pending): Memory => ({
  path: item.path,
  content: item.notes.length === 0 ? item.content : `${item.content}\n\n${item.notes.join("\n")}`,
})

/** Expands the `@path` imports of memory files. A file already seen (a memory file, or loaded earlier) loads once. */
export const expand = Effect.fn("KeteMemoryFiles.expand")(function* (
  fs: FSUtil.Interface,
  files: readonly Memory[],
  roots: readonly KeteMemoryImports.Root[],
  home: string,
) {
  const seen = new Set<string>(yield* Effect.forEach(files, (file) => fs.resolve(file.path)))
  const results: Expanded[] = []
  for (const file of files) {
    const top: Pending = { path: file.path, content: file.content, notes: [] }
    const loaded: Pending[] = []
    let used = 0
    const visit = (item: Pending, depth: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (depth >= KeteMemoryImports.MAX_DEPTH) return
        const dir = dirname(item.path)
        for (const token of KeteMemoryImports.importTokens(item.content)) {
          const real = yield* fs.resolve(KeteMemoryImports.target(token, dir, home))
          if (seen.has(real)) continue
          const refuse = (reason: KeteMemoryImports.Skip) => {
            item.notes.push(KeteMemoryImports.note(token, reason))
            return Effect.logDebug("memory import skipped", { token, path: real, reason })
          }
          const reason = KeteMemoryImports.denied(real, roots, home)
          if (reason) {
            yield* refuse(reason)
            continue
          }
          const info = yield* fs.stat(real).pipe(Effect.catch(() => Effect.undefined))
          if (!info) {
            yield* Effect.logDebug("memory import skipped", { token, path: real, reason: "missing" })
            continue
          }
          if (info.type !== "File") {
            yield* refuse("not-file")
            continue
          }
          const size = Number(info.size)
          if (size > KeteMemoryImports.MAX_FILE) {
            yield* refuse("too-large")
            continue
          }
          if (used + size > KeteMemoryImports.MAX_TOTAL) {
            yield* refuse("total")
            continue
          }
          const content = yield* fs.readFileStringSafe(real).pipe(Effect.catch(() => Effect.undefined))
          if (content === undefined) {
            yield* Effect.logDebug("memory import skipped", { token, path: real, reason: "unreadable" })
            continue
          }
          // The file may have grown since stat; the read text is what counts.
          const bytes = Buffer.byteLength(content)
          if (bytes > KeteMemoryImports.MAX_FILE) {
            yield* refuse("too-large")
            continue
          }
          used += bytes
          seen.add(real)
          const child: Pending = { path: real, content, notes: [] }
          loaded.push(child)
          yield* visit(child, depth + 1)
        }
      })
    yield* visit(top, 0)
    const rendered = withNotes(top)
    results.push({ ...rendered, imports: loaded.map(withNotes), notes: top.notes })
  }
  return results
})

function ancestorDirectories(start: string, stop: string): string[] {
  if (start === stop) return [start]
  return [start, ...ancestorDirectories(dirname(start), stop)]
}

interface Item {
  readonly path: string
  readonly content: string
  /** A CLAUDE.md that upstream doesn't load; AGENTS.md entries come from upstream. */
  readonly kete: boolean
  readonly imports: readonly Memory[]
  readonly hasNotes: boolean
}

type Loaded = { readonly type: "available"; readonly items: Item[] } | { readonly type: "unavailable" }

const CLAUDE_NAMES = [["CLAUDE.md"], [".claude", "CLAUDE.md"]] as const

export const Plugin = define({
  id: "kete.memory-files",
  effect: Effect.fn("KeteMemoryFiles.Plugin")(function* (ctx: PluginContext) {
    const discovery = yield* InstructionDiscovery.Service
    if (!discovery.project && !discovery.global) return
    yield* Effect.gen(function* () {
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const location = yield* Location.Service
      const watcher = yield* Watcher.Service
      const config = yield* Config.Service
      const access = yield* FileAccess.Service
      const sessionInstructions = yield* SessionInstructions.Service
      const changes = yield* PubSub.sliding<string>(1)
      const lock = Semaphore.makeUnsafe(1)
      const start = yield* fs.resolve(location.directory)
      const root = yield* fs.resolve(location.project.directory)
      const home = yield* fs.resolve(global.home)
      const project = discovery.project && FSUtil.contains(root, start)
      const stop = FSUtil.contains(home, start) ? home : root
      const globalFile = yield* fs.resolve(join(global.config, "AGENTS.md"))
      const claudeHome = yield* fs.resolve(join(home, ".claude"))
      const claudeGlobal = join(claudeHome, "CLAUDE.md")
      const userRoots: KeteMemoryImports.Root[] = [
        { path: claudeHome, markdownOnly: true },
        { path: yield* fs.resolve(global.config), markdownOnly: true },
      ]
      const projectRoots: KeteMemoryImports.Root[] = [
        ...(discovery.project ? [{ path: root, markdownOnly: false }] : []),
        ...(discovery.global ? userRoots : []),
      ]
      const globalRoots: KeteMemoryImports.Root[] = [
        ...userRoots,
        ...(discovery.project ? [{ path: root, markdownOnly: false }] : []),
      ]
      const loaded: { current: Loaded } = { current: { type: "available", items: [] } }

      const settings = Effect.fn("KeteMemoryFiles.settings")(function* () {
        const memory = Config.latest(yield* config.entries(), "kete")?.memory
        return { claudeMd: memory?.claudeMd !== false, imports: memory?.imports !== false }
      })

      const claudeCandidates = (dir: string) => CLAUDE_NAMES.map((name) => join(dir, ...name))

      // Everything that can become a memory file; watched even while absent so creating one is noticed.
      const candidates = [
        ...(discovery.global ? [globalFile, claudeGlobal] : []),
        ...(project
          ? ancestorDirectories(start, stop).flatMap((dir) => [join(dir, "AGENTS.md"), ...claudeCandidates(dir)])
          : []),
      ]

      const watched = new Set<string>()
      const publish = (update: Watcher.Update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid)
      const watchAll = Effect.fn("KeteMemoryFiles.watchAll")(function* (paths: Iterable<string>) {
        for (const path of paths) {
          // fs.watch throws for a missing folder; try again on the next rescan.
          if (watched.has(path) || !(yield* fs.isDir(dirname(path)))) continue
          watched.add(path)
          // shortcut: watched imports are never unsubscribed, bounded by the import cap; unsubscribe on a rescan if it ever matters
          const updates = yield* watcher.subscribe({ path, type: "file" })
          yield* updates.pipe(Stream.runForEach(publish), Effect.forkScoped({ startImmediately: true }))
        }
      })

      const firstFile = Effect.fn("KeteMemoryFiles.firstFile")(function* (paths: readonly string[]) {
        for (const path of paths) if (yield* fs.isFile(path)) return path
        return undefined
      })

      /** The memory file a folder contributes: AGENTS.md, else (with claudeMd) CLAUDE.md or .claude/CLAUDE.md. */
      const pick = Effect.fn("KeteMemoryFiles.pick")(function* (dir: string, claudeMd: boolean) {
        const agents = join(dir, "AGENTS.md")
        if (yield* fs.isFile(agents)) return { path: yield* fs.resolve(agents), kete: false }
        if (!claudeMd) return undefined
        const claude = yield* firstFile(claudeCandidates(dir))
        return claude ? { path: yield* fs.resolve(claude), kete: true } : undefined
      })

      const refresh = Effect.fn("KeteMemoryFiles.refresh")(
        function* (file?: string) {
          const { claudeMd, imports } = yield* settings()
          const picked: { path: string; kete: boolean; global: boolean }[] = []
          const add = (entry: { path: string; kete: boolean } | undefined, isGlobal: boolean) => {
            if (entry && !picked.some((item) => item.path === entry.path)) picked.push({ ...entry, global: isGlobal })
          }
          if (discovery.global) {
            if (yield* fs.isFile(globalFile)) add({ path: globalFile, kete: false }, true)
            if (claudeMd && (yield* fs.isFile(claudeGlobal))) add({ path: yield* fs.resolve(claudeGlobal), kete: true }, true)
          }
          if (project) {
            for (const dir of ancestorDirectories(start, stop)) {
              const entry = yield* pick(dir, claudeMd)
              // The walk can reach the global files; global: false excludes them there too.
              if (entry && !discovery.global && (entry.path === globalFile || entry.path === claudeGlobal)) continue
              add(entry, false)
            }
          }

          const files: (Memory & { kete: boolean; global: boolean })[] = []
          for (const item of picked) {
            const content = yield* fs.readFileStringSafe(item.path)
            if (content === undefined) {
              // An unreadable CLAUDE.md is ours to report; upstream reports its own AGENTS.md.
              if (!item.kete) continue
              loaded.current = { type: "unavailable" }
              return
            }
            files.push({ ...item, content })
          }

          const expanded = new Map<string, Expanded>()
          if (imports) {
            for (const [group, roots] of [
              [files.filter((item) => item.global), globalRoots],
              [files.filter((item) => !item.global), projectRoots],
            ] as const)
              for (const result of yield* expand(fs, group, roots, home)) expanded.set(result.path, result)
          }
          loaded.current = {
            type: "available",
            items: files.map((item) => {
              const result = expanded.get(item.path)
              return {
                path: item.path,
                kete: item.kete,
                content: result?.content ?? item.content,
                imports: result?.imports ?? [],
                hasNotes: (result?.notes.length ?? 0) > 0,
              }
            }),
          }
          yield* watchAll([...candidates, ...(loaded.current.items.flatMap((item) => item.imports.map((i) => i.path)))])
          if (!file) return
          yield* Effect.logDebug("memory files rescanned", { file, files: loaded.current.items.map((item) => item.path) })
        },
        (effect, ..._args: [file?: string]) => lock.withPermit(effect),
      )

      const isolate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to load memory files", { cause }).pipe(
              Effect.andThen(Effect.sync(() => void (loaded.current = { type: "unavailable" }))),
            ),
          ),
        )

      // Subscribe before debouncing so no update slips through while the debounce starts its pull.
      const updates = yield* PubSub.subscribe(changes)
      yield* Stream.fromSubscription(updates).pipe(
        Stream.debounce("100 millis"),
        Stream.runForEach((file) => isolate(refresh(file)).pipe(Effect.andThen(discovery.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      yield* isolate(refresh())

      yield* discovery.transform((editor) => {
        if (loaded.current.type === "unavailable") {
          editor.unavailable()
          return
        }
        const items = loaded.current.items
        if (!items.some((item) => item.kete || item.imports.length > 0 || item.hasNotes)) return
        const before = editor.list().map((entry) => ({ path: entry.path, content: entry.content }))
        const upstream = new Set<string>(before.map((entry) => entry.path))
        for (const entry of before) editor.remove(entry.path)
        const emitted = new Set<string>()
        const emit = (entry: Memory) => {
          if (emitted.has(entry.path)) return
          emitted.add(entry.path)
          editor.add(new InstructionDiscovery.File({ path: AbsolutePath.make(entry.path), content: entry.content }))
        }
        for (const item of items) {
          if (!item.kete && !upstream.has(item.path)) continue
          emit(item)
          item.imports.forEach(emit)
        }
        for (const entry of before) emit(entry)
      })

      // Nested memory files: a read also loads the CLAUDE.md files of the folders between the file and the
      // Location root (the root's own are initial instructions), as upstream does for AGENTS.md.
      yield* ctx.tool.hook("execute.after", (event) =>
        Effect.gen(function* () {
          if (event.tool !== "read" || event.status !== "completed" || !discovery.project) return
          const requested =
            Predicate.isObject(event.input) && Predicate.hasProperty(event.input, "path") ? event.input.path : undefined
          if (typeof requested !== "string") return
          const output = event.result.output
          const listing = Predicate.isObject(output) && Predicate.hasProperty(output, "type") && output.type === "list-page"
          const target = yield* access.resolve({ path: requested })
          if (target.externalDirectory !== undefined) return
          const resolved = yield* fs.resolve(target.absolute)
          const cwd = yield* fs.resolve(location.directory)
          const from = listing ? resolved : dirname(resolved)
          if (!FSUtil.contains(cwd, from)) return
          const { claudeMd, imports } = yield* settings()
          const known = new Set<string>()
          const preloaded = yield* discovery.list()
          if (Array.isArray(preloaded)) for (const entry of preloaded) known.add(entry.path)

          const files: (Memory & { kete: boolean })[] = []
          for (const dir of ancestorDirectories(from, cwd).filter((item) => item !== cwd)) {
            const entry = yield* pick(dir, claudeMd)
            if (!entry || known.has(entry.path)) continue
            if (!entry.kete && !imports) continue
            const content = yield* fs.readFileStringSafe(entry.path)
            if (content !== undefined) files.push({ ...entry, content })
          }
          const results = imports ? yield* expand(fs, files, projectRoots, home) : files.map((item) => ({ ...item, imports: [], notes: [] as string[] }))
          for (const result of results) for (const note of result.notes) yield* Effect.logDebug("memory import skipped", { note })
          const paths = results.flatMap((result, index) => [
            ...(files[index]!.kete ? [result.path] : []),
            ...result.imports.map((item) => item.path),
          ])
          const fresh = paths.filter((path) => !known.has(path))
          if (fresh.length === 0) return
          yield* sessionInstructions.load({ sessionID: event.sessionID, paths: fresh })
        }).pipe(
          Effect.catchCause((cause) => Effect.logDebug("nested memory files skipped", { cause })),
        ),
      )
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to activate memory files", { cause }).pipe(Effect.asVoid),
      ),
    )
  }),
})
