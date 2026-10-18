// Extra working directories (kete/add-dir.ts, kete/add-dir-plugin.ts): what may be added, the metadata
// guard, the permission grant (real-path containment, explicit rules and denies win, re-checked at use)
// and the allowance rules for subagents. Real temporary folders and symlinks; a small file-system adapter
// over node:fs stands in for FSUtil.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import nfs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FSUtil } from "@opencode/util/fs-util"
import { Effect, Option } from "effect"
import { KeteAddDir } from "@opencode/core/kete/add-dir"
import { KeteAddDirPlugin } from "@opencode/core/kete/add-dir-plugin"
import { KetePermissionCeiling } from "@opencode/core/kete/permission-ceiling"
import type { SessionSchema } from "@opencode/core/session/schema"

const run = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect)

const fs = {
  existsSafe: (value: string) => Effect.sync(() => nfs.existsSync(value)),
  resolve: (value: string) => Effect.sync(() => FSUtil.resolve(value)),
  isDir: (value: string) => Effect.sync(() => nfs.statSync(value, { throwIfNoEntry: false })?.isDirectory() ?? false),
  readLink: (value: string) => Effect.try({ try: () => nfs.readlinkSync(value), catch: (error) => error }),
} as unknown as KeteAddDirPlugin.Lookup["fs"]

let root: string
let home: string
let work: string
let lib: string
let ctx: Omit<KeteAddDir.Context, "existing">

beforeAll(() => {
  root = nfs.realpathSync(nfs.mkdtempSync(path.join(os.tmpdir(), "kete-add-dir-")))
  home = path.join(root, "home")
  work = path.join(root, "work")
  lib = path.join(root, "lib")
  for (const dir of [".ssh", ".config/kete", ".config/gh", "docs"].map((item) => path.join(home, item))) nfs.mkdirSync(dir, { recursive: true })
  for (const dir of [work, lib, path.join(lib, "src"), path.join(root, "other"), path.join(work, "inside")]) nfs.mkdirSync(dir, { recursive: true })
  nfs.writeFileSync(path.join(root, "file.txt"), "x")
  ctx = { base: work, home, workspace: [work], kete: [path.join(home, ".config", "kete")] }
})
afterAll(() => nfs.rmSync(root, { recursive: true, force: true }))

const validate = (input: string, existing: string[] = []) => run(KeteAddDir.validate(fs, input, { ...ctx, existing }))

describe("add-dir validate", () => {
  test("accepts a folder (absolute, relative, with ..) as its real path", async () => {
    expect(await validate(lib)).toEqual({ ok: true, real: lib })
    expect(await validate("../lib")).toEqual({ ok: true, real: lib })
    expect(await validate("../lib/src/../../lib")).toEqual({ ok: true, real: lib })
  })

  test("refuses with a reason for each case", async () => {
    const refused = async (input: string, reason: RegExp, existing: string[] = []) => {
      const result = await validate(input, existing)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(reason)
    }
    await refused(path.join(root, "missing"), /doesn't exist/)
    await refused(path.join(root, "file.txt"), /isn't a folder/)
    await refused(path.parse(root).root, /root/)
    await refused(home, /home folder/)
    await refused(root, /home folder/) // a folder above home
    await refused(path.join(home, ".ssh"), /credentials/)
    await refused(path.join(home, ".config"), /credentials|Kete/) // contains ~/.config/gh and the Kete folder
    await refused(path.join(home, ".config", "kete"), /Kete Code's own/)
    await refused(path.join(work, "inside"), /inside the workspace/)
    await refused(work, /inside the workspace/)
    await refused("   ", /empty/)
    const many = Array.from({ length: KeteAddDir.MAX }, (_, index) => path.join(root, `m${index}`))
    await refused(path.join(root, "other"), /at most/, many)
  })

  test("an exact repeat is accepted even at the limit", async () => {
    const many = Array.from({ length: KeteAddDir.MAX - 1 }, (_, index) => path.join(root, `m${index}`))
    expect(await validate(lib, [...many, lib])).toEqual({ ok: true, real: lib })
  })

  test("a symlink to a refused folder is refused by its real path", async () => {
    const link = path.join(root, "to-ssh")
    nfs.symlinkSync(path.join(home, ".ssh"), link)
    const result = await validate(link)
    expect(result.ok).toBe(false)
  })

  test("job mode refuses every folder", async () => {
    process.env.OPENCODE_JOB_MODE = "1"
    try {
      const result = await validate(lib)
      expect(result).toEqual({ ok: false, reason: expect.stringContaining("job") })
    } finally {
      delete process.env.OPENCODE_JOB_MODE
    }
  })
})

describe("add-dir guard", () => {
  type Metadata = Parameters<typeof KeteAddDir.guard>[2]
  const guard = (before: Metadata, next: NonNullable<Metadata>) =>
    run(KeteAddDir.guard(fs, Effect.succeed(ctx), before, next))
  const refuses = (before: Metadata, next: NonNullable<Metadata>) =>
    Effect.runPromise(KeteAddDir.guard(fs, Effect.succeed(ctx), before, next).pipe(Effect.exit)).then((exit) => exit._tag === "Failure")

  test("metadata without the key passes untouched", async () => {
    const next = { "kete.permissionMode": "plan" }
    expect(await guard(undefined, next)).toBe(next)
  })

  test("stores real paths, keeps other keys, dedupes", async () => {
    const stored = await guard(undefined, { other: 1, [KeteAddDir.metadataKey]: ["../lib", lib] })
    expect(stored).toEqual({ other: 1, [KeteAddDir.metadataKey]: [lib] })
  })

  test("refuses an invalid folder, a non-list and too many", async () => {
    expect(await refuses(undefined, { [KeteAddDir.metadataKey]: [path.join(home, ".ssh")] })).toBe(true)
    expect(await refuses(undefined, { [KeteAddDir.metadataKey]: [work] })).toBe(true)
    expect(await refuses(undefined, { [KeteAddDir.metadataKey]: "lib" })).toBe(true)
    expect(await refuses(undefined, { [KeteAddDir.metadataKey]: [1] })).toBe(true)
    expect(await refuses(undefined, { [KeteAddDir.metadataKey]: Array.from({ length: KeteAddDir.MAX + 1 }, () => lib) })).toBe(true)
  })

  test("entries the session already had pass; a child inheriting its parent's folders is accepted", async () => {
    const before = { [KeteAddDir.metadataKey]: [lib] }
    expect(await guard(before, { [KeteAddDir.metadataKey]: [lib] })).toEqual(before)
    expect(await refuses(before, { [KeteAddDir.metadataKey]: [lib, path.join(home, ".ssh")] })).toBe(true)
  })

  test("job mode refuses even folders the session had", async () => {
    process.env.OPENCODE_JOB_MODE = "1"
    try {
      expect(await refuses({ [KeteAddDir.metadataKey]: [lib] }, { [KeteAddDir.metadataKey]: [lib] })).toBe(true)
    } finally {
      delete process.env.OPENCODE_JOB_MODE
    }
  })
})

type Rule = { action: string; resource: string; effect: "allow" | "ask" | "deny" }
const id = (value: string) => value as SessionSchema.ID
const info = (value: string, metadata?: Record<string, unknown>, parentID?: string, permissions?: Rule[]) =>
  ({ id: value, parentID, metadata, permissions, agent: "build" }) as unknown as SessionSchema.Info

const lookup = (
  sessions: Record<string, SessionSchema.Info>,
  rules: Rule[] = [{ action: "external_directory", resource: "*", effect: "ask" }],
  approved: Rule[] = [],
): KeteAddDirPlugin.Lookup => ({
  session: (sessionID) => Effect.succeed(Option.fromNullishOr(sessions[sessionID])),
  agent: () => Effect.succeed({ permissions: rules } as never),
  approved: Effect.succeed(approved),
  fs,
  context: Effect.succeed(ctx),
})

const request = (resources: string[], effect: "allow" | "ask" | "deny" = "ask", action = "external_directory") => ({
  sessionID: id("ses_a"),
  action,
  resources,
  effect,
})
const sessionWith = (folders: string[]) => ({ ses_a: info("ses_a", { [KeteAddDir.metadataKey]: folders }) })

describe("add-dir grants", () => {
  test("grants an ask for a directory inside an added folder, and only that", async () => {
    const l = lookup(sessionWith([lib]))
    const inside = request([`${lib}/*`, `${lib}/src/*`])
    await run(KeteAddDirPlugin.granted(l, inside))
    expect(inside.effect).toBe("allow")
    for (const resources of [[`${path.join(root, "other")}/*`], [`${lib}/*`, `${path.join(root, "other")}/*`], [`${lib}-sibling/*`]]) {
      const outside = request(resources)
      await run(KeteAddDirPlugin.granted(l, outside))
      expect(outside.effect).toBe("ask")
    }
  })

  test("a path with .. that leaves the folder is not granted", async () => {
    const l = lookup(sessionWith([lib]))
    const traversal = request([`${lib}/src/../../other/*`])
    await run(KeteAddDirPlugin.granted(l, traversal))
    expect(traversal.effect).toBe("ask")
  })

  test("a symlink inside an added folder to a protected or sibling folder grants nothing", async () => {
    const l = lookup(sessionWith([lib]))
    nfs.symlinkSync(path.join(home, ".ssh"), path.join(lib, "ssh"))
    nfs.symlinkSync(path.join(root, "other"), path.join(lib, "sibling"))
    for (const link of ["ssh", "sibling"]) {
      const event = request([`${lib}/${link}/*`])
      await run(KeteAddDirPlugin.granted(l, event))
      expect(event.effect).toBe("ask")
    }
  })

  test("a folder replaced by a symlink after it was added grants nothing", async () => {
    const swapped = path.join(root, "swapped")
    nfs.mkdirSync(swapped)
    const l = lookup(sessionWith([swapped]))
    const before = request([`${swapped}/*`])
    await run(KeteAddDirPlugin.granted(l, before))
    expect(before.effect).toBe("allow")
    nfs.rmdirSync(swapped)
    nfs.symlinkSync(path.join(root, "other"), swapped)
    const after = request([`${swapped}/*`])
    await run(KeteAddDirPlugin.granted(l, after))
    expect(after.effect).toBe("ask")
  })

  test("never touches a deny, another action, or a session without folders", async () => {
    const l = lookup(sessionWith([lib]))
    const denied = request([`${lib}/*`], "deny")
    await run(KeteAddDirPlugin.granted(l, denied))
    expect(denied.effect).toBe("deny")
    const edit = request([`${lib}/a.ts`], "ask", "edit")
    await run(KeteAddDirPlugin.granted(l, edit))
    expect(edit.effect).toBe("ask")
    const none = request([`${lib}/*`])
    await run(KeteAddDirPlugin.granted(lookup({ ses_a: info("ses_a") }), none))
    expect(none.effect).toBe("ask")
  })

  test("an explicit external_directory ask for the folder still asks; a deny rule is left to the permission service", async () => {
    const explicit = lookup(sessionWith([lib]), [
      { action: "external_directory", resource: "*", effect: "ask" },
      { action: "external_directory", resource: `${lib}/*`, effect: "ask" },
    ])
    const event = request([`${lib}/*`])
    await run(KeteAddDirPlugin.granted(explicit, event))
    expect(event.effect).toBe("ask")
    // A session rule written for the folder counts the same way.
    const session = lookup({ ses_a: info("ses_a", { [KeteAddDir.metadataKey]: [lib] }, undefined, [{ action: "external_directory", resource: `${lib}/src/*`, effect: "ask" }]) })
    const nested = request([`${lib}/src/*`])
    await run(KeteAddDirPlugin.granted(session, nested))
    expect(nested.effect).toBe("ask")
  })

  test("a subagent uses its root session's folders", async () => {
    const l = lookup({ ses_root: info("ses_root", { [KeteAddDir.metadataKey]: [lib] }), ses_a: info("ses_a", undefined, "ses_root") })
    const event = request([`${lib}/*`])
    await run(KeteAddDirPlugin.granted(l, event))
    expect(event.effect).toBe("allow")
  })

  test("job mode grants nothing", async () => {
    process.env.OPENCODE_JOB_MODE = "1"
    try {
      const event = request([`${lib}/*`])
      await run(KeteAddDirPlugin.granted(lookup(sessionWith([lib])), event))
      expect(event.effect).toBe("ask")
    } finally {
      delete process.env.OPENCODE_JOB_MODE
    }
  })
})

describe("add-dir dirs and rules", () => {
  test("the root-most session with folders wins", async () => {
    const sessions = {
      ses_root: info("ses_root", { [KeteAddDir.metadataKey]: [lib] }),
      ses_child: info("ses_child", { [KeteAddDir.metadataKey]: ["/elsewhere"] }, "ses_root"),
    }
    expect(await run(KeteAddDir.dirs(lookup(sessions), id("ses_child")))).toEqual([lib])
  })

  test("the subagent ceiling: a parent that would ask doesn't make a subagent ask again, a parent's deny still denies", async () => {
    const sessions = { ses_child: info("ses_child", undefined, "ses_parent"), ses_parent: info("ses_parent", { [KeteAddDir.metadataKey]: [lib] }) }
    const ceilingFor = (parentRules: Rule[]) =>
      run(
        KetePermissionCeiling.ceiling(
          {
            session: (sessionID) => Effect.succeed(Option.fromNullishOr(sessions[sessionID as keyof typeof sessions])),
            agent: () => Effect.succeed({ permissions: parentRules } as never),
            approved: Effect.succeed([]),
            // As the plugin's lookup does: the folders of the child's root session, as allow rules.
            policy: (sessionID) => KeteAddDir.dirs(lookup(sessions), sessionID).pipe(Effect.map(KeteAddDir.rules)),
          },
          id("ses_child"),
          "external_directory",
          [`${lib}/src/*`],
        ),
      )
    const ask: Rule = { action: "external_directory", resource: "*", effect: "ask" }
    expect(await ceilingFor([ask])).toBe("allow")
    expect(await ceilingFor([ask, { action: "external_directory", resource: `${lib}/*`, effect: "deny" }])).toBe("deny")
  })

  test("rules allow each folder and what is inside it, with forward slashes", () => {
    expect(KeteAddDir.rules(["C:\\work\\lib"])).toEqual([
      { action: "external_directory", resource: "C:/work/lib", effect: "allow" },
      { action: "external_directory", resource: "C:/work/lib/*", effect: "allow" },
    ])
  })
})
