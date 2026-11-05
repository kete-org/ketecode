// The file tools open a checked real path with no symbolic link allowed in any component, so a folder swapped
// for a link after the check redirects nothing: not a read, a create, a delete, a listing or the formatter.
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { EnvironmentLocal } from "@opencode/core/environment/local"
import { KeteVerifiedOpen } from "@opencode/core/kete/verified-open"

let root: string
let outside: string

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kete-nf-in-")))
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "kete-nf-out-")))
  await fs.writeFile(path.join(outside, "secret"), "KEY")
})
afterEach(async () => {
  await fs.chmod(root, 0o755).catch(() => undefined)
  await fs.rm(root, { recursive: true, force: true })
  await fs.rm(outside, { recursive: true, force: true })
})

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8")
const bytes = (value: string) => new TextEncoder().encode(value)
const failure = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.flip(effect))
const checked = async (real: string): Promise<KeteVerifiedOpen.Entry> => {
  const info = await fs.stat(real, { bigint: true }).catch(() => undefined)
  return info?.isFile() ? { real, id: { dev: info.dev, ino: info.ino } } : { real }
}
const causeMessage = (error: unknown) => String((error as { cause?: { message?: string } }).cause?.message)
/** Replace the folder `dir` with a symlink to `outside` (what a process racing the tool would do). */
const swap = async (dir: string) => {
  await fs.rm(dir, { recursive: true, force: true })
  await fs.symlink(outside, dir)
}
const untouched = async () => {
  expect(await fs.readdir(outside)).toEqual(["secret"])
  expect(await fs.readFile(path.join(outside, "secret"), "utf8")).toBe("KEY")
}
const registryFor = (entries: Record<string, KeteVerifiedOpen.Entry>): KeteVerifiedOpen.Registry => ({
  paths: new Map(Object.entries(entries).map(([key, entry]) => [path.resolve(key), entry])),
  changed: false,
})
const unsupportedPlatform: KeteVerifiedOpen.Platform = { kind: "unsupported", reason: "test" }
const without = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(Effect.provideService(KeteVerifiedOpen.CurrentPlatform, unsupportedPlatform))

describe.skipIf(process.platform === "win32")("KeteVerifiedOpen without following links", () => {
  describe("a folder swapped for a link after the check", () => {
    test("a new file is not created outside", async () => {
      await fs.mkdir(path.join(root, "dir"))
      const file = path.join(root, "dir", "new.txt")
      const entry = await checked(file)
      await swap(path.join(root, "dir"))
      expect(await failure(KeteVerifiedOpen.write(file, entry, bytes("X")))).toMatchObject({ _tag: "Environment.Failed" })
      await untouched()
    })

    test("a new file with missing parents is not created outside", async () => {
      await fs.mkdir(path.join(root, "a"))
      const file = path.join(root, "a", "b", "c", "new.txt")
      const entry = await checked(file)
      await swap(path.join(root, "a"))
      expect(await failure(KeteVerifiedOpen.write(file, entry, bytes("X")))).toMatchObject({ _tag: "Environment.Failed" })
      await untouched()
    })

    test("an existing file is not overwritten outside", async () => {
      await fs.mkdir(path.join(root, "dir"))
      const file = path.join(root, "dir", "secret")
      await fs.writeFile(file, "inside")
      const entry = await checked(file)
      await swap(path.join(root, "dir"))
      expect(await failure(KeteVerifiedOpen.write(file, entry, bytes("X")))).toMatchObject({ _tag: "Environment.Failed" })
      expect(await failure(KeteVerifiedOpen.read(file, entry))).toMatchObject({ _tag: "Environment.Failed" })
      await untouched()
    })

    test("a delete does not reach outside", async () => {
      await fs.mkdir(path.join(root, "dir"))
      const file = path.join(root, "dir", "secret")
      await fs.writeFile(file, "inside")
      const entry = await checked(file)
      await swap(path.join(root, "dir"))
      expect(await failure(KeteVerifiedOpen.remove(file, entry))).toMatchObject({ _tag: "Environment.Failed" })
      await untouched()
    })

    test("a move (write to the target, delete the source) reaches outside from neither side", async () => {
      await fs.mkdir(path.join(root, "from"))
      await fs.mkdir(path.join(root, "to"))
      const source = path.join(root, "from", "secret")
      const target = path.join(root, "to", "secret")
      await fs.writeFile(source, "inside")
      const sourceEntry = await checked(source)
      const targetEntry = await checked(target)
      await swap(path.join(root, "to"))
      expect(await failure(KeteVerifiedOpen.write(target, targetEntry, bytes("moved")))).toMatchObject({ _tag: "Environment.Failed" })
      await fs.rm(path.join(root, "to"))
      await swap(path.join(root, "from"))
      expect(await failure(KeteVerifiedOpen.remove(source, sourceEntry))).toMatchObject({ _tag: "Environment.Failed" })
      await untouched()
    })

    test("a listing is refused", async () => {
      await fs.mkdir(path.join(root, "dir"))
      const entry = await checked(path.join(root, "dir"))
      await swap(path.join(root, "dir"))
      expect(await failure(KeteVerifiedOpen.list(path.join(root, "dir"), entry))).toMatchObject({ _tag: "Environment.Failed" })
    })

    test("the formatter is not run on it", async () => {
      await fs.mkdir(path.join(root, "dir"))
      const file = path.join(root, "dir", "secret")
      await fs.writeFile(file, "inside")
      const registry = registryFor({ [file]: await checked(file) })
      await swap(path.join(root, "dir"))
      const run = (target: string) =>
        Effect.runPromise(KeteVerifiedOpen.formattable(target).pipe(Effect.provideService(KeteVerifiedOpen.Expected, registry)))
      expect(await run(file)).toBe(false)
      expect(await run(path.join(root, "unregistered.ts"))).toBe(true)
    })

    test("the local driver's list and remove refuse it, and behave as before when nothing was checked", async () => {
      await fs.mkdir(path.join(root, "dir"))
      const file = path.join(root, "dir", "secret")
      await fs.writeFile(file, "inside")
      const registry = registryFor({
        [path.join(root, "dir")]: await checked(path.join(root, "dir")),
        [file]: await checked(file),
      })
      await swap(path.join(root, "dir"))
      const files = EnvironmentLocal.makeLocalDriver(undefined as never /* the file methods never spawn */).overrides!
      const checkedRun = <A, E>(effect: Effect.Effect<A, E>) =>
        failure(effect.pipe(Effect.provideService(KeteVerifiedOpen.Expected, registry)))
      expect(await checkedRun(files.list!(path.join(root, "dir")))).toMatchObject({ _tag: "Environment.Failed" })
      expect(await checkedRun(files.remove!(file))).toMatchObject({ _tag: "Environment.Failed" })
      await untouched()
      // Nothing recorded: the upstream behaviour (this is why only checked paths are routed).
      const listed = await Effect.runPromise(files.list!(path.join(root, "dir")))
      expect(listed.map((entry) => entry.name)).toEqual(["secret"])
    })
  })

  describe("a normal call", () => {
    test("a new file and its missing folders are created, and an overwrite keeps the mode", async () => {
      const file = path.join(root, "x", "y", "new.txt")
      await Effect.runPromise(KeteVerifiedOpen.write(file, await checked(file), bytes("created")))
      expect(await fs.readFile(file, "utf8")).toBe("created")
      const existing = path.join(root, "mode.txt")
      await fs.writeFile(existing, "old content", { mode: 0o640 })
      await Effect.runPromise(KeteVerifiedOpen.write(existing, await checked(existing), bytes("new")))
      expect(await fs.readFile(existing, "utf8")).toBe("new")
      expect((await fs.stat(existing)).mode & 0o777).toBe(0o640)
    })

    test("a file is read whole and by range", async () => {
      const file = path.join(root, "a.txt")
      await fs.writeFile(file, "hello world")
      const entry = await checked(file)
      const whole = await Effect.runPromise(KeteVerifiedOpen.read(file, entry))
      expect(text(whole.bytes)).toBe("hello world")
      expect(whole.info).toMatchObject({ type: "file", size: 11 })
      expect(text((await Effect.runPromise(KeteVerifiedOpen.read(file, entry, { offset: 6, length: 5 }))).bytes)).toBe("world")
    })

    test("a file is deleted, a folder is not (and stays)", async () => {
      const file = path.join(root, "gone.txt")
      await fs.writeFile(file, "x")
      expect(await Effect.runPromise(KeteVerifiedOpen.remove(file, await checked(file)))).toBe(true)
      await expect(fs.stat(file)).rejects.toThrow()
      const folder = path.join(root, "folder")
      await fs.mkdir(folder)
      await fs.writeFile(path.join(folder, "keep"), "x")
      const error = await failure(KeteVerifiedOpen.remove(folder, await checked(folder)))
      expect(error).toMatchObject({ _tag: "Environment.Failed" })
      expect(causeMessage(error)).toContain("only files are deleted")
      expect(await fs.readFile(path.join(folder, "keep"), "utf8")).toBe("x")
    })

    test("a link checked as a link is deleted as an entry of its folder; its target stays", async () => {
      await fs.mkdir(path.join(root, "dir"))
      const target = path.join(root, "target.txt")
      const link = path.join(root, "dir", "link.txt")
      await fs.writeFile(target, "before")
      await fs.symlink(target, link)
      const entry = { ...(await checked(target)), link: true, linkParent: path.join(root, "dir") }
      await Effect.runPromise(KeteVerifiedOpen.remove(link, entry))
      await expect(fs.lstat(link)).rejects.toThrow()
      expect(await fs.readFile(target, "utf8")).toBe("before")
    })

    test("a link inside a linked folder is refused and nothing outside changes", async () => {
      await fs.writeFile(path.join(outside, "x"), "target")
      await fs.symlink(outside, path.join(root, "home"))
      await fs.symlink(path.join(outside, "secret"), path.join(outside, "y"))
      const link = path.join(root, "home", "y")
      const registry = registryFor({})
      await Effect.runPromise(
        KeteVerifiedOpen.record(link, path.join(outside, "secret")).pipe(Effect.provideService(KeteVerifiedOpen.Expected, registry)),
      )
      const entry = registry.paths.get(path.resolve(link)) as KeteVerifiedOpen.Entry
      expect(entry).toMatchObject({ link: true, linkParent: undefined })
      const error = await failure(KeteVerifiedOpen.remove(link, entry))
      expect(causeMessage(error)).toContain("inside a linked folder")
      expect((await fs.lstat(path.join(outside, "y"))).isSymbolicLink()).toBe(true)
      expect(await fs.readFile(path.join(outside, "x"), "utf8")).toBe("target")
      expect(await fs.readFile(path.join(outside, "secret"), "utf8")).toBe("KEY")
    })

    test("a file with another hard link is not written, and both names stay unchanged", async () => {
      const file = path.join(root, "a.txt")
      await fs.writeFile(file, "before")
      await fs.link(file, path.join(root, "b.txt"))
      const error = await failure(KeteVerifiedOpen.write(file, await checked(file), bytes("X")))
      expect(causeMessage(error)).toContain("other hard links")
      expect(await fs.readFile(file, "utf8")).toBe("before")
      expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("before")
    })

    test("a file with another hard link is still read", async () => {
      const file = path.join(root, "a.txt")
      await fs.writeFile(file, "before")
      await fs.link(file, path.join(root, "b.txt"))
      expect(text((await Effect.runPromise(KeteVerifiedOpen.read(file, await checked(file)))).bytes)).toBe("before")
    })

    test("the formatter is not run on a file that gained a hard link after the check", async () => {
      const file = path.join(root, "f.ts")
      await fs.writeFile(file, "x")
      const registry = registryFor({ [file]: await checked(file) })
      await fs.rm(file)
      await fs.link(path.join(outside, "secret"), file)
      const ask = Effect.runPromise(KeteVerifiedOpen.formattable(file).pipe(Effect.provideService(KeteVerifiedOpen.Expected, registry)))
      expect(await ask).toBe(false)
    })

    test("the formatter runs through a linked folder that still leads to the checked file, not after a swap", async () => {
      await fs.mkdir(path.join(root, "real"))
      await fs.symlink(path.join(root, "real"), path.join(root, "linked"))
      const file = path.join(root, "linked", "secret")
      await fs.writeFile(file, "x")
      const registry = registryFor({ [file]: await checked(path.join(root, "real", "secret")) })
      const ask = () => Effect.runPromise(KeteVerifiedOpen.formattable(file).pipe(Effect.provideService(KeteVerifiedOpen.Expected, registry)))
      expect(await ask()).toBe(true)
      await fs.rm(path.join(root, "linked"))
      await fs.symlink(outside, path.join(root, "linked"))
      expect(await ask()).toBe(false)
      await untouched()
    })

    test("a link whose folder is swapped after the check is not deleted outside", async () => {
      await fs.mkdir(path.join(root, "dir"))
      const link = path.join(root, "dir", "secret")
      await fs.symlink(path.join(root, "nowhere"), link)
      const entry = { ...(await checked(path.join(root, "nowhere"))), link: true, linkParent: path.join(root, "dir") }
      await swap(path.join(root, "dir"))
      // root/dir now leads outside, where "secret" is a regular file: whatever remove answers, it must not reach it.
      await Effect.runPromise(Effect.exit(KeteVerifiedOpen.remove(link, entry)))
      await untouched()
    })

    test("a file that became a link after the check: the checked file is deleted, the link's outside target is not", async () => {
      const file = path.join(root, "file.txt")
      await fs.writeFile(file, "checked")
      const entry = await checked(file)
      await fs.rename(file, path.join(root, "aside.txt"))
      await fs.symlink(path.join(outside, "secret"), file)
      await Effect.runPromise(Effect.exit(KeteVerifiedOpen.remove(file, entry)))
      await untouched()
    })

    test("a move is a write to the target and a delete of the source", async () => {
      const source = path.join(root, "s.txt")
      const target = path.join(root, "t", "t.txt")
      await fs.writeFile(source, "payload")
      await Effect.runPromise(KeteVerifiedOpen.write(target, await checked(target), bytes("payload")))
      expect(await Effect.runPromise(KeteVerifiedOpen.remove(source, await checked(source)))).toBe(true)
      expect(await fs.readFile(target, "utf8")).toBe("payload")
      await expect(fs.stat(source)).rejects.toThrow()
    })

    test("a folder is listed with names and kinds", async () => {
      await fs.mkdir(path.join(root, "sub"))
      await fs.writeFile(path.join(root, "f.txt"), "x")
      await fs.symlink(path.join(root, "f.txt"), path.join(root, "l"))
      const listed = await Effect.runPromise(KeteVerifiedOpen.list(root, await checked(root)))
      expect(listed?.toSorted((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: "f.txt", type: "file" },
        { name: "l", type: "symlink" },
        { name: "sub", type: "directory" },
      ])
    })

    test("a value through a linked folder opens the checked real path", async () => {
      await fs.mkdir(path.join(root, "real"))
      await fs.symlink(path.join(root, "real"), path.join(root, "link"))
      const value = path.join(root, "link", "f.txt")
      const entry = { real: path.join(root, "real", "f.txt") }
      await Effect.runPromise(KeteVerifiedOpen.write(value, entry, bytes("through")))
      expect(await fs.readFile(entry.real, "utf8")).toBe("through")
      expect(text((await Effect.runPromise(KeteVerifiedOpen.read(value, await checked(entry.real)))).bytes)).toBe("through")
    })

    test("a value under an un-realpathed temp folder opens its real path", async () => {
      const value = path.join(os.tmpdir(), path.basename(root), "f.txt")
      const real = path.join(root, "f.txt")
      await Effect.runPromise(KeteVerifiedOpen.write(value, { real }, bytes("tmp")))
      expect(await fs.readFile(real, "utf8")).toBe("tmp")
    })
  })

  describe.skipIf(process.getuid?.() === 0)("permissions", () => {
    test("reading a write-only file fails with a clear permission error", async () => {
      const file = path.join(root, "wo.txt")
      await fs.writeFile(file, "x", { mode: 0o200 })
      const error = await failure(KeteVerifiedOpen.read(file, await checked(file)))
      expect(error).toMatchObject({ _tag: "Environment.Failed" })
      expect(causeMessage(error)).toContain("permission denied")
    })

    test("a write-only file can be written, but is not formatted where a descriptor needs read access (macOS)", async () => {
      const file = path.join(root, "wo.txt")
      await fs.writeFile(file, "x", { mode: 0o200 })
      const entry = await checked(file)
      await Effect.runPromise(KeteVerifiedOpen.write(file, entry, bytes("new")))
      await fs.chmod(file, 0o600)
      expect(await fs.readFile(file, "utf8")).toBe("new")
      await fs.chmod(file, 0o200)
      const formattable = await Effect.runPromise(
        KeteVerifiedOpen.formattable(file).pipe(Effect.provideService(KeteVerifiedOpen.Expected, registryFor({ [file]: entry }))),
      )
      expect(formattable).toBe(process.platform !== "darwin")
    })

    test("creating in a folder that cannot be read fails with a permission error on macOS", async () => {
      if (process.platform !== "darwin") return
      const dir = path.join(root, "noread")
      await fs.mkdir(dir)
      await fs.chmod(dir, 0o300)
      const file = path.join(dir, "new.txt")
      const error = await failure(KeteVerifiedOpen.write(file, await checked(file), bytes("X")))
      await fs.chmod(dir, 0o700)
      expect(error).toMatchObject({ _tag: "Environment.Failed" })
      expect(causeMessage(error)).toContain("EACCES")
    })
  })

  describe("when no-follow access is not available", () => {
    test("every operation fails closed and nothing is written", async () => {
      const file = path.join(root, "a.txt")
      await fs.writeFile(file, "inside")
      const entry = await checked(file)
      const errors = [
        await failure(without(KeteVerifiedOpen.read(file, entry))),
        await failure(without(KeteVerifiedOpen.write(file, entry, bytes("X")))),
        await failure(without(KeteVerifiedOpen.list(root, await checked(root)))),
        await failure(without(KeteVerifiedOpen.remove(file, entry))),
      ]
      for (const error of errors) {
        expect(error).toMatchObject({ _tag: "Environment.Failed" })
        expect(causeMessage(error)).toContain("without following symbolic links")
      }
      expect(await fs.readFile(file, "utf8")).toBe("inside")
      const registry = registryFor({ [file]: entry })
      expect(
        await Effect.runPromise(
          without(KeteVerifiedOpen.formattable(file)).pipe(Effect.provideService(KeteVerifiedOpen.Expected, registry)),
        ),
      ).toBe(false)
    })

    test("a platform without a no-follow layer is unsupported, Windows keeps the identity check", () => {
      expect(KeteVerifiedOpen.load("sunos")).toMatchObject({ kind: "unsupported" })
      expect(KeteVerifiedOpen.load("win32")).toEqual({ kind: "identity" })
    })
  })
})
