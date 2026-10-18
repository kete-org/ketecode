import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, Stream } from "effect"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigInstructionPlugin } from "@opencode/core/config/plugin/instruction"
import { FileAccess } from "@opencode/core/file-access"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { KeteMemoryFiles } from "@opencode/core/kete/memory-files"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { location } from "../fixture/location"
import { tmpdir } from "../fixture/tmpdir"
import { readInitial, readUpdate } from "../lib/instructions"
import { testEffect } from "../lib/effect"
import { host } from "../plugin/host"

const it = testEffect(Layer.empty)

interface Scenario {
  /** Files to create, relative to the tmp folder (`home/repo/...` is the project, `global/...` the config dir). */
  readonly files?: Record<string, string>
  /** Symlinks to create: [link, target], both relative to the tmp folder. */
  readonly links?: readonly [string, string][]
  /** The location directory, relative to the project. */
  readonly directory?: string
  readonly project?: boolean
  readonly global?: boolean
  readonly memory?: { claudeMd?: boolean; imports?: boolean }
  /** Run with the home folder as the project root (a cwd with no repository). */
  readonly projectAtHome?: boolean
  /** No version control: the project root is just the cwd. */
  readonly noRepository?: boolean
  /** A project kete.json `kete` object, after the global one. */
  readonly projectKete?: Record<string, unknown>
  /** Relative symlinks: [link, target as written], the link relative to the tmp folder. */
  readonly relLinks?: readonly [string, string][]
}

interface World {
  readonly base: string
  readonly project: string
  readonly home: string
  readonly global: string
  readonly discovery: InstructionDiscovery.Interface
  readonly loads: string[][]
  readonly text: Effect.Effect<string, unknown>
  /** Runs the read tool's execute.after hook for `target` (a path relative to the project). */
  readonly read: (target: string) => Effect.Effect<void>
  readonly change: (file: string) => Effect.Effect<void, unknown, Watcher.Test | Bus.Service>
}

const scenario = (
  input: Scenario,
  body: (world: World) => Effect.Effect<void, unknown, Watcher.Test | Bus.Service>,
) =>
  Effect.acquireRelease(
    Effect.promise(() => tmpdir()),
    (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
  ).pipe(
    Effect.flatMap((tmp) =>
      Effect.gen(function* () {
        const base = yield* Effect.promise(() => fs.realpath(tmp.path))
        const project = input.projectAtHome ? path.join(base, "home") : path.join(base, "home", "repo")
        const home = path.join(base, "home")
        const global = path.join(base, "global")
        yield* Effect.promise(async () => {
          await fs.mkdir(project, { recursive: true })
          await fs.mkdir(global, { recursive: true })
          for (const [name, content] of Object.entries(input.files ?? {})) {
            await fs.mkdir(path.dirname(path.join(base, name)), { recursive: true })
            await fs.writeFile(path.join(base, name), content)
          }
          for (const [link, target] of input.links ?? []) {
            await fs.mkdir(path.dirname(path.join(base, link)), { recursive: true })
            await fs.symlink(path.join(base, target), path.join(base, link))
          }
          for (const [link, target] of input.relLinks ?? []) {
            await fs.mkdir(path.dirname(path.join(base, link)), { recursive: true })
            await fs.symlink(target, path.join(base, link))
          }
        })
        const directory = path.join(project, input.directory ?? "")
        const loads: string[][] = []
        const hooks: ((event: never) => Effect.Effect<void>)[] = []
        const watcher = Watcher.testLayer
        const layer = Layer.mergeAll(
          AppNodeBuilder.build(
            LayerNode.group([InstructionDiscovery.node, Bus.node, FSUtil.node, Global.node, Location.node, Watcher.node]),
            [
              InstructionDiscovery.node.replace(
                InstructionDiscovery.configured({ project: input.project, global: input.global }),
              ),
              Global.node.replace(Global.layerWith({ config: global, home })),
              Location.node.replace(
                Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(directory) },
                      { projectDirectory: AbsolutePath.make(project), vcs: input.noRepository ? undefined : { type: "git", store: AbsolutePath.make(path.join(project, ".git")) } },
                    ),
                  ),
                ),
              ),
              Watcher.node.replace(watcher),
            ],
          ),
          watcher,
          Config.testLayer([
            { type: "document", path: path.join(global, "kete.json"), info: { kete: { memory: input.memory } } } as never,
            ...(input.projectKete
              ? [{ type: "document", path: path.join(project, "kete.json"), info: { kete: input.projectKete } } as never]
              : []),
          ]),
          Layer.succeed(
            FileAccess.Service,
            FileAccess.Service.of({
              resolve: (request: { path: string }) => Effect.succeed({ absolute: path.resolve(directory, request.path) }),
            } as never),
          ),
          Layer.succeed(
            SessionInstructions.Service,
            SessionInstructions.Service.of({
              load: (request) => Effect.sync(() => void loads.push([...request.paths])),
            }),
          ),
        )
        return yield* Effect.gen(function* () {
          // Upstream's plugin loads the AGENTS.md entries that this one rewrites.
          yield* ConfigInstructionPlugin.Plugin.effect(host())
          yield* KeteMemoryFiles.Plugin.effect(
            host({
              tool: {
                transform: () => Effect.die("unused"),
                reload: () => Effect.die("unused"),
                list: () => Effect.die("unused"),
                hook: ((name: string, callback: (event: never) => Effect.Effect<void>) =>
                  Effect.sync(() => {
                    if (name === "execute.after") hooks.push(callback)
                    return {}
                  })) as never,
              },
            }),
          )
          const discovery = yield* InstructionDiscovery.Service
          yield* body({
            base,
            project,
            home,
            global,
            discovery,
            loads,
            text: discovery.load().pipe(
              Effect.flatMap(readInitial),
              Effect.map((initial) => initial.text),
            ),
            read: (target) =>
              Effect.forEach(
                hooks,
                (hook) =>
                  hook({
                    tool: "read",
                    status: "completed",
                    sessionID: "ses_test",
                    input: { path: target },
                    result: { output: { type: "file" } },
                  } as never),
                { discard: true },
              ),
            change: (file) => emitAndWait({ type: "update", path: file }),
          })
        }).pipe(Effect.provide(layer))
      }),
    ),
  )

function emitAndWait(update: Watcher.Update) {
  return Effect.scoped(Effect.gen(function* () {
    const watcher = yield* Watcher.Test
    const bus = yield* Bus.Service
    const updated = yield* Deferred.make<void>()
    const fiber = yield* bus.subscribe(InstructionDiscovery.Event.Updated).pipe(
      Stream.runForEach(() => Deferred.succeed(updated, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    yield* watcher.emit(update)
    yield* Deferred.await(updated).pipe(Effect.timeout("2 seconds"))
    yield* Fiber.interrupt(fiber)
  }))
}

const block = (file: string, content: string) => `Instructions from: ${file}\n${content}`

describe("KeteMemoryFiles.Plugin", () => {
  it.live("loads CLAUDE.md where there is no AGENTS.md, and .claude/CLAUDE.md after it", () =>
    scenario(
      {
        files: {
          "home/repo/CLAUDE.md": "root claude",
          "home/repo/a/AGENTS.md": "a agents",
          "home/repo/a/CLAUDE.md": "a claude",
          "home/repo/b/.claude/CLAUDE.md": "b dot claude",
          "home/repo/b/CLAUDE.md": "b claude",
          "home/repo/c/.claude/CLAUDE.md": "c dot claude",
        },
        directory: "a",
      },
      (world) =>
        Effect.gen(function* () {
          // CLAUDE.md in a folder that has an AGENTS.md is ignored.
          expect(yield* world.text).toBe(
            [block(path.join(world.project, "a", "AGENTS.md"), "a agents"), block(path.join(world.project, "CLAUDE.md"), "root claude")].join("\n\n"),
          )
        }),
    ),
  )

  it.live("prefers CLAUDE.md over .claude/CLAUDE.md in one folder, and loads the latter alone", () =>
    scenario(
      {
        files: { "home/repo/b/.claude/CLAUDE.md": "dot", "home/repo/b/CLAUDE.md": "plain", "home/repo/c/.claude/CLAUDE.md": "c dot" },
        directory: "b",
      },
      (world) =>
        Effect.gen(function* () {
          expect(yield* world.text).toBe(block(path.join(world.project, "b", "CLAUDE.md"), "plain"))
        }),
    ).pipe(
      Effect.andThen(
        scenario({ files: { "home/repo/c/.claude/CLAUDE.md": "c dot" }, directory: "c" }, (world) =>
          Effect.gen(function* () {
            expect(yield* world.text).toBe(block(path.join(world.project, "c", ".claude", "CLAUDE.md"), "c dot"))
          }),
        ),
      ),
    ),
  )

  it.live("loads a symlinked CLAUDE.md once when it points at an AGENTS.md", () =>
    scenario(
      {
        files: { "home/repo/AGENTS.md": "shared" },
        links: [["home/repo/CLAUDE.md", "home/repo/AGENTS.md"]],
      },
      (world) =>
        Effect.gen(function* () {
          expect(yield* world.text).toBe(block(path.join(world.project, "AGENTS.md"), "shared"))
        }),
    ),
  )

  it.live("orders global files first: AGENTS.md, then ~/.claude/CLAUDE.md, then the project", () =>
    scenario(
      {
        files: {
          "global/AGENTS.md": "global agents",
          "home/.claude/CLAUDE.md": "home claude",
          "home/repo/CLAUDE.md": "project claude",
        },
      },
      (world) =>
        Effect.gen(function* () {
          expect(yield* world.text).toBe(
            [
              block(path.join(world.global, "AGENTS.md"), "global agents"),
              block(path.join(world.home, ".claude", "CLAUDE.md"), "home claude"),
              block(path.join(world.project, "CLAUDE.md"), "project claude"),
            ].join("\n\n"),
          )
        }),
    ),
  )

  it.live("global: false loads no global CLAUDE.md", () =>
    scenario(
      { files: { "home/.claude/CLAUDE.md": "home claude", "home/repo/CLAUDE.md": "project claude" }, global: false },
      (world) =>
        Effect.gen(function* () {
          expect(yield* world.text).toBe(block(path.join(world.project, "CLAUDE.md"), "project claude"))
        }),
    ),
  )

  it.live("puts an import right after its importer and follows five levels", () =>
    scenario(
      {
        files: {
          "home/repo/CLAUDE.md": "root\n@./docs/l1.md",
          "home/repo/docs/l1.md": "l1 @./l2.md",
          "home/repo/docs/l2.md": "l2 @./l3.md",
          "home/repo/docs/l3.md": "l3 @./l4.md",
          "home/repo/docs/l4.md": "l4 @./l5.md",
          "home/repo/docs/l5.md": "l5 @./l6.md",
          "home/repo/docs/l6.md": "l6",
          "home/repo/AGENTS.md": "agents\n@./docs/l1.md\n@./docs/cycle.md",
          "home/repo/docs/cycle.md": "cycle @./cycle.md",
        },
        directory: "other",
      },
      (world) =>
        Effect.gen(function* () {
          const text = yield* world.text
          const order = ["AGENTS.md", "docs/l1.md", "docs/l2.md", "docs/l3.md", "docs/l4.md", "docs/l5.md", "docs/cycle.md"].map(
            (file) => text.indexOf(`Instructions from: ${path.join(world.project, file)}`),
          )
          expect(order.every((index) => index >= 0)).toBe(true)
          expect([...order].sort((a, b) => a - b)).toEqual(order)
          expect(text).not.toContain("docs/l6.md")
          // A cycle and a repeated import load once. AGENTS.md wins over CLAUDE.md in a folder.
          for (const file of ["cycle.md", "l1.md"])
            expect(text.split(`Instructions from: ${path.join(world.project, "docs", file)}`).length).toBe(2)
          expect(text).not.toContain(path.join(world.project, "CLAUDE.md"))
        }),
    ),
  )

  it.live("refuses secrets and escapes with a note, and never reads them", () =>
    scenario(
      {
        files: {
          "home/repo/CLAUDE.md": [
            "@./.env",
            "@~/.ssh/id_rsa",
            "@../outside.md",
            "@./link.md",
            "@./big.md",
            "@./server.pem",
            "@./missing.md",
          ].join("\n"),
          "home/repo/.env": "TOPSECRET=env",
          "home/.ssh/id_rsa": "TOPSECRET=ssh",
          "home/outside.md": "TOPSECRET=outside",
          "outside-target/secret.md": "TOPSECRET=link",
          "home/repo/big.md": "x".repeat(65 * 1024),
          "home/repo/server.pem": "TOPSECRET=pem",
        },
        links: [["home/repo/link.md", "outside-target/secret.md"]],
      },
      (world) =>
        Effect.gen(function* () {
          const text = yield* world.text
          expect(text).not.toContain("TOPSECRET")
          expect(text).not.toContain("xxxx")
          for (const token of ["@./.env", "@~/.ssh/id_rsa", "@../outside.md", "@./link.md", "@./big.md", "@./server.pem"])
            expect(text).toContain(`(import of ${token.slice(1)} skipped:`)
          // A missing target is left alone, with no note.
          expect(text).not.toContain("import of ./missing.md")
        }),
    ),
  )

  it.live("stops importing once a memory file's imports pass 256 KiB", () =>
    scenario(
      {
        files: {
          "home/repo/CLAUDE.md": [1, 2, 3, 4, 5].map((n) => `@./f${n}.md`).join("\n"),
          ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`home/repo/f${n}.md`, `F${n}`.padEnd(60 * 1024, "-")])),
        },
      },
      (world) =>
        Effect.gen(function* () {
          const text = yield* world.text
          expect(text).toContain("F4")
          expect(text).not.toContain("F5-")
          expect(text).toContain("(import of ./f5.md skipped:")
        }),
    ),
  )

  it.live("re-renders when CLAUDE.md or an imported file changes", () =>
    scenario(
      { files: { "home/repo/CLAUDE.md": "root @./note.md", "home/repo/note.md": "note v1" } },
      (world) =>
        Effect.gen(function* () {
          const initial = yield* readInitial(yield* world.discovery.load())
          const claude = path.join(world.project, "CLAUDE.md")
          const note = path.join(world.project, "note.md")

          yield* Effect.promise(() => fs.writeFile(note, "note v2"))
          yield* world.change(note)
          expect((yield* readUpdate(yield* world.discovery.load(), initial)).text).toContain("note v2")

          yield* Effect.promise(() => fs.writeFile(claude, "root v2"))
          yield* world.change(claude)
          const text = yield* world.text
          expect(text).toContain("root v2")
          expect(text).not.toContain("note v2")
        }),
    ),
  )

  it.live("loads a nested CLAUDE.md once when a file below it is read", () =>
    scenario(
      {
        files: {
          "home/repo/CLAUDE.md": "root",
          "home/repo/sub/CLAUDE.md": "sub @./extra.md",
          "home/repo/sub/extra.md": "extra",
          "home/repo/sub/x.ts": "export {}",
          "home/repo/other/AGENTS.md": "other @./more.md",
          "home/repo/other/more.md": "more",
        },
      },
      (world) =>
        Effect.gen(function* () {
          yield* world.read("sub/x.ts")
          expect(world.loads).toEqual([[path.join(world.project, "sub", "CLAUDE.md"), path.join(world.project, "sub", "extra.md")]])
          // Folders with an AGENTS.md load it upstream; only its imports are ours.
          yield* world.read("other/x.ts")
          expect(world.loads[1]).toEqual([path.join(world.project, "other", "more.md")])
        }),
    ),
  )

  it.live("honours kete.memory.claudeMd and imports being off", () =>
    scenario(
      {
        files: { "home/repo/CLAUDE.md": "root @./note.md", "home/repo/AGENTS.md": "agents @./note.md", "home/repo/note.md": "note" },
        memory: { claudeMd: false },
      },
      (world) =>
        Effect.gen(function* () {
          const text = yield* world.text
          expect(text).toContain(block(path.join(world.project, "note.md"), "note"))
          expect(text).not.toContain("CLAUDE.md")
        }),
    ).pipe(
      Effect.andThen(
        scenario(
          {
            files: { "home/repo/CLAUDE.md": "root @./note.md", "home/repo/note.md": "note" },
            memory: { imports: false },
          },
          (world) =>
            Effect.gen(function* () {
              const text = yield* world.text
              expect(text).toBe(block(path.join(world.project, "CLAUDE.md"), "root @./note.md"))
            }),
        ),
      ),
    ),
  )

  it.live("adds nothing when project discovery is off (job review mode)", () =>
    scenario(
      { files: { "home/repo/CLAUDE.md": "root", "home/repo/sub/CLAUDE.md": "sub" }, project: false, global: false },
      (world) =>
        Effect.gen(function* () {
          expect(yield* world.discovery.list()).toEqual([])
          yield* world.read("sub/x.ts")
          expect(world.loads).toEqual([])
        }),
    ),
  )
})

describe("KeteMemoryFiles security review", () => {
  const posix = process.platform !== "win32"

  ;(posix ? it.live : it.live.skip)("a CLAUDE.md symlinked to a key, or a .claude folder linked to another repo, is not loaded", () =>
    scenario(
      {
        files: { "home/.ssh/id_rsa": "PRIVATE KEY", "home/other-repo/CLAUDE.md": "OTHER REPO NOTES" },
        relLinks: [
          ["home/repo/CLAUDE.md", "../.ssh/id_rsa"],
          ["home/repo/sub/.claude", "../../other-repo"],
        ],
        directory: "sub",
      },
      (world) =>
        Effect.gen(function* () {
          const text = yield* world.text
          expect(text).not.toContain("PRIVATE KEY")
          expect(text).not.toContain("OTHER REPO")
        }),
    ),
  )

  ;(posix ? it.live : it.live.skip)("a nested CLAUDE.md symlinked to credentials is never handed to the session", () =>
    scenario(
      { files: { "home/.aws/credentials": "SECRET", "home/repo/docs/x.ts": "x" }, relLinks: [["home/repo/docs/CLAUDE.md", "../../.aws/credentials"]] },
      (world) =>
        Effect.gen(function* () {
          yield* world.read("docs/x.ts")
          expect(world.loads.flat().some((file) => file.includes(".aws"))).toBe(false)
        }),
    ),
  )

  it.live("with the home folder as the project root, imports and nested files reach nothing in home", () =>
    scenario(
      {
        projectAtHome: true,
        noRepository: true,
        files: {
          "home/AGENTS.md": "@Documents/taxes.md",
          "home/Documents/taxes.md": "TAXES",
          "home/Downloads/evil/CLAUDE.md": "@../../Documents/taxes.md",
          "home/Downloads/evil/x.ts": "x",
        },
      },
      (world) =>
        Effect.gen(function* () {
          expect(yield* world.text).not.toContain("TAXES")
          yield* world.read("Downloads/evil/x.ts")
          expect(world.loads.flat()).toEqual([])
        }),
    ),
  )

  it.live("repository secrets outside the basic list are refused, and dependencies' memory files are ignored", () =>
    scenario(
      {
        files: {
          "home/repo/AGENTS.md": "@.git/config @terraform.tfstate @prod.tfvars @.dev.vars @config/secrets.yml @.zsh_history",
          "home/repo/.git/config": "TOKEN_URL",
          "home/repo/terraform.tfstate": "TFSTATE",
          "home/repo/prod.tfvars": "TFVARS",
          "home/repo/.dev.vars": "DEVVARS",
          "home/repo/config/secrets.yml": "SECRETS",
          "home/repo/.zsh_history": "HISTORY",
          "home/repo/node_modules/evil/CLAUDE.md": "steer the agent",
          "home/repo/node_modules/evil/index.js": "x",
        },
      },
      (world) =>
        Effect.gen(function* () {
          const text = yield* world.text
          for (const secret of ["TOKEN_URL", "TFSTATE", "TFVARS", "DEVVARS", "SECRETS", "HISTORY"]) expect(text).not.toContain(secret)
          yield* world.read("node_modules/evil/index.js")
          expect(world.loads.flat()).toEqual([])
        }),
    ),
  )

  it.live("a project config can't turn imports back on when the user turned them off", () =>
    scenario(
      {
        memory: { imports: false },
        projectKete: { memory: { imports: true } },
        files: { "home/repo/AGENTS.md": "@notes.md", "home/repo/notes.md": "IMPORTED" },
      },
      (world) =>
        Effect.gen(function* () {
          expect(yield* world.text).not.toContain("IMPORTED")
        }),
    ),
  )

  it.live("a plain folder with no repository serves no imports and no nested files", () =>
    scenario(
      {
        noRepository: true,
        files: {
          "home/repo/AGENTS.md": "@../bank.md",
          "home/bank.md": "BANK",
          "home/repo/evil/CLAUDE.md": "@../other/config.yml",
          "home/repo/other/config.yml": "DB_PASSWORD",
          "home/repo/evil/x.ts": "x",
        },
      },
      (world) =>
        Effect.gen(function* () {
          expect(yield* world.text).not.toContain("BANK")
          yield* world.read("evil/x.ts")
          expect(world.loads.flat()).toEqual([])
        }),
    ),
  )

  it.live("a nested file imports only markdown from outside its own folder", () =>
    scenario(
      {
        files: {
          "home/repo/config/database.yml": "DB_PASSWORD",
          "home/repo/docs/guide.md": "GUIDE",
          "home/repo/.venv/lib/evil/CLAUDE.md": "@../../../config/database.yml @../../../docs/guide.md @local.txt",
          "home/repo/.venv/lib/evil/local.txt": "LOCAL",
          "home/repo/.venv/lib/evil/x.py": "x",
        },
      },
      (world) =>
        Effect.gen(function* () {
          yield* world.read(".venv/lib/evil/x.py")
          const loaded = world.loads.flat()
          expect(loaded.some((file) => file.endsWith("database.yml"))).toBe(false)
          expect(loaded.some((file) => file.endsWith("guide.md"))).toBe(true)
          expect(loaded.some((file) => file.endsWith("local.txt"))).toBe(true)
        }),
    ),
  )

  it.live("a folder outside the project (an --add-dir folder) contributes no memory files when read", () =>
    scenario(
      {
        files: {
          "home/lib/CLAUDE.md": "LIB CLAUDE",
          "home/lib/AGENTS.md": "LIB AGENTS",
          "home/lib/src/x.ts": "x",
          "home/lib/src/CLAUDE.md": "LIB NESTED",
        },
      },
      (world) =>
        Effect.gen(function* () {
          yield* world.read("../lib/src/x.ts")
          expect(world.loads.flat()).toEqual([])
          expect(yield* world.text).not.toContain("LIB")
        }),
    ),
  )

  ;(process.platform !== "win32" ? it.live : it.live.skip)("upstream's AGENTS.md symlinked to a key or another repository is not loaded at start", () =>
    scenario(
      {
        memory: { claudeMd: false, imports: false },
        files: { "home/.ssh/id_rsa": "PRIVATE KEY", "home/other/AGENTS.md": "OTHER REPO" },
        relLinks: [
          ["home/repo/AGENTS.md", "../.ssh/id_rsa"],
          ["home/repo/sub/AGENTS.md", "../../other/AGENTS.md"],
        ],
        directory: "sub",
      },
      (world) =>
        Effect.gen(function* () {
          const text = yield* world.text
          expect(text).not.toContain("PRIVATE KEY")
          expect(text).not.toContain("OTHER REPO")
        }),
    ),
  )
})

